import { cookies } from "next/headers";
import { cache } from "react";
import { COOKIE_ACCESS, contextoPorToken, lerClaims, type ContextoStaff } from "../sessao-staff";

/**
 * Helpers para Server Components do painel (leem cookies via next/headers).
 * `cache` evita consultar o banco duas vezes na mesma renderização.
 */
export const tokenAtual = cache(async (): Promise<string | undefined> => {
  return (await cookies()).get(COOKIE_ACCESS)?.value;
});

export const staffAtual = cache(async (): Promise<ContextoStaff | null> => {
  const token = await tokenAtual();
  return token ? contextoPorToken(token) : null;
});

/** Para onde mandar quem não tem contexto de staff: MFA (se só falta o 2º fator) ou login. */
export async function destinoSemAcesso(): Promise<"/painel/mfa" | "/painel/entrar"> {
  const token = await tokenAtual();
  return lerClaims(token)?.aal === "aal1" ? "/painel/mfa" : "/painel/entrar";
}
