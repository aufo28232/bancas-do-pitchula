"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Turnstile } from "@/components/ui/turnstile";
import { alertarAssumido, ativarSom, bipe } from "@/lib/client/alerta";
import { enviar } from "@/lib/client/api";
import { TempoReal } from "@/lib/client/tempo-real";
import { ROTULO_TIPO_PIX } from "@/lib/validacao/pedido";
import type { EstadoPedido } from "@/lib/server/publico/espectador";

type Mensagem = EstadoPedido["mensagens"][number];
type Fase = "lendo" | "verificar" | "carregando" | "pronto" | "invalido" | "erro";

type RespostaRealtime = {
  url: string;
  chavePublica: string;
  token: string;
  expiraEmSeg: number;
  topicos: { pedido: string; vagas: string | null };
};

const MOTIVOS: Record<string, string> = {
  vagas_esgotadas: "As vagas desta banca acabaram.",
  banido: "Seu pedido não pôde ser aceito.",
  sem_resposta: "O tempo para responder acabou.",
  comprovante_ilegivel: "Não deu para ler o comprovante.",
  deposito_nao_encontrado: "O depósito não foi encontrado.",
  dados_divergentes: "Os dados enviados não conferem.",
  exclusao_a_pedido: "Pedido excluído a seu pedido.",
  outro: "O pedido foi recusado pela equipe.",
};

// O fragmento é lido UMA vez por carregamento (o React em dev roda efeitos duas vezes).
let tokenDoLink: string | null | undefined;

function lerFragmento(): string | null {
  if (tokenDoLink !== undefined) return tokenDoLink;
  const t = window.location.hash.slice(1);
  // Apaga o token da barra de endereço ANTES de qualquer outra coisa carregar.
  if (t) history.replaceState(null, "", window.location.pathname + window.location.search);
  tokenDoLink = /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
  return tokenDoLink;
}

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

