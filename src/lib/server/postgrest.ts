import { getSupabaseEnv } from "@/lib/env";
import { DependencyUnavailableError } from "./errors";

/**
 * Chamada de função no schema `api` via PostgREST (D-002, D-056).
 * - { token }: JWT do usuário -> RLS e as checagens da função usam a identidade real.
 * - "servico": service role -> só para funções api.srv_* (que conferem tudo por dentro).
 */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`rpc ${code}`);
    this.name = "RpcError";
  }

  httpStatus(): number {
    if (this.code === "42501") return 403;
    if (this.code === "P0002") return 404;
    if (this.code === "23505") return 409;
    if (["22023", "23514", "22P02", "23502"].includes(this.code)) return 400;
    if (this.code.startsWith("PGRST3") || this.status === 401) return 401;
    return this.status >= 400 && this.status < 500 ? this.status : 500;
  }
}

export type Credencial = { token: string } | "servico";

function cabecalhos(cred: Credencial): Record<string, string> {
  const env = getSupabaseEnv();
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Profile": "api",
    "Accept-Profile": "api",
  };
  if (cred === "servico") {
    h.apikey = env.SUPABASE_SERVICE_ROLE_KEY;
    // Chaves novas (sb_secret_...) não são JWT: vão só no header apikey.
    if (!env.SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_")) h.Authorization = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
  } else {
    h.apikey = env.SUPABASE_ANON_KEY;
    h.Authorization = `Bearer ${cred.token}`;
  }
  return h;
}

export async function rpc<T>(funcao: string, args: Record<string, unknown>, cred: Credencial): Promise<T> {
  if (!/^[a-z_]+$/.test(funcao)) throw new Error("nome de função inválido");
  const env = getSupabaseEnv();
  let resposta: Response;
  try {
    resposta = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${funcao}`, {
      method: "POST",
      headers: cabecalhos(cred),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    throw new DependencyUnavailableError("supabase");
  }
  if (resposta.status >= 500 && resposta.status !== 500) throw new DependencyUnavailableError("supabase");

  const texto = await resposta.text();
  if (!resposta.ok) {
    let code = String(resposta.status);
    try {
      const dados = JSON.parse(texto) as { code?: unknown };
      if (typeof dados.code === "string") code = dados.code;
    } catch {
      // corpo não-JSON: mantém o status como código
    }
    throw new RpcError(code, resposta.status);
  }
  return (texto ? JSON.parse(texto) : null) as T;
}
