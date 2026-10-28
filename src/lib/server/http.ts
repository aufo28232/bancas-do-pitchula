import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { getSecurityEnv } from "@/lib/env";
import { checarCsrf } from "./csrf";
import { DependencyUnavailableError, HttpError, MSG } from "./errors";
import { log } from "./log";
import { RpcError } from "./postgrest";
import { HibpIndisponivelError, MENSAGEM_SENHA } from "./senha";

const SEM_CACHE = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

export type Contexto = { req: Request; requestId: string; setCookies: string[] };

export function json(dados: unknown, status = 200, ctx?: Contexto): Response {
  const headers = new Headers(SEM_CACHE);
  if (ctx) {
    headers.set("X-Request-Id", ctx.requestId);
    for (const c of ctx.setCookies) headers.append("Set-Cookie", c);
  }
  return new Response(JSON.stringify(dados), { status, headers });
}

function erro(status: number, mensagem: string, ctx: Contexto, extras: Record<string, string> = {}): Response {
  const r = json({ erro: mensagem, requestId: ctx.requestId }, status, ctx);
  for (const [k, v] of Object.entries(extras)) r.headers.set(k, v);
  return r;
}

/** Lê o corpo JSON com limite de tamanho e valida com Zod (100% das entradas, enunciado §6). */
export async function lerCorpo<S extends z.ZodType>(req: Request, schema: S, maxBytes = 8192): Promise<z.infer<S>> {
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > maxBytes) throw new HttpError(413, MSG.dadosInvalidos, "corpo_grande");
  const tipo = req.headers.get("content-type") ?? "";
  if (!tipo.toLowerCase().startsWith("application/json")) throw new HttpError(415, MSG.dadosInvalidos, "content_type");

  const texto = await req.text();
  if (Buffer.byteLength(texto, "utf8") > maxBytes) throw new HttpError(413, MSG.dadosInvalidos, "corpo_grande");

  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new HttpError(400, MSG.dadosInvalidos, "json_invalido");
  }
  const r = schema.safeParse(bruto);
  if (!r.success) throw new HttpError(400, MSG.dadosInvalidos, "validacao");
  return r.data;
}

/**
 * Envolve toda mutação: request id, CSRF obrigatório e tradução de erros
 * para mensagens genéricas (detalhes só no log, sem dados pessoais).
 */
export function mutacao(rota: string, fn: (ctx: Contexto) => Promise<Response>) {
  return async function handler(req: Request): Promise<Response> {
    const ctx: Contexto = { req, requestId: randomUUID(), setCookies: [] };
    const inicio = Date.now();
    try {
      const falha = checarCsrf(req, getSecurityEnv().SITE_URL);
      if (falha) throw new HttpError(403, MSG.csrf, `csrf_${falha}`);
      const resposta = await fn(ctx);
      log("info", { evento: "requisicao", rota, status: resposta.status, requestId: ctx.requestId, duracaoMs: Date.now() - inicio });
      return resposta;
    } catch (e) {
      return traduzirErro(e, rota, ctx);
    }
  };
}

export function traduzirErro(e: unknown, rota: string, ctx: Contexto): Response {
  if (e instanceof HttpError) {
    log(e.status >= 500 ? "error" : "warn", { evento: "recusada", rota, status: e.status, motivo: e.reason, requestId: ctx.requestId });
    return erro(e.status, e.publicMessage, ctx, e.headers);
  }
  if (e instanceof DependencyUnavailableError) {
    log("error", { evento: "dependencia_fora", rota, dependencia: e.dependency, requestId: ctx.requestId });
    return erro(503, MSG.indisponivel, ctx, { "Retry-After": "30" });
  }
  if (e instanceof HibpIndisponivelError) {
    log("error", { evento: "dependencia_fora", rota, dependencia: "hibp", requestId: ctx.requestId });
    return erro(503, MENSAGEM_SENHA.indisponivel, ctx, { "Retry-After": "30" });
  }
  if (e instanceof RpcError) {
    const status = e.httpStatus();
    log(status >= 500 ? "error" : "warn", { evento: "rpc_erro", rota, codigo: e.code, status, requestId: ctx.requestId });
    const msg = status === 401 ? MSG.sessao : status === 403 ? MSG.semPermissao : status >= 500 ? MSG.generico : MSG.dadosInvalidos;
    return erro(status, msg, ctx);
  }
  log("error", { evento: "erro_inesperado", rota, requestId: ctx.requestId });
  return erro(500, MSG.generico, ctx);
}