function formatarRestante(seg: number): string {
  const s = Math.max(0, Math.ceil(seg));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PaginaPedido({ siteKey }: { siteKey: string }) {
  const router = useRouter();
  const [fase, setFase] = useState<Fase>("lendo");
  const [erro, setErro] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [chaveTs, setChaveTs] = useState(0);
  const [estado, setEstado] = useState<EstadoPedido | null>(null);
  const [conectado, setConectado] = useState(false);
  const [som, setSom] = useState(false);
  const [aviso, setAviso] = useState("");
  const [agora, setAgora] = useState(0);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erroMsg, setErroMsg] = useState("");
  const ultimoAlerta = useRef(0);
  const atendimentoAnterior = useRef<boolean | null>(null);
  const fimDaLista = useRef<HTMLLIElement>(null);

  const alertar = useCallback((atendente: string | null) => {
    if (Date.now() - ultimoAlerta.current < 3000) return;
    ultimoAlerta.current = Date.now();
    alertarAssumido();
    setAviso(atendente ? `${atendente} assumiu seu pedido.` : "Seu pedido foi assumido.");
  }, []);

  const aplicarEstado = useCallback(
    (novo: EstadoPedido) => {
      const antes = atendimentoAnterior.current;
      atendimentoAnterior.current = novo.pedido.em_atendimento;
      // Reserva para quando o evento do tempo real não chega (polling).
      if (antes === false && novo.pedido.em_atendimento) alertar(novo.pedido.atendente);
      setEstado(novo);
    },
    [alertar],
  );

  const carregar = useCallback(
    async (inicial: boolean) => {
      const r = await enviar<EstadoPedido>("/api/pedido/estado");
      if (r.ok) {
        aplicarEstado(r.dados);
        setFase("pronto");
        return;
      }
      if (r.status === 401) {
        // Pedido apagado (banca encerrada, D-044) ou sessão perdida.
        if (inicial) setFase("invalido");
        else router.replace("/");
        return;
      }
      if (inicial) {
        setErro(r.erro);
        setFase("erro");
      }
    },
    [aplicarEstado, router],
  );

  // 1. Fragmento -> Turnstile -> sessão em cookie. Sem fragmento, tenta a sessão existente.
  useEffect(() => {
    const t = lerFragmento();
    void Promise.resolve().then(() => {
      if (t) {
        setToken(t);
        setFase("verificar");
      } else {
        setFase("carregando");
        void carregar(true);
      }
    });
  }, [carregar]);

  async function aoVerificar(ts: string) {
    if (!ts || !token) return;
    setFase("carregando");
    const r = await enviar("/api/pedido/sessao", { token, turnstile: ts });
    if (r.ok) {
      setToken(null);
      await carregar(true);
      return;
    }
    if (r.status === 404) {
      setFase("invalido");
      return;
    }
    setErro(r.erro);
    setChaveTs((k) => k + 1);
    setFase("verificar");
  }

  // 2. Tempo real (só ouvir) + renovação do token curto.
  const pronto = fase === "pronto";
  useEffect(() => {
    if (!pronto) return;
    let rt: TempoReal | null = null;
    let renovar: ReturnType<typeof setTimeout> | undefined;
    let ativo = true;

    async function conectar() {
      const r = await enviar<RespostaRealtime>("/api/pedido/realtime");
      if (!ativo || !r.ok) {
        if (ativo && !r.ok) renovar = setTimeout(() => void conectar(), 30_000);
        return;
      }
      const d = r.dados;
      if (!rt) {
        rt = new TempoReal(d.url, d.chavePublica);
        await rt.definirToken(d.token);
        rt.ouvir(
          d.topicos.pedido,
          {
            status: (p) =>
              setEstado((e) => {
                if (!e) return e;
                const status = p.status === "pago" || p.status === "recusado" ? p.status : "pendente";
                const emAtendimento = p.em_atendimento === true;
                atendimentoAnterior.current = emAtendimento;
                return {
                  ...e,
                  pedido: {
                    ...e.pedido,
                    status,
                    em_atendimento: emAtendimento,
                    atendente: typeof p.atendente === "string" ? p.atendente : null,
                    motivo: typeof p.motivo === "string" ? p.motivo : null,
                    prazo: typeof p.prazo === "string" ? p.prazo : null,
                    posicao: status === "pendente" ? e.pedido.posicao : null,
                  },
                };
              }),
            posicao: (p) =>
              setEstado((e) =>
                e && typeof p.posicao === "number" ? { ...e, pedido: { ...e.pedido, posicao: p.posicao } } : e,
              ),
            prazo: (p) => {
              const expira = typeof p.expira_em === "string" ? p.expira_em : null;
              // Começou a contar o prazo de 5 min: um bipe curto (D-046).
              if (expira) bipe(1);
              setEstado((e) => (e ? { ...e, pedido: { ...e.pedido, prazo: expira } } : e));
            },
            assumido: (p) => alertar(typeof p.atendente === "string" ? p.atendente : null),
            mensagem: (p) =>
              setEstado((e) => {
                if (!e || typeof p.id !== "string" || e.mensagens.some((m) => m.id === p.id)) return e;
                const m: Mensagem = {
                  id: p.id,
                  autor: p.autor === "staff" || p.autor === "sistema" ? p.autor : "espectador",
                  texto: typeof p.texto === "string" ? p.texto : null,
                  tem_anexo: p.tem_anexo === true,
                  atendente: typeof p.atendente === "string" ? p.atendente : null,
                  criada_em: typeof p.criada_em === "string" ? p.criada_em : new Date().toISOString(),
                };
                return { ...e, mensagens: [...e.mensagens, m] };
              }),
          },
          (ok) => setConectado(ok),
        );
        if (d.topicos.vagas) {
          // Banca encerrada: tudo é apagado e todos voltam para "Aguardando banca..." (D-044).
          rt.ouvir(d.topicos.vagas, { banca_encerrada: () => router.replace("/") }, () => undefined);
        }
      } else {
        await rt.definirToken(d.token);
      }
      renovar = setTimeout(() => void conectar(), Math.max(30, d.expiraEmSeg - 60) * 1000);
    }

    void conectar();
    return () => {
      ativo = false;
      if (renovar) clearTimeout(renovar);
      rt?.encerrar();
    };
  }, [pronto, alertar, router]);

  // O primeiro toque em qualquer lugar da página também libera o som (em silêncio).
  useEffect(() => {
    if (!pronto) return;
    const liberar = () => void ativarSom(true).then((ok) => setSom((atual) => atual || ok));
    document.addEventListener("pointerdown", liberar, { once: true });
    return () => document.removeEventListener("pointerdown", liberar);
  }, [pronto]);

  // 3. Polling de reserva: rápido sem tempo real, lento com ele.
  useEffect(() => {
    if (!pronto) return;
    const id = setInterval(() => void carregar(false), conectado ? 60_000 : 8_000);
    return () => clearInterval(id);
  }, [pronto, conectado, carregar]);

  // 4. Relógio do prazo de resposta.
  const prazo = estado?.pedido.status === "pendente" ? estado.pedido.prazo : null;
  useEffect(() => {
    if (!prazo) return;
    const tique = () => setAgora(Date.now());
    const primeiro = setTimeout(tique, 0);
    const id = setInterval(tique, 1000);
    return () => {
      clearTimeout(primeiro);
      clearInterval(id);
    };
  }, [prazo]);

  // Rola o chat para a última mensagem.
  const totalMensagens = estado?.mensagens.length ?? 0;
  useEffect(() => {
    fimDaLista.current?.scrollIntoView({ block: "nearest" });
  }, [totalMensagens]);

  async function aoAtivarSom() {
    setSom(await ativarSom());
  }

  async function aoMandar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = texto.trim();
    if (!t) return;
    setEnviando(true);
    setErroMsg("");
    const r = await enviar("/api/pedido/mensagem", { texto: t });
    setEnviando(false);
    if (r.ok) {
      setTexto("");
      void carregar(false);
      return;
    }
    setErroMsg(r.erro);
    if (r.status === 409) void carregar(false);
  }

  // -------------------------------------------------------------------------
  if (fase === "lendo" || fase === "carregando") {
    return (
      <p role="status" className="mt-16 text-fg-muted">
        Carregando seu pedido…
      </p>
    );
  }

  if (fase === "verificar") {
    return (
      <section aria-labelledby="t-verificar" className="mt-12 max-w-md">
        <h1 id="t-verificar" className="font-display text-4xl font-black uppercase">
          Abrindo seu pedido
        </h1>
        <p className="mt-3 text-fg-muted">Só uma verificação rápida de segurança.</p>
        <div className="mt-6">
          <Turnstile key={chaveTs} siteKey={siteKey} acao="pedido_sessao" aoMudar={(t) => void aoVerificar(t)} />
        </div>
        {erro ? (
          <p role="alert" className="mt-4 text-sm text-accent">
            {erro}
          </p>
        ) : null}
      </section>
    );
  }

  if (fase === "invalido" || fase === "erro" || !estado) {
    return (
      <section aria-labelledby="t-invalido" className="mt-12 max-w-md">
        <h1 id="t-invalido" className="font-display text-4xl font-black uppercase">
          {fase === "erro" ? "Algo deu errado" : "Link inválido"}
        </h1>
        <p className="mt-3 text-fg-muted">
          {fase === "erro"
            ? erro || "Não foi possível abrir seu pedido agora."
            : "Este link de pedido não é válido ou já expirou. Use o link que apareceu quando você enviou o pedido."}
        </p>
        <Link href="/" className="mt-6 inline-block underline underline-offset-4">
          Ir para o início
        </Link>
      </section>
    );
  }

  const p = estado.pedido;
  const restante = p.prazo && agora > 0 ? (new Date(p.prazo).getTime() - agora) / 1000 : null;
  const aberto = p.status === "pendente";

  return (
    <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-16">
      <section aria-labelledby="t-status">
        <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">{estado.banca.nome}</p>

        {p.status === "pendente" ? (
          <>
            <h1 id="t-status" className="mt-3 font-display font-black uppercase leading-[0.85]">
              {p.em_atendimento ? (
                <span className="block text-[clamp(2.5rem,9vw,4.5rem)] text-accent">Em atendimento</span>
              ) : (
                <>
                  <span className="block text-base tracking-[0.2em] text-fg-muted">Sua posição na fila</span>
                  <span className="block font-mono text-[clamp(5rem,24vw,9rem)]" data-posicao={p.posicao ?? ""}>
                    {p.posicao ? `${p.posicao}º` : "–"}
                  </span>
                </>
              )}
            </h1>
            <p className="mt-3 text-fg-muted">
              {p.em_atendimento
                ? `${p.atendente ?? "Um moderador"} está cuidando do seu pedido. Fica de olho no chat.`
                : "Aguarde: a equipe vai chamar no chat abaixo. Deixe esta página aberta."}
            </p>
          </>
        ) : p.status === "pago" ? (
          <>
            <h1 id="t-status" className="mt-3 font-display text-[clamp(2.5rem,9vw,4.5rem)] font-black uppercase leading-[0.85] text-accent">
              Pagamento registrado
            </h1>
            <p className="mt-3 text-fg-muted">A equipe registrou o pagamento do seu pedido. Confira o seu Pix.</p>
          </>
        ) : (
          <>
            <h1 id="t-status" className="mt-3 font-display text-[clamp(2.5rem,9vw,4.5rem)] font-black uppercase leading-[0.85]">
              Pedido encerrado
            </h1>
            <p className="mt-3 text-fg-muted">{MOTIVOS[p.motivo ?? "outro"] ?? MOTIVOS.outro}</p>
            {p.nota ? <p className="mt-2 border-l-2 border-line pl-3 text-sm">{p.nota}</p> : null}
          </>
        )}

        {aberto && restante !== null ? (
          <div role="timer" aria-live="off" className="mt-6 border-l-2 border-accent pl-4" data-prazo="">
            <p className="font-mono text-4xl font-bold text-accent">{formatarRestante(restante)}</p>
            <p className="text-sm">Responda no chat antes do tempo acabar, ou o pedido será encerrado.</p>
          </div>
        ) : null}

        <p aria-live="assertive" className="mt-4 text-sm font-medium text-accent">
          {aviso}
        </p>

        {aberto ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void aoAtivarSom()}
              aria-pressed={som}
              className="rounded-sm border border-line px-3 py-1.5 text-sm hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {som ? "Som ativado" : "Ativar som"}
            </button>
            <span className="text-xs text-fg-muted">Toca um bipe quando seu pedido for assumido.</span>
          </div>
        ) : null}

        <dl className="mt-10 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-fg-muted">Nome</dt>
          <dd>{estado.dados.nome}</dd>
          <dt className="text-fg-muted">CPF</dt>
          <dd className="font-mono">{estado.dados.cpf}</dd>
          <dt className="text-fg-muted">Pix ({ROTULO_TIPO_PIX[estado.dados.pixTipo]})</dt>
          <dd className="font-mono break-all">{estado.dados.pix}</dd>
          <dt className="text-fg-muted">ID na plataforma</dt>
          <dd className="font-mono">{estado.dados.plataformaId}</dd>
        </dl>
        <p className="mt-2 text-xs text-fg-muted">Seus dados aparecem incompletos de propósito.</p>
        <p className="mt-6 text-xs text-fg-muted" aria-live="polite">
          {conectado ? "Atualizando ao vivo." : "Reconectando… a página continua se atualizando."}
        </p>
      </section>

      <section aria-labelledby="t-chat" className="flex min-h-[420px] flex-col border border-line bg-surface">
        <h2 id="t-chat" className="border-b border-line px-4 py-3 font-display text-lg font-extrabold uppercase tracking-wide">
          Chat com a equipe
        </h2>
        <ol role="log" aria-live="polite" aria-label="Mensagens" className="flex-1 space-y-3 overflow-y-auto px-4 py-4 lg:max-h-[60svh]">
          {estado.mensagens.map((m) => (
            <li
              key={m.id}
              className={
                m.autor === "espectador"
                  ? "ml-8 rounded-sm bg-bg px-3 py-2"
                  : m.autor === "sistema"
                    ? "text-center text-xs text-fg-muted"
                    : "mr-8 rounded-sm border-l-2 border-accent bg-bg px-3 py-2"
              }
            >
              {m.autor !== "sistema" ? (
                <p className="text-xs text-fg-muted">
                  {m.autor === "espectador" ? "Você" : (m.atendente ?? "Equipe")} · {hora(m.criada_em)}
                </p>
              ) : null}
              {m.texto ? <p className="whitespace-pre-wrap break-words">{m.texto}</p> : null}
              {m.tem_anexo ? <p className="text-xs text-fg-muted">[imagem enviada]</p> : null}
            </li>
          ))}
          <li ref={fimDaLista} aria-hidden="true" />
        </ol>

        {aberto ? (
          <form onSubmit={(e) => void aoMandar(e)} className="border-t border-line p-3">
            <label htmlFor="mensagem" className="sr-only">
              Sua mensagem
            </label>
            <textarea
              id="mensagem"
              name="mensagem"
              rows={2}
              maxLength={1000}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              aria-describedby={erroMsg ? "mensagem-erro" : undefined}
              className="block w-full resize-none border-0 border-b border-line bg-transparent px-0 py-2 text-base outline-none focus:border-accent"
              placeholder="Escreva para a equipe"
            />
            {erroMsg ? (
              <p id="mensagem-erro" role="alert" className="mt-2 text-sm text-accent">
                {erroMsg}
              </p>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-fg-muted">{texto.length}/1000</span>
              <Botao carregando={enviando} className="w-auto! px-5 py-2 text-base" disabled={!texto.trim()}>
                Enviar
              </Botao>
            </div>
          </form>
        ) : (
          <p className="border-t border-line p-3 text-sm text-fg-muted">Este pedido foi finalizado; o chat está fechado.</p>
        )}
      </section>
    </div>
  );
}
