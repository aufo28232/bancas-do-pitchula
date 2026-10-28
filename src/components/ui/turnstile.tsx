"use client";

import { useEffect, useRef } from "react";

type OpcoesRender = {
  sitekey: string;
  action?: string;
  theme?: "dark" | "light" | "auto";
  language?: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
};

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opcoes: OpcoesRender) => string;
      remove: (id: string) => void;
    };
  }
}

let carregamento: Promise<void> | null = null;

/** Carrega o script do Turnstile uma vez. A CSP libera via 'strict-dynamic' (script inserido por script com nonce). */
function carregarScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  carregamento ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      carregamento = null;
      reject(new Error("turnstile"));
    };
    document.head.appendChild(s);
  });
  return carregamento;
}

/**
 * Widget do Cloudflare Turnstile. O token é verificado NO SERVIDOR.
 * Para gerar um token novo depois de um envio que falhou, mude a `key` do componente.
 */
export function Turnstile({ siteKey, acao, aoMudar }: { siteKey: string; acao: string; aoMudar: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(aoMudar);
  useEffect(() => {
    callback.current = aoMudar;
  });

  useEffect(() => {
    let id: string | undefined;
    let cancelado = false;
    carregarScript()
      .then(() => {
        if (cancelado || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          action: acao,
          theme: "dark",
          language: "pt-br",
          callback: (t) => callback.current(t),
          "expired-callback": () => callback.current(""),
          "error-callback": () => callback.current(""),
        });
      })
      .catch(() => callback.current(""));
    return () => {
      cancelado = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, acao]);

  return <div ref={ref} data-turnstile="" className="min-h-[65px]" />;
}
