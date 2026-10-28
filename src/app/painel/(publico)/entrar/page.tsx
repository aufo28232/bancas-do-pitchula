import type { Metadata } from "next";
import { FormEntrar } from "@/components/painel/form-entrar";
import { getSecurityEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Entrar" };

export default function PaginaEntrar() {
  const { TURNSTILE_SITE_KEY } = getSecurityEnv();
  return (
    <>
      <h1 className="mb-8 font-display text-5xl font-black uppercase leading-none">Entrar</h1>
      <FormEntrar siteKey={TURNSTILE_SITE_KEY} />
    </>
  );
}
