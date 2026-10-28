import { isIP } from "node:net";

export type DeployMode = "managed" | "cloudflare_locked" | "tunnel";

/** Valor usado quando o IP não pode ser determinado: todos caem no MESMO balde (mais restritivo). */
export const IP_DESCONHECIDO = "desconhecido";

function expandirIPv6(ip: string): number[] | null {
  let endereco = ip;
  // IPv4 embutido no final (ex.: ::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(endereco);
  if (v4?.[1]) {
    const partes = v4[1].split(".").map(Number);
    if (partes.length !== 4 || partes.some((n) => n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = partes;
    endereco = endereco.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [cabeca = "", cauda] = endereco.split("::");
  const ini = cabeca ? cabeca.split(":") : [];
  const fim = cauda !== undefined && cauda !== "" ? cauda.split(":") : [];
  const faltam = cauda !== undefined ? 8 - ini.length - fim.length : 0;
  const grupos = [...ini, ...Array<string>(Math.max(0, faltam)).fill("0"), ...fim];
  if (grupos.length !== 8) return null;
  const nums = grupos.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/**
 * Forma canônica usada nas regras por IP (D-011):
 * IPv4 inteiro; IPv6 agrupado pelo /64 (um aparelho costuma ter o /64 todo).
 */
export function normalizarIp(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const ip = bruto.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tipo = isIP(ip);
  if (tipo === 4) return ip;
  if (tipo === 6) {
    const g = expandirIPv6(ip);
    if (!g) return null;
    // IPv4 mapeado em IPv6 (::ffff:a.b.c.d) volta a ser IPv4.
    if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
      const [, , , , , , hi = 0, lo = 0] = g;
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return g.slice(0, 4).map((n) => n.toString(16)).join(":") + "::/64";
  }
  return null;
}

/**
 * IP do cliente conforme o modo de deploy (D-031, D-058):
 * - cloudflare_locked / tunnel: só CF-Connecting-IP (a origem só recebe tráfego da Cloudflare).
 * - managed: último valor de X-Forwarded-For (o que o proxy da hospedagem acrescentou).
 *   Pode ser forjado se houver acesso direto à origem: as regras por IP ficam ENFRAQUECIDAS.
 */
/**
 * Quantos proxies confiáveis a hospedagem põe na frente (TRUSTED_PROXY_HOPS, 1 a 5;
 * padrão 1). O IP do cliente é o valor nessa posição, contando do FIM do
 * X-Forwarded-For. Meça na hospedagem real com a página /painel/diagnostico (D-078).
 */
export function saltosConfiaveis(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

export function ipDoCliente(headers: Pick<Headers, "get">, modo: DeployMode, saltos = saltosConfiaveis()): string {
  if (modo === "cloudflare_locked" || modo === "tunnel") {
    return normalizarIp(headers.get("cf-connecting-ip")) ?? IP_DESCONHECIDO;
  }
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const partes = xff.split(",").map((p) => p.trim()).filter(Boolean);
    // Menos valores do que proxies confiáveis = cabeçalho incompleto: não confia em nenhum.
    if (partes.length < saltos) return IP_DESCONHECIDO;
    const escolhido = normalizarIp(partes[partes.length - saltos]);
    if (escolhido) return escolhido;
  }
  return normalizarIp(headers.get("x-real-ip")) ?? IP_DESCONHECIDO;
}
