/**
 * Apoio aos testes de INTEGRAÇÃO (Vitest) contra o Supabase local e o Redis reais.
 */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect } from "vitest";
import { fatoresDoUsuario } from "@/lib/server/gotrue";
import { postEntrar, postMfaInscrever, postMfaVerificar } from "@/lib/server/painel/auth";
import { criarStreamer } from "@/lib/server/seed";
import { COOKIE_ACCESS, COOKIE_REFRESH } from "@/lib/server/sessao-staff";
import { ateProximoPeriodoTotp, totp } from "./util";

const OBRIGATORIAS = [
  "SITE_URL", "HMAC_KEYS", "HMAC_ACTIVE", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "DB_URL",
];

export function exigirAmbiente(extras: string[] = []): void {
  const faltando = [...OBRIGATORIAS, ...extras].filter((v) => !process.env[v]);
  if (faltando.length > 0) {
    throw new Error(`Teste de integração precisa do Supabase local e do Redis. Faltam: ${faltando.join(", ")}`);
  }
}

export const SITE = () => new URL(process.env.SITE_URL ?? "").origin;
export const TURNSTILE_TESTE = "XXXX.DUMMY.TOKEN.XXXX"; // token de teste da Cloudflare
export const ENDERECO_FECHADO = "http://127.0.0.1:9"; // nada escuta aqui: simula serviço fora do ar
export const CSRF = randomBytes(32).toString("base64url");

export type Handler = (req: Request) => Promise<Response>;

/** Simula um navegador: guarda cookies entre requisições e tem um IP próprio. */
export class Navegador {
  readonly cookies = new Map<string, string>([["__Host-bp_csrf", CSRF]]);
  constructor(
    readonly ip = `10.${randomBytes(1)[0] ?? 1}.${randomBytes(1)[0] ?? 1}.${((randomBytes(1)[0] ?? 0) % 250) + 1}`,
  ) {}

  get access(): string | undefined {
    return this.cookies.get(COOKIE_ACCESS);
  }
  get refresh(): string | undefined {
    return this.cookies.get(COOKIE_REFRESH);
  }

  async post(
    handler: Handler,
    corpo: unknown,
    extra: { origin?: string; semCsrf?: boolean; fetchSite?: string } = {},
  ): Promise<{ status: number; dados: Record<string, unknown> }> {
    const headers = new Headers({
      "content-type": "application/json",
      origin: extra.origin ?? SITE(),
      "sec-fetch-site": extra.fetchSite ?? "same-origin",
      "x-forwarded-for": this.ip,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0",
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    });
    if (!extra.semCsrf) headers.set("x-csrf-token", CSRF);
    const res = await handler(new Request(`${SITE()}/api/teste`, { method: "POST", headers, body: JSON.stringify(corpo) }));
    for (const c of res.headers.getSetCookie()) {
      const [par = "", ...atributos] = c.split("; ");
      const i = par.indexOf("=");
      const nome = par.slice(0, i);
      if (atributos.some((a) => a === "Max-Age=0")) this.cookies.delete(nome);
      else this.cookies.set(nome, decodeURIComponent(par.slice(i + 1)));
    }
    return { status: res.status, dados: (await res.json()) as Record<string, unknown> };
  }
}

export const senhaForte = () => `Teste-${randomBytes(15).toString("base64url")}`;
export const emailNovo = (p: string) => `${p}-${randomUUID().slice(0, 8)}@teste.local`;
export const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function conectarBanco() {
  return postgres(process.env.DB_URL ?? "", { max: 1, onnotice: () => undefined });
}

async function verificar(nav: Navegador, fatorId: string, segredo: string): Promise<number> {
  let r = await nav.post(postMfaVerificar, { fatorId, codigo: totp(segredo) });
  if (r.status === 400) {
    await esperar(ateProximoPeriodoTotp());
    r = await nav.post(postMfaVerificar, { fatorId, codigo: totp(segredo) });
  }
  return r.status;
}

/** Login + cadastro do autenticador. Devolve o segredo TOTP. */
export async function entrarCadastrandoMfa(nav: Navegador, email: string, senha: string): Promise<string> {
  const login = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
  expect(login.status).toBe(200);
  const inscricao = await nav.post(postMfaInscrever, {});
  expect(inscricao.status).toBe(200);
  const segredo = String(inscricao.dados.segredo);
  expect(await verificar(nav, String(inscricao.dados.fatorId), segredo)).toBe(200);
  return segredo;
}

/** Login + verificação com o autenticador já cadastrado. */
export async function entrarComMfa(nav: Navegador, email: string, senha: string, segredo: string): Promise<void> {
  const login = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
  expect(login.status).toBe(200);
  const fator = (await fatoresDoUsuario(nav.access ?? ""))?.find((f) => f.status === "verified");
  expect(fator).toBeDefined();
  expect(await verificar(nav, fator?.id ?? "", segredo)).toBe(200);
}

/** Desativa streamers anteriores e cria um novo, já logado com MFA. */
export async function novoStreamerLogado(sql: ReturnType<typeof conectarBanco>) {
  await sql`update app.staff set active = false, deactivated_at = now() where role = 'owner' and active`;
  const email = emailNovo("streamer");
  const senha = senhaForte();
  const id = await criarStreamer({ email, senha, apelido: "Pitchula" });
  const nav = new Navegador();
  const segredo = await entrarCadastrandoMfa(nav, email, senha);
  return { id, email, senha, segredo, nav };
}
