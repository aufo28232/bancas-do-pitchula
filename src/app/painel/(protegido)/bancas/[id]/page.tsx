import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormBanca } from "@/components/painel/form-banca";
import { getServerEnv } from "@/lib/env";
import { listarBancas } from "@/lib/server/painel/bancas-rsc";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Editar banca" };

export default async function EditarBanca({ params }: { params: Promise<{ id: string }> }) {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  if (staff.role !== "owner") notFound();
  const { id } = await params;
  const banca = (await listarBancas(staff.token)).find((b) => b.id === id && b.status !== "encerrada");
  if (!banca) notFound();
  return (
    <section className="flex flex-col gap-8">
      <h1 className="font-display text-5xl font-black uppercase leading-none">Editar banca</h1>
      <FormBanca
        banca={{
          id: banca.id,
          name: banca.name,
          total_cents: banca.total_cents,
          slots: banca.slots,
          ip_limit: banca.ip_limit,
          order_count: banca.order_count,
          version: banca.version,
        }}
        ipEnfraquecido={getServerEnv().DEPLOY_MODE === "managed"}
      />
    </section>
  );
}
