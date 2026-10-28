import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BotaoAcao, FormCriarConvite } from "@/components/painel/acoes";
import { dataHora } from "@/lib/formato";
import { rpc } from "@/lib/server/postgrest";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Equipe" };

type Membro = { user_id: string; role: "owner" | "moderator"; display_name: string; active: boolean; sessoes_ativas: number };
type Convite = { id: string; display_name: string; created_at: string; expires_at: string; situacao: string };

export default async function PaginaEquipe() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  // Só o streamer. O banco também recusa (api.owner_*), isto só evita mostrar a página.
  if (staff.role !== "owner") notFound();

  const [equipe, convites] = await Promise.all([
    rpc<Membro[]>("owner_list_staff", {}, { token: staff.token }),
    rpc<Convite[]>("owner_list_invites", {}, { token: staff.token }),
  ]);
  const ativos = equipe.filter((m) => m.active);

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="t-equipe" className="flex flex-col gap-4">
        <h2 id="t-equipe" className="font-display text-3xl font-black uppercase">Equipe</h2>
        <ul className="divide-y divide-line border-y border-line">
          {ativos.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span>
                <strong>{m.display_name}</strong> · {m.role === "owner" ? "streamer" : "moderador"} ·{" "}
                <span className="text-fg-muted">{m.sessoes_ativas} sessão(ões) ativa(s)</span>
              </span>
              {m.role === "moderator" ? (
                <span className="flex flex-wrap gap-2">
                  <BotaoAcao
                    url="/api/painel/equipe/resetar-mfa"
                    corpo={{ userId: m.user_id }}
                    rotulo="Resetar MFA"
                    confirmar="Derruba as sessões e pede novo cadastro do autenticador."
                  />
                  <BotaoAcao
                    url="/api/painel/equipe/remover"
                    corpo={{ userId: m.user_id }}
                    rotulo="Remover"
                    variante="perigo"
                    confirmar="Remover este moderador agora?"
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="t-convites" className="flex flex-col gap-4">
        <h2 id="t-convites" className="font-display text-3xl font-black uppercase">Convidar moderador</h2>
        <FormCriarConvite />
        {convites.length > 0 ? (
          <ul className="divide-y divide-line border-y border-line">
            {convites.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  {c.display_name} · <span className="text-fg-muted">{c.situacao}</span>
                  <span className="ml-2 font-mono text-xs text-fg-muted">
                    criado {dataHora(c.created_at)} · expira {dataHora(c.expires_at)}
                  </span>
                </span>
                {c.situacao === "pendente" ? (
                  <BotaoAcao url="/api/painel/convites/revogar" corpo={{ id: c.id }} rotulo="Revogar" variante="perigo" />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
