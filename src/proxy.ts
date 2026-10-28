import { NextResponse, type NextRequest } from "next/server";
import { serializarCookie } from "@/lib/server/cookies";
import { CSRF_COOKIE, novoTokenCsrf } from "@/lib/server/csrf";
import { renovar } from "@/lib/server/gotrue";
import {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  cookiesDeSaida,
  cookiesDeSessao,
  precisaRenovar,
} from "@/lib/server/sessao-staff";

/**
 * Roda antes de toda página e rota (exceto arquivos estáticos):
 * 1. CSP com nonce novo a cada requisição (ARCHITECTURE §8).
 * 2. Cookie de CSRF (double submit) se ainda não existir.
 * 3. Renovação da sessão do staff NO SERVIDOR: o refresh token nunca vai para o JS.
 * 4. Referrer-Policy no-referrer nas páginas com token no fragmento.
 * Nenhuma decisão de AUTORIZAÇÃO acontece aqui: isso fica no banco e nas rotas.
 */
function politicaCsp(nonce: string, dev: boolean, supabaseUrl: string | undefined, siteHttps: boolean): string {
  let supabase = "";
  if (supabaseUrl) {
    try {
      const u = new URL(supabaseUrl);
      supabase = ` ${u.origin} ${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
    } catch {
      supabase = "";
    }
  }
  const diretivas = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${dev ? " 'unsafe-eval'" : ""}`,
    // Em dev o Next injeta <style> sem nonce (recarga a quente); em produção, só nonce.
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    // Atributos style (ex.: next/image) são liberados; <style> e <script> inline não (D-055).
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${supabase}${dev ? " ws:" : ""}`,
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  // Só faz sentido (e só funciona) quando o site é servido por HTTPS.
  if (!dev && siteHttps) diretivas.push("upgrade-insecure-requests");
  return diretivas.join("; ");
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const caminho = req.nextUrl.pathname;
  const dev = process.env.NODE_ENV !== "production";
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = politicaCsp(nonce, dev, process.env.SUPABASE_URL, (process.env.SITE_URL ?? "").startsWith("https://"));

  const cookies = new Map(req.cookies.getAll().map((c) => [c.name, c.value]));
  const setCookies: string[] = [];

  if (!cookies.get(CSRF_COOKIE)) {
    const token = novoTokenCsrf();
    cookies.set(CSRF_COOKIE, token);
    // Legível pelo JS do próprio site (é o "double submit"); __Host- impede plantio por subdomínio.
    setCookies.push(serializarCookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: "Strict" }));
  }

  const ehPainel = caminho === "/painel" || caminho.startsWith("/painel/") || caminho.startsWith("/api/painel/");
  if (ehPainel) {
    const access = cookies.get(COOKIE_ACCESS);
    const refresh = cookies.get(COOKIE_REFRESH);
    if (refresh && precisaRenovar(access)) {
      try {
        const tokens = await renovar(refresh);
        if (tokens) {
          setCookies.push(...cookiesDeSessao(tokens));
          cookies.set(COOKIE_ACCESS, tokens.access_token);
          cookies.set(COOKIE_REFRESH, tokens.refresh_token);
        } else {
          // Sessão revogada/expirada no Auth: limpa e deixa a página mandar para o login.
          setCookies.push(...cookiesDeSaida());
          cookies.delete(COOKIE_ACCESS);
          cookies.delete(COOKIE_REFRESH);
        }
      } catch {
        // Supabase fora do ar: segue sem renovar; a página mostra o erro amigável.
      }
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set(
    "Referrer-Policy",
    caminho === "/pedido" || caminho.startsWith("/painel/convite") ? "no-referrer" : "strict-origin",
  );
  if (ehPainel || caminho.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  for (const c of setCookies) res.headers.append("Set-Cookie", c);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pitchula.jpg|robots.txt).*)"],
};
