import type { Metadata } from "next";
import { PaginaPedido } from "@/components/pedido/pagina-pedido";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";
import { getSecurityEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: { absolute: `Seu pedido · Bancas do ${site.streamer}` },
  // Página pessoal: nunca indexar. O proxy também manda Referrer-Policy: no-referrer.
  robots: { index: false, follow: false },
};

/**
 * /pedido#<token>: acompanhamento do pedido pelo espectador (ARCHITECTURE §5.5).
 * O token vive só no fragmento (não chega ao servidor nem aos logs). A página
 * o troca por uma sessão em cookie httpOnly e apaga da barra de endereço.
 */
export default function Pedido() {
  const { TURNSTILE_SITE_KEY } = getSecurityEnv();
  return (
    <main className="relative z-[1] mx-auto flex min-h-svh max-w-6xl flex-col justify-between px-4 py-8 sm:px-12 sm:py-12">
      <div>
        <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
          Banca do {site.streamer}
        </p>
        <PaginaPedido siteKey={TURNSTILE_SITE_KEY} />
      </div>
      <SiteFooter />
    </main>
  );
}
