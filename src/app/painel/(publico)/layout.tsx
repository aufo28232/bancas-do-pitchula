import type { ReactNode } from "react";
import { site } from "@/config/site";

/** Telas de acesso ao painel: coluna estreita, alinhada à esquerda. */
export default function LayoutAcesso({ children }: { children: ReactNode }) {
  return (
    <main className="relative z-[1] mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 py-12">
      <p className="mb-3 font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
        Painel · {site.streamer}
      </p>
      {children}
    </main>
  );
}
