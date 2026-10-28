import { createHmac } from "node:crypto";
import { getSecurityEnv } from "@/lib/env";

/**
 * Chaves HMAC versionadas (D-013). Formato da variável:
 *   HMAC_KEYS={"1":"<base64 de 32 bytes>","2":"..."}  HMAC_ACTIVE=2
 * Cada uso tem um DOMÍNIO próprio (ex.: "rl-ip", "device"), para que o mesmo
 * valor gere HMACs diferentes em contextos diferentes.
 */
export type HmacKeyring = { active: number; keys: Map<number, Buffer> };

export function parseKeyring(json: string, active: number): HmacKeyring {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("HMAC_KEYS não é um JSON válido");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("HMAC_KEYS precisa ser um objeto {versão: chave}");
  }
  const keys = new Map<number, Buffer>();
  for (const [versao, valor] of Object.entries(raw as Record<string, unknown>)) {
    const v = Number(versao);
    if (!Number.isInteger(v) || v < 1 || typeof valor !== "string") {
      throw new Error("HMAC_KEYS tem uma entrada inválida");
    }
    const chave = Buffer.from(valor, "base64");
    if (chave.length < 32) throw new Error(`HMAC_KEYS: a chave da versão ${v} tem menos de 32 bytes`);
    keys.set(v, chave);
  }
  if (!keys.has(active)) throw new Error("HMAC_ACTIVE aponta para uma versão inexistente");
  return { active, keys };
}

export function getKeyring(): HmacKeyring {
  const env = getSecurityEnv();
  return parseKeyring(env.HMAC_KEYS, env.HMAC_ACTIVE);
}

export function hmac(ring: HmacKeyring, dominio: string, valor: string, versao = ring.active): Buffer {
  const chave = ring.keys.get(versao);
  if (!chave) throw new Error("versão de chave HMAC inexistente");
  return createHmac("sha256", chave).update(`${dominio}\u0000${valor}`, "utf8").digest();
}

/** HMAC com a versão ativa, em hex (para chaves do Redis e afins). */
export function hmacHex(dominio: string, valor: string): string {
  return hmac(getKeyring(), dominio, valor).toString("hex");
}

/** Representação de bytea aceita pelo PostgREST/Postgres. */
export function toPgBytea(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}
