"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Mantém a página da banca em dia (pausada, esgotada, encerrada) sem tempo real (D-091):
 * com centenas de pessoas na página, cada pagamento virava uma mensagem para cada uma,
 * e o plano grátis do Supabase aceita ~100 mensagens/s e 200 conexões. Aqui a página
 * só pergunta ao servidor a cada 30 s, e só com a aba visível. Banca encerrada: o
 * servidor já manda para o início (D-044).
 */
export function EstadoAoVivo() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
