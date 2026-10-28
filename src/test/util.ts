/**
 * Utilitários de TESTE (Vitest e Playwright). Não são usados pela aplicação.
 * Sem import de framework de teste para servir aos dois.
 */
import { createHmac, randomInt } from "node:crypto";

function base32(s: string): Buffer {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alfabeto.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** TOTP (RFC 6238): faz o papel do app autenticador. */
export function totp(segredo: string, quando = Date.now()): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(quando / 30_000)));
  const h = createHmac("sha1", base32(segredo)).update(contador).digest();
  const off = (h[h.length - 1] ?? 0) & 0xf;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Milissegundos até o próximo período de 30 s do TOTP (+1 s de folga). */
export function ateProximoPeriodoTotp(): number {
  return 30_000 - (Date.now() % 30_000) + 1_000;
}

/** CPF aleatório VÁLIDO (dígitos verificadores corretos). */
export function gerarCpf(): string {
  const n = Array.from({ length: 9 }, () => randomInt(10));
  if (n.every((d) => d === n[0])) n[8] = ((n[8] ?? 0) + 1) % 10;
  const dv = (base: number[]) => {
    const soma = base.reduce((acc, d, i) => acc + d * (base.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  n.push(dv(n));
  n.push(dv(n));
  return n.join("");
}

export function mascararCpf(cpf: string): string {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}
