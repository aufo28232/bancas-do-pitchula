import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseEnv } from "@/lib/env";
import { z } from "zod";
import { hmac, parseKeyring, type HmacKeyring } from "./keys";

/**
 * Cifra de dados pessoais em repouso (ARCHITECTURE §6.1):
 * - AES-256-GCM, IV aleatório de 96 bits por valor, tag de 128 bits;
 * - AAD = "{tabela.coluna}:{id do pedido}:v{versão}": um texto cifrado copiado
 *   para outro pedido ou outra coluna NÃO decifra;
 * - formato "v{versão}:" + base64url(iv ‖ texto cifrado ‖ tag), para permitir rotação.
 * A chave existe só neste servidor; o banco só vê texto cifrado.
 */
export type Campo = "orders.full_name_enc" | "orders.cpf_enc" | "orders.pix_key_enc" | "orders.platform_id_enc";

const cryptoEnvSchema = z.object({
  DATA_ENC_KEYS: z.string().min(2),
  DATA_ENC_ACTIVE: z.coerce.number().int().min(1),
});

/** Mesmo formato das chaves HMAC: {"versão": "base64 de 32 bytes"}. */
export function chavesDeCifra(json: string, ativa: number): HmacKeyring {
  const ring = parseKeyring(json, ativa);
  for (const [v, k] of ring.keys) {
    if (k.length !== 32) throw new Error(`DATA_ENC_KEYS: a chave da versão ${v} precisa ter exatamente 32 bytes`);
  }
  return ring;
}

export function getChavesDeCifra(): HmacKeyring {
  const env = parseEnv(cryptoEnvSchema, process.env);
  return chavesDeCifra(env.DATA_ENC_KEYS, env.DATA_ENC_ACTIVE);
}

const aad = (campo: Campo, id: string, versao: number) => Buffer.from(`${campo}:${id}:v${versao}`, "utf8");

export function cifrar(ring: HmacKeyring, campo: Campo, id: string, texto: string): string {
  const versao = ring.active;
  const chave = ring.keys.get(versao);
  if (!chave) throw new Error("chave de cifra ativa ausente");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv, { authTagLength: 16 });
  c.setAAD(aad(campo, id, versao));
  const corpo = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return `v${versao}:${Buffer.concat([iv, corpo, c.getAuthTag()]).toString("base64url")}`;
}

export class DecifraError extends Error {
  constructor() {
    super("não foi possível decifrar");
    this.name = "DecifraError";
  }
}

export function decifrar(ring: HmacKeyring, campo: Campo, id: string, valor: string): string {
  const m = /^v(\d{1,4}):([A-Za-z0-9_-]+)$/.exec(valor);
  if (!m?.[1] || !m[2]) throw new DecifraError();
  const versao = Number(m[1]);
  const chave = ring.keys.get(versao);
  const bruto = Buffer.from(m[2], "base64url");
  if (!chave || bruto.length < 12 + 16 + 1) throw new DecifraError();
  try {
    const d = createDecipheriv("aes-256-gcm", chave, bruto.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(aad(campo, id, versao));
    d.setAuthTag(bruto.subarray(bruto.length - 16));
    return Buffer.concat([d.update(bruto.subarray(12, bruto.length - 16)), d.final()]).toString("utf8");
  } catch {
    // Mensagem genérica: nunca ecoa o valor nem detalhes da chave.
    throw new DecifraError();
  }
}

/** Versão do texto cifrado (para a rotina de rotação de chaves). */
export function versaoDoCifrado(valor: string): number | null {
  const m = /^v(\d{1,4}):/.exec(valor);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * HMAC de dados (anti-duplicidade e banimentos, D-013): devolve o da versão ATIVA
 * (para gravar) e o de TODAS as versões (para comparar durante uma rotação).
 */
export function hmacsDeDado(ring: HmacKeyring, dominio: string, valorNormalizado: string): { ativo: Buffer; todos: Buffer[] } {
  const todos = [...ring.keys.keys()].sort((a, b) => a - b).map((v) => hmac(ring, dominio, valorNormalizado, v));
  return { ativo: hmac(ring, dominio, valorNormalizado), todos };
}
