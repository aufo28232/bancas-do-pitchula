import Link from "next/link";
import { redirect } from "next/navigation";
import { BotaoAcao } from "@/components/painel/acoes";
import { CopiarTexto } from "@/components/painel/copiar";
import { formatarReais } from "@/lib/dinheiro";
import { getSecurityEnv } from "@/lib/env";
import { listarBancas } from "@/lib/server/painel/bancas-rsc";
import { rpc } from "@/lib/server/postgrest";
import { staffAtual } from "@/lib/server/painel/rsc";

const ROTULO_STATUS = { aberta: "aberta", fechada: "pausada", esgotada: "esgotada", encerrada: "encerrada" } as const;

export default async function InicioPainel() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  const dono = staff.role === "owner";

  const [bancas, alertas] = await Promise.all([
    listarBancas(staff.token),
    dono ? rpc<unknown[]>("owner_list_alerts", {}, { token: staff.token }) : Promise.resolve([]),
  ]);
  const origem = new URL(getSecurityEnv().SITE_URL).origin;

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-5xl font-black uppercase leading-none">Bancas</h1>
        {/* Streamer e moderadores criam e gerenciam bancas (D-088). */}
        <Link href="/painel/bancas/nova" className="bg-accent px-4 py-2.5 font-display text-lg font-extrabold uppercase text-accent-fg">
          Nova banca
        </Link>
      </div>

      {alertas.length > 0 ? (
        <p role="status" className="border-l-2 border-accent pl-4">
          {alertas.length === 1 ? "1 alerta de segurança" : `${alertas.length} alertas de segurança`} para revisar.{" "}
          <Link href="/painel/sessoes" className="underline underline-offset-4">Ver alertas</Link>
        </p>
      ) : null}

      {dono && bancas.some((b) => b.status === "encerrada") ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          <span>{bancas.filter((b) => b.status === "encerrada").length} banca(s) encerrada(s) no histórico.</span>
          <BotaoAcao
            url="/api/painel/bancas/apagar-historico"
            corpo={{}}
            rotulo="Apagar histórico"
            variante="perigo"
            confirmar="Apagar da lista todas as bancas encerradas? Não dá para desfazer."
          />
        </div>
      ) : null}

      {bancas.length === 0 ? (
        <p className="text-fg-muted">Nenhuma banca ainda.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {bancas.map((b) => (
            <li key={b.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <p>
                  <strong>{b.name}</strong>{" "}
                  <span className={b.status === "aberta" ? "text-accent" : "text-fg-muted"}>· {ROTULO_STATUS[b.status]}</span>
                </p>
                <p className="font-mono text-sm text-fg-muted">
                  {formatarReais(b.per_person_cents)}/pessoa · {b.paid_count}/{b.slots} pagas · {b.pendentes} na fila
                  {b.remainder_cents > 0 ? ` · sobra ${formatarReais(b.remainder_cents)}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {b.status !== "encerrada" ? (
                  <Link
                    href={`/painel/bancas/${b.id}/atendimento`}
                    className="bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
                  >
                    Atender{b.pendentes > 0 ? ` (${b.pendentes})` : ""}
                  </Link>
                ) : null}
                {b.code ? <CopiarTexto texto={`${origem}/${b.code}-banca`} rotulo="Copiar link" /> : null}
                {b.status !== "encerrada" ? (
                  <>
                    <Link href={`/painel/bancas/${b.id}`} className="border border-line px-3 py-1.5 text-sm hover:border-fg-muted">
                      Editar
                    </Link>
                    {b.status === "aberta" ? (
                      <BotaoAcao url="/api/painel/bancas/status" corpo={{ id: b.id, acao: "fechar" }} rotulo="Pausar" />
                    ) : null}
                    {b.status === "fechada" ? (
                      <BotaoAcao url="/api/painel/bancas/status" corpo={{ id: b.id, acao: "reabrir" }} rotulo="Reabrir" />
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
