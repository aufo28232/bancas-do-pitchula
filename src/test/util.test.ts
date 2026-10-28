import { describe, expect, it } from "vitest";
import { cpfValido } from "@/lib/validacao/pedido";
import { gerarCpf, totp } from "./util";

describe("utilitários de teste", () => {
  it("gerador de CPF produz CPFs válidos", () => {
    for (let i = 0; i < 200; i++) expect(cpfValido(gerarCpf())).toBe(true);
  });
  it("TOTP bate com o vetor de teste da RFC 6238 (SHA-1, T=59s)", () => {
    // Segredo "12345678901234567890" em base32; a RFC dá 94287082 com 8 dígitos -> 287082 com 6.
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });
});
