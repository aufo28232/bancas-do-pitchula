import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BotaoAcao } from "@/components/painel/acoes";
import { dataHora } from "@/lib/formato";
import { listarBans } from "@/lib/server/painel/atendimento";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Banidos" };

const TIPO = { cpf: "CPF", pix: "Chave Pix", platform_id: "ID na plataforma", ip: "IP" } as const;

/** Lista de banidos: tipo, escopo, motivo e datas. O valor banido NUNCA aparece (só o HMAC existe). */
export default async function PaginaBanidos() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  const bans = await listarBans(staff);

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-5xl font-black uppercase leading-none">Banidos</h1>
      </div>
      {bans.length === 0 ? (
        <p className="text-fg-muted">Nenhum banimento ativo.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {bans.map((b) => (
            <li key={b.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1 text-sm">
                <p>
                  <strong>{TIPO[b.tipo]}</strong> · {b.escopo === "global" ? "todas as bancas" : `só na banca ${b.banca ?? "(apagada)"}`}
                  {b.revisao_vencida ? <span className="text-accent"> · revisão vencida</span> : null}
                </p>
                <p className="text-fg-muted">{b.motivo}</p>
                <p className="font-mono text-xs text-fg-muted">
                  por {b.autor ?? "?"} em {dataHora(b.criado_em)}
                  {b.expira_em ? ` · expira ${dataHora(b.expira_em)}` : ""}
                  {b.revisao_em ? ` · revisar até ${dataHora(b.revisao_em)}` : ""}
                </p>
              </div>
              {b.pode_desbanir ? (
                <BotaoAcao url="/api/painel/banidos/desbanir" corpo={{ id: b.id }} rotulo="Desbanir" confirmar="Desfazer este banimento?" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
