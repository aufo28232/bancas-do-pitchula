import { getSecurityEnv } from "@/lib/env";
import { DependencyUnavailableError } from "./errors";

/**
 * Cliente mínimo da API REST do Upstash Redis (D-056): só o pipeline.
 * Qualquer falha (rede, timeout, HTTP != 200, erro de comando) vira
 * DependencyUnavailableError, e quem chama decide FALHAR FECHADO.
 */
export type RedisCommand = (string | number)[];

const TIMEOUT_MS = 1500;

export async function redisPipeline(comandos: RedisCommand[]): Promise<unknown[]> {
  const env = getSecurityEnv();
  let resposta: Response;
  try {
    resposta = await fetch(`${env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(comandos.map((c) => c.map(String))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new DependencyUnavailableError("redis");
  }
  if (!resposta.ok) throw new DependencyUnavailableError("redis");

  let dados: unknown;
  try {
    dados = await resposta.json();
  } catch {
    throw new DependencyUnavailableError("redis");
  }
  if (!Array.isArray(dados) || dados.length !== comandos.length) throw new DependencyUnavailableError("redis");

  return dados.map((item: unknown) => {
    if (typeof item !== "object" || item === null || "error" in item) throw new DependencyUnavailableError("redis");
    return (item as { result?: unknown }).result;
  });
}
