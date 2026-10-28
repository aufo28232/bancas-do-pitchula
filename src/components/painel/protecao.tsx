"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Atalho de pânico (D-017): Alt+Q troca a tela inteira por uma tela neutra, sem
 * nenhum dado. O mesmo atalho (ou o botão) volta. O conteúdo fica montado, só
 * escondido, para não perder o que estava sendo digitado.
 */
export function ProtecaoPainel({ children }: { children: ReactNode }) {
  const [oculto, setOculto] = useState(false);

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "q" || e.key === "Q" || e.code === "KeyQ")) {
        e.preventDefault();
        setOculto((v) => !v);
      }
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, []);

  return (
    <>
      <div hidden={oculto} aria-hidden={oculto || undefined}>
        {children}
      </div>
      {oculto ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg" data-panico="">
          <p className="font-display text-3xl font-black uppercase text-fg-muted">Painel oculto</p>
          <button
            type="button"
            onClick={() => setOculto(false)}
            className="rounded-sm border border-line px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
          >
            Mostrar (Alt+Q)
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOculto(true)}
          className="fixed bottom-4 right-4 z-40 rounded-sm border border-line bg-bg px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
        >
          Ocultar painel (Alt+Q)
        </button>
      )}
    </>
  );
}
