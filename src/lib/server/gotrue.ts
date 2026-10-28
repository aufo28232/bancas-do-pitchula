import { getSupabaseEnv } from "@/lib/env";
import { DependencyUnavailableError } from "./errors";
import { rpc } from "./postgrest";

/**
 * Cliente mínimo da API REST do Supabase Auth (GoTrue), usado SÓ no servidor (D-056).
 * O navegador nunca fala com o Auth para login (enunciado §5).
 */
export type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export type Fator = { id: string; factor_type: string; status: "verified" | "unverified" | string };

type Metodo = "GET" | "POST" | "DELETE" | "PUT";

async function chamar(
  caminho: string,
  metodo: Metodo,
  opcoes: { token?: string; servico?: boolean; corpo?: unknown } = {},
): Promise<{ status: number; dados: unknown }> {
  const env = getSupabaseEnv();
  const chave = opcoes.servico ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  const headers: Record<string, string> = { apikey: chave, "Content-Type": "application/json" };
  if (opcoes.token) headers.Authorization = `Bearer ${opcoes.token}`;
  else if (opcoes.servico && !chave.startsWith("sb_")) headers.Authorization = `Bearer ${chave}`;

  let resposta: Response;
  try {
    resposta = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1${caminho}`, {
      method: metodo,
      headers,
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    throw new DependencyUnavailableError("supabase");
  }
  if (resposta.status >= 500) throw new DependencyUnavailableError("supabase");
  const texto = await resposta.text();
  let dados: unknown = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  return { status: resposta.status, dados };
}

function comoTokens(d: unknown): Tokens | null {
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  if (typeof o.access_token !== "string" || typeof o.refresh_token !== "string") return null;
  return {
    access_token: o.access_token,
    refresh_token: o.refresh_token,
    expires_in: typeof o.expires_in === "number" ? o.expires_in : 300,
  };
}

/** Login por senha. O token do Turnstile vai para o captcha nativo do Supabase (D-054). */
export async function entrarComSenha(email: string, senha: string, captcha: string): Promise<Tokens | null> {
  const r = await chamar("/token?grant_type=password", "POST", {
    corpo: { email, password: senha, gotrue_meta_security: { captcha_token: captcha } },
  });
  return r.status === 200 ? comoTokens(r.dados) : null;
}

/**
 * Login ANÔNIMO do espectador (D-003), feito pelo servidor. O token do Turnstile
 * vai para o captcha nativo do Supabase Auth. A conta anônima não acessa nenhuma
 * tabela; serve só para o Realtime autorizar o canal do próprio pedido.
 */
export async function entrarAnonimo(captcha: string): Promise<(Tokens & { userId: string }) | null> {
  const r = await chamar("/signup", "POST", { corpo: { data: {}, gotrue_meta_security: { captcha_token: captcha } } });
  if (r.status !== 200) return null;
  const tokens = comoTokens(r.dados);
  const userId = (r.dados as { user?: { id?: unknown } } | null)?.user?.id;
  return tokens && typeof userId === "string" ? { ...tokens, userId } : null;
}

export async function renovar(refreshToken: string): Promise<Tokens | null> {
  const r = await chamar("/token?grant_type=refresh_token", "POST", { corpo: { refresh_token: refreshToken } });
  return r.status === 200 ? comoTokens(r.dados) : null;
}

export async function sair(accessToken: string): Promise<void> {
  try {
    await chamar("/logout?scope=local", "POST", { token: accessToken });
  } catch {
    // Melhor esforço: a sessão também é revogada no banco.
  }
}

export async function fatoresDoUsuario(accessToken: string): Promise<Fator[] | null> {
  const r = await chamar("/user", "GET", { token: accessToken });
  if (r.status !== 200) return null;
  const fatores = (r.dados as { factors?: unknown } | null)?.factors;
  return Array.isArray(fatores) ? (fatores as Fator[]) : [];
}

export async function inscreverTotp(
  accessToken: string,
): Promise<{ id: string; qrCode: string; secret: string } | null> {
  const r = await chamar("/factors", "POST", {
    token: accessToken,
    corpo: { factor_type: "totp", friendly_name: `painel-${Date.now()}`, issuer: "Bancas do Pitchula" },
  });
  const d = r.dados as { id?: unknown; totp?: { qr_code?: unknown; secret?: unknown } } | null;
  if (r.status !== 200 || typeof d?.id !== "string" || typeof d.totp?.qr_code !== "string" || typeof d.totp.secret !== "string") {
    return null;
  }
  return { id: d.id, qrCode: d.totp.qr_code, secret: d.totp.secret };
}

export async function removerFatorProprio(accessToken: string, fatorId: string): Promise<boolean> {
  const r = await chamar(`/factors/${encodeURIComponent(fatorId)}`, "DELETE", { token: accessToken });
  return r.status === 200 || r.status === 204;
}

/** Desafio + verificação do TOTP. Sucesso devolve tokens novos já em AAL2. */
export async function verificarTotp(accessToken: string, fatorId: string, codigo: string): Promise<Tokens | null> {
  const f = encodeURIComponent(fatorId);
  const desafio = await chamar(`/factors/${f}/challenge`, "POST", { token: accessToken, corpo: {} });
  const desafioId = (desafio.dados as { id?: unknown } | null)?.id;
  if (desafio.status !== 200 || typeof desafioId !== "string") return null;
  const r = await chamar(`/factors/${f}/verify`, "POST", {
    token: accessToken,
    corpo: { challenge_id: desafioId, code: codigo },
  });
  return r.status === 200 ? comoTokens(r.dados) : null;
}

// --------------------------------------------------------------------------
// Admin (service role): só convites, seed e reset de MFA.
// --------------------------------------------------------------------------
/**
 * Cria conta pela API admin. Antes, autoriza o e-mail no banco: sem isso o
 * trigger que bloqueia cadastro público recusa a criação (D-048).
 */
export async function adminCriarUsuario(email: string, senha: string): Promise<{ id: string } | "conflito" | null> {
  await rpc("srv_allow_account", { p_email: email }, "servico");
  const r = await chamar("/admin/users", "POST", {
    servico: true,
    corpo: { email, password: senha, email_confirm: true },
  });
  const id = (r.dados as { id?: unknown } | null)?.id;
  if ((r.status === 200 || r.status === 201) && typeof id === "string") return { id };
  if (r.status === 422 || r.status === 409) return "conflito";
  return null;
}

/** true se a conta foi apagada ou já não existia. */
export async function adminApagarUsuario(userId: string): Promise<boolean> {
  const r = await chamar(`/admin/users/${encodeURIComponent(userId)}`, "DELETE", { servico: true });
  return r.status === 200 || r.status === 204 || r.status === 404;
}

export async function adminFatores(userId: string): Promise<Fator[] | null> {
  const r = await chamar(`/admin/users/${encodeURIComponent(userId)}`, "GET", { servico: true });
  if (r.status !== 200) return null;
  const fatores = (r.dados as { factors?: unknown } | null)?.factors;
  return Array.isArray(fatores) ? (fatores as Fator[]) : [];
}

export async function adminApagarFator(userId: string, fatorId: string): Promise<boolean> {
  const r = await chamar(
    `/admin/users/${encodeURIComponent(userId)}/factors/${encodeURIComponent(fatorId)}`,
    "DELETE",
    { servico: true },
  );
  return r.status === 200 || r.status === 204;
}
