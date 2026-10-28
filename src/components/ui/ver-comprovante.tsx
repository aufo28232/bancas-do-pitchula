"use client";

import { useState } from "react";
import { enviar } from "@/lib/client/api";

/**
 * Comprovante no chat: nada é carregado até a pessoa pedir. O servidor confere o
 * direito, gera uma URL assinada de 60 s e (no painel) registra na auditoria.
 */
export function VerComprovante({ url, corpo, rotulo = "Ver comprovante" }: { url: string; corpo: Record<string, string>; rotulo?: string }) {
  const [src, setSrc] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  async function abrir() {
    setCarregando(true);
    setErro("");
    const r = await enviar<{ url: string }>(url, corpo);
    setCarregando(false);
    if (r.ok) setSrc(r.dados.url);
    else setErro(r.erro);
  }

  if (src) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element -- URL assinada e temporária do Storage */}
        <img src={src} alt="Comprovante enviado" className="mt-1 max-h-72 w-auto rounded-sm border border-line" data-comprovante="" />
      </a>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-fg-muted">[comprovante]</span>
      <button
        type="button"
        onClick={() => void abrir()}
        disabled={carregando}
        className="rounded-sm border border-line px-2 py-0.5 hover:border-fg-muted disabled:opacity-60"
      >
        {carregando ? "Abrindo…" : rotulo}
      </button>
      {erro ? (
        <span role="alert" className="text-accent">
          {erro}
        </span>
      ) : null}
    </span>
  );
}
