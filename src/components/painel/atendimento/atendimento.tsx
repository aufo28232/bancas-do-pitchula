"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ativarSom, bipe } from "@/lib/client/alerta";
import { enviar } from "@/lib/client/api";
import { TempoReal } from "@/lib/client/tempo-real";
import { formatarReais } from "@/lib/dinheiro";
import type { DetalhePedido, Fila, ItemFila, RespostaRapida } from "@/lib/server/painel/atendimento";
import { EncerrarBanca } from "../encerrar-banca";
import { Detalhe } from "./detalhe";
import { formatarRestante, useRelogio } from "./relogio";

type Props = {
  inicial: Fila;
  respostas: RespostaRapida[];
  dono: boolean;
};

type CredRealtime = { url: string; chavePublica: string; token: string; expiraEmSeg: number; topico: string };

/**
 * Tela de atendimento de uma banca: fila (só pendentes por padrão) + pedido aberto.
 * Atualiza pelo canal `staff:{banca}` (só ids e estados) e busca os dados no servidor,
 * que aplica o modo live. Sem tempo real, faz polling.
 */
export function Atendimento({ inicial, respostas, dono }: Props) {
  const router = useRouter();
  const bancaId = inicial.banca.id;
  const [fila, setFila] = useState(inicial);
  const [finalizados, setFinalizados] = useState(false);
  const [semComprovante, setSemComprovante] = useState(false);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<DetalhePedido | null>(null);
  const [erro, setErro] = useState("");
  const [conectado, setConectado] = useState(false);
  const [som, setSom] = useState(false);
  const [confirmarLive, setConfirmarLive] = useState(false);
  const agora = useRelogio();

  const idsConhecidos = useRef(new Set(inicial.pedidos.map((p) => p.id)));
  const selecionadoRef = useRef<string | null>(null);
  const meusRef = useRef(new Set<string>());

  const recarregarFila = useCallback(
    async (fin: boolean) => {
      const r = await enviar<Fila>("/api/painel/fila", { banca: bancaId, finalizados: fin });
      if (r.ok) {
        setFila(r.dados);
        meusRef.current = new Set(r.dados.pedidos.filter((p) => p.meu).map((p) => p.id));
        setErro("");
      } else if (r.status === 401) {
        router.replace("/painel/entrar");
      } else if (r.status === 404) {
        // Banca encerrada: some do painel.
        router.replace("/painel");
      } else {
        setErro(r.erro);
      }
    },
    [bancaId, router],
  );

  const recarregarDetalhe = useCallback(async () => {
    const id = selecionadoRef.current;
    if (!id) return;
    const r = await enviar<DetalhePedido>("/api/painel/pedidos/detalhe", { id });
    if (selecionadoRef.current !== id) return;
    if (r.ok) setDetalhe(r.dados);
    else if (r.status === 404) {
      setDetalhe(null);
      setSelecionado(null);
      selecionadoRef.current = null;
    }
  }, []);

  const finalizadosRef = useRef(finalizados);
  const atualizar = useCallback(async () => {
    await Promise.all([recarregarFila(finalizadosRef.current), recarregarDetalhe()]);
  }, [recarregarFila, recarregarDetalhe]);

  function abrir(id: string) {
    selecionadoRef.current = id;
    setSelecionado(id);
    setDetalhe(null);
    void recarregarDetalhe();
  }

  function fechar() {
    selecionadoRef.current = null;
    setSelecionado(null);
    setDetalhe(null);
  }

  function trocarAba(fin: boolean) {
    finalizadosRef.current = fin;
    setFinalizados(fin);
    void recarregarFila(fin);
  }

  // Tempo real: qualquer evento do canal da banca -> busca de novo (com intervalo mínimo).
  useEffect(() => {
    let rt: TempoReal | null = null;
    let ativo = true;
    let renovar: ReturnType<typeof setTimeout> | undefined;
    let agendado: ReturnType<typeof setTimeout> | undefined;

    const agendar = () => {
      if (agendado) return;
      agendado = setTimeout(() => {
        agendado = undefined;
        void atualizar();
      }, 250);
    };

    async function conectar() {
      const r = await enviar<CredRealtime>("/api/painel/realtime", { banca: bancaId });
      if (!ativo) return;
      if (!r.ok) {
        renovar = setTimeout(() => void conectar(), 30_000);
        return;
      }
      if (!rt) {
        rt = new TempoReal(r.dados.url, r.dados.chavePublica);
        await rt.definirToken(r.dados.token);
        rt.ouvir(
          r.dados.topico,
          {
            fila: (p) => {
              const id = typeof p.pedido === "string" ? p.pedido : "";
              // Pedido novo na fila: bipe para a equipe.
              if (id && p.status === "pendente" && !idsConhecidos.current.has(id)) {
                idsConhecidos.current.add(id);
                bipe(1);
              }
              agendar();
            },
            // Banca encerrada (aqui ou em outra aba): tudo foi apagado, volta para a lista.
            banca_encerrada: () => router.replace("/painel"),
            mensagem: (p) => {
              // Espectador respondeu num pedido que está comigo: bipe.
              if (p.autor === "espectador" && typeof p.pedido === "string" && meusRef.current.has(p.pedido)) bipe(2);
              agendar();
            },
          },
          setConectado,
        );
      } else {
        await rt.definirToken(r.dados.token);
      }
      renovar = setTimeout(() => void conectar(), Math.max(30, r.dados.expiraEmSeg - 60) * 1000);
    }

    void conectar();
    return () => {
      ativo = false;
      if (renovar) clearTimeout(renovar);
      if (agendado) clearTimeout(agendado);
      rt?.encerrar();
    };
  }, [bancaId, atualizar, router]);

  // Polling de reserva.
  useEffect(() => {
    const id = setInterval(() => void atualizar(), conectado ? 60_000 : 8_000);
    return () => clearInterval(id);
  }, [conectado, atualizar]);

  async function alternarLive() {
    if (fila.live && !confirmarLive) {
      setConfirmarLive(true);
      return;
    }
    setConfirmarLive(false);
    const r = await enviar("/api/painel/modo-live", { ligado: !fila.live });
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    router.refresh();
    await atualizar();
  }

  const b = fila.banca;
  const pedidos = semComprovante ? fila.pedidos.filter((p) => !p.tem_comprovante) : fila.pedidos;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-fg-muted">Atendimento</p>
            <h1 className="font-display text-4xl font-black uppercase leading-none">{b.nome}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => void alternarLive()}
              aria-pressed={fila.live}
              className={`rounded-sm border px-3 py-1.5 ${fila.live ? "border-accent text-accent" : "border-line text-fg"}`}
            >
              Modo live: {fila.live ? "ligado" : "desligado"}
            </button>
            {confirmarLive ? (
              <span className="flex items-center gap-2" role="alert">
                <span className="text-fg-muted">Os dados vão aparecer completos na tela.</span>
                <button type="button" onClick={() => void alternarLive()} className="rounded-sm border border-accent px-3 py-1.5 text-accent">
                  Desligar
                </button>
                <button type="button" onClick={() => setConfirmarLive(false)} className="rounded-sm border border-line px-3 py-1.5">
                  Cancelar
                </button>
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void ativarSom().then(setSom)}
              aria-pressed={som}
              className="rounded-sm border border-line px-3 py-1.5"
            >
              {som ? "Som ativado" : "Ativar som"}
            </button>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-y border-line py-3 text-sm sm:grid-cols-5">
          <Resumo rotulo="Por pessoa" valor={formatarReais(b.por_pessoa_cents)} />
          <Resumo rotulo="Vagas" valor={`${b.pagas}/${b.vagas} pagas`} />
          <Resumo rotulo="Recebidos" valor={String(b.recebidos)} />
          <Resumo rotulo="Recusados" valor={String(b.recusados)} />
          <Resumo rotulo="Total pago" valor={formatarReais(b.total_pago_cents)} />
        </dl>
        <EncerrarBanca id={b.id} nome={b.nome} />
        <p className="text-xs text-fg-muted" aria-live="polite">
          {conectado ? "Fila ao vivo." : "Reconectando… a fila continua se atualizando."}
          {b.status !== "aberta" ? ` Banca ${b.status === "fechada" ? "pausada" : b.status}.` : ""}
        </p>
        {erro ? (
          <p role="alert" className="text-sm text-accent">
            {erro}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <section aria-labelledby="t-fila" className={selecionado ? "hidden lg:block" : ""}>
          <h2 id="t-fila" className="sr-only">
            Fila
          </h2>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Filtro da fila">
            <AbaBotao ativo={!finalizados} onClick={() => trocarAba(false)}>
              Pendentes
            </AbaBotao>
            <AbaBotao ativo={finalizados} onClick={() => trocarAba(true)}>
              Finalizados
            </AbaBotao>
            {!finalizados ? (
              <label className="ml-auto flex items-center gap-2 text-fg-muted">
                <input type="checkbox" checked={semComprovante} onChange={(e) => setSemComprovante(e.target.checked)} className="accent-accent" />
                Sem comprovante
              </label>
            ) : null}
          </div>

          {pedidos.length === 0 ? (
            <p className="border border-line p-4 text-sm text-fg-muted">
              {finalizados ? "Nenhum pedido finalizado ainda." : "Nenhum pedido na fila."}
            </p>
          ) : (
            <ul className="divide-y divide-line border border-line" data-fila="">
              {pedidos.map((p) => (
                <ItemDaFila key={p.id} p={p} agora={agora} ativo={p.id === selecionado} aoAbrir={() => abrir(p.id)} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Pedido aberto" className={selecionado ? "" : "hidden lg:block"}>
          {selecionado ? (
            <Detalhe
              key={selecionado}
              detalhe={detalhe}
              respostas={respostas}
              dono={dono}
              agora={agora}
              aoVoltar={fechar}
              aoMudar={atualizar}
            />
          ) : (
            <p className="border border-line p-6 text-sm text-fg-muted">Escolha um pedido na fila.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Resumo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.15em] text-fg-muted">{rotulo}</dt>
      <dd className="font-mono">{valor}</dd>
    </div>
  );
}

function AbaBotao({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={`rounded-sm border px-3 py-1.5 ${ativo ? "border-fg text-fg" : "border-line text-fg-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

const ROTULO_STATUS = { pendente: "pendente", pago: "pago", recusado: "recusado" } as const;

function ItemDaFila({ p, agora, ativo, aoAbrir }: { p: ItemFila; agora: number; ativo: boolean; aoAbrir: () => void }) {
  const restante = p.prazo && agora > 0 ? (new Date(p.prazo).getTime() - agora) / 1000 : null;
  const aguardando = p.status === "pendente" && p.ultima_autor === "espectador";
  return (
    <li>
      <button
        type="button"
        onClick={aoAbrir}
        aria-current={ativo || undefined}
        className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface ${ativo ? "bg-surface" : ""}`}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium">
            {p.posicao ? <span className="mr-2 font-mono text-fg-muted">{p.posicao}º</span> : null}
            <span data-nome-fila="">{p.nome}</span>
          </span>
          {restante !== null ? (
            <span className="font-mono text-sm text-accent" aria-label={`Prazo do espectador: ${formatarRestante(restante)}`}>
              {formatarRestante(restante)}
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
          {p.status !== "pendente" ? <span>{ROTULO_STATUS[p.status]}</span> : null}
          {p.meu ? <span className="text-accent">com você</span> : p.atendente ? <span>com {p.atendente}</span> : null}
          {aguardando ? <span className="text-fg">respondeu</span> : null}
          {p.status === "pendente" && !p.tem_comprovante ? <span>sem comprovante</span> : null}
        </span>
      </button>
    </li>
  );
}
