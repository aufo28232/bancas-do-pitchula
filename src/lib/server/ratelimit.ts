import { DependencyUnavailableError } from "./errors";
import { log } from "./log";
import { redisPipeline } from "./redis";

/**
 * Rate limit por janela fixa no Redis (D-030).
 * `id` deve ser um HMAC (nunca IP ou e-mail em claro: ARCHITECTURE §1.3).
 */
export type Resultado = { permitido: boolean; tentarEmSeg: number };

export async function contar(balde: string, id: string, limite: number, janelaSeg: number): Promise<Resultado> {
  const chave = `rl:${balde}:${id}`;
  const [, contagem, ttl] = await redisPipeline([
    ["SET", chave, "0", "EX", janelaSeg, "NX"],
    ["INCR", chave],
    ["TTL", chave],
  ]);
  const n = Number(contagem);
  const restante = Number(ttl);
  return { permitido: n <= limite, tentarEmSeg: restante > 0 ? restante : janelaSeg };
}

/**
 * Operações críticas (login, criar pedido, upload, convite): Redis fora = BLOQUEIA.
 * A exceção sobe e vira 503 com mensagem amigável.
 */
export async function contarOuFalhar(balde: string, id: string, limite: number, janelaSeg: number): Promise<Resultado> {
  return contar(balde, id, limite, janelaSeg);
}

/**
 * Operações não críticas do painel: Redis fora = PERMITE, com log de alerta (D-030).
 */
export async function contarOuPermitir(balde: string, id: string, limite: number, janelaSeg: number): Promise<Resultado> {
  try {
    return await contar(balde, id, limite, janelaSeg);
  } catch (e) {
    if (e instanceof DependencyUnavailableError) {
      log("warn", { evento: "rate_limit_sem_redis", motivo: balde });
      return { permitido: true, tentarEmSeg: 0 };
    }
    throw e;
  }
}
