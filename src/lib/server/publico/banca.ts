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

export type EstadoInicio = { codigo: string | null; encerrada: boolean };

/**
 * Tela inicial (D-084, D-085): código da banca criada por último que ainda existe
 * e, sem banca, se alguma foi encerrada há menos de 30 min ("Bancas encerradas").
 * Supabase fora do ar = "Aguardando banca...".
 */
export async function estadoInicio(): Promise<EstadoInicio> {
  try {
    const r = await rpc<{ codigo?: unknown; encerrada?: unknown } | null>("public_home", {}, "servico");
    return {
      codigo: typeof r?.codigo === "string" ? r.codigo : null,
      encerrada: r?.encerrada === true,
    };
  } catch {
    return { codigo: null, encerrada: false };
  }
}
