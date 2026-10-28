import { RetomarPedido } from "@/components/pedido/retomar-pedido";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";

/** Tela inicial: "Aguardando banca..." (DECISIONS D-044, D-047). */
export default function Home() {
  return (
    <main className="relative z-[1] mx-auto flex min-h-svh max-w-6xl flex-col justify-between px-4 py-8 sm:px-12 sm:py-12">
      <RetomarPedido />
      <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
        Banca do {site.streamer}
      </p>

      <section aria-labelledby="titulo" className="my-16">
        <h1
          id="titulo"
          className="font-display text-[clamp(3.5rem,15vw,10rem)] font-black uppercase leading-[0.85] tracking-tight"
        >
          Aguardando
          <br />
          banca
          <span className="espera-pontos text-accent" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </h1>
        <p className="mt-6 max-w-md text-base text-fg-muted">
          Fica de olho na live. Quando a banca abrir, o link aparece lá.
        </p>
        <div className="espera-varredura mt-10 max-w-md text-accent" aria-hidden="true" />
      </section>

      <SiteFooter />
    </main>
  );
}
