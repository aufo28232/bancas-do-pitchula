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
