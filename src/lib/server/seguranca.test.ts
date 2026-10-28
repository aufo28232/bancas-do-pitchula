import { describe, expect, it } from "vitest";
import { apagarCookie, lerCookies, serializarCookie } from "./cookies";
import { CSRF_COOKIE, checarCsrf, novoTokenCsrf } from "./csrf";
import { ipDoCliente, normalizarIp } from "./ip";
import { hmac, parseKeyring } from "./keys";
import { bloqueioPara } from "./lockout";
import { camposPermitidos } from "./log";
import { RpcError } from "./postgrest";
import { problemaDeTamanho } from "./senha";
import { lerClaims, precisaRenovar, resumoUserAgent } from "./sessao-staff";

const SITE = "https://bancas.exemplo.com";
const chave = (b: number) => Buffer.alloc(32, b).toString("base64");

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b(payload)}.assinatura`;
}

describe("IP do cliente por modo de deploy", () => {
  it("normaliza IPv4 e agrupa IPv6 no /64", () => {
    expect(normalizarIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizarIp("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(normalizarIp("2001:db8:abcd:12::ffff")).toBe("2001:db8:abcd:12::/64");
    expect(normalizarIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(normalizarIp("não é ip")).toBeNull();
  });

  it("dois endereços do mesmo /64 contam como o mesmo IP", () => {
    expect(normalizarIp("2001:db8::1")).toBe(normalizarIp("2001:db8::abcd:9999"));
  });

  it("managed: usa o ÚLTIMO X-Forwarded-For (o que o proxy da hospedagem acrescentou)", () => {
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 198.51.100.7", "cf-connecting-ip": "9.9.9.9" });
    expect(ipDoCliente(h, "managed")).toBe("198.51.100.7");
  });

  it("managed com 2 proxies confiáveis: pega o penúltimo; cabeçalho curto demais não vale", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.9, 10.0.0.2" });
    expect(ipDoCliente(h, "managed", 2)).toBe("198.51.100.9");
    expect(ipDoCliente(new Headers({ "x-forwarded-for": "198.51.100.9" }), "managed", 2)).toBe("desconhecido");
  });

  it("cloudflare_locked/tunnel: só confia no CF-Connecting-IP", () => {
    const h = new Headers({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "203.0.113.5" });
    expect(ipDoCliente(h, "cloudflare_locked")).toBe("203.0.113.5");
    expect(ipDoCliente(new Headers({ "x-forwarded-for": "1.1.1.1" }), "tunnel")).toBe("desconhecido");
  });
});

describe("chaves HMAC", () => {
  it("rejeita chave curta, JSON inválido e versão ativa inexistente", () => {
    expect(() => parseKeyring(`{"1":"${Buffer.alloc(16).toString("base64")}"}`, 1)).toThrow(/32 bytes/);
    expect(() => parseKeyring("não é json", 1)).toThrow();
    expect(() => parseKeyring(`{"1":"${chave(1)}"}`, 2)).toThrow(/inexistente/);
  });

  it("domínios diferentes geram HMACs diferentes para o mesmo valor", () => {
    const ring = parseKeyring(`{"1":"${chave(1)}","2":"${chave(2)}"}`, 2);
    expect(hmac(ring, "rl-ip", "1.2.3.4").equals(hmac(ring, "rl-conta", "1.2.3.4"))).toBe(false);
    expect(hmac(ring, "x", "v", 1).equals(hmac(ring, "x", "v", 2))).toBe(false);
    expect(hmac(ring, "x", "v")).toHaveLength(32);
  });
});

describe("CSRF", () => {
  const token = novoTokenCsrf();
  const base = {
    origin: SITE,
    "sec-fetch-site": "same-origin",
    cookie: `${CSRF_COOKIE}=${token}`,
    "x-csrf-token": token,
  };
  const req = (h: Record<string, string>) => new Request(`${SITE}/api/x`, { method: "POST", headers: h });

  it("aceita a requisição do próprio site", () => {
    expect(checarCsrf(req(base), SITE)).toBeNull();
  });

  it("recusa outra origem, origem ausente e Sec-Fetch-Site cross-site", () => {
    expect(checarCsrf(req({ ...base, origin: "https://golpe.exemplo" }), SITE)).toBe("origem");
    const semOrigem: Record<string, string> = { ...base };
    delete semOrigem.origin;
    expect(checarCsrf(req(semOrigem), SITE)).toBe("origem");
    expect(checarCsrf(req({ ...base, "sec-fetch-site": "cross-site" }), SITE)).toBe("fetch_site");
  });

  it("recusa token ausente ou diferente do cookie", () => {
    const semHeader: Record<string, string> = { ...base };
    delete semHeader["x-csrf-token"];
    expect(checarCsrf(req(semHeader), SITE)).toBe("token");
    expect(checarCsrf(req({ ...base, "x-csrf-token": novoTokenCsrf() }), SITE)).toBe("token");
  });
});

describe("cookies", () => {
  it("todo cookie sai com Secure, HttpOnly e SameSite=Strict por padrão", () => {
    const c = serializarCookie("__Host-x", "valor", { maxAge: 60 });
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).not.toMatch(/Domain=/i);
    expect(apagarCookie("__Host-x")).toContain("Max-Age=0");
  });

  it("lê o primeiro valor e ignora lixo", () => {
    expect(lerCookies("a=1; b=2; a=3; lixo")).toEqual({ a: "1", b: "2" });
  });
});

describe("sessão do staff", () => {
  it("renova quando falta access token ou ele vence em menos de 60 s", () => {
    const agora = 1_800_000_000;
    expect(precisaRenovar(undefined, agora)).toBe(true);
    expect(precisaRenovar(jwt({ exp: agora + 30 }), agora)).toBe(true);
    expect(precisaRenovar(jwt({ exp: agora + 300 }), agora)).toBe(false);
  });

  it("lê claims e ignora token malformado", () => {
    expect(lerClaims(jwt({ sub: "u", aal: "aal2" }))?.aal).toBe("aal2");
    expect(lerClaims("abc")).toBeNull();
  });

  it("guarda só um resumo do user-agent", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
    expect(resumoUserAgent(ua)).toBe("Chrome · Windows");
  });
});

describe("regras de senha e bloqueio", () => {
  it("mínimo de 12 caracteres contando caracteres, não bytes", () => {
    expect(problemaDeTamanho("curtinha")).toBe("curta");
    expect(problemaDeTamanho("çççççççççççç")).toBeNull();
    expect(problemaDeTamanho("a".repeat(129))).toBe("longa");
  });

  it("bloqueio progressivo: 5 → 1 min, 10 → 15 min, 20 → 1 h", () => {
    expect(bloqueioPara(4)).toBe(0);
    expect(bloqueioPara(5)).toBe(60);
    expect(bloqueioPara(10)).toBe(900);
    expect(bloqueioPara(20)).toBe(3600);
  });
});

describe("logs e erros", () => {
  it("o logger descarta qualquer campo fora da lista (ex.: cpf, token, email)", () => {
    expect(camposPermitidos({ evento: "x", cpf: "1", token: "t", email: "e", rota: "r" })).toEqual(["evento", "rota"]);
  });

  it("traduz erros do banco para status HTTP", () => {
    expect(new RpcError("42501", 403).httpStatus()).toBe(403);
    expect(new RpcError("P0002", 400).httpStatus()).toBe(404);
    expect(new RpcError("PGRST303", 401).httpStatus()).toBe(401);
    expect(new RpcError("XX000", 500).httpStatus()).toBe(500);
  });
});
