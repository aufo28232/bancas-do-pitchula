import Link from "next/link";
import { redirect } from "next/navigation";
import { rpc } from "@/lib/server/postgrest";
import { staffAtual } from "@/lib/server/painel/rsc";

export default async function InicioPainel() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");

  const alertas =
    staff.role === "owner" ? await rpc<unknown[]>("owner_list_alerts", {}, { token: staff.token }) : [];

  return (
    <section className="flex flex-col gap-8">
      <h1 className="font-display text-5xl font-black uppercase leading-none">Oi, {staff.displayName}</h1>
      {alertas.length > 0 ? (
        <p role="status" className="border-l-2 border-accent pl-4">
          {alertas.length === 1 ? "1 alerta de segurança" : `${alertas.length} alertas de segurança`} para revisar.{" "}
          <Link href="/painel/sessoes" className="underline underline-offset-4">
            Ver alertas
          </Link>
        </p>
      ) : null}
      <p className="max-w-prose text-fg-muted">
        As bancas e a fila de atendimento aparecem aqui assim que estiverem disponíveis.
      </p>
    </section>
  );
}
