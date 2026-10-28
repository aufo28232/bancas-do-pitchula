"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TempoReal } from "@/lib/client/tempo-real";

type Props = {
  codigo: string;
  statusInicial: string;
  url: string;
  chavePublica: string;
};

/**
 * Acompanha a banca ao vivo (canal público SÓ DE LEITURA `vagas:{código}`) sem
 * mostrar a contagem de vagas (D-084). Mudou o estado (pausada, esgotada,
 * reaberta): recarrega os dados do servidor. Encerrada: volta para o início (D-044).
 */
export function EstadoAoVivo({ codigo, statusInicial, url, chavePublica }: Props) {
  const router = useRouter();
  const [conectado, setConectado] = useState(false);

  useEffect(() => {
    let status = statusInicial;
    const rt = new TempoReal(url, chavePublica);
    rt.ouvir(
      `vagas:${codigo}`,
      {
        vagas: (p) => {
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

  return <span hidden data-ao-vivo={conectado ? "sim" : "nao"} />;
}
