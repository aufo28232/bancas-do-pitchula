import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

const base = { PLATFORM_NAME: "4fly" };

describe("ambiente do servidor", () => {
  it("aceita o mínimo e aplica os padrões seguros", () => {
    const env = parseServerEnv(base);
    expect(env.PLATFORM_SIGNUP_URL).toBe("");
    expect(env.DEPLOY_MODE).toBe("managed");
  });

  it("aceita link https", () => {
    const env = parseServerEnv({ ...base, PLATFORM_SIGNUP_URL: "https://go.aff.4fly.game/3kxqo488" });
    expect(env.PLATFORM_SIGNUP_URL).toBe("https://go.aff.4fly.game/3kxqo488");
  });

  it("aceita link vazio (esconde o link)", () => {
    expect(parseServerEnv({ ...base, PLATFORM_SIGNUP_URL: "" }).PLATFORM_SIGNUP_URL).toBe("");
  });

  it.each(["http://go.aff.4fly.game/x", "javascript:alert(1)", "data:text/html,oi", "nao-e-url"])(
    "rejeita link inseguro ou inválido: %s",
    (url) => {
      expect(() => parseServerEnv({ ...base, PLATFORM_SIGNUP_URL: url })).toThrow(/PLATFORM_SIGNUP_URL/);
    },
  );

  it("exige o nome da plataforma", () => {
    expect(() => parseServerEnv({})).toThrow(/PLATFORM_NAME/);
  });

  it("rejeita modo de deploy desconhecido", () => {
    expect(() => parseServerEnv({ ...base, DEPLOY_MODE: "vercel" })).toThrow(/DEPLOY_MODE/);
  });

  it("a mensagem de erro não vaza o valor recebido", () => {
    const segredo = "https-nao-valido-com-valor-sensivel";
    try {
      parseServerEnv({ ...base, PLATFORM_SIGNUP_URL: segredo });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(segredo);
    }
  });
});
