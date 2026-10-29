import { z } from "zod";
import { getSupabaseEnv } from "@/lib/env";
import {
  CPF_LIVE,
  ID_LIVE,
  mascararNomeLive,
  mascararPixLive,
  mascararTextoLive,
} from "@/lib/mascara";
import { mascaraCpf, mascaraTelefone, type TipoPix } from "@/lib/validacao/pedido";
import { decifrar, getChavesDeCifra, type Campo } from "../cripto";
import { HttpError, MSG } from "../errors";
import { json, lerCorpo, mutacao } from "../http";
import { log } from "../log";
import { getKeyring, hmac } from "../keys";
import { RpcError, rpc } from "../postgrest";
import { contarOuFalhar } from "../ratelimit";
import { agendarLimpeza } from "../limpeza";
import { exigirStaff, lerClaims, type ContextoStaff } from "../sessao-staff";
import { nomeNoBucket, urlAssinada } from "../storage";
import { zId } from "../validacao";
import { limitePainel } from "./bancas";

/**
 * Atendimento no painel (ARCHITECTURE §5.6, §5.8).
 * - O banco devolve os dados pessoais CIFRADOS. Este módulo decifra e, com o modo
 *   live ligado (padrão em todo login), devolve só a máscara: o valor real não
 *   chega ao navegador. Revelar/copiar Pix é pedido a pedido e auditado no banco.
 * - Toda regra de trava, prazo, vaga e permissão é conferida NO BANCO; aqui só se
 *   traduz o erro para uma mensagem.
 */

// ---------------------------------------------------------------------------
// Tradução dos erros das funções de atendimento
// ---------------------------------------------------------------------------
const ERROS: Record<string, [number, string]> = {
  BP001: [409, "Este pedido está com outro moderador."],
  BP002: [409, "Este pedido já foi finalizado."],
  BP003: [409, "Não há mais vagas nesta banca."],
  BP004: [409, "Assuma o pedido antes."],
  BP005: [400, MSG.dadosInvalidos],
  P0002: [404, "Não encontrado. Ele pode ter sido apagado."],
};

async function chamar<T>(staff: ContextoStaff, funcao: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await rpc<T>(funcao, args, { token: staff.token });
  } catch (e) {
    const m = e instanceof RpcError ? ERROS[e.code] : undefined;
    if (m) throw new HttpError(m[0], m[1], `rpc_${(e as RpcError).code}`);
    throw e;
  }
}

function decifrarCampo(id: string, campo: Campo, valor: string): string | null {
  // "v0:" = dado apagado a pedido do titular (D-018): não há o que decifrar.
  if (valor.startsWith("v0:")) return null;
  try {
    return decifrar(getChavesDeCifra(), campo, id, valor);
  } catch {
    log("error", { evento: "decifra_falhou", motivo: campo });
    return null;
  }
}

const formatarPix = (tipo: TipoPix, v: string) =>
  tipo === "cpf" ? mascaraCpf(v) : tipo === "telefone" ? mascaraTelefone(v) : v;

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------
export type ItemFila = {
  id: string;
  seq: number;
  status: "pendente" | "pago" | "recusado";
  posicao: number | null;
  nome: string;
  criado_em: string;
  atendente: string | null;
  meu: boolean;
  prazo: string | null;
  motivo: string | null;
  tem_comprovante: boolean;
  ultima_autor: "espectador" | "staff" | "sistema" | null;
  ultima_em: string | null;
};

export type Fila = {
  live: boolean;
  banca: {
    id: string;
    nome: string;
    codigo: string | null;
    status: string;
    vagas: number;
    pagas: number;
    por_pessoa_cents: number;
    sobra_cents: number;
    recebidos: number;
    recusados: number;
    total_pago_cents: number;
  };
  pedidos: ItemFila[];
};

type FilaBruta = Omit<Fila, "pedidos"> & { pedidos: (Omit<ItemFila, "nome"> & { nome_enc: string })[] };

