import { randomInt } from "node:crypto";

/**
 * Código da banca: 8 caracteres [a-z0-9] + "-" + 4 dígitos (enunciado §1),
 * gerado com o gerador criptográfico do Node. ~54 bits de entropia.
 * A URL pública é /{código}-banca. A unicidade é garantida pelo banco.
 */
const ALFABETO = "abcdefghijklmnopqrstuvwxyz0123456789";

export function gerarCodigoBanca(): string {
  let letras = "";
  for (let i = 0; i < 8; i++) letras += ALFABETO[randomInt(ALFABETO.length)];
  let digitos = "";
  for (let i = 0; i < 4; i++) digitos += String(randomInt(10));
  return `${letras}-${digitos}`;
}

export const REGEX_CODIGO = /^[a-z0-9]{8}-[0-9]{4}$/;
export const REGEX_SLUG = /^([a-z0-9]{8}-[0-9]{4})-banca$/;

export function codigoDoSlug(slug: string): string | null {
  return REGEX_SLUG.exec(slug)?.[1] ?? null;
}
