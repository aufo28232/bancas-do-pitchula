import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chavesDeCifra, cifrar, decifrar, DecifraError, hmacsDeDado, versaoDoCifrado } from "./cripto";

const chave = (b: number) => Buffer.alloc(32, b).toString("base64");
const v1 = chavesDeCifra(`{"1":"${chave(1)}"}`, 1);
const v1e2 = chavesDeCifra(`{"1":"${chave(1)}","2":"${chave(2)}"}`, 2);
const id = randomUUID();

describe("cifra AES-256-GCM", () => {
  it("ida e volta, com prefixo de versão e sem o texto em claro", () => {
    const c = cifrar(v1, "orders.cpf_enc", id, "52998224725");
    expect(c).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(c).not.toContain("52998224725");
    expect(decifrar(v1, "orders.cpf_enc", id, c)).toBe("52998224725");
  });

  it("o mesmo valor cifrado duas vezes dá resultados diferentes (IV aleatório)", () => {
    expect(cifrar(v1, "orders.cpf_enc", id, "x")).not.toBe(cifrar(v1, "orders.cpf_enc", id, "x"));
  });

  it("adulteração de qualquer byte é detectada", () => {
    const c = cifrar(v1, "orders.full_name_enc", id, "Maria da Silva");
    const corpo = Buffer.from(c.slice(3), "base64url");
    corpo[20] = (corpo[20] ?? 0) ^ 0xff;
    expect(() => decifrar(v1, "orders.full_name_enc", id, `v1:${corpo.toString("base64url")}`)).toThrow(DecifraError);
  });

  it("texto cifrado copiado para OUTRO pedido ou OUTRA coluna não decifra (AAD)", () => {
    const c = cifrar(v1, "orders.cpf_enc", id, "52998224725");
    expect(() => decifrar(v1, "orders.cpf_enc", randomUUID(), c)).toThrow(DecifraError);
    expect(() => decifrar(v1, "orders.pix_key_enc", id, c)).toThrow(DecifraError);
  });

  it("rotação: depois de ativar a v2, o que foi cifrado na v1 continua legível", () => {
    const antigo = cifrar(v1, "orders.pix_key_enc", id, "chave");
    const novo = cifrar(v1e2, "orders.pix_key_enc", id, "chave");
    expect(versaoDoCifrado(antigo)).toBe(1);
    expect(versaoDoCifrado(novo)).toBe(2);
    expect(decifrar(v1e2, "orders.pix_key_enc", id, antigo)).toBe("chave");
    expect(decifrar(v1e2, "orders.pix_key_enc", id, novo)).toBe("chave");
  });

  it("versão de chave removida ou formato inválido: erro genérico, sem ecoar o valor", () => {
    const novo = cifrar(v1e2, "orders.cpf_enc", id, "52998224725");
    expect(() => decifrar(v1, "orders.cpf_enc", id, novo)).toThrow(DecifraError);
    try {
      decifrar(v1, "orders.cpf_enc", id, "lixo-52998224725");
    } catch (e) {
      expect(String(e)).not.toContain("52998224725");
    }
  });

  it("chave de cifra precisa ter exatamente 32 bytes", () => {
    expect(() => chavesDeCifra(`{"1":"${Buffer.alloc(48, 1).toString("base64")}"}`, 1)).toThrow(/32 bytes/);
  });
});

describe("HMAC de dados", () => {
  it("devolve a versão ativa e todas as versões (para comparar durante a rotação)", () => {
    const { ativo, todos } = hmacsDeDado(v1e2, "cpf", "52998224725");
    expect(todos).toHaveLength(2);
    expect(todos[1]?.equals(ativo)).toBe(true);
    expect(todos[0]?.equals(ativo)).toBe(false);
  });
});
