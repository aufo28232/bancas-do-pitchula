import { randomUUID, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { adminApagarUsuario } from "./gotrue";
import { log } from "./log";
import { rpc } from "./postgrest";
import { apagarArquivos, nomeNoBucket } from "./storage";

/**
 * Trabalhador de limpeza (D-075). O banco põe numa fila o que só as APIs do
 * Supabase conseguem apagar (arquivos do Storage e contas anônimas do Auth) e este
 * código, com a service role, apaga em lotes e marca como feito. Até 5 tentativas
 * por item; o erro fica registrado sem dado pessoal.
 *
 * Roda: logo depois de encerrar uma banca (sem esperar), a cada hora pelo pg_cron
 * (pg_net chama POST /api/interno/limpeza) ou por qualquer cron externo.
 */
type Lote = { arquivos: { id: number; caminho: string }[]; usuarios: string[] };
export type ResultadoLimpeza = { arquivos: number; usuarios: number; falhas: number };

export async function executarLimpeza(maxLotes = 10): Promise<ResultadoLimpeza> {
  const total: ResultadoLimpeza = { arquivos: 0, usuarios: 0, falhas: 0 };
  for (let i = 0; i < maxLotes; i++) {
    const lote = await rpc<Lote>("srv_purge_batch", { p_limit: 100 }, "servico");
    if (lote.arquivos.length === 0 && lote.usuarios.length === 0) break;

    const arquivosOk: number[] = [];
    const arquivosErro: number[] = [];
    try {
      await apagarArquivos(lote.arquivos.map((a) => nomeNoBucket(a.caminho)));
      arquivosOk.push(...lote.arquivos.map((a) => a.id));
    } catch {
      arquivosErro.push(...lote.arquivos.map((a) => a.id));
    }

    const usuariosOk: string[] = [];
    const usuariosErro: string[] = [];
    for (const u of lote.usuarios) {
      try {
        if (await adminApagarUsuario(u)) usuariosOk.push(u);
        else usuariosErro.push(u);
      } catch {
        usuariosErro.push(u);
      }
    }

    await rpc(
      "srv_purge_done",
      {
        p_arquivos_ok: arquivosOk,
        p_arquivos_erro: arquivosErro,
        p_usuarios_ok: usuariosOk,
        p_usuarios_erro: usuariosErro,
        p_erro: arquivosErro.length + usuariosErro.length > 0 ? "falha na API do Supabase" : null,
      },
      "servico",
    );
    total.arquivos += arquivosOk.length;
    total.usuarios += usuariosOk.length;
    total.falhas += arquivosErro.length + usuariosErro.length;
    // Tudo falhou neste lote: para e deixa para a próxima rodada.
    if (arquivosOk.length + usuariosOk.length === 0) break;
  }
  return total;
}

/** Chamado depois de encerrar uma banca, sem segurar a resposta. */
export async function limparEmSegundoPlano(): Promise<void> {
  try {
    const r = await executarLimpeza();
    log("info", { evento: "limpeza", quantidade: r.arquivos + r.usuarios, tentativas: r.falhas });
  } catch {
    log("error", { evento: "limpeza_falhou" });
  }
}

/**
 * Agenda a limpeza para DEPOIS da resposta (after do Next). Fora de uma requisição
 * (testes, scripts), roda na hora sem esperar.
 */
export function agendarLimpeza(): void {
  try {
    after(limparEmSegundoPlano);
  } catch {
    void limparEmSegundoPlano();
  }
}

function segredoConfere(recebido: string | null): boolean {
  const esperado = process.env.LIMPEZA_SECRET ?? "";
  if (esperado.length < 32 || !recebido?.startsWith("Bearer ")) return false;
  const a = Buffer.from(recebido.slice(7), "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/interno/limpeza (servidor-a-servidor, sem cookie nem CSRF):
 * exige `Authorization: Bearer <LIMPEZA_SECRET>`. Sem a variável configurada, a rota
 * não existe (404). Roda a manutenção do banco e depois a limpeza.
 */
export async function postLimpeza(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const cabecalhos = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId };
  if (!process.env.LIMPEZA_SECRET) return new Response(JSON.stringify({ erro: "não encontrado" }), { status: 404, headers: cabecalhos });
  if (!segredoConfere(req.headers.get("authorization"))) {
    log("warn", { evento: "recusada", rota: "interno/limpeza", status: 401, requestId });
    return new Response(JSON.stringify({ erro: "não autorizado" }), { status: 401, headers: cabecalhos });
  }
  try {
    const manutencao = await rpc<Record<string, number>>("srv_maintenance", {}, "servico");
    const limpeza = await executarLimpeza();
    log("info", { evento: "limpeza", rota: "interno/limpeza", status: 200, requestId });
    return new Response(JSON.stringify({ manutencao, limpeza }), { status: 200, headers: cabecalhos });
  } catch {
    log("error", { evento: "limpeza_falhou", rota: "interno/limpeza", requestId });
    return new Response(JSON.stringify({ erro: "falhou" }), { status: 503, headers: cabecalhos });
  }
}
