import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BotaoSair } from "@/components/painel/acoes";
import { ProtecaoPainel } from "@/components/painel/protecao";
import { destinoSemAcesso, staffAtual } from "@/lib/server/painel/rsc";

/**
 * Toda página aqui dentro exige staff AAL2 com sessão viva, conferido NO BANCO.
 * Esconder links não é controle de acesso: cada rota e cada função confere de novo.
 */
export default async function LayoutProtegido({ children }: { children: ReactNode }) {
  const staff = await staffAtual();
  if (!staff) redirect(await destinoSemAcesso());

  return (
    <ProtecaoPainel>
      <div className="relative z-[1] mx-auto flex min-h-svh w-full max-w-6xl flex-col px-4 py-6 sm:px-8">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
          <nav aria-label="Painel" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <Link href="/painel" className="font-display text-lg font-extrabold uppercase tracking-wide">
              Painel
            </Link>
            <Link href="/painel" className="text-fg-muted hover:text-fg">
              Bancas
            </Link>
            <Link href="/painel/banidos" className="text-fg-muted hover:text-fg">
              Banidos
            </Link>
            <Link href="/painel/sessoes" className="text-fg-muted hover:text-fg">
              Sessões
            </Link>
            {staff.role === "owner" ? (
              <>
                <Link href="/painel/respostas" className="text-fg-muted hover:text-fg">
                  Respostas
                </Link>
                <Link href="/painel/equipe" className="text-fg-muted hover:text-fg">
                  Equipe
                </Link>
                <Link href="/painel/auditoria" className="text-fg-muted hover:text-fg">
                  Auditoria
                </Link>
                <Link href="/painel/diagnostico" className="text-fg-muted hover:text-fg">
                  Diagnóstico
                </Link>
              </>
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
    </ProtecaoPainel>
  );
}