export async function carregarFila(staff: ContextoStaff, bancaId: string, finalizados: boolean): Promise<Fila> {
  const f = await chamar<FilaBruta>(staff, "staff_list_queue", { p_banca: bancaId, p_finalizados: finalizados });
  return {
    live: f.live,
    banca: f.banca,
    pedidos: f.pedidos.map(({ nome_enc, ...p }) => {
      const nome = decifrarCampo(p.id, "orders.full_name_enc", nome_enc) ?? "********";
      return { ...p, nome: f.live ? mascararNomeLive(nome) : nome };
    }),
  };
}

const corpoFila = z.object({ banca: zId, finalizados: z.boolean().default(false) });

export const postFila = mutacao("painel/fila", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoFila, 256);
  const staff = await exigirStaff(ctx.req);
  return json(await carregarFila(staff, d.banca, d.finalizados), 200, ctx);
});

// ---------------------------------------------------------------------------
// Detalhe do pedido
// ---------------------------------------------------------------------------
export type PedidoPainel = {
  id: string;
  seq: number;
  /** Número do pedido dentro da banca (#1, #2...; D-089). */
  numero: number;
  status: "pendente" | "pago" | "recusado";
  criado_em: string;
  atendente: string | null;
  meu: boolean;
  prazo: string | null;
  motivo: string | null;
  nota: string | null;
  tem_comprovante: boolean;
  pix_tipo: TipoPix;
  pago_por: string | null;
  pago_em: string | null;
  recusado_por: string | null;
  recusado_em: string | null;
  apagado: boolean;
};

export type MensagemPainel = {
  id: string;
  autor: "espectador" | "staff" | "sistema";
  texto: string | null;
  tem_anexo: boolean;
  anexo: string | null;
  atendente: string | null;
  criada_em: string;
};

export type SinaisFraude = { mesmo_pix: number; mesmo_id: number; comprovante_repetido: number };

export type DetalhePedido = {
  live: boolean;
  pedido: PedidoPainel;
  sinais: SinaisFraude;
  dados: { nome: string; cpf: string; pixTipo: TipoPix; pix: string; plataformaId: string | null };
  banca: { id: string; nome: string; status: string; por_pessoa_cents: number; restantes: number };
  mensagens: MensagemPainel[];
};

type DetalheBruto = Omit<DetalhePedido, "live" | "dados" | "pedido"> & {
  pedido: PedidoPainel & { enc: { nome: string; cpf: string; pix: string; pid: string | null } };
};

export async function carregarPedido(staff: ContextoStaff, id: string): Promise<DetalhePedido> {
  const b = await chamar<DetalheBruto>(staff, "staff_get_order", { p_order: id });
  const { enc, ...pedido } = b.pedido;
  const live = staff.liveMode;
  const tipo = pedido.pix_tipo;
  const nome = decifrarCampo(id, "orders.full_name_enc", enc.nome) ?? "********";
  const APAGADO = "(apagado a pedido do titular)";
  const dados = pedido.apagado
    ? { nome: APAGADO, cpf: APAGADO, pixTipo: tipo, pix: APAGADO, plataformaId: enc.pid ? APAGADO : null }
    : live
    ? { nome: mascararNomeLive(nome), cpf: CPF_LIVE, pixTipo: tipo, pix: mascararPixLive(tipo), plataformaId: enc.pid ? ID_LIVE : null }
    : {
        nome,
        cpf: mascaraCpf(decifrarCampo(id, "orders.cpf_enc", enc.cpf) ?? ""),
        pixTipo: tipo,
        pix: formatarPix(tipo, decifrarCampo(id, "orders.pix_key_enc", enc.pix) ?? ""),
        // Pedidos novos não têm ID na casa (D-089).
        plataformaId: enc.pid ? (decifrarCampo(id, "orders.platform_id_enc", enc.pid) ?? "") : null,
      };
  return {
    live,
    pedido,
    sinais: b.sinais,
    dados,
    banca: b.banca,
    // D-015: com o modo live ligado, dados digitados pelo espectador no chat também são mascarados.
    mensagens: b.mensagens.map((m) =>
      live && m.autor === "espectador" && m.texto ? { ...m, texto: mascararTextoLive(m.texto) } : m,
    ),
  };
}

