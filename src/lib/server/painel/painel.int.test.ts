/**
 * TESTE DE INTEGRAÇÃO da autenticação do painel (Etapa 2).
 * Roda contra o Supabase LOCAL de verdade (Auth, PostgREST, Postgres) e um
 * Redis de verdade (via proxy REST compatível com o Upstash). Nada é mockado.
 * Pré-requisitos (o CI configura): supabase start + Redis/SRH + variáveis do .env.example.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCriarUsuario, adminFatores, fatoresDoUsuario, renovar } from "../gotrue";
import { criarStreamer } from "../seed";
import { COOKIE_ACCESS, COOKIE_REFRESH, contextoPorToken, lerClaims } from "../sessao-staff";
import { postEntrar, postMfaInscrever, postMfaVerificar, postSair } from "./auth";
import { postAceitarConvite, postCriarConvite, postRevogarConvite } from "./convites";
import { postRemoverModerador, postResetarMfa, postRevogarSessao } from "./equipe";

const OBRIGATORIAS = [
  "SITE_URL", "HMAC_KEYS", "HMAC_ACTIVE", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "DB_URL",
];
const faltando = OBRIGATORIAS.filter((v) => !process.env[v]);
if (faltando.length > 0) {
  throw new Error(`Teste de integração precisa do Supabase local e do Redis. Faltam: ${faltando.join(", ")}`);
}

const SITE = new URL(process.env.SITE_URL ?? "").origin;
const TURNSTILE_TESTE = "XXXX.DUMMY.TOKEN.XXXX"; // token de teste da Cloudflare
const CSRF = randomBytes(32).toString("base64url");
const ENDERECO_FECHADO = "http://127.0.0.1:9"; // nada escuta aqui: simula serviço fora do ar

type Handler = (req: Request) => Promise<Response>;

/** Simula um navegador: guarda cookies entre requisições e tem um IP próprio. */
class Navegador {
  readonly cookies = new Map<string, string>([["__Host-bp_csrf", CSRF]]);
  constructor(readonly ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`) {}

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
      origin: extra.origin ?? SITE,
      "sec-fetch-site": extra.fetchSite ?? "same-origin",
      "x-forwarded-for": this.ip,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0",
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    });
    if (!extra.semCsrf) headers.set("x-csrf-token", CSRF);
    const res = await handler(new Request(`${SITE}/api/teste`, { method: "POST", headers, body: JSON.stringify(corpo) }));
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

// TOTP (RFC 6238), para fazer o papel do app autenticador.
function base32(s: string): Buffer {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alfabeto.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(segredo: string, quando = Date.now()): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(quando / 30_000)));
  const h = createHmac("sha1", base32(segredo)).update(contador).digest();
  const off = (h[h.length - 1] ?? 0) & 0xf;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const senhaForte = () => `Teste-${randomBytes(15).toString("base64url")}`;
const emailNovo = (p: string) => `${p}-${randomUUID().slice(0, 8)}@teste.local`;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Verifica o TOTP; se o código do período atual for recusado (já usado), espera o próximo período. */
async function verificar(nav: Navegador, fatorId: string, segredo: string): Promise<number> {
  let r = await nav.post(postMfaVerificar, { fatorId, codigo: totp(segredo) });
  if (r.status === 400) {
    await esperar(30_000 - (Date.now() % 30_000) + 1_000);
    r = await nav.post(postMfaVerificar, { fatorId, codigo: totp(segredo) });
  }
  return r.status;
}

/** Login + cadastro do autenticador (primeira vez). Devolve o segredo TOTP. */
async function entrarCadastrandoMfa(nav: Navegador, email: string, senha: string): Promise<string> {
  const login = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
  expect(login.status).toBe(200);
  const inscricao = await nav.post(postMfaInscrever, {});
  expect(inscricao.status).toBe(200);
  const segredo = String(inscricao.dados.segredo);
  expect(await verificar(nav, String(inscricao.dados.fatorId), segredo)).toBe(200);
  return segredo;
}

/** Login + verificação com o autenticador já cadastrado. */
async function entrarComMfa(nav: Navegador, email: string, senha: string, segredo: string): Promise<void> {
  const login = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
  expect(login.status).toBe(200);
  const fator = (await fatoresDoUsuario(nav.access ?? ""))?.find((f) => f.status === "verified");
  expect(fator).toBeDefined();
  expect(await verificar(nav, fator?.id ?? "", segredo)).toBe(200);
}

/** Aceita um convite e devolve o email/senha do moderador criado. */
async function criarModerador(dono: Navegador, apelido: string): Promise<{ email: string; senha: string; userId: string }> {
  const convite = await dono.post(postCriarConvite, { apelido });
  expect(convite.status).toBe(201);
  const token = String(convite.dados.link).split("#")[1];
  const email = emailNovo("mod");
  const senha = senhaForte();
  const aceite = await new Navegador().post(postAceitarConvite, { token, email, senha, apelido, turnstile: TURNSTILE_TESTE });
  expect(aceite.status).toBe(201);
  const [linha] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  return { email, senha, userId: linha?.id ?? "" };
}

const sql = postgres(process.env.DB_URL ?? "", { max: 1, onnotice: () => undefined });

const dono = { email: emailNovo("streamer"), senha: senhaForte(), id: "", segredo: "" };
const navDono = new Navegador();

beforeAll(async () => {
  // Estado limpo: só pode existir um streamer ativo.
  await sql`update app.staff set active = false, deactivated_at = now() where role = 'owner' and active`;
  dono.id = await criarStreamer({ email: dono.email, senha: dono.senha, apelido: "Pitchula" });
});

afterAll(async () => {
  await sql.end();
});

describe("login do painel", () => {
  it("recusa requisição sem token CSRF, de outra origem ou cross-site", async () => {
    const nav = new Navegador();
    const corpo = { email: dono.email, senha: dono.senha, turnstile: TURNSTILE_TESTE };
    expect((await nav.post(postEntrar, corpo, { semCsrf: true })).status).toBe(403);
    expect((await nav.post(postEntrar, corpo, { origin: "https://site-clonado.exemplo" })).status).toBe(403);
    expect((await nav.post(postEntrar, corpo, { fetchSite: "cross-site" })).status).toBe(403);
    expect(nav.access).toBeUndefined();
  });

  it("senha certa abre só AAL1: sem MFA o banco nega o painel", async () => {
    const nav = new Navegador();
    const r = await nav.post(postEntrar, { email: dono.email, senha: dono.senha, turnstile: TURNSTILE_TESTE });
    expect(r.status).toBe(200);
    expect(r.dados.proximo).toBe("/painel/mfa");
    expect(lerClaims(nav.access)?.aal).toBe("aal1");
    expect(await contextoPorToken(nav.access ?? "")).toBeNull();
  });

  it("MFA obrigatório: cadastro do TOTP sobe a sessão para AAL2 e libera o painel", async () => {
    dono.segredo = await entrarCadastrandoMfa(navDono, dono.email, dono.senha);
    expect(lerClaims(navDono.access)?.aal).toBe("aal2");
    const ctx = await contextoPorToken(navDono.access ?? "");
    expect(ctx?.role).toBe("owner");
    const [auditoria] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where action = 'login' and actor_id = ${dono.id}`;
    expect(auditoria?.n).toBeGreaterThanOrEqual(1);
  });

  it("refresh token fica só em cookie httpOnly", async () => {
    const nav = new Navegador();
    const corpo = { email: dono.email, senha: dono.senha, turnstile: TURNSTILE_TESTE };
    const headers = new Headers({
      "content-type": "application/json", origin: SITE, "sec-fetch-site": "same-origin",
      "x-forwarded-for": nav.ip, cookie: `__Host-bp_csrf=${CSRF}`, "x-csrf-token": CSRF,
    });
    const res = await postEntrar(new Request(`${SITE}/api/x`, { method: "POST", headers, body: JSON.stringify(corpo) }));
    const cookieRefresh = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_REFRESH}=`)) ?? "";
    expect(cookieRefresh).toContain("HttpOnly");
    expect(cookieRefresh).toContain("Secure");
    expect(cookieRefresh).toContain("SameSite=Strict");
    const corpoResposta = await res.text();
    expect(corpoResposta).not.toContain("refresh");
    expect(corpoResposta).not.toContain("access_token");
  });

  it("quem não é staff não entra, com a MESMA mensagem de senha errada", async () => {
    const email = emailNovo("curioso");
    const senha = senhaForte();
    const criado = await adminCriarUsuario(email, senha);
    expect(criado).not.toBe("conflito");
    const nav = new Navegador();
    const certo = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
    const errado = await new Navegador().post(postEntrar, { email, senha: "senha-errada-123", turnstile: TURNSTILE_TESTE });
    expect(certo.status).toBe(401);
    expect(certo.dados.erro).toBe(errado.dados.erro);
    expect(nav.access).toBeUndefined();
    const [s] = await sql<{ n: number }[]>`
      select count(*)::int as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = ${email}`;
    expect(s?.n).toBe(0);
  });

  it("bloqueio progressivo: 5 senhas erradas bloqueiam até a senha certa", async () => {
    const email = emailNovo("alvo");
    const senha = senhaForte();
    await adminCriarUsuario(email, senha);
    const nav = new Navegador();
    for (let i = 0; i < 5; i++) {
      expect((await nav.post(postEntrar, { email, senha: `errada-${i}-xxxxxxx`, turnstile: TURNSTILE_TESTE })).status).toBe(401);
    }
    const bloqueado = await nav.post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE });
    expect(bloqueado.status).toBe(429);
    // O bloqueio vale para a CONTA, mesmo vindo de outro IP.
    expect((await new Navegador().post(postEntrar, { email, senha, turnstile: TURNSTILE_TESTE })).status).toBe(429);
  });

  it("Redis fora do ar: login é BLOQUEADO (503) e nenhuma sessão é criada", async () => {
    const original = process.env.UPSTASH_REDIS_REST_URL;
    const [antes] = await sql<{ n: number }[]>`select count(*)::int as n from app.staff_sessions where user_id = ${dono.id}`;
    process.env.UPSTASH_REDIS_REST_URL = ENDERECO_FECHADO;
    try {
      const nav = new Navegador();
      const r = await nav.post(postEntrar, { email: dono.email, senha: dono.senha, turnstile: TURNSTILE_TESTE });
      expect(r.status).toBe(503);
      expect(nav.access).toBeUndefined();
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = original;
    }
    const [depois] = await sql<{ n: number }[]>`select count(*)::int as n from app.staff_sessions where user_id = ${dono.id}`;
    expect(depois?.n).toBe(antes?.n);
  });
});

describe("convites de moderador", () => {
  it("convite cria moderador; o mesmo link não funciona de novo", async () => {
    const convite = await navDono.post(postCriarConvite, { apelido: "Mod Teste" });
    expect(convite.status).toBe(201);
    const token = String(convite.dados.link).split("#")[1];
    const [salvo] = await sql<{ n: number }[]>`select count(*)::int as n from app.staff_invites where token_hash = sha256(convert_to(${token ?? ""}, 'UTF8'))`;
    expect(salvo?.n).toBe(1); // o banco guarda só o hash

    const email = emailNovo("mod");
    const ok = await new Navegador().post(postAceitarConvite, { token, email, senha: senhaForte(), apelido: "Mod Teste", turnstile: TURNSTILE_TESTE });
    expect(ok.status).toBe(201);

    const outroEmail = emailNovo("intruso");
    const reuso = await new Navegador().post(postAceitarConvite, { token, email: outroEmail, senha: senhaForte(), apelido: "Intruso", turnstile: TURNSTILE_TESTE });
    expect(reuso.status).toBe(400);
    const [conta] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users where email = ${outroEmail}`;
    expect(conta?.n).toBe(0);
  });

  it("convite expirado e convite revogado são recusados", async () => {
    const velho = randomBytes(32).toString("base64url");
    await sql`
      insert into app.staff_invites (token_hash, display_name, created_by, created_at, expires_at)
      values (sha256(convert_to(${velho}, 'UTF8')), 'Velho', ${dono.id}, now() - interval '25 hours', now() - interval '1 hour')`;
    const expirado = await new Navegador().post(postAceitarConvite, {
      token: velho, email: emailNovo("velho"), senha: senhaForte(), apelido: "Velho", turnstile: TURNSTILE_TESTE,
    });
    expect(expirado.status).toBe(400);

    const convite = await navDono.post(postCriarConvite, { apelido: "Revogado" });
    expect((await navDono.post(postRevogarConvite, { id: convite.dados.id })).status).toBe(200);
    const revogado = await new Navegador().post(postAceitarConvite, {
      token: String(convite.dados.link).split("#")[1], email: emailNovo("rev"), senha: senhaForte(), apelido: "Revogado", turnstile: TURNSTILE_TESTE,
    });
    expect(revogado.status).toBe(400);
  });

  it("senha vazada (HIBP) é recusada; HIBP fora do ar também recusa (falha fechada)", async () => {
    const convite = await navDono.post(postCriarConvite, { apelido: "Senhas" });
    const token = String(convite.dados.link).split("#")[1];
    const base = { token, email: emailNovo("senha"), apelido: "Senhas", turnstile: TURNSTILE_TESTE };

    const vazada = await new Navegador().post(postAceitarConvite, { ...base, senha: "password1234" });
    expect(vazada.status).toBe(400);
    expect(String(vazada.dados.erro)).toMatch(/vazamentos/);

    const curta = await new Navegador().post(postAceitarConvite, { ...base, senha: "curta123" });
    expect(curta.status).toBe(400);

    const original = process.env.HIBP_API_URL;
    process.env.HIBP_API_URL = ENDERECO_FECHADO;
    try {
      const fora = await new Navegador().post(postAceitarConvite, { ...base, senha: senhaForte() });
      expect(fora.status).toBe(503);
    } finally {
      if (original === undefined) delete process.env.HIBP_API_URL;
      else process.env.HIBP_API_URL = original;
    }
    // Nada foi consumido: o convite continua válido.
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from app.staff_invites where token_hash = sha256(convert_to(${token ?? ""}, 'UTF8')) and used_at is null`;
    expect(c?.n).toBe(1);
  });

  it("Turnstile recusado no servidor impede o aceite", async () => {
    const convite = await navDono.post(postCriarConvite, { apelido: "Robo" });
    const original = process.env.TURNSTILE_SECRET_KEY;
    process.env.TURNSTILE_SECRET_KEY = "2x0000000000000000000000000000000AA"; // chave de teste "sempre recusa"
    try {
      const r = await new Navegador().post(postAceitarConvite, {
        token: String(convite.dados.link).split("#")[1], email: emailNovo("robo"), senha: senhaForte(), apelido: "Robo", turnstile: TURNSTILE_TESTE,
      });
      expect(r.status).toBe(400);
    } finally {
      process.env.TURNSTILE_SECRET_KEY = original;
    }
  });
});

describe("permissões, sessões e revogação", () => {
  let mod: { email: string; senha: string; userId: string };
  const navMod = new Navegador();

  beforeAll(async () => {
    mod = await criarModerador(navDono, "Mod Permissoes");
    await entrarCadastrandoMfa(navMod, mod.email, mod.senha);
  });

  it("moderador AAL2 entra, mas NÃO convida, NÃO remove e NÃO reseta MFA", async () => {
    expect((await contextoPorToken(navMod.access ?? ""))?.role).toBe("moderator");
    expect((await navMod.post(postCriarConvite, { apelido: "Sombra" })).status).toBe(403);
    expect((await navMod.post(postRemoverModerador, { userId: dono.id })).status).toBe(403);
    expect((await navMod.post(postResetarMfa, { userId: dono.id })).status).toBe(403);
  });

  it("streamer derruba outra sessão: JWT ainda válido e refresh token deixam de funcionar", async () => {
    const outraAba = new Navegador();
    await entrarComMfa(outraAba, dono.email, dono.senha, dono.segredo);
    const sessao = lerClaims(outraAba.access)?.session_id ?? "";
    expect((await navDono.post(postRevogarSessao, { sessionId: sessao })).status).toBe(200);
    expect(await contextoPorToken(outraAba.access ?? "")).toBeNull();
    expect(await renovar(outraAba.refresh ?? "")).toBeNull();
  });

  it("reset de MFA apaga o autenticador e derruba as sessões do moderador", async () => {
    const outro = await criarModerador(navDono, "Mod Reset");
    const nav = new Navegador();
    await entrarCadastrandoMfa(nav, outro.email, outro.senha);
    expect((await navDono.post(postResetarMfa, { userId: outro.userId })).status).toBe(200);
    expect(await adminFatores(outro.userId)).toEqual([]);
    expect(await contextoPorToken(nav.access ?? "")).toBeNull();
  });

  it("moderador removido perde o acesso na próxima requisição, com JWT ainda válido", async () => {
    const tokenAntigo = navMod.access ?? "";
    expect((await navDono.post(postRemoverModerador, { userId: mod.userId })).status).toBe(200);
    expect(await contextoPorToken(tokenAntigo)).toBeNull();
    expect((await navMod.post(postRevogarSessao, { sessionId: lerClaims(tokenAntigo)?.session_id })).status).toBe(401);
  });

  it("sair encerra a sessão no banco e no Auth", async () => {
    const nav = new Navegador();
    await entrarComMfa(nav, dono.email, dono.senha, dono.segredo);
    const token = nav.access ?? "";
    const refresh = nav.refresh ?? "";
    expect((await nav.post(postSair, {})).status).toBe(200);
    expect(nav.access).toBeUndefined();
    expect(await contextoPorToken(token)).toBeNull();
    expect(await renovar(refresh)).toBeNull();
  });
});

describe("cadastro público bloqueado no banco (D-048)", () => {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY ?? "";
  const servico = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const contas = async (email: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from auth.users where email = ${email}`)[0]?.n;

  it("cadastro por e-mail pela API pública do Auth é recusado", async () => {
    const email = emailNovo("publico");
    const r = await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senhaForte(), gotrue_meta_security: { captcha_token: TURNSTILE_TESTE } }),
    });
    expect(r.ok).toBe(false);
    expect(await contas(email)).toBe(0);
  });

  it("nem a API admin cria conta sem a pré-autorização do servidor", async () => {
    const email = emailNovo("admin-direto");
    const headers: Record<string, string> = { apikey: servico, "Content-Type": "application/json" };
    if (!servico.startsWith("sb_")) headers.Authorization = `Bearer ${servico}`;
    const r = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: senhaForte(), email_confirm: true }),
    });
    expect(r.ok).toBe(false);
    expect(await contas(email)).toBe(0);
  });

  it("login anônimo (que o espectador vai usar) continua funcionando", async () => {
    const r = await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ gotrue_meta_security: { captcha_token: TURNSTILE_TESTE } }),
    });
    expect(r.status).toBe(200);
    const dados = (await r.json()) as { user?: { is_anonymous?: boolean } };
    expect(dados.user?.is_anonymous).toBe(true);
  });
});
