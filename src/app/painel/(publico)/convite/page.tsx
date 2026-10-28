import type { Metadata } from "next";
import { FormAceitarConvite } from "@/components/painel/form-aceitar-convite";
import { getSecurityEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Convite de moderador" };

export default function PaginaConvite() {
  const { TURNSTILE_SITE_KEY } = getSecurityEnv();
  return (
    <>
      <h1 className="mb-3 font-display text-5xl font-black uppercase leading-none">Convite</h1>
      <p className="mb-8 text-fg-muted">Crie sua conta de moderador. O link vale uma vez só.</p>
      <FormAceitarConvite siteKey={TURNSTILE_SITE_KEY} />
    </>
  );
}
