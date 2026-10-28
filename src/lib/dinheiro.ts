/** Dinheiro sempre em CENTAVOS (inteiro). Formatação pt-BR. */

export function formatarReais(cents: number): string {
  const inteiro = cents % 100 === 0;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: inteiro ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .format(cents / 100)
    .replace(/ /g, " ");
}

/**
 * Lê o valor digitado pelo streamer: "3000", "3.000", "3.000,50", "3000,5", "R$ 3.000".
 * Retorna centavos, ou null se inválido (mais de 2 casas, letras, negativo).
 */
export function lerReais(entrada: string): number | null {
  let s = entrada.replace(/R\$|\s/g, "");
  if (!s) return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (!/^\d+\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [inteiros = "0", fracao = ""] = s.split(".");
  const cents = Number(inteiros) * 100 + Number(fracao.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Valor por pessoa (arredonda para baixo) e sobra, como o banco calcula. */
export function dividir(totalCents: number, vagas: number): { porPessoa: number; sobra: number } {
  if (vagas <= 0) return { porPessoa: 0, sobra: totalCents };
  const porPessoa = Math.floor(totalCents / vagas);
  return { porPessoa, sobra: totalCents - porPessoa * vagas };
}
