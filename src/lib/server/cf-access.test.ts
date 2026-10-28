/**
 * Validação do JWT do Cloudflare Access com chaves RSA geradas no teste (sem rede).
 */
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configAccess, verificarJwtAccess } from "./cf-access";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const outra = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };
const EMISSOR = "https://minhaequipe.cloudflareaccess.com";
const AUD = "aud-do-painel";
const agora = 1_800_000_000;

function jwt(corpo: Record<string, unknown>, opcoes: { kid?: string; alg?: string; chave?: typeof privateKey } = {}): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const dados = `${b({ alg: opcoes.alg ?? "RS256", kid: opcoes.kid ?? "k1", typ: "JWT" })}.${b(corpo)}`;
  const assinatura = createSign("RSA-SHA256").update(dados).sign(opcoes.chave ?? privateKey).toString("base64url");
  return `${dados}.${assinatura}`;
}

const valido = { aud: [AUD], iss: EMISSOR, exp: agora + 600, nbf: agora - 10, email: "streamer@exemplo.com" };
const conferir = (t: string) => verificarJwtAccess(t, { jwks, aud: AUD, emissor: EMISSOR, agoraSeg: agora });

describe("Cloudflare Access no painel", () => {
  it("aceita só o JWT assinado pela equipe, com aud, emissor e validade certos", () => {
    expect(conferir(jwt(valido))).toBe(true);
    expect(conferir(jwt({ ...valido, aud: ["outro-app"] }))).toBe(false);
    expect(conferir(jwt({ ...valido, iss: "https://atacante.cloudflareaccess.com" }))).toBe(false);
    expect(conferir(jwt({ ...valido, exp: agora - 120 }))).toBe(false);
    expect(conferir(jwt({ ...valido, nbf: agora + 600 }))).toBe(false);
  });

  it("recusa assinatura de outra chave, kid desconhecido, alg trocado e token adulterado", () => {
    expect(conferir(jwt(valido, { chave: outra.privateKey }))).toBe(false);
    expect(conferir(jwt(valido, { kid: "nao-existe" }))).toBe(false);
    expect(conferir(jwt(valido, { alg: "none" }))).toBe(false);
    const [h, , s] = jwt(valido).split(".");
    const corpoFalso = Buffer.from(JSON.stringify({ ...valido, email: "outro@x.com" })).toString("base64url");
    expect(conferir(`${h}.${corpoFalso}.${s}`)).toBe(false);
    expect(conferir("lixo")).toBe(false);
  });

  it("configuração: desligada sem as duas variáveis; só aceita domínio *.cloudflareaccess.com", () => {
    expect(configAccess({})).toBeNull();
    expect(configAccess({ CF_ACCESS_TEAM_DOMAIN: "minhaequipe.cloudflareaccess.com" })).toBeNull();
    expect(configAccess({ CF_ACCESS_TEAM_DOMAIN: "https://minhaequipe.cloudflareaccess.com/", CF_ACCESS_AUD: "x" })).toEqual({
      equipe: "minhaequipe.cloudflareaccess.com",
      aud: "x",
    });
    expect(configAccess({ CF_ACCESS_TEAM_DOMAIN: "evil.com", CF_ACCESS_AUD: "x" })).toBeNull();
  });
});
