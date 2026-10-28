import { getSupabaseEnv } from "@/lib/env";
import { DependencyUnavailableError } from "./errors";

/**
 * Cliente mínimo da API REST do Supabase Storage (D-056), SÓ no servidor e com a
 * service role. O bucket `comprovantes` é privado: o navegador só vê um arquivo
 * por URL assinada de 60 s, gerada sob demanda para quem tem direito.
 */
export const BUCKET = "comprovantes";

function base(): { url: string; headers: Record<string, string> } {
  const env = getSupabaseEnv();
  const headers: Record<string, string> = { apikey: env.SUPABASE_SERVICE_ROLE_KEY };
  if (!env.SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_")) headers.Authorization = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
  return { url: `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1`, headers };
}

async function chamar(caminho: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  const b = base();
  try {
    const r = await fetch(`${b.url}${caminho}`, {
      ...init,
      headers: { ...b.headers, ...init.headers },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (r.status >= 500) throw new DependencyUnavailableError("supabase");
    return r;
  } catch (e) {
    if (e instanceof DependencyUnavailableError) throw e;
    throw new DependencyUnavailableError("supabase");
  }
}

const codificar = (nome: string) => nome.split("/").map(encodeURIComponent).join("/");

/** Nome do objeto dentro do bucket ("{banca}/{pedido}/{id}.webp"), a partir do caminho guardado no banco. */
export function nomeNoBucket(caminho: string): string {
  if (!caminho.startsWith(`${BUCKET}/`)) throw new Error("caminho fora do bucket");
  return caminho.slice(BUCKET.length + 1);
}

export async function subirArquivo(nome: string, conteudo: Buffer, tipo: string): Promise<void> {
  const r = await chamar(`/object/${BUCKET}/${codificar(nome)}`, {
    method: "POST",
    headers: { "Content-Type": tipo, "x-upsert": "false", "Cache-Control": "no-store" },
    body: new Uint8Array(conteudo),
  });
  if (!r.ok) throw new DependencyUnavailableError("supabase");
}

export async function urlAssinada(nome: string, segundos = 60): Promise<string> {
  const r = await chamar(`/object/sign/${BUCKET}/${codificar(nome)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: segundos }),
  });
  if (!r.ok) throw new DependencyUnavailableError("supabase");
  const d = (await r.json()) as { signedURL?: unknown; signedUrl?: unknown };
  const relativa = typeof d.signedURL === "string" ? d.signedURL : typeof d.signedUrl === "string" ? d.signedUrl : null;
  if (!relativa) throw new DependencyUnavailableError("supabase");
  return `${base().url}${relativa.startsWith("/") ? "" : "/"}${relativa}`;
}

/** Apaga vários objetos. Objeto que já não existe não é erro (a exclusão é idempotente). */
export async function apagarArquivos(nomes: string[]): Promise<void> {
  if (nomes.length === 0) return;
  const r = await chamar(`/object/${BUCKET}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: nomes }),
  });
  if (!r.ok) throw new DependencyUnavailableError("supabase");
}

/** Só para conferência (testes e diagnóstico): o arquivo existe no Storage? */
export async function existeArquivo(nome: string): Promise<boolean> {
  const r = await chamar(`/object/${BUCKET}/${codificar(nome)}`, { method: "GET" });
  return r.ok;
}
