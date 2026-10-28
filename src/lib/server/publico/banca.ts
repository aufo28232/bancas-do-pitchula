import { cache } from "react";
import { rpc } from "../postgrest";

export type BancaPublica = {
  name: string;
  per_person_cents: number;
  slots: number;
  restantes: number;
  status: "aberta" | "fechada" | "esgotada";
};

/** Dados públicos da banca (só número de vagas, valor e estado). Encerrada = não existe. */
export const bancaPublica = cache(async (codigo: string): Promise<BancaPublica | null> => {
  const linhas = await rpc<BancaPublica[]>("public_get_banca", { p_code: codigo }, "servico");
  return linhas[0] ?? null;
});

/**
 * Código da banca criada por último que ainda existe (D-084): a tela inicial
 * abre direto nela. Supabase fora do ar = null (mostra "Aguardando banca...").
 */
export async function bancaAtual(): Promise<string | null> {
  try {
    const codigo = await rpc<unknown>("public_current_banca", {}, "servico");
    return typeof codigo === "string" ? codigo : null;
  } catch {
    return null;
  }
}
