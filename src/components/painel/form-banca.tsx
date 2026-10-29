"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { enviar } from "@/lib/client/api";
import { dividir, formatarReais, lerReais } from "@/lib/dinheiro";
import { theme } from "@/theme/theme";

type Foto = keyof typeof theme.fotosBanca;
const FOTOS = Object.keys(theme.fotosBanca) as Foto[];

export type BancaEditavel = {
  id: string;
  name: string;
  total_cents: number;
  slots: number;
  ip_limit: boolean;
  order_count: number;
  version: number;
  platform_name: string | null;
  signup_url: string | null;
  foto: Foto | null;
};

/** Mesmo critério do servidor e do banco: só https, sem espaço (D-086). */
function linkValido(link: string): boolean {
  if (!/^https:\/\/[^\s<>"]+$/.test(link) || link.length > 500) return false;
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

function centsParaTexto(c: number): string {
  return formatarReais(c).replace("R$ ", "");
}

/** Criação e edição de banca, com prévia do valor por pessoa e da sobra. */
export function FormBanca({ banca }: { banca?: BancaEditavel }) {
  const router = useRouter();
  const travado = (banca?.order_count ?? 0) > 0;
  const [nome, setNome] = useState(banca?.name ?? "");
  const [valor, setValor] = useState(banca ? centsParaTexto(banca.total_cents) : "");
  const [vagas, setVagas] = useState(banca ? String(banca.slots) : "");
  const [ipLimit, setIpLimit] = useState(banca?.ip_limit ?? true);
  const [casa, setCasa] = useState(banca?.platform_name ?? "");
  const [link, setLink] = useState(banca?.signup_url ?? "");
  const [foto, setFoto] = useState<Foto | null>(banca?.foto ?? null);
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
    if (!casa.trim()) return setErro("Informe o nome da casa.");
    if (!linkValido(link.trim())) return setErro("Link de afiliado inválido. Use o link completo, começando com https://");
    if (!foto) return setErro("Escolha a foto da banca.");

    setEnviando(true);
    setErro("");
    if (!banca) {
      const r = await enviar<{ link: string }>("/api/painel/bancas/criar", {
        nome, totalCents, vagas: nVagas, ipLimit, idem, casa: casa.trim(), linkAfiliado: link.trim(), foto,
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
      linkAfiliado: link.trim(),
      foto,
      ...(travado ? {} : { totalCents, vagas: nVagas, casa: casa.trim() }),
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

      <Campo
        id="casa"
        name="casa"
        rotulo="Nome da casa"
        placeholder="Ex.: Teste"
        value={casa}
        onChange={(e) => setCasa(e.target.value)}
        maxLength={40}
        disabled={travado}
        required
      />
      <Campo
        id="link-afiliado"
        name="linkAfiliado"
        rotulo="Link de afiliado"
        inputMode="url"
        placeholder="https://"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        maxLength={500}
        required
      />
      {casa.trim() ? (
        <p className="-mt-3 text-sm text-fg-muted">
          Na página: &quot;Ainda não tem conta na {casa.trim()}? Cadastre-se aqui&quot;
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-fg-muted">Foto da banca</legend>
        <div className="grid grid-cols-2 gap-3">
          {FOTOS.map((f) => {
            const item = theme.fotosBanca[f];
            const marcada = foto === f;
            return (
              <label
                key={f}
                className={`flex cursor-pointer flex-col gap-2 border p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${marcada ? "border-accent" : "border-line hover:border-fg-muted"}`}
              >
                <input
                  type="radio"
                  name="foto"
                  value={f}
                  checked={marcada}
                  onChange={() => setFoto(f)}
                  className="sr-only"
                />
                <Image src={item.src} alt="" width={item.width} height={item.height} sizes="200px" className="aspect-square w-full object-cover object-top" />
                <span className={`text-center text-sm ${marcada ? "text-accent" : ""}`}>{item.rotulo}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

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
          {banca ? <span className="mt-1 block text-fg-muted">Mudar agora vale só para os próximos pedidos.</span> : null}
        </span>
      </label>

      <p role="alert" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      <Botao carregando={enviando}>{banca ? "Salvar" : "Criar banca"}</Botao>
    </form>
  );
}
