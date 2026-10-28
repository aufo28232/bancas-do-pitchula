import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BotaoAcao } from "@/components/painel/acoes";
import { FormResposta } from "@/components/painel/form-resposta";
import { listarRespostas } from "@/lib/server/painel/atendimento";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Respostas rápidas" };

/** Respostas rápidas: todos usam no chat; só o streamer edita (a API confere de novo). */
export default async function PaginaRespostas() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  if (staff.role !== "owner") notFound();
  const respostas = await listarRespostas(staff);

  return (
    <section className="flex flex-col gap-8">
      <h1 className="font-display text-5xl font-black uppercase leading-none">Respostas rápidas</h1>
      <FormResposta />
      <ul className="divide-y divide-line border-y border-line">
        {respostas.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium">{r.label}</p>
              <p className="text-fg-muted">{r.body}</p>
            </div>
            <BotaoAcao url="/api/painel/respostas/remover" corpo={{ id: r.id }} rotulo="Remover" confirmar="Remover esta resposta?" />
          </li>
        ))}
      </ul>
    </section>
  );
}
