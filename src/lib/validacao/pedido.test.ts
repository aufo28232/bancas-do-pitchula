import { describe, expect, it } from "vitest";
import { dividir, formatarReais, lerReais } from "../dinheiro";
import { codigoDoSlug, gerarCodigoBanca, REGEX_CODIGO } from "../server/codigo-banca";
import { cpfValido, mascaraCpf, mascaraTelefone, normalizarPix, pedidoSchema } from "./pedido";

const valido = {
  codigo: "k7x9q2mb-4821",
  nome: "  Maria   da Silva ",
  pixTipo: "email",
  pixChave: "Maria@Exemplo.com",
  cpf: "529.982.247-25",
  privacidade: true,
  maioridade: true,
  turnstile: "token",
} as const;

describe("CPF", () => {
  it("aceita CPF com dígitos verificadores corretos, com ou sem máscara", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
  });
  it.each(["529.982.247-24", "111.111.111-11", "123", "abc.def.ghi-jk", ""])("recusa %s", (cpf) => {
    expect(cpfValido(cpf)).toBe(false);
  });
  it("máscara progressiva", () => {
    expect(mascaraCpf("529")).toBe("529");
    expect(mascaraCpf("5299822")).toBe("529.982.2");
    expect(mascaraCpf("52998224725999")).toBe("529.982.247-25");
  });
});

describe("chave Pix por tipo", () => {
  it("CPF", () => {
    expect(normalizarPix("cpf", "529.982.247-25")).toBe("52998224725");
    expect(normalizarPix("cpf", "529.982.247-24")).toBeNull();
  });
  it("e-mail (minúsculas, limite de 77)", () => {
    expect(normalizarPix("email", " Fulano@Exemplo.COM ")).toBe("fulano@exemplo.com");
    expect(normalizarPix("email", "sem-arroba.com")).toBeNull();
    expect(normalizarPix("email", `${"a".repeat(70)}@exemplo.com`)).toBeNull();
  });
  it("telefone vira +55 + DDD + número", () => {
    expect(normalizarPix("telefone", "(21) 99876-5432")).toBe("+5521998765432");
    expect(normalizarPix("telefone", "+55 21 99876-5432")).toBe("+5521998765432");
    expect(normalizarPix("telefone", "21 3876-5432")).toBe("+552138765432");
    expect(normalizarPix("telefone", "(21) 89876-5432")).toBeNull(); // 11 dígitos sem o 9
    expect(normalizarPix("telefone", "(01) 99876-5432")).toBeNull(); // DDD inválido
    expect(normalizarPix("telefone", "9876")).toBeNull();
  });
  it("chave aleatória (UUID)", () => {
    expect(normalizarPix("aleatoria", "123E4567-E89B-12D3-A456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(normalizarPix("aleatoria", "123e4567")).toBeNull();
  });
  it("máscara de telefone", () => {
    expect(mascaraTelefone("21998765432")).toBe("(21) 99876-5432");
    expect(mascaraTelefone("2138765432")).toBe("(21) 3876-5432");
  });
});

describe("formulário de pedido (mesmo schema no cliente e no servidor)", () => {
  it("aceita um pedido válido e normaliza o nome", () => {
    const r = pedidoSchema.safeParse(valido);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nome).toBe("Maria da Silva");
  });

  it("exige nome e sobrenome", () => {
    expect(pedidoSchema.safeParse({ ...valido, nome: "Maria" }).success).toBe(false);
    expect(pedidoSchema.safeParse({ ...valido, nome: "Maria <script>" }).success).toBe(false);
  });

  it("recusa chave Pix que não combina com o tipo", () => {
    const r = pedidoSchema.safeParse({ ...valido, pixTipo: "cpf", pixChave: "maria@exemplo.com" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["pixChave"]);
  });

  it("exige ciência da privacidade e maioridade", () => {
    expect(pedidoSchema.safeParse({ ...valido, privacidade: false }).success).toBe(false);
    expect(pedidoSchema.safeParse({ ...valido, maioridade: false }).success).toBe(false);
  });

  it("recusa CPF inválido", () => {
    expect(pedidoSchema.safeParse({ ...valido, cpf: "111.111.111-11" }).success).toBe(false);
  });
});

describe("dinheiro", () => {
  it("formata em reais, sem centavos quando é inteiro", () => {
    expect(formatarReais(3000)).toBe("R$ 30");
    expect(formatarReais(3333)).toBe("R$ 33,33");
    expect(formatarReais(300000)).toBe("R$ 3.000");
  });
  it("lê o que o streamer digita", () => {
    expect(lerReais("3000")).toBe(300000);
    expect(lerReais("3.000")).toBe(300000);
    expect(lerReais("R$ 3.000,50")).toBe(300050);
    expect(lerReais("100,5")).toBe(10050);
    expect(lerReais("99.90")).toBe(9990);
    expect(lerReais("1,234")).toBeNull();
    expect(lerReais("-5")).toBeNull();
    expect(lerReais("abc")).toBeNull();
  });
  it("divide igual ao banco: arredonda para baixo e mostra a sobra", () => {
    expect(dividir(10000, 3)).toEqual({ porPessoa: 3333, sobra: 1 });
    expect(dividir(300000, 100)).toEqual({ porPessoa: 3000, sobra: 0 });
  });
});

describe("código da banca", () => {
  it("segue o formato e não se repete em 2.000 sorteios", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = gerarCodigoBanca();
      expect(c).toMatch(REGEX_CODIGO);
      vistos.add(c);
    }
    expect(vistos.size).toBe(2000);
  });
  it("extrai o código só de URLs no formato exato", () => {
    expect(codigoDoSlug("k7x9q2mb-4821-banca")).toBe("k7x9q2mb-4821");
    expect(codigoDoSlug("K7X9Q2MB-4821-banca")).toBeNull();
    expect(codigoDoSlug("k7x9q2mb-4821")).toBeNull();
    expect(codigoDoSlug("../../etc-0000-banca")).toBeNull();
  });
});
