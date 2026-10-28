"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { enviar } from "@/lib/client/api";
import { formatarReais } from "@/lib/dinheiro";
import type { DetalhePedido, RespostaRapida } from "@/lib/server/painel/atendimento";
import { ROTULO_TIPO_PIX } from "@/lib/validacao/pedido";
import { formatarRestante, novaChave } from "./relogio";

type Props = {
  detalhe: DetalhePedido | null;
  respostas: RespostaRapida[];
  dono: boolean;
  agora: number;
  aoVoltar: () => void;
  aoMudar: () => Promise<void>;
};

const MOTIVOS_RECUSA = [
  ["comprovante_ilegivel", "Comprovante ilegível"],
  ["deposito_nao_encontrado", "Depósito não encontrado"],
  ["dados_divergentes", "Dados não conferem"],
  ["outro", "Outro motivo"],
] as const;

const MOTIVO_TEXTO: Record<string, string> = {
  vagas_esgotadas: "vagas esgotadas",
  banido: "banido",
  sem_resposta: "sem resposta em 5 min",
  comprovante_ilegivel: "comprovante ilegível",
  deposito_nao_encontrado: "depósito não encontrado",
  dados_divergentes: "dados não conferem",
  exclusao_a_pedido: "exclusão a pedido",
  outro: "outro motivo",
};

const TIPOS_BAN = [
  ["cpf", "CPF"],
  ["pix", "Chave Pix"],
  ["platform_id", "ID na plataforma"],
  ["ip", "IP (até 7 dias)"],
] as const;

type Painel = "nenhum" | "pagar" | "recusar" | "banir" | "forcar";

const botao =
  "rounded-sm border px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

