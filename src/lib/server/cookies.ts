/** Leitura e escrita de cookies sem depender de APIs do Next (testável com Request puro). */

export function lerCookies(header: string | null | undefined): Record<string, string> {
  const saida: Record<string, string> = {};
  if (!header) return saida;
  for (const parte of header.split(";")) {
    const i = parte.indexOf("=");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (!nome || nome in saida) continue;
    try {
      saida[nome] = decodeURIComponent(valor);
    } catch {
      saida[nome] = valor;
    }
  }
  return saida;
}

export type OpcoesCookie = {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax";
  path?: string;
};

/**
 * Todo cookie do site usa o prefixo __Host- (exige Secure, Path=/ e nenhum Domain):
 * não pode ser definido por subdomínio nem por conexão sem TLS.
 */
export function serializarCookie(nome: string, valor: string, op: OpcoesCookie = {}): string {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, `Path=${op.path ?? "/"}`, "Secure"];
  if (op.httpOnly ?? true) partes.push("HttpOnly");
  partes.push(`SameSite=${op.sameSite ?? "Strict"}`);
  if (op.maxAge !== undefined) partes.push(`Max-Age=${Math.max(0, Math.floor(op.maxAge))}`);
  return partes.join("; ");
}

export function apagarCookie(nome: string, httpOnly = true): string {
  return serializarCookie(nome, "", { maxAge: 0, httpOnly });
}
