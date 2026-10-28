import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getSecurityEnv, getSupabaseEnv } from "@/lib/env";
import { mascararCpf, mascararNome, mascararPix, mascararPlataformaId } from "@/lib/mascara";
import type { TipoPix } from "@/lib/validacao/pedido";
import { apagarCookie, lerCookies, serializarCookie } from "../cookies";
import { decifrar, getChavesDeCifra, type Campo } from "../cripto";
import { HttpError, MSG } from "../errors";
import { adminApagarUsuario, entrarAnonimo, renovar } from "../gotrue";
import { json, lerCorpo, mutacao } from "../http";
import { ipDoCliente } from "../ip";
import { getKeyring, hmac, toPgBytea } from "../keys";
import { log } from "../log";
import { rpc } from "../postgrest";
import { contarOuFalhar, contarOuPermitir } from "../ratelimit";
import { zTurnstile } from "../validacao";

/**
 * Página do pedido do espectador (ARCHITECTURE §5.5, D-003, D-023, D-043).
 *
 * - O link traz o token no FRAGMENTO. A página lê, apaga da barra de endereço e
 *   troca por uma sessão em cookie httpOnly (__Host-bp_ped). O banco guarda só hashes.
 * - Na troca, o servidor faz o login ANÔNIMO do Supabase (Turnstile no captcha do
 *   Auth) e vincula esse usuário ao pedido. O refresh token fica em cookie httpOnly;
 *   o navegador recebe só o access token curto, que serve apenas para OUVIR o canal
 *   do próprio pedido no Realtime (RLS em realtime.messages).
 * - Dados pessoais saem decifrados e MASCARADOS: o valor completo não chega ao navegador.
 */
export const COOKIE_PEDIDO = "__Host-bp_ped";
export const COOKIE_PEDIDO_RT = "__Host-bp_ped_rt";
const VIDA_SESSAO_SEG = 30 * 24 * 3600;

const MSG_LINK = "Este link de pedido não é válido ou já expirou.";
const MSG_SEM_SESSAO = "Abra de novo o link do seu pedido.";

const hashSessao = (s: string) => createHash("sha256").update(`ped-sessao\u0000${s}`, "utf8").digest();
const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest();

function sessaoDoCookie(req: Request): string | null {
  const v = lerCookies(req.headers.get("cookie"))[COOKIE_PEDIDO];
  return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

function exigirSessao(req: Request): { sessao: string; hash: string; idRl: string } {
  const sessao = sessaoDoCookie(req);
  if (!sessao) throw new HttpError(401, MSG_SEM_SESSAO, "sem_sessao_pedido");
  const h = hashSessao(sessao);
  return { sessao, hash: toPgBytea(h), idRl: h.toString("hex").slice(0, 32) };
}

// ---------------------------------------------------------------------------
// POST /api/pedido/sessao: troca o token do link por cookie + login anônimo
// ---------------------------------------------------------------------------
const corpoSessao = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  turnstile: zTurnstile,
});

