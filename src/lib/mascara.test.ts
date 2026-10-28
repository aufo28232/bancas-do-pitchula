import { describe, expect, it } from "vitest";
import { mascararCpf, mascararEmail, mascararNome, mascararPix, mascararPlataformaId, mascararTelefone } from "./mascara";

describe("máscaras da página do pedido (D-023)", () => {
  it("nome: primeiro nome e iniciais", () => {
    expect(mascararNome("João Pedro da Silva")).toBe("João P. d. S.");
    expect(mascararNome("  Ana   Lima ")).toBe("Ana L.");
  });

  it("CPF: só os 3 últimos dígitos", () => {
    expect(mascararCpf("12345678901")).toBe("***.***.**9-01");
    expect(mascararCpf("123")).toBe("***.***.***-**");
  });

  it("e-mail: primeira letra do usuário e do domínio", () => {
    expect(mascararEmail("joao.silva@gmail.com")).toBe("j***@g***.com");
    expect(mascararEmail("a@b.com.br")).toBe("a***@b***.com.br");
  });

  it("telefone: só os 4 últimos dígitos", () => {
    expect(mascararTelefone("+5521987654321")).toBe("(**) *****-4321");
    expect(mascararTelefone("+552133334444")).toBe("(**) ****-4444");
  });

  it("chave aleatória: 4 primeiros e 4 últimos caracteres, hífens preservados", () => {
    const m = mascararPix("aleatoria", "123e4567-e89b-12d3-a456-426614174000");
    expect(m).toBe("123e****-****-****-****-********4000");
    expect(m).not.toContain("e89b");
  });

  it("nenhuma máscara devolve o valor completo", () => {
    const valores: [Parameters<typeof mascararPix>[0], string][] = [
      ["cpf", "52998224725"],
      ["email", "maria@exemplo.com"],
      ["telefone", "+5511912345678"],
      ["aleatoria", "123e4567-e89b-12d3-a456-426614174000"],
    ];
    for (const [tipo, v] of valores) expect(mascararPix(tipo, v)).not.toBe(v);
    expect(mascararPlataformaId("jogador123")).toBe("*******123");
    expect(mascararPlataformaId("ab")).toBe("**");
  });
});

describe("modo live do painel (máscara total)", () => {
  it("nome vira só as iniciais com asteriscos", async () => {
    const { mascararNomeLive } = await import("./mascara");
    expect(mascararNomeLive("João Pedro Silva")).toBe("J*** P*** S***");
  });

  it("chat: e-mail e sequências de 8+ dígitos somem; números curtos ficam (D-015)", async () => {
    const { mascararTextoLive } = await import("./mascara");
    expect(mascararTextoLive("meu cpf é 529.982.247-25 ok")).toBe("meu cpf é ***.***.***-** ok");
    expect(mascararTextoLive("pix maria@exemplo.com")).toBe("pix ***@***");
    expect(mascararTextoLive("zap (21) 98765-4321")).toBe("zap (**) *****-****");
    expect(mascararTextoLive("depositei 50 reais às 21:30")).toBe("depositei 50 reais às 21:30");
    expect(mascararTextoLive("+5521987654321")).toBe("+*************");
  });
});
