import { randomBytes, timingSafeEqual } from "node:crypto";
import { lerCookies } from "./cookies";

/**
 * Proteção CSRF em TODA mutação (D-039, D-060), em três camadas:
 * 1. Origin precisa ser exatamente a origem do site (SITE_URL);
 *    Sec-Fetch-Site, quando presente, precisa ser "same-origin".
 * 2. Double submit: cookie __Host-bp_csrf (legível pelo JS do próprio site)
 *    igual ao header x-csrf-token. O prefixo __Host- impede que um subdomínio
 *    ou uma conexão sem TLS plante o cookie.
 * 3. Cookies de sessão com SameSite=Strict.
 */
export const CSRF_COOKIE = "__Host-bp_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function novoTokenCsrf(): string {
  return randomBytes(32).toString("base64url");
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type FalhaCsrf = "origem" | "fetch_site" | "token";

export function checarCsrf(req: Request, siteUrl: string): FalhaCsrf | null {
  const esperado = new URL(siteUrl).origin;
  const origem = req.headers.get("origin");
  if (!origem || origem !== esperado) return "origem";

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return "fetch_site";

  const doCookie = lerCookies(req.headers.get("cookie"))[CSRF_COOKIE];
  const doHeader = req.headers.get(CSRF_HEADER);
  if (!doCookie || !doHeader || doCookie.length < 32 || !iguais(doCookie, doHeader)) return "token";

  return null;
}
