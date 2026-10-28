import type { ButtonHTMLAttributes } from "react";

type Props = { carregando?: boolean; variante?: "principal" | "secundario" | "perigo" } & ButtonHTMLAttributes<HTMLButtonElement>;

const estilos = {
  principal:
    "w-full bg-accent px-5 py-3.5 font-display text-lg font-extrabold uppercase tracking-wide text-accent-fg hover:brightness-110",
  secundario: "border border-line px-3 py-1.5 text-sm text-fg hover:border-fg-muted",
  perigo: "border border-line px-3 py-1.5 text-sm text-accent hover:border-accent",
} as const;

export function Botao({ carregando = false, variante = "principal", className, children, disabled, ...resto }: Props) {
  return (
    <button
      type="submit"
      disabled={disabled || carregando}
      aria-busy={carregando || undefined}
      className={`rounded-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ${estilos[variante]} ${className ?? ""}`}
      {...resto}
    >
      {carregando ? <span className="inline-block animate-pulse motion-reduce:animate-none">Aguarde…</span> : children}
    </button>
  );
}
