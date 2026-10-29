import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BotaoAcao } from "@/components/painel/acoes";
import { dataHora } from "@/lib/formato";
import { rpc } from "@/lib/server/postgrest";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Sessões" };

type Sessao = {
  session_id: string;
  display_name: string;
  created_at: string;
  last_seen_at: string;
  ua_summary: string | null;
  approx_location: string | null;
  atual: boolean;
};
type Alerta = { id: string; display_name: string; kind: string; created_at: string };

const TEXTO_ALERTA: Record<string, string> = {
  novo_dispositivo: "entrou de um dispositivo novo",
  encerramento_por_moderador: "· uma banca foi encerrada por um moderador (veja quem na auditoria)",
  banca_por_moderador: "· um moderador criou ou alterou uma banca (veja quem e o quê na auditoria)",
  retencao_falhou: "· a rotina de limpeza encontrou pedidos que deveriam ter sido apagados",
};

export default async function PaginaSessoes() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");

  const [sessoes, alertas] = await Promise.all([
    rpc<Sessao[]>("staff_list_sessions", {}, { token: staff.token }),
    staff.role === "owner" ? rpc<Alerta[]>("owner_list_alerts", {}, { token: staff.token }) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-12">
      {staff.role === "owner" && alertas.length > 0 ? (
        <section aria-labelledby="t-alertas" className="flex flex-col gap-4">
          <h2 id="t-alertas" className="font-display text-3xl font-black uppercase">Alertas</h2>
          <ul className="divide-y divide-line border-y border-line">
            {alertas.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <strong>{a.display_name}</strong> {TEXTO_ALERTA[a.kind] ?? "gerou um alerta"} · {dataHora(a.created_at)}
                </span>
                <BotaoAcao url="/api/painel/alertas/ciente" corpo={{ id: a.id }} rotulo="Fui eu / ciente" />
              </li>
            ))}
          </ul>
          <p className="text-sm text-fg-muted">Se não reconhecer o acesso, derrube a sessão abaixo e troque a senha.</p>
        </section>
      ) : null}

      <section aria-labelledby="t-sessoes" className="flex flex-col gap-4">
        <h2 id="t-sessoes" className="font-display text-3xl font-black uppercase">
          {staff.role === "owner" ? "Sessões ativas da equipe" : "Suas sessões ativas"}
        </h2>
        <ul className="divide-y divide-line border-y border-line">
          {sessoes.map((s) => (
            <li key={s.session_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex flex-col">
                <span>
                  {s.display_name} · {s.ua_summary ?? "dispositivo desconhecido"}
                  {s.approx_location ? ` · ${s.approx_location}` : ""}
                  {s.atual ? <strong className="ml-2 text-accent">esta sessão</strong> : null}
                </span>
                <span className="font-mono text-xs text-fg-muted">
                  desde {dataHora(s.created_at)} · última atividade {dataHora(s.last_seen_at)}
                </span>
              </span>
              <BotaoAcao
                url="/api/painel/sessoes/revogar"
                corpo={{ sessionId: s.session_id }}
                rotulo="Derrubar"
                variante="perigo"
                confirmar={s.atual ? "Isso desconecta você." : "Derrubar esta sessão?"}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
