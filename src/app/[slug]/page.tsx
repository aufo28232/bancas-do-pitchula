import type { Metadata } from "next";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { FormPedido } from "@/components/banca/form-pedido";
import { EstadoAoVivo } from "@/components/banca/estado-ao-vivo";
import { RetomarPedido } from "@/components/pedido/retomar-pedido";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";
import { formatarReais } from "@/lib/dinheiro";
import { getSecurityEnv, getServerEnv, getSupabaseEnv } from "@/lib/env";
import { codigoDoSlug } from "@/lib/server/codigo-banca";
import { bancaPublica } from "@/lib/server/publico/banca";
import { theme } from "@/theme/theme";

type Props = { params: Promise<{ slug: string }> };

/** Foto escolhida na criação da banca (D-089); banca antiga usa a padrão. */
function fotoDaBanca(f: "1win" | "chillbet" | null) {
  return f ? theme.fotosBanca[f] : theme.photo;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const codigo = codigoDoSlug((await params).slug);
  const banca = codigo ? await bancaPublica(codigo) : null;
  const foto = fotoDaBanca(banca?.foto ?? null);
  const titulo = banca ? `Banca do ${site.streamer} · ${banca.name}` : `Bancas do ${site.streamer}`;
  const descricao = banca
    ? `${formatarReais(banca.per_person_cents)} por pessoa. Site oficial.`
    : site.description;
  let base: URL | undefined;
  try {
    base = new URL(getSecurityEnv().SITE_URL);
  } catch {
    base = undefined;
  }
  return {
    title: { absolute: titulo },
    description: descricao,
    metadataBase: base,
    // O link circula na live; não precisa (nem deve) aparecer em buscadores.
    robots: { index: false, follow: false },
    openGraph: {
      title: titulo,
      description: descricao,
      type: "website",
      locale: "pt_BR",
      siteName: site.name,
      images: [{ url: foto.src, width: foto.width, height: foto.height, alt: foto.alt }],
    },
    twitter: { card: "summary_large_image", title: titulo, description: descricao, images: [foto.src] },
  };
}

const AVISO_STATUS = {
  fechada: { titulo: "Banca pausada", texto: "O streamer pausou esta banca. Fica de olho na live." },
  esgotada: { titulo: "Vagas esgotadas", texto: "Todas as vagas desta banca foram preenchidas." },
} as const;

export default async function PaginaBanca({ params }: Props) {
  const codigo = codigoDoSlug((await params).slug);
  if (!codigo) notFound();
  const banca = await bancaPublica(codigo);
  // Banca encerrada ou inexistente: o link deixou de existir (D-044).
  if (!banca) redirect("/");
  const foto = fotoDaBanca(banca.foto);

  // Casa e link da banca (D-086); banca antiga sem casa usa o padrão do ambiente.
  const env = getServerEnv();
  const casa = banca.platform_name ?? env.PLATFORM_NAME;
  const linkCadastro = banca.platform_name ? (banca.signup_url ?? "") : env.PLATFORM_SIGNUP_URL;
  const { TURNSTILE_SITE_KEY } = getSecurityEnv();
  // Chave PÚBLICA (anon): só abre o canal de leitura do estado da banca.
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getSupabaseEnv();

  return (
    <main className="relative z-[1] min-h-svh lg:grid lg:grid-cols-[45fr_55fr]">
      {/* Já fez pedido nesta banca neste navegador? Volta direto para ele. */}
      <RetomarPedido codigo={codigo} />
      {/* Foto: banner no celular, metade direita sangrando no desktop */}
      <div className="relative h-[40svh] w-full lg:sticky lg:top-0 lg:order-2 lg:h-svh">
        <Image
          src={foto.src}
          alt={foto.alt}
          fill
          priority
          sizes="(min-width: 1024px) 55vw, 100vw"
          className="object-cover object-foto"
        />
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/3 bg-linear-to-t from-bg to-transparent lg:hidden" />
        <div aria-hidden="true" className="absolute inset-y-0 left-0 hidden w-48 bg-linear-to-r from-bg to-transparent lg:block" />
      </div>

      <section
        aria-labelledby="nome-banca"
        className="relative -mt-24 px-4 pb-10 lg:order-1 lg:mt-0 lg:flex lg:min-h-svh lg:items-center lg:px-12 lg:py-16"
      >
        <div className="mx-auto w-full max-w-[420px] lg:mx-0">
          <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
            Banca do {site.streamer}
          </p>
          <h1 id="nome-banca" className="mt-2 text-xl font-medium">
            {banca.name}
          </h1>

          <p className="mt-4 font-display font-black leading-[0.82] tracking-tight">
            <span className="block text-[clamp(4.5rem,21vw,8.5rem)]">{formatarReais(banca.per_person_cents)}</span>
            <span className="mt-2 block text-base font-extrabold uppercase tracking-[0.2em] text-fg-muted">por pessoa</span>
          </p>

          <EstadoAoVivo
            codigo={codigo}
            statusInicial={banca.status}
            url={SUPABASE_URL}
            chavePublica={SUPABASE_ANON_KEY}
          />

          {banca.status === "aberta" ? (
            <div className="mt-10">
              {linkCadastro ? (
                <p className="mb-6 text-sm text-fg-muted">
                  <a
                    href={linkCadastro}
                    target="_blank"
                    rel="noopener noreferrer nofollow sponsored"
                    className="underline decoration-line underline-offset-4 hover:text-fg"
                  >
                    Ainda não tem conta na {casa}? Cadastre-se aqui
                    <span className="sr-only"> (abre em nova aba)</span>
                  </a>
                </p>
              ) : null}
              <FormPedido codigo={codigo} siteKey={TURNSTILE_SITE_KEY} plataforma={casa} />
            </div>
          ) : (
            <div role="status" className="mt-10 border-l-2 border-accent pl-4">
              <p className="font-display text-2xl font-black uppercase">{AVISO_STATUS[banca.status].titulo}</p>
              <p className="mt-1 text-fg-muted">{AVISO_STATUS[banca.status].texto}</p>
            </div>
          )}

          <SiteFooter />
        </div>
      </section>
    </main>
  );
}
