import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BotaoSair } from "@/components/painel/acoes";
import { destinoSemAcesso, staffAtual } from "@/lib/server/painel/rsc";

/**
 * Toda página aqui dentro exige staff AAL2 com sessão viva, conferido NO BANCO.
 * Esconder links não é controle de acesso: cada rota e cada função confere de novo.
 */
export default async function LayoutProtegido({ children }: { children: ReactNode }) {
  const staff = await staffAtual();
  if (!staff) redirect(await destinoSemAcesso());

  return (
    <div className="relative z-[1] mx-auto flex min-h-svh w-full max-w-5xl flex-col px-4 py-6 sm:px-8">
      <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <nav aria-label="Painel" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Link href="/painel" className="font-display text-lg font-extrabold uppercase tracking-wide">
            Painel
          </Link>
          <Link href="/painel/sessoes" className="text-fg-muted hover:text-fg">
            Sessões
          </Link>
          {staff.role === "owner" ? (
            <Link href="/painel/equipe" className="text-fg-muted hover:text-fg">
              Equipe
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-fg-muted">
            {staff.displayName} · {staff.role === "owner" ? "streamer" : "moderador"}
          </span>
          <BotaoSair />
        </div>
      </header>
      {children}
    </div>
  );
}