export const postSessaoPedido = mutacao("pedido/sessao", async (ctx) => {
  const env = getSecurityEnv();
  const ip = ipDoCliente(ctx.req.headers, env.DEPLOY_MODE);
  const idIp = hmac(getKeyring(), "rl-ip", ip).toString("hex");

  // Redis fora = bloqueia (cria conta anônima no Auth).
  const lim = await contarOuFalhar("pedido-sessao-ip", idIp, 20, 600);
  if (!lim.permitido) {
    throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(lim.tentarEmSeg) });
  }

  const d = await lerCorpo(ctx.req, corpoSessao, 4096);

  // O Supabase Auth confere o Turnstile (captcha nativo, D-054). Inválido = recusa.
  const anon = await entrarAnonimo(d.turnstile);
  if (!anon) {
    throw new HttpError(400, "Não foi possível confirmar que você é uma pessoa. Recarregue e tente de novo.", "captcha");
  }

  const sessao = randomBytes(32).toString("base64url");
  const hSessao = toPgBytea(hashSessao(sessao));
  const pedido = await rpc<string | null>(
    "srv_open_order_session",
    { p_token_hash: toPgBytea(hashToken(d.token)), p_session_hash: hSessao },
    "servico",
  );
  if (!pedido) {
    // Link inválido: a conta anônima recém-criada não serve para nada.
    await adminApagarUsuario(anon.userId).catch(() => undefined);
    throw new HttpError(404, MSG_LINK, "token_invalido");
  }

  const vinculado = await rpc<boolean>("srv_bind_viewer", { p_session_hash: hSessao, p_viewer: anon.userId }, "servico");
  if (!vinculado) throw new HttpError(404, MSG_LINK, "vinculo");

  ctx.setCookies.push(
    serializarCookie(COOKIE_PEDIDO, sessao, { maxAge: VIDA_SESSAO_SEG }),
    serializarCookie(COOKIE_PEDIDO_RT, anon.refresh_token, { maxAge: VIDA_SESSAO_SEG }),
  );
  return json({ ok: true }, 200, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/pedido/estado: estado + mensagens, com dados mascarados
// ---------------------------------------------------------------------------
type EstadoBruto = {
  pedido: {
    id: string;
    status: "pendente" | "pago" | "recusado";
    posicao: number | null;
    em_atendimento: boolean;
    atendente: string | null;
    motivo: string | null;
    nota: string | null;
    prazo: string | null;
    criado_em: string;
    pix_tipo: TipoPix;
    enc: { nome: string; cpf: string; pix: string; pid: string };
  };
  banca: { nome: string; codigo: string | null; status: string };
  mensagens: {
    id: string;
    autor: "espectador" | "staff" | "sistema";
    texto: string | null;
    tem_anexo: boolean;
    atendente: string | null;
    criada_em: string;
  }[];
};

export type EstadoPedido = {
  pedido: Omit<EstadoBruto["pedido"], "enc" | "pix_tipo">;
  dados: { nome: string; cpf: string; pixTipo: TipoPix; pix: string; plataformaId: string };
  banca: EstadoBruto["banca"];
  mensagens: EstadoBruto["mensagens"];
};

function decifrarMascarado(id: string, campo: Campo, valor: string, mascara: (v: string) => string): string {
  try {
    return mascara(decifrar(getChavesDeCifra(), campo, id, valor));
  } catch {
    // Nunca ecoa o valor nem o erro de cifra; mostra só que existe.
    log("error", { evento: "decifra_falhou", motivo: campo });
    return "********";
  }
}

export function montarEstado(b: EstadoBruto): EstadoPedido {
  const { enc, pix_tipo, ...pedido } = b.pedido;
  return {
    pedido,
    dados: {
      nome: decifrarMascarado(pedido.id, "orders.full_name_enc", enc.nome, mascararNome),
      cpf: decifrarMascarado(pedido.id, "orders.cpf_enc", enc.cpf, mascararCpf),
      pixTipo: pix_tipo,
      pix: decifrarMascarado(pedido.id, "orders.pix_key_enc", enc.pix, (v) => mascararPix(pix_tipo, v)),
      plataformaId: decifrarMascarado(pedido.id, "orders.platform_id_enc", enc.pid, mascararPlataformaId),
    },
    banca: b.banca,
    mensagens: b.mensagens,
  };
}

function semSessao(ctx: { setCookies: string[] }): never {
  ctx.setCookies.push(apagarCookie(COOKIE_PEDIDO), apagarCookie(COOKIE_PEDIDO_RT));
  throw new HttpError(401, MSG_SEM_SESSAO, "sessao_pedido_invalida");
}

export const postEstadoPedido = mutacao("pedido/estado", async (ctx) => {
  const s = exigirSessao(ctx.req);
  // Leitura: Redis fora = permite (o polling de reserva não pode derrubar a página).
  const lim = await contarOuPermitir("pedido-estado", s.idRl, 60, 60);
  if (!lim.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(lim.tentarEmSeg) });

  const bruto = await rpc<EstadoBruto | null>("srv_viewer_state", { p_session_hash: s.hash }, "servico");
  if (!bruto) semSessao(ctx);
  return json(montarEstado(bruto), 200, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/pedido/realtime: access token curto para OUVIR o próprio canal
// ---------------------------------------------------------------------------
export const postRealtimePedido = mutacao("pedido/realtime", async (ctx) => {
  const s = exigirSessao(ctx.req);
  const lim = await contarOuFalhar("pedido-realtime", s.idRl, 30, 600);
  if (!lim.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(lim.tentarEmSeg) });

  const refresh = lerCookies(ctx.req.headers.get("cookie"))[COOKIE_PEDIDO_RT];
  const bruto = await rpc<EstadoBruto | null>("srv_viewer_state", { p_session_hash: s.hash }, "servico");
  if (!bruto || !refresh) semSessao(ctx);

  const tokens = await renovar(refresh);
  if (!tokens) semSessao(ctx);
  ctx.setCookies.push(serializarCookie(COOKIE_PEDIDO_RT, tokens.refresh_token, { maxAge: VIDA_SESSAO_SEG }));

  const sb = getSupabaseEnv();
  return json(
    {
      url: sb.SUPABASE_URL,
      chavePublica: sb.SUPABASE_ANON_KEY,
      token: tokens.access_token,
      expiraEmSeg: tokens.expires_in,
      topicos: {
        pedido: `pedido:${bruto.pedido.id}`,
        vagas: bruto.banca.codigo ? `vagas:${bruto.banca.codigo}` : null,
      },
    },
    200,
    ctx,
  );
});

// ---------------------------------------------------------------------------
// POST /api/pedido/mensagem: resposta do espectador (zera o prazo de 5 min)
// ---------------------------------------------------------------------------
const corpoMensagem = z.object({
  texto: z
    .string()
    .transform((t) => t.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(z.string().min(1).max(1000)),
});

export const postMensagemPedido = mutacao("pedido/mensagem", async (ctx) => {
  const s = exigirSessao(ctx.req);
  const [porMin, rajada] = await Promise.all([
    contarOuFalhar("pedido-msg", s.idRl, 10, 60),
    contarOuFalhar("pedido-msg-rajada", s.idRl, 1, 2),
  ]);
  if (!porMin.permitido || !rajada.permitido) {
    throw new HttpError(429, "Você está mandando mensagens rápido demais. Espere um pouco.", "rate_limit", {
      "Retry-After": String(Math.max(porMin.permitido ? 0 : porMin.tentarEmSeg, rajada.permitido ? 0 : rajada.tentarEmSeg)),
    });
  }
  const d = await lerCorpo(ctx.req, corpoMensagem, 6000);
  const r = await rpc<string>("srv_viewer_post_message", { p_session_hash: s.hash, p_body: d.texto }, "servico");
  if (r === "sessao") semSessao(ctx);
  if (r === "finalizado") throw new HttpError(409, "Este pedido já foi finalizado e não recebe mais mensagens.", "finalizado");
  return json({ ok: true }, 201, ctx);
});