const corpoId = z.object({ id: zId });

export const postDetalhePedido = mutacao("painel/pedidos/detalhe", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoId, 256);
  const staff = await exigirStaff(ctx.req);
  return json(await carregarPedido(staff, d.id), 200, ctx);
});

// ---------------------------------------------------------------------------
// Ações (todas com chave de idempotência gerada no navegador)
// ---------------------------------------------------------------------------
const corpoAcao = z.object({ id: zId, idem: zId });

function acaoSimples(rota: string, funcao: string, opcoes: { owner?: boolean } = {}) {
  return mutacao(`painel/pedidos/${rota}`, async (ctx) => {
    const d = await lerCorpo(ctx.req, corpoAcao, 256);
    const staff = await exigirStaff(ctx.req, opcoes);
    await limitePainel(staff.userId);
    const r = await chamar<Record<string, unknown>>(staff, funcao, { p_order: d.id, p_idem: d.idem });
    return json(r, 200, ctx);
  });
}

export const postAssumir = acaoSimples("assumir", "staff_claim");
export const postForcarAssumir = acaoSimples("forcar", "owner_force_claim", { owner: true });
export const postLiberar = acaoSimples("liberar", "staff_release");
export const postPagar = acaoSimples("pagar", "staff_mark_paid");

const corpoMensagem = z.object({
  id: zId,
  texto: z
    .string()
    .transform((t) => t.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(z.string().min(1).max(1000)),
});

export const postMensagemStaff = mutacao("painel/pedidos/mensagem", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoMensagem, 6000);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  const id = await chamar<string>(staff, "staff_send_message", { p_order: d.id, p_body: d.texto });
  return json({ id }, 201, ctx);
});

const corpoRecusar = z.object({
  id: zId,
  idem: zId,
  motivo: z.enum(["comprovante_ilegivel", "deposito_nao_encontrado", "dados_divergentes", "outro"]),
  nota: z.string().trim().max(280).optional(),
});

export const postRecusar = mutacao("painel/pedidos/recusar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoRecusar, 1024);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  const r = await chamar<Record<string, unknown>>(staff, "staff_refuse", {
    p_order: d.id,
    p_reason: d.motivo,
    p_note: d.nota || null,
    p_idem: d.idem,
  });
  return json(r, 200, ctx);
});

const corpoBanir = z
  .object({
    id: zId,
    idem: zId,
    tipo: z.enum(["cpf", "pix", "platform_id", "ip"]),
    escopo: z.enum(["global", "banca"]),
    motivo: z.string().trim().min(3).max(280),
    horas: z.number().int().min(1).max(8760).nullable().default(null),
  })
  .refine((d) => d.tipo !== "ip" || (d.horas !== null && d.horas <= 168), { path: ["horas"] });

export const postBanir = mutacao("painel/pedidos/banir", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoBanir, 1024);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  const r = await chamar<Record<string, unknown>>(staff, "staff_ban", {
    p_order: d.id,
    p_kind: d.tipo,
    p_scope: d.escopo,
    p_reason: d.motivo,
    p_expires_hours: d.horas,
    p_idem: d.idem,
  });
  return json(r, 200, ctx);
});

// ---------------------------------------------------------------------------
// Revelar (modo live) e copiar Pix: um campo por vez, auditado no banco
// ---------------------------------------------------------------------------
const CAMPOS: Record<"nome" | "cpf" | "pix" | "pid", Campo> = {
  nome: "orders.full_name_enc",
  cpf: "orders.cpf_enc",
  pix: "orders.pix_key_enc",
  pid: "orders.platform_id_enc",
};

