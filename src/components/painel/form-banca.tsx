"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { enviar } from "@/lib/client/api";
import { dividir, formatarReais, lerReais } from "@/lib/dinheiro";

export type BancaEditavel = {
  id: string;
  name: string;
  total_cents: number;
  slots: number;
  ip_limit: boolean;
  order_count: number;
  version: number;
};

function centsParaTexto(c: number): string {
  return formatarReais(c).replace("R$ ", "");
}

/** Criação e edição de banca, com prévia do valor por pessoa e da sobra. */
export function FormBanca({ banca, ipEnfraquecido }: { banca?: BancaEditavel; ipEnfraquecido: boolean }) {
  const router = useRouter();
  const travado = (banca?.order_count ?? 0) > 0;
  const [nome, setNome] = useState(banca?.name ?? "");
  const [valor, setValor] = useState(banca ? centsParaTexto(banca.total_cents) : "");
  const [vagas, setVagas] = useState(banca ? String(banca.slots) : "");
  const [ipLimit, setIpLimit] = useState(banca?.ip_limit ?? true);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [criada, setCriada] = useState<{ link: string } | null>(null);
  const [copiado, setCopiado] = useState(false);
  // Chave de idempotência: clique duplo não cria duas bancas.
  const [idem] = useState(() => crypto.randomUUID());

  const totalCents = lerReais(valor);
  const nVagas = Number(vagas);
  const previa = useMemo(() => {
    if (totalCents === null || !Number.isInteger(nVagas) || nVagas < 1) return null;
    return dividir(totalCents, nVagas);
  }, [totalCents, nVagas]);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!nome.trim()) return setErro("Dê um nome para a banca.");
    if (totalCents === null || totalCents <= 0) return setErro("Valor total inválido. Ex.: 3.000 ou 3.000,50");
    if (!Number.isInteger(nVagas) || nVagas < 1 || nVagas > 10_000) return setErro("Vagas: de 1 a 10.000.");
    if (previa && previa.porPessoa < 1) return setErro("O valor por pessoa ficaria abaixo de R$ 0,01.");

    setEnviando(true);
    setErro("");
    if (!banca) {
      const r = await enviar<{ link: string }>("/api/painel/bancas/criar", {
        nome, totalCents, vagas: nVagas, ipLimit, idem,
      });
      setEnviando(false);
      if (r.ok) {
        setCriada({ link: r.dados.link });
        router.refresh();
      } else setErro(r.erro);
      return;
    }
    const r = await enviar<{ versao: number }>("/api/painel/bancas/editar", {
      id: banca.id,
      versao: banca.version,
      nome,
      ipLimit,
      ...(travado ? {} : { totalCents, vagas: nVagas }),
    });
    setEnviando(false);
    if (r.ok) {
      router.push("/painel");
      router.refresh();
    } else setErro(r.erro);
  }

  if (criada) {
    return (
      <div role="status" className="flex flex-col gap-4 border-l-2 border-accent pl-4">
        <p className="font-display text-3xl font-black uppercase leading-none">Banca criada</p>
        <p className="text-fg-muted">Este é o link para divulgar na live:</p>
        <code className="break-all bg-surface p-3 font-mono">{criada.link}</code>
        <div className="flex flex-wrap gap-2">
          <Botao
            type="button"
            variante="secundario"
            onClick={async () => {
              await navigator.clipboard.writeText(criada.link).then(() => setCopiado(true), () => setCopiado(false));
            }}
          >
            {copiado ? "Copiado" : "Copiar link"}
          </Botao>
          <Botao type="button" variante="secundario" onClick={() => router.push("/painel")}>
            Voltar ao painel
          </Botao>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={aoEnviar} className="flex max-w-lg flex-col gap-6" noValidate>
      <Campo id="nome-banca" name="nome" rotulo="Nome da banca" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} required />
      <Campo
        id="valor"
        name="valor"
        rotulo="Valor total (R$)"
        inputMode="decimal"
        placeholder="3.000"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        disabled={travado}
        dica={travado ? "Travado: a banca já recebeu pedidos. Para mudar, encerre e crie outra." : undefined}
        required
      />
      <Campo
        id="vagas"
        name="vagas"
        rotulo="Quantidade de vagas"
        inputMode="numeric"
        placeholder="100"
        value={vagas}
        onChange={(e) => setVagas(e.target.value.replace(/\D/g, ""))}
        disabled={travado}
        required
      />

      <div aria-live="polite" className="border border-line p-4 font-mono text-sm">
        {previa && totalCents !== null ? (
          <>
            <p>
              {formatarReais(totalCents)} ÷ {nVagas} {nVagas === 1 ? "vaga" : "vagas"} ={" "}
              <strong className="text-accent">{formatarReais(previa.porPessoa)} por pessoa</strong>
            </p>
            {previa.sobra > 0 ? (
              <p className="mt-1 text-fg-muted">Sobra {formatarReais(previa.sobra)} (fica com o streamer, aparece no resumo).</p>
            ) : null}
          </>
        ) : (
          <p className="text-fg-muted">Preencha valor e vagas para ver quanto cada pessoa recebe.</p>
        )}
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={ipLimit} onChange={(e) => setIpLimit(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
        <span>
          Limitar a 1 pedido por IP
          <span className="mt-1 block text-fg-muted">
            Pode barrar pessoas diferentes na mesma casa ou na mesma rede de celular.
            {banca ? " Mudar agora vale só para os próximos pedidos." : ""}
          </span>
          {ipEnfraquecido ? (
            <span className="mt-1 block text-accent">
              Neste modo de hospedagem o IP pode ser forjado: a regra por IP fica enfraquecida.
            </span>
          ) : null}
        </span>
      </label>

      <p role="alert" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      <Botao carregando={enviando}>{banca ? "Salvar" : "Criar banca"}</Botao>
    </form>
  );
}
