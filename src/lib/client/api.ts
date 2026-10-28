/**
 * POST JSON para as rotas do próprio site, com o token CSRF (double submit).
 * Usado só por componentes de cliente.
 */
export type RespostaApi<T> = { ok: true; dados: T } | { ok: false; status: number; erro: string };

function tokenCsrf(): string {
  const item = document.cookie.split("; ").find((c) => c.startsWith("__Host-bp_csrf="));
  return item ? decodeURIComponent(item.slice("__Host-bp_csrf=".length)) : "";
}

export async function enviar<T = unknown>(url: string, corpo: unknown = {}): Promise<RespostaApi<T>> {
  try {
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": tokenCsrf() },
      body: JSON.stringify(corpo),
    });
    const dados = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return { ok: true, dados: dados as T };
    const erro = typeof dados.erro === "string" ? dados.erro : "Não foi possível concluir agora. Tente de novo.";
    return { ok: false, status: r.status, erro };
  } catch {
    return { ok: false, status: 0, erro: "Sem conexão. Confira a internet e tente de novo." };
  }
}

/** Envia um arquivo cru no corpo (comprovante), com o token CSRF. */
export async function enviarArquivo<T = unknown>(url: string, arquivo: Blob): Promise<RespostaApi<T>> {
  try {
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream", "x-csrf-token": tokenCsrf() },
      body: arquivo,
    });
    const dados = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return { ok: true, dados: dados as T };
    const erro = typeof dados.erro === "string" ? dados.erro : "Não foi possível enviar agora. Tente de novo.";
    return { ok: false, status: r.status, erro };
  } catch {
    return { ok: false, status: 0, erro: "Sem conexão. Confira a internet e tente de novo." };
  }
}