const corpoRevelar = z.object({ id: zId, campo: z.enum(["nome", "cpf", "pix", "pid"]) });

async function revelar(staff: ContextoStaff, id: string, campo: keyof typeof CAMPOS, acao: "revelar" | "copiar_pix") {
  // Revelar é um a um e com limite próprio (T21): 30 por minuto por pessoa. Redis fora = bloqueia.
  const lim = await contarOuFalhar("revelar", hmac(getKeyring(), "rl-staff", staff.userId).toString("hex"), 30, 60);
  if (!lim.permitido) {
    throw new HttpError(429, "Muitas revelações seguidas. Espere um pouco.", "rate_limit_revelar", {
      "Retry-After": String(lim.tentarEmSeg),
    });
  }
  const enc = await chamar<string>(staff, "staff_reveal", { p_order: id, p_campo: campo, p_acao: acao });
  const valor = decifrarCampo(id, CAMPOS[campo], enc);
  if (valor === null) throw new HttpError(500, MSG.generico, "decifra");
  return valor;
}

export const postRevelar = mutacao("painel/pedidos/revelar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoRevelar, 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  let valor = await revelar(staff, d.id, d.campo, "revelar");
  if (d.campo === "cpf") valor = mascaraCpf(valor);
  return json({ valor }, 200, ctx);
});

/** O valor vai direto para a área de transferência no navegador, sem passar pela tela. */
export const postCopiarPix = mutacao("painel/pedidos/copiar-pix", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoId, 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  return json({ valor: await revelar(staff, d.id, "pix", "copiar_pix") }, 200, ctx);
});

// ---------------------------------------------------------------------------
// Modo live, banimentos e respostas rápidas
// ---------------------------------------------------------------------------
export const postModoLive = mutacao("painel/modo-live", async (ctx) => {
  const d = await lerCorpo(ctx.req, z.object({ ligado: z.boolean() }), 64);
  const staff = await exigirStaff(ctx.req);
  const ligado = await chamar<boolean>(staff, "staff_set_live_mode", { p_ligado: d.ligado });
  return json({ ligado }, 200, ctx);
});

export const postDesbanir = mutacao("painel/banidos/desbanir", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoId, 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  await chamar(staff, "staff_lift_ban", { p_ban: d.id });
  return json({ ok: true }, 200, ctx);
});

export type Ban = {
  id: string;
  tipo: "cpf" | "pix" | "platform_id" | "ip";
  escopo: "global" | "banca";
  banca: string | null;
  motivo: string;
  autor: string | null;
  criado_em: string;
  expira_em: string | null;
  revisao_em: string | null;
  revisao_vencida: boolean;
  pode_desbanir: boolean;
};

export function listarBans(staff: ContextoStaff): Promise<Ban[]> {
  return chamar<Ban[]>(staff, "staff_list_bans", {});
}

export type RespostaRapida = { id: string; label: string; body: string; sort: number };

export function listarRespostas(staff: ContextoStaff): Promise<RespostaRapida[]> {
  return chamar<RespostaRapida[]>(staff, "staff_list_quick_replies", {});
}

export const postRespostas = mutacao("painel/respostas", async (ctx) => {
  const staff = await exigirStaff(ctx.req);
  return json(await listarRespostas(staff), 200, ctx);
});

const corpoSalvarResposta = z.object({
  id: zId.nullable().default(null),
  rotulo: z.string().trim().min(1).max(40),
  texto: z.string().trim().min(1).max(500),
  ordem: z.number().int().min(0).max(1000).nullable().default(null),
});

export const postSalvarResposta = mutacao("painel/respostas/salvar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoSalvarResposta, 2048);
  const staff = await exigirStaff(ctx.req, { owner: true });
  const id = await chamar<string>(staff, "owner_save_quick_reply", {
    p_id: d.id,
    p_label: d.rotulo,
    p_body: d.texto,
    p_sort: d.ordem,
  });
  return json({ id }, 200, ctx);
});

