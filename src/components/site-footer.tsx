import { site } from "@/config/site";

const linkProps = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Ícone genérico de tela com play (não é o logo da Twitch). */
function IconLive() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="13" rx="1" />
      <path d="M10 8.5v5l4-2.5z" fill="currentColor" stroke="none" />
      <path d="M8 21h8" />
    </svg>
  );
}

/** Ícone genérico de câmera (não é o logo do Instagram). */
function IconCamera() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="14" rx="1" />
      <circle cx="12" cy="13" r="3.5" />
      <path d="M8 6l1.5-2h5L16 6" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line pt-5 text-sm text-fg-muted">
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        <li>
          <a href={site.links.twitch} {...linkProps} className="inline-flex items-center gap-2 hover:text-fg">
            <IconLive />
            Twitch <span className="sr-only">(abre em nova aba)</span>
          </a>
        </li>
        <li>
          <a href={site.links.instagram} {...linkProps} className="inline-flex items-center gap-2 hover:text-fg">
            <IconCamera />
            Instagram <span className="sr-only">(abre em nova aba)</span>
          </a>
        </li>
      </ul>
      <p className="mt-4 max-w-md text-xs leading-relaxed">{site.avisoOficial}</p>
    </footer>
  );
}
