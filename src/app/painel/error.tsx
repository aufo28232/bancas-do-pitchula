"use client";

/** Erro inesperado no painel: mensagem genérica, sem detalhes internos. */
export default function ErroPainel({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="relative z-[1] mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-4">
      <h1 className="font-display text-4xl font-black uppercase">Algo deu errado</h1>
      <p className="text-fg-muted">Serviço temporariamente indisponível. Tente de novo em instantes.</p>
      <button type="button" onClick={reset} className="self-start border border-line px-4 py-2 hover:border-fg-muted">
        Tentar de novo
      </button>
    </main>
  );
}
