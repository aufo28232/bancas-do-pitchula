import { createPublicKey, verify } from "node:crypto";

/**
 * Cloudflare Access no /painel (ARCHITECTURE §11, opcional).
 * Com CF_ACCESS_TEAM_DOMAIN e CF_ACCESS_AUD preenchidos, toda requisição do painel
 * precisa trazer o JWT do Access (`Cf-Access-Jwt-Assertion`) válido: assinatura
 * RS256 com as chaves públicas da sua equipe, `aud` certo, emissor certo e dentro
 * da validade. Assim o Access vale mesmo se alguém chegar direto na origem
 * (modo "managed"). Falha ao buscar as chaves = NEGA (falha fechada).
 * Sem as variáveis, a checagem fica desligada (o login + MFA continuam valendo).
 */
type Jwk = Record<string, unknown> & { kid?: string; kty?: string };
type Jwks = { keys: Jwk[] };
export type ConfigAccess = { equipe: string; aud: string };

export function configAccess(env: Record<string, string | undefined> = process.env): ConfigAccess | null {
  const bruto = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.CF_ACCESS_AUD ?? "").trim();
  if (!bruto || !aud) return null;
  const equipe = bruto.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(equipe)) return null;
  return { equipe: equipe.toLowerCase(), aud };
}

const b64url = (s: string) => Buffer.from(s, "base64url");

function jsonDe(parte: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(b64url(parte).toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verificação pura (testável): não faz rede. */
export function verificarJwtAccess(
  jwt: string,
  opcoes: { jwks: Jwks; aud: string; emissor: string; agoraSeg?: number },
): boolean {
  const partes = jwt.split(".");
  if (partes.length !== 3) return false;
  const [h, p, s] = partes as [string, string, string];
  const cab = jsonDe(h);
  const corpo = jsonDe(p);
  if (!cab || !corpo || cab.alg !== "RS256" || typeof cab.kid !== "string") return false;

  const jwk = opcoes.jwks.keys.find((k) => k.kid === cab.kid && (k.kty === "RSA"));
  if (!jwk) return false;
  let ok = false;
  try {
    const chave = createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]);
    ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), chave, b64url(s));
  } catch {
    return false;
  }
  if (!ok) return false;

  const agora = opcoes.agoraSeg ?? Math.floor(Date.now() / 1000);
  const auds = Array.isArray(corpo.aud) ? corpo.aud : [corpo.aud];
  if (!auds.includes(opcoes.aud)) return false;
  if (corpo.iss !== opcoes.emissor) return false;
  if (typeof corpo.exp !== "number" || corpo.exp < agora - 30) return false;
  if (typeof corpo.nbf === "number" && corpo.nbf > agora + 30) return false;
  return true;
}

let cache: { equipe: string; jwks: Jwks; ate: number } | null = null;

async function chaves(equipe: string): Promise<Jwks | null> {
  if (cache && cache.equipe === equipe && cache.ate > Date.now()) return cache.jwks;
  try {
    const r = await fetch(`https://${equipe}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<Jwks>;
    if (!Array.isArray(d.keys)) return null;
    cache = { equipe, jwks: { keys: d.keys }, ate: Date.now() + 3600_000 };
    return cache.jwks;
  } catch {
    return null;
  }
}

/** true = pode seguir (Access desligado ou JWT válido). */
export async function accessPermite(jwt: string | null): Promise<boolean> {
  const cfg = configAccess();
  if (!cfg) return true;
  if (!jwt) return false;
  const jwks = await chaves(cfg.equipe);
  if (!jwks) return false;
  return verificarJwtAccess(jwt, { jwks, aud: cfg.aud, emissor: `https://${cfg.equipe}` });
}
