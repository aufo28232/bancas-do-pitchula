import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Atendimento } from "@/components/painel/atendimento/atendimento";
import { HttpError } from "@/lib/server/errors";
import { carregarFila, listarRespostas } from "@/lib/server/painel/atendimento";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Atendimento" };

export default async function PaginaAtendimento({ params }: { params: Promise<{ id: string }> }) {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();

  const dados = await Promise.all([carregarFila(staff, id, false), listarRespostas(staff)]).catch((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  });
  if (!dados) notFound();
  const [fila, respostas] = dados;
  return <Atendimento inicial={fila} respostas={respostas} dono={staff.role === "owner"} />;
}