export function Detalhe({ detalhe, respostas, dono, agora, aoVoltar, aoMudar }: Props) {
  const [painel, setPainel] = useState<Painel>("nenhum");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [texto, setTexto] = useState("");
  const [revelados, setRevelados] = useState<Partial<Record<"nome" | "cpf" | "pix" | "pid", string>>>({});
  const temporizadores = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fimDoChat = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lista = temporizadores.current;
    return () => lista.forEach(clearTimeout);
  }, []);

  const totalMensagens = detalhe?.mensagens.length ?? 0;
  useEffect(() => {
    fimDoChat.current?.scrollIntoView({ block: "nearest" });
  }, [totalMensagens]);

  if (!detalhe) {
    return (
      <p role="status" className="border border-line p-6 text-sm text-fg-muted">
        Carregando o pedido…
      </p>
    );
  }

  const p = detalhe.pedido;
  const pendente = p.status === "pendente";
  const comOutro = pendente && !p.meu && p.atendente !== null;
  const podeDecidir = pendente && (p.meu || (dono && !comOutro));
  const restante = p.prazo && agora > 0 ? (new Date(p.prazo).getTime() - agora) / 1000 : null;

  async function executar(url: string, corpo: Record<string, unknown>, sucesso?: string): Promise<boolean> {
    setOcupado(true);
    setErro("");
    setAviso("");
    const r = await enviar(url, corpo);
    setOcupado(false);
    if (!r.ok) {
      setErro(r.erro);
      await aoMudar();
      return false;
    }
    setPainel("nenhum");
    if (sucesso) setAviso(sucesso);
    await aoMudar();
    return true;
  }

  async function revelar(campo: "nome" | "cpf" | "pix" | "pid") {
    setErro("");
    const r = await enviar<{ valor: string }>("/api/painel/pedidos/revelar", { id: p.id, campo });
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    setRevelados((v) => ({ ...v, [campo]: r.dados.valor }));
    // Mostra por 5 s e mascara de novo (ARCHITECTURE §5.8).
    temporizadores.current.push(
      setTimeout(() => setRevelados((v) => ({ ...v, [campo]: undefined })), 5000),
    );
  }

  async function copiarPix() {
    setErro("");
    const r = await enviar<{ valor: string }>("/api/painel/pedidos/copiar-pix", { id: p.id });
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    try {
      // Vai direto para a área de transferência, sem aparecer na tela.
      await navigator.clipboard.writeText(r.dados.valor);
      setAviso("Pix copiado.");
    } catch {
      setErro("O navegador não deixou copiar. Use o botão de revelar.");
    }
  }

  async function aoMandar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = texto.trim();
    if (!t) return;
    if (await executar("/api/painel/pedidos/mensagem", { id: p.id, texto: t })) setTexto("");
  }

  async function aoRecusar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await executar(
      "/api/painel/pedidos/recusar",
      { id: p.id, idem: novaChave(), motivo: String(f.get("motivo")), nota: String(f.get("nota") ?? "") },
      "Pedido recusado.",
    );
  }

  async function aoBanir(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const tipo = String(f.get("tipo"));
    const horas = Number(f.get("horas"));
    await executar(
      "/api/painel/pedidos/banir",
      {
        id: p.id,
        idem: novaChave(),
        tipo,
        escopo: String(f.get("escopo")),
        motivo: String(f.get("motivo") ?? ""),
        horas: tipo === "ip" ? horas : null,
      },
      "Banimento registrado.",
    );
  }

  const linhaDado = (rotulo: string, campo: "nome" | "cpf" | "pix" | "pid", valor: string, extra?: ReactNode) => (
    <>
      <dt className="text-fg-muted">{rotulo}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono" data-campo={campo}>
          {revelados[campo] ?? valor}
        </span>
        {detalhe.live && !revelados[campo] ? (
          <button type="button" className={`${botao} border-line px-2 py-0.5 text-xs`} onClick={() => void revelar(campo)}>
            Revelar
          </button>
        ) : null}
        {extra}
      </dd>
    </>
  );

  return (
    <article className="flex flex-col gap-6" aria-labelledby="t-pedido">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" onClick={aoVoltar} className="mb-2 text-sm text-fg-muted underline underline-offset-4 lg:hidden">
            Voltar para a fila
          </button>
          <h2 id="t-pedido" className="font-display text-3xl font-black uppercase leading-none">
            Pedido #{p.seq}
          </h2>
          <p className="mt-1 text-sm text-fg-muted" data-status={p.status}>
            {p.status === "pendente"
              ? p.meu
                ? "Com você"
                : p.atendente
                  ? `Com ${p.atendente}`
                  : "Ninguém atendendo"
              : p.status === "pago"
                ? `Pago${p.pago_por ? ` por ${p.pago_por}` : ""}`
                : `Recusado (${MOTIVO_TEXTO[p.motivo ?? "outro"] ?? "outro motivo"})${p.recusado_por ? ` por ${p.recusado_por}` : ""}`}
            {p.status === "pendente" && !p.tem_comprovante ? " · sem comprovante" : ""}
          </p>
        </div>
        {restante !== null && pendente ? (
          <div role="timer" aria-live="off" className="border-l-2 border-accent pl-3 text-right" data-prazo-painel="">
            <p className="font-mono text-2xl text-accent">{formatarRestante(restante)}</p>
            <p className="text-xs text-fg-muted">para o espectador responder</p>
          </div>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {linhaDado("Nome", "nome", detalhe.dados.nome)}
        {linhaDado("CPF", "cpf", detalhe.dados.cpf)}
        {linhaDado(
          `Pix (${ROTULO_TIPO_PIX[detalhe.dados.pixTipo]})`,
          "pix",
          detalhe.dados.pix,
          <button type="button" className={`${botao} border-line px-2 py-0.5 text-xs`} onClick={() => void copiarPix()}>
            Copiar Pix
          </button>,
        )}
        {linhaDado("ID na plataforma", "pid", detalhe.dados.plataformaId)}
      </dl>
      {detalhe.live ? (
        <p className="-mt-3 text-xs text-fg-muted">Modo live: os dados ficam escondidos. Revelar mostra por 5 s e fica registrado.</p>
      ) : null}

      {/* Ações ------------------------------------------------------------------ */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {pendente && !p.meu && !comOutro ? (
            <button
              type="button"
              disabled={ocupado}
              className={`${botao} border-accent bg-accent font-medium text-accent-fg`}
              onClick={() => void executar("/api/painel/pedidos/assumir", { id: p.id, idem: novaChave() })}
            >
              Assumir
            </button>
          ) : null}
          {comOutro && dono ? (
            <button type="button" disabled={ocupado} className={`${botao} border-line`} onClick={() => setPainel("forcar")}>
              Forçar assumir
            </button>
          ) : null}
          {podeDecidir ? (
            <>
              <button type="button" disabled={ocupado} className={`${botao} border-accent text-accent`} onClick={() => setPainel("pagar")}>
                Marcar pago
              </button>
              <button type="button" disabled={ocupado} className={`${botao} border-line`} onClick={() => setPainel("recusar")}>
                Recusar
              </button>
            </>
          ) : null}
          {pendente && (p.meu || (dono && p.atendente)) ? (
            <button
              type="button"
              disabled={ocupado}
              className={`${botao} border-line`}
              onClick={() => void executar("/api/painel/pedidos/liberar", { id: p.id, idem: novaChave() })}
            >
              Liberar
            </button>
          ) : null}
          <button type="button" disabled={ocupado} className={`${botao} border-line text-fg-muted`} onClick={() => setPainel("banir")}>
            Banir
          </button>
        </div>

        {painel === "pagar" ? (
          <div role="alertdialog" aria-label="Confirmar pagamento" className="flex flex-col gap-3 border border-accent p-4">
            <p>
              Confirmar Pix de <strong>{formatarReais(detalhe.banca.por_pessoa_cents)}</strong> para{" "}
              <strong>{detalhe.dados.nome}</strong>? Não dá para desfazer.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={ocupado}
                className={`${botao} border-accent bg-accent font-medium text-accent-fg`}
                onClick={() => void executar("/api/painel/pedidos/pagar", { id: p.id, idem: novaChave() }, "Pagamento registrado.")}
              >
                Confirmar pagamento
              </button>
              <button type="button" className={`${botao} border-line`} onClick={() => setPainel("nenhum")}>
                Cancelar
              </button>
            </div>
          </div>
        ) : null}

        {painel === "forcar" ? (
          <div role="alertdialog" aria-label="Forçar assumir" className="flex flex-col gap-3 border border-line p-4">
            <p>Tirar o pedido de {p.atendente} e assumir? Fica registrado na auditoria.</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={ocupado}
                className={`${botao} border-accent text-accent`}
                onClick={() => void executar("/api/painel/pedidos/forcar", { id: p.id, idem: novaChave() })}
              >
                Forçar
              </button>
              <button type="button" className={`${botao} border-line`} onClick={() => setPainel("nenhum")}>
                Cancelar
              </button>
            </div>
          </div>
        ) : null}

        {painel === "recusar" ? (
          <form onSubmit={(e) => void aoRecusar(e)} className="flex flex-col gap-3 border border-line p-4" aria-label="Recusar pedido">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-muted">Motivo</span>
              <select name="motivo" className="border border-line bg-bg px-2 py-2" defaultValue="comprovante_ilegivel">
                {MOTIVOS_RECUSA.map(([v, r]) => (
                  <option key={v} value={v}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-muted">Nota para o espectador (opcional)</span>
              <input name="nota" maxLength={280} className="border-b border-line bg-transparent py-2 outline-none focus:border-accent" />
            </label>
            <p className="text-xs text-fg-muted">Recusar é definitivo: o mesmo CPF não faz outro pedido nesta banca.</p>
            <div className="flex gap-2">
              <button type="submit" disabled={ocupado} className={`${botao} border-accent text-accent`}>
                Confirmar recusa
              </button>
              <button type="button" className={`${botao} border-line`} onClick={() => setPainel("nenhum")}>
                Cancelar
              </button>
            </div>
          </form>
        ) : null}

        {painel === "banir" ? <FormBanir ocupado={ocupado} aoEnviar={aoBanir} aoCancelar={() => setPainel("nenhum")} /> : null}

        <p aria-live="polite" className="min-h-5 text-sm text-fg-muted">
          {aviso}
        </p>
        {erro ? (
          <p role="alert" className="text-sm text-accent">
            {erro}
          </p>
        ) : null}
      </div>

      {/* Chat ------------------------------------------------------------------- */}
      <section aria-labelledby="t-chat-painel" className="flex flex-col border border-line bg-surface">
        <h3 id="t-chat-painel" className="border-b border-line px-4 py-2 font-display text-lg font-extrabold uppercase">
          Chat
        </h3>
        <div role="log" aria-live="polite" aria-label="Mensagens do pedido" className="max-h-[50svh] overflow-y-auto px-4 py-3">
          <ol className="space-y-3">
            {detalhe.mensagens.map((m) => (
              <li
                key={m.id}
                className={
                  m.autor === "sistema"
                    ? "text-center text-xs text-fg-muted"
                    : m.autor === "staff"
                      ? "ml-8 rounded-sm border-l-2 border-accent bg-bg px-3 py-2"
                      : "mr-8 rounded-sm bg-bg px-3 py-2"
                }
              >
                {m.autor !== "sistema" ? (
                  <p className="text-xs text-fg-muted">
                    {m.autor === "staff" ? (m.atendente ?? "Equipe") : "Espectador"} · {hora(m.criada_em)}
                  </p>
                ) : null}
                {m.texto ? <p className="whitespace-pre-wrap break-words">{m.texto}</p> : null}
                {m.tem_anexo ? <p className="text-xs text-fg-muted">[comprovante]</p> : null}
              </li>
            ))}
          </ol>
          <div ref={fimDoChat} aria-hidden="true" />
        </div>

        {pendente && p.meu ? (
          <form onSubmit={(e) => void aoMandar(e)} className="flex flex-col gap-2 border-t border-line p-3">
            {respostas.length > 0 ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Respostas rápidas">
                {respostas.map((r) => (
                  <button key={r.id} type="button" className={`${botao} border-line px-2 py-1 text-xs`} onClick={() => setTexto(r.body)}>
                    {r.label}
                  </button>
                ))}
              </div>
            ) : null}
            <label htmlFor="msg-painel" className="sr-only">
              Mensagem para o espectador
            </label>
            <textarea
              id="msg-painel"
              rows={2}
              maxLength={1000}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Mensagem para o espectador (começa o prazo de 5 min)"
              className="block w-full resize-none border-0 border-b border-line bg-transparent py-2 outline-none focus:border-accent"
            />
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-fg-muted">{texto.length}/1000</span>
              <button type="submit" disabled={ocupado || !texto.trim()} className={`${botao} border-accent bg-accent font-medium text-accent-fg`}>
                Enviar
              </button>
            </div>
          </form>
        ) : (
          <p className="border-t border-line p-3 text-sm text-fg-muted">
            {pendente ? "Assuma o pedido para conversar." : "Pedido finalizado."}
          </p>
        )}
      </section>
    </article>
  );
}

function FormBanir({
  ocupado,
  aoEnviar,
  aoCancelar,
}: {
  ocupado: boolean;
  aoEnviar: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [tipo, setTipo] = useState("cpf");
  return (
    <form onSubmit={(e) => void aoEnviar(e)} className="flex flex-col gap-3 border border-line p-4" aria-label="Banir">
      <p className="text-xs text-fg-muted">
        O banimento usa o dado deste pedido; ninguém precisa digitar. Pedido pendente é recusado e o link dele para de funcionar.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted">O que banir</span>
        <select name="tipo" value={tipo} onChange={(e) => setTipo(e.target.value)} className="border border-line bg-bg px-2 py-2">
          {TIPOS_BAN.map(([v, r]) => (
            <option key={v} value={v}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted">Onde vale</span>
        <select name="escopo" defaultValue="global" className="border border-line bg-bg px-2 py-2">
          <option value="global">Todas as bancas</option>
          <option value="banca">Só esta banca</option>
        </select>
      </label>
      {tipo === "ip" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">Validade (horas, até 168)</span>
          <input name="horas" type="number" min={1} max={168} defaultValue={24} className="border-b border-line bg-transparent py-2 outline-none focus:border-accent" />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted">Motivo (aparece na lista de banidos)</span>
        <input name="motivo" required minLength={3} maxLength={280} className="border-b border-line bg-transparent py-2 outline-none focus:border-accent" />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={ocupado} className={`${botao} border-accent text-accent`}>
          Confirmar banimento
        </button>
        <button type="button" className={`${botao} border-line`} onClick={aoCancelar}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
