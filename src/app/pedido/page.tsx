import type { Metadata } from "next";
import { PaginaPedido } from "@/components/pedido/pagina-pedido";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: { absolute: `Seu pedido · Bancas do ${site.streamer}` },
  // Página pessoal: nunca indexar. O proxy também manda Referrer-Policy: no-referrer.
  robots: { index: false, follow: false },
};

/**
 * /pedido: acompanhamento do pedido pelo espectador (ARCHITECTURE §5.5).
 * O pedido vem da sessão em cookie httpOnly criada junto com ele (D-082):
 * não há link nem token para copiar, vazar na live ou mandar em print.
 */
export default function Pedido() {
  return (
    <main className="relative z-[1] mx-auto flex min-h-svh max-w-6xl flex-col justify-between px-4 py-8 sm:px-12 sm:py-12">
      <div>
        <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
          Banca do {site.streamer}
        </p>
        <PaginaPedido />
      </div>
      <SiteFooter />
    </main>
  );
}
