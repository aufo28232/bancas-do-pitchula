import { randomBytes } from "node:crypto";
import { apagarCookie, lerCookies, serializarCookie } from "./cookies";
import { HttpError, MSG } from "./errors";
import type { Tokens } from "./gotrue";
import { RpcError, rpc } from "./postgrest";

/**
 * Sessão do staff em cookies httpOnly + Secure + SameSite=Strict + __Host- (D-027, D-057).
 * O refresh token NUNCA chega ao JavaScript da página. A renovação acontece no
 * servidor (proxy.ts), e o navegador só recebe o access token curto quando
 * precisar do Realtime (Etapa 4).
 */
export const COOKIE_ACCESS = "__Host-bp_at";
export const COOKIE_REFRESH = "__Host-bp_rt";
export const COOKIE_DISPOSITIVO = "__Host-bp_dev";

/** Inatividade máxima (enunciado §5); o banco confere de novo em current_staff_role(). */
export const INATIVIDADE_SEG = 8 * 3600;

export function cookiesDeSessao(t: Tokens): string[] {
  return [
    serializarCookie(COOKIE_ACCESS, t.access_token, { maxAge: Math.max(30, t.expires_in - 15) }),
    serializarCookie(COOKIE_REFRESH, t.refresh_token, { maxAge: INATIVIDADE_SEG }),
  ];
}

export function cookiesDeSaida(): string[] {
  return [apagarCookie(COOKIE_ACCESS), apagarCookie(COOKIE_REFRESH)];
}

export function lerSessao(req: Request): { access?: string; refresh?: string; dispositivo?: string } {
  const c = lerCookies(req.headers.get("cookie"));
  return { access: c[COOKIE_ACCESS], refresh: c[COOKIE_REFRESH], dispositivo: c[COOKIE_DISPOSITIVO] };
}

/**
 * Lê o payload do JWT SEM verificar a assinatura.
 * Usado só para (a) tokens recebidos agora do próprio Supabase Auth, pelo servidor,
 * e (b) decidir quando renovar / para qual tela redirecionar.
 * Toda AUTORIZAÇÃO acontece no banco, que verifica a assinatura (PostgREST).
 */
export type Claims = { sub?: string; session_id?: string; aal?: string; exp?: number; is_anonymous?: boolean };

export function lerClaims(jwt: string | undefined): Claims | null {
  if (!jwt) return null;
  const partes = jwt.split(".");
  if (partes.length !== 3 || !partes[1]) return null;
  try {
    const dados = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")) as unknown;
    return typeof dados === "object" && dados !== null ? (dados as Claims) : null;
  } catch {
    return null;
  }
}

/** true se o access token falta ou vence em menos de 60 s. */
export function precisaRenovar(access: string | undefined, agoraSeg = Math.floor(Date.now() / 1000)): boolean {
  const exp = lerClaims(access)?.exp;
  return typeof exp !== "number" || exp - agoraSeg < 60;
}

/** Cookie de dispositivo: id aleatório, longo, só para reconhecer dispositivos conhecidos. */
export function novoIdDispositivo(): string {
  return randomBytes(16).toString("base64url");
}

export function cookieDispositivo(id: string): string {
  return serializarCookie(COOKIE_DISPOSITIVO, id, { maxAge: 365 * 24 * 3600 });
}

/** Resumo curto do user-agent ("Chrome · Windows"), sem guardar o UA completo (D-037). */
export function resumoUserAgent(ua: string | null): string {
  if (!ua) return "desconhecido";
  const nav =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "Outro navegador";
  const so =
    /Windows/.test(ua) ? "Windows" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : "outro sistema";
  return `${nav} · ${so}`;
}

// ---------------------------------------------------------------------------
// Guardas das rotas do painel
// ---------------------------------------------------------------------------
export type ContextoStaff = {
  token: string;
  userId: string;
  role: "owner" | "moderator";
  displayName: string;
  sessionId: string;
  liveMode: boolean;
};

type LinhaWhoami = { user_id: string; role: "owner" | "moderator"; display_name: string; session_id: string; live_mode: boolean };

/**
 * Confere no BANCO: staff ativo + AAL2 + sessão viva + inatividade < 8h.
 * Também marca atividade. Qualquer falha -> 401 (o cliente volta para o login).
 */
export async function exigirStaff(req: Request, opcoes: { owner?: boolean } = {}): Promise<ContextoStaff> {
  const { access } = lerSessao(req);
  if (!access) throw new HttpError(401, MSG.sessao, "sem_sessao");
  const ctx = await contextoPorToken(access);
  if (!ctx) throw new HttpError(401, MSG.sessao, "sessao_invalida");
  if (opcoes.owner && ctx.role !== "owner") throw new HttpError(403, MSG.semPermissao, "nao_owner");
  return ctx;
}

export async function contextoPorToken(token: string): Promise<ContextoStaff | null> {
  try {
    const linhas = await rpc<LinhaWhoami[]>("staff_whoami", {}, { token });
    const l = linhas[0];
    if (!l) return null;
    return {
      token,
      userId: l.user_id,
      role: l.role,
      displayName: l.display_name,
      sessionId: l.session_id,
      liveMode: l.live_mode,
    };
  } catch (e) {
    if (e instanceof RpcError && [401, 403].includes(e.httpStatus())) return null;
    throw e;
  }
}

/** Staff ainda em AAL1 (tela de MFA). */
export async function preAutenticado(token: string): Promise<{ userId: string; displayName: string } | null> {
  try {
    const linhas = await rpc<{ user_id: string; display_name: string }[]>("preauth_whoami", {}, { token });
    const l = linhas[0];
    return l ? { userId: l.user_id, displayName: l.display_name } : null;
  } catch (e) {
    if (e instanceof RpcError && [401, 403].includes(e.httpStatus())) return null;
    throw e;
  }
}
