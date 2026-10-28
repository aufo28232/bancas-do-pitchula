import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FormMfaCadastrar, FormMfaVerificar } from "@/components/painel/form-mfa";
import { fatoresDoUsuario } from "@/lib/server/gotrue";
import { tokenAtual } from "@/lib/server/painel/rsc";
import { lerClaims, preAutenticado } from "@/lib/server/sessao-staff";

export const metadata: Metadata = { title: "Verificação em duas etapas" };

export default async function PaginaMfa() {
  const token = await tokenAtual();
  if (!token) redirect("/painel/entrar");
  if (lerClaims(token)?.aal === "aal2") redirect("/painel");

  const pre = await preAutenticado(token);
  if (!pre) redirect("/painel/entrar");

  const fatores = (await fatoresDoUsuario(token)) ?? [];
  const verificado = fatores.find((f) => f.factor_type === "totp" && f.status === "verified");

  return (
    <>
      <h1 className="mb-3 font-display text-5xl font-black uppercase leading-none">
        {verificado ? "Código" : "Autenticador"}
      </h1>
      <p className="mb-8 text-fg-muted">
        {verificado
          ? `Oi, ${pre.displayName}. Digite o código do seu app autenticador.`
          : `Oi, ${pre.displayName}. Antes de entrar, cadastre um app autenticador.`}
      </p>
      {verificado ? <FormMfaVerificar fatorId={verificado.id} /> : <FormMfaCadastrar />}
    </>
  );
}
