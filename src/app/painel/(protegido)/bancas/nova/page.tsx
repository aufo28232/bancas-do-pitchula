import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormBanca } from "@/components/painel/form-banca";
import { getServerEnv } from "@/lib/env";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Nova banca" };

export default async function NovaBanca() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  if (staff.role !== "owner") notFound();
  return (
    <section className="flex flex-col gap-8">
      <h1 className="font-display text-5xl font-black uppercase leading-none">Nova banca</h1>
      <FormBanca ipEnfraquecido={getServerEnv().DEPLOY_MODE === "managed"} />
    </section>
  );
}