export const postRemoverResposta = mutacao("painel/respostas/remover", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoId, 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await chamar(staff, "owner_delete_quick_reply", { p_id: d.id });
  return json({ ok: true }, 200, ctx);
});

// ---------------------------------------------------------------------------
// Tempo real do painel: o access token curto do staff (D-027) para OUVIR staff:{banca}
// ---------------------------------------------------------------------------
export const postRealtimePainel = mutacao("painel/realtime", async (ctx) => {
  const d = await lerCorpo(ctx.req, z.object({ banca: zId }), 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  const exp = lerClaims(staff.token)?.exp ?? 0;
  const sb = getSupabaseEnv();
  return json(
    {
      url: sb.SUPABASE_URL,
      chavePublica: sb.SUPABASE_ANON_KEY,
      token: staff.token,
      expiraEmSeg: Math.max(0, exp - Math.floor(Date.now() / 1000)),
      topico: `staff:${d.banca}`,
    },
    200,
    ctx,
  );
});

// ---------------------------------------------------------------------------
// Comprovante (URL assinada de 60 s; abrir fica na auditoria, D-016)
// ---------------------------------------------------------------------------
export const postComprovanteStaff = mutacao("painel/pedidos/comprovante", async (ctx) => {
  const d = await lerCorpo(ctx.req, z.object({ anexo: zId }), 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  const caminho = await chamar<string>(staff, "staff_attachment_path", { p_attachment: d.anexo });
  return json({ url: await urlAssinada(nomeNoBucket(caminho), 60) }, 200, ctx);
});

// ---------------------------------------------------------------------------
// Encerrar banca = apagar tudo na hora (D-044). Streamer ou moderador (D-045),
// digitando o nome da banca. Arquivos e contas anônimas saem logo depois.
// ---------------------------------------------------------------------------
const corpoEncerrar = z.object({ id: zId, nome: z.string().max(120), idem: zId });

export const postEncerrarBanca = mutacao("painel/bancas/encerrar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoEncerrar, 512);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  try {
    const r = await chamar<Record<string, unknown>>(staff, "staff_end_banca", {
      p_banca: d.id,
      p_confirm_name: d.nome,
      p_idem: d.idem,
    });
    agendarLimpeza();
    return json({ resumo: r, proximo: "/painel" }, 200, ctx);
  } catch (e) {
    if (e instanceof HttpError && e.reason === "rpc_BP005") {
      throw new HttpError(400, "O nome digitado não confere com o nome da banca.", "nome_confirmacao");
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Auditoria (só o streamer lê; ninguém altera)
// ---------------------------------------------------------------------------
export type RegistroAuditoria = {
  pos: number;
  em: string;
  acao: string;
  papel: "owner" | "moderator" | "sistema";
  autor: string | null;
  alvo: string | null;
  banca: string | null;
  pedido: string | null;
  detalhe: Record<string, unknown> | null;
};

export function listarAuditoria(staff: ContextoStaff, antes: number | null): Promise<RegistroAuditoria[]> {
  return chamar<RegistroAuditoria[]>(staff, "owner_list_audit", { p_limit: 100, p_antes: antes });
}

export function verificarAuditoria(staff: ContextoStaff): Promise<{ integra: boolean; quebra_em: number | null; registros: number }> {
  return chamar(staff, "owner_verify_audit", {});
}

// ---------------------------------------------------------------------------
// Apagar os dados a pedido do titular (o espectador pede pelo chat; D-083)
// ---------------------------------------------------------------------------
export const postApagarDados = mutacao("painel/pedidos/apagar-dados", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoId, 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  await chamar(staff, "staff_erase_order", { p_order: d.id });
  // Comprovantes e conta anônima saem do Storage/Auth logo em seguida.
  agendarLimpeza();
  return json({ ok: true }, 200, ctx);
});
