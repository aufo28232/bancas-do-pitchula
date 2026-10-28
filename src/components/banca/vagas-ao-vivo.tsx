"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TempoReal } from "@/lib/client/tempo-real";

type Props = {
  codigo: string;
  restantesIniciais: number;
  slots: number;
  statusInicial: string;
  url: string;
  chavePublica: string;
};

/**
 * Vagas restantes ao vivo (canal público SÓ DE LEITURA `vagas:{código}`).
 * Mudou o estado da banca (pausada, esgotada, reaberta): recarrega os dados do servidor.
 * Banca encerrada: volta para "Aguardando banca..." (D-044).
 */
export function VagasAoVivo({ codigo, restantesIniciais, slots, statusInicial, url, chavePublica }: Props) {
  const router = useRouter();
  const [restantes, setRestantes] = useState(restantesIniciais);
  const [total, setTotal] = useState(slots);
  const [pulso, setPulso] = useState(0);
  const [conectado, setConectado] = useState(false);

  useEffect(() => {
    let status = statusInicial;
    const rt = new TempoReal(url, chavePublica);
    rt.ouvir(
      `vagas:${codigo}`,
      {
        vagas: (p) => {
          if (typeof p.restantes === "number") {
            setRestantes(p.restantes);
            setPulso((n) => n + 1);
          }
          if (typeof p.total === "number") setTotal(p.total);
          if (typeof p.status === "string" && p.status !== status) {
            status = p.status;
            router.refresh();
          }
        },
        banca_encerrada: () => router.replace("/"),
      },
      setConectado,
    );
    return () => rt.encerrar();
  }, [codigo, url, chavePublica, statusInicial, router]);

  // Sem tempo real: atualiza pelo servidor de tempos em tempos.
  useEffect(() => {
    if (conectado) return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [conectado, router]);

  const pagas = Math.max(0, total - restantes);
  return (
    <div className="mt-8" data-vagas={restantes} data-ao-vivo={conectado ? "sim" : "nao"}>
      <p className="flex items-baseline justify-between text-sm">
        <span>
          <strong key={pulso} className={`inline-block font-mono text-lg ${pulso ? "vagas-pulso" : ""}`}>
            {restantes}
          </strong>{" "}
          vagas restantes
        </span>
        <span className="font-mono text-fg-muted">de {total}</span>
      </p>
      <progress
        value={pagas}
        max={total}
        aria-label={`${restantes} de ${total} vagas restantes`}
        className="mt-2 block h-1 w-full appearance-none overflow-hidden rounded-none bg-line [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:bg-accent [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-500"
      />
    </div>
  );
}
