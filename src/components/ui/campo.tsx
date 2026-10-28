import type { InputHTMLAttributes } from "react";

type Props = { id: string; rotulo: string; erro?: string | undefined; dica?: string } & InputHTMLAttributes<HTMLInputElement>;

/** Campo com rótulo pequeno acima e só a linha inferior (identidade visual do site). */
export function Campo({ id, rotulo, erro, dica, className, ...resto }: Props) {
  const descricao = [erro ? `${id}-erro` : null, dica ? `${id}-dica` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-[0.18em] text-fg-muted">
        {rotulo}
      </label>
      <input
        id={id}
        aria-invalid={erro ? true : undefined}
        aria-describedby={descricao}
        className={`border-0 border-b border-line bg-transparent px-0 py-2 text-base text-fg outline-none transition-colors placeholder:text-fg-muted/60 focus:border-accent focus-visible:outline-none ${className ?? ""}`}
        {...resto}
      />
      {dica ? (
        <p id={`${id}-dica`} className="text-xs text-fg-muted">
          {dica}
        </p>
      ) : null}
      {erro ? (
        <p id={`${id}-erro`} className="text-sm text-accent">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
