import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dataHora } from "@/lib/formato";
import { listarAuditoria, verificarAuditoria } from "@/lib/server/painel/atendimento";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Auditoria" };

const PAPEL = { owner: "streamer", moderator: "moderador", sistema: "sistema" } as const;

/**
 * Auditoria (só o streamer): quem fez o quê e quando. Os registros não guardam
 * dados pessoais, e a cadeia de hash mostra se alguém mexeu no banco por fora (D-019).
 */
export default async function PaginaAuditoria({ searchParams }: { searchParams: Promise<{ antes?: string }> }) {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  if (staff.role !== "owner") notFound();
  const antesBruto = (await searchParams).antes;
  const antes = antesBruto && /^\d{1,15}$/.test(antesBruto) ? Number(antesBruto) : null;

  const [registros, verificacao] = await Promise.all([listarAuditoria(staff, antes), verificarAuditoria(staff)]);
  const ultimo = registros.at(-1);

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-5xl font-black uppercase leading-none">Auditoria</h1>
        <p role="status" className={`mt-3 text-sm ${verificacao.integra ? "text-fg-muted" : "text-accent"}`}>
          {verificacao.integra
            ? `Cadeia íntegra: ${verificacao.registros} registros conferidos, nenhuma alteração detectada.`
            : `ATENÇÃO: a cadeia de registros foi alterada a partir da posição ${verificacao.quebra_em}. Alguém mexeu no banco por fora do sistema.`}
        </p>
      </div>
      {registros.length === 0 ? (
        <p className="text-fg-muted">Nenhum registro.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-fg-muted">
              <tr>
                <th scope="col" className="py-2 pr-4">Quando</th>
                <th scope="col" className="py-2 pr-4">Quem</th>
                <th scope="col" className="py-2 pr-4">Ação</th>
                <th scope="col" className="py-2 pr-4">Banca / pedido</th>
                <th scope="col" className="py-2">Detalhe</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {registros.map((r) => (
                <tr key={r.pos}>
                  <td className="py-2 pr-4 font-mono text-xs">{dataHora(r.em)}</td>
                  <td className="py-2 pr-4">
                    {r.autor ?? PAPEL[r.papel]}
                    {r.autor ? <span className="text-fg-muted"> · {PAPEL[r.papel]}</span> : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.acao}</td>
                  <td className="py-2 pr-4">
                    {r.banca ?? "—"}
                    {r.pedido ? <span className="font-mono text-xs text-fg-muted"> #{r.pedido}</span> : null}
                  </td>
                  <td className="py-2 font-mono text-xs text-fg-muted">
                    {r.alvo ? `alvo: ${r.alvo} ` : ""}
                    {r.detalhe ? JSON.stringify(r.detalhe) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ultimo && registros.length === 100 ? (
        <Link href={`/painel/auditoria?antes=${ultimo.pos}`} className="self-start underline underline-offset-4">
          Registros mais antigos
        </Link>
      ) : null}
    </section>
  );
}
