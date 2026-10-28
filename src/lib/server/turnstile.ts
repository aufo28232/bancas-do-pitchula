import { getSecurityEnv } from "@/lib/env";
import { DependencyUnavailableError } from "./errors";

/**
 * Verificação do Cloudflare Turnstile NO SERVIDOR (siteverify).
 * - token inválido/expirado/reusado -> false
 * - Cloudflare fora do ar/timeout   -> DependencyUnavailableError (falha fechada)
 *
 * Observação (D-054): no LOGIN quem verifica o token é o próprio Supabase Auth
 * (captcha nativo). Os tokens do Turnstile são de uso único, então não podem ser
 * verificados duas vezes.
 */
export async function verificarTurnstile(token: string, ip?: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const env = getSecurityEnv();
  const corpo = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip && ip !== "desconhecido" && !ip.includes("/")) corpo.set("remoteip", ip);

  let resposta: Response;
  try {
    resposta = await fetch(env.TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: corpo,
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
  } catch {
    throw new DependencyUnavailableError("turnstile");
  }
  if (resposta.status >= 500) throw new DependencyUnavailableError("turnstile");

  try {
    const dados = (await resposta.json()) as { success?: unknown };
    return dados.success === true;
  } catch {
    throw new DependencyUnavailableError("turnstile");
  }
}
