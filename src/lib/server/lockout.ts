import { redisPipeline } from "./redis";

/**
 * Bloqueio progressivo de login (ARCHITECTURE §5.1):
 *   5 falhas -> 1 min · 10 falhas -> 15 min · 20 falhas -> 1 h
 * Contado por conta (HMAC do e-mail) E por IP (HMAC). As falhas expiram em 24h.
 * Só falhas de senha contam; sucesso zera a contagem da conta.
 */
const DEGRAUS = [
  { falhas: 20, bloqueioSeg: 3600 },
  { falhas: 10, bloqueioSeg: 900 },
  { falhas: 5, bloqueioSeg: 60 },
] as const;

const JANELA_FALHAS_SEG = 24 * 3600;

const chaveFalhas = (id: string) => `lock:falhas:${id}`;
const chaveBloqueio = (id: string) => `lock:ate:${id}`;

/** Segundos restantes do maior bloqueio ativo entre os ids (0 = livre). */
export async function bloqueioAtivo(ids: string[]): Promise<number> {
  const ttls = await redisPipeline(ids.map((id) => ["TTL", chaveBloqueio(id)]));
  return Math.max(0, ...ttls.map((t) => Number(t)));
}

export function bloqueioPara(falhas: number): number {
  for (const d of DEGRAUS) if (falhas >= d.falhas) return d.bloqueioSeg;
  return 0;
}

/** Registra uma falha para cada id e aplica o bloqueio do degrau alcançado. */
export async function registrarFalha(ids: string[]): Promise<void> {
  const resultados = await redisPipeline(
    ids.flatMap((id) => [
      ["SET", chaveFalhas(id), "0", "EX", JANELA_FALHAS_SEG, "NX"],
      ["INCR", chaveFalhas(id)],
    ]),
  );
  const bloqueios: (string | number)[][] = [];
  ids.forEach((id, i) => {
    const falhas = Number(resultados[i * 2 + 1]);
    const seg = bloqueioPara(falhas);
    if (seg > 0) bloqueios.push(["SET", chaveBloqueio(id), "1", "EX", seg]);
  });
  if (bloqueios.length > 0) await redisPipeline(bloqueios);
}

export async function limparFalhas(id: string): Promise<void> {
  await redisPipeline([
    ["DEL", chaveFalhas(id)],
    ["DEL", chaveBloqueio(id)],
  ]);
}
