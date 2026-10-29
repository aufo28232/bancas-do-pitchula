import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { RetomarPedido } from "@/components/pedido/retomar-pedido";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";
import { estadoInicio } from "@/lib/server/publico/banca";
import { COOKIE_PEDIDO } from "@/lib/server/publico/espectador";

/**
 * Tela inicial (D-044, D-047, D-084, D-085). Com banca aberta (ou pausada/esgotada),
 * abre direto a criada por último. Quem tem pedido neste navegador vai antes
 * para o próprio pedido (D-082). Sem banca: "Bancas encerradas" por 30 min depois
 * de um encerramento; depois, "Aguardando banca...".
 */
export default async function Home() {
  const { codigo, encerrada } = await estadoInicio();
  const destino = codigo ? `/${codigo}-banca` : undefined;
  // Sem sessão de pedido: redireciona já no servidor (nem pisca a tela de espera).
  if (destino && !(await cookies()).has(COOKIE_PEDIDO)) redirect(destino);

  return (
    <main className="relative z-[1] mx-auto flex min-h-svh max-w-6xl flex-col justify-between px-4 py-8 sm:px-12 sm:py-12">
      <RetomarPedido senao={destino} />
      <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
        Banca do {site.streamer}
      </p>

      <section aria-labelledby="titulo" className="my-16">
        {encerrada ? (
          <>
            <h1
              id="titulo"
              className="font-display text-[clamp(3.5rem,15vw,10rem)] font-black uppercase leading-[0.85] tracking-tight"
            >
              Bancas
              <br />
              encerradas
            </h1>
            <p className="mt-6 max-w-md text-base text-fg-muted">Até a próxima! Fica de olho na live.</p>
          </>
        ) : (
          <>
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
              Fica de olho na live. Quando a banca abrir, ela aparece aqui: é só atualizar a página.
            </p>
            <div className="espera-varredura mt-10 max-w-md text-accent" aria-hidden="true" />
          </>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
