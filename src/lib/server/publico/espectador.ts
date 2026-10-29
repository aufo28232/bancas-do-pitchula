import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getSecurityEnv, getSupabaseEnv } from "@/lib/env";
import { mascararCpf, mascararNome, mascararPix, mascararPlataformaId } from "@/lib/mascara";
import type { TipoPix } from "@/lib/validacao/pedido";
import { apagarCookie, lerCookies, serializarCookie } from "../cookies";
import { decifrar, getChavesDeCifra, type Campo } from "../cripto";
import { HttpError, MSG } from "../errors";
import { renovar } from "../gotrue";
import { json, lerCorpo, mutacao } from "../http";
import { ipDoCliente } from "../ip";
import { getKeyring, hmac, toPgBytea } from "../keys";
import { log } from "../log";
import { rpc } from "../postgrest";
import { contarOuFalhar, contarOuPermitir } from "../ratelimit";
import { ImagemInvalidaError, LIMITE_BYTES, processarComprovante } from "../imagem";
import { BUCKET, apagarArquivos, nomeNoBucket, subirArquivo, urlAssinada } from "../storage";
import { zId } from "../validacao";

/**
 * Página do pedido do espectador (ARCHITECTURE §5.5, D-003, D-023, D-043).
 *
 * - Ao criar o pedido, o navegador já recebe uma sessão em cookie httpOnly
 *   (__Host-bp_ped) e vai direto para /pedido (D-082). O banco guarda só hashes.
 * - Na criação, o servidor faz o login ANÔNIMO do Supabase (Turnstile no captcha do
 *   Auth) e vincula esse usuário ao pedido. O refresh token fica em cookie httpOnly;
 *   o navegador recebe só o access token curto, que serve apenas para OUVIR o canal
 *   do próprio pedido no Realtime (RLS em realtime.messages).
 * - Dados pessoais saem decifrados e MASCARADOS: o valor completo não chega ao navegador.
 */
export const COOKIE_PEDIDO = "__Host-bp_ped";
export const COOKIE_PEDIDO_RT = "__Host-bp_ped_rt";
const VIDA_SESSAO_SEG = 30 * 24 * 3600;

const MSG_SEM_SESSAO = "Não encontramos um pedido aberto neste navegador.";

const hashSessao = (s: string) => createHash("sha256").update(`ped-sessao\u0000${s}`, "utf8").digest();

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
// Sessão do pedido: aberta na hora em que o pedido é criado (D-082)
// ---------------------------------------------------------------------------
/**
 * Liga o navegador ao pedido recém-criado: cookie de sessão (o banco guarda só o
 * hash) + refresh token da conta anônima (só para o Realtime). Os dois são
 * httpOnly, Secure, SameSite=Strict, e valem até o encerramento da banca.
 */
export async function abrirSessaoPedido(
  ctx: { setCookies: string[] },
  hashTokenAcesso: Buffer,
  anon: { userId: string; refresh_token: string },
): Promise<void> {
  const sessao = randomBytes(32).toString("base64url");
  const hSessao = toPgBytea(hashSessao(sessao));
  const pedido = await rpc<string | null>(
    "srv_open_order_session",
    { p_token_hash: toPgBytea(hashTokenAcesso), p_session_hash: hSessao },
    "servico",
  );
  const vinculado = pedido
    ? await rpc<boolean>("srv_bind_viewer", { p_session_hash: hSessao, p_viewer: anon.userId }, "servico")
    : false;
  if (!vinculado) throw new HttpError(500, MSG.generico, "sessao_pedido");
  ctx.setCookies.push(
    serializarCookie(COOKIE_PEDIDO, sessao, { maxAge: VIDA_SESSAO_SEG }),
    serializarCookie(COOKIE_PEDIDO_RT, anon.refresh_token, { maxAge: VIDA_SESSAO_SEG }),
  );
}

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
    enc: { nome: string; cpf: string; pix: string; pid: string | null };
  };
  banca: { id: string; nome: string; codigo: string | null; status: string };
  mensagens: {
    id: string;
    autor: "espectador" | "staff" | "sistema";
    texto: string | null;
    tem_anexo: boolean;
    anexo: string | null;
    atendente: string | null;
    criada_em: string;
  }[];
};

export type EstadoPedido = {
  pedido: Omit<EstadoBruto["pedido"], "enc" | "pix_tipo">;
  dados: { nome: string; cpf: string; pixTipo: TipoPix; pix: string; plataformaId: string | null };
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
      plataformaId: enc.pid ? decifrarMascarado(pedido.id, "orders.platform_id_enc", enc.pid, mascararPlataformaId) : null,
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
// POST /api/pedido/mensagem: resposta do espectador (zera o prazo de 10 min)
// ---------------------------------------------------------------------------
const corpoMensagem = z.object({
  texto: z
    .string()
    .transform((t) => t.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(z.string().min(1).max(1000)),
});

export const postMensagemPedido = mutacao("pedido/mensagem", async (ctx) => {
  const s = exigirSessao(ctx.req);
  // 10 por minuto, 1 a cada 2 s e 30 por hora (D-021). Redis fora = bloqueia.
  const limites = await Promise.all([
    contarOuFalhar("pedido-msg", s.idRl, 10, 60),
    contarOuFalhar("pedido-msg-rajada", s.idRl, 1, 2),
    contarOuFalhar("pedido-msg-hora", s.idRl, 30, 3600),
  ]);
  const estourados = limites.filter((l) => !l.permitido);
  if (estourados.length > 0) {
    throw new HttpError(429, "Você está mandando mensagens rápido demais. Espere um pouco.", "rate_limit", {
      "Retry-After": String(Math.max(...estourados.map((l) => l.tentarEmSeg))),
    });
  }
  const d = await lerCorpo(ctx.req, corpoMensagem, 6000);
  const r = await rpc<string>("srv_viewer_post_message", { p_session_hash: s.hash, p_body: d.texto }, "servico");
  if (r === "sessao") semSessao(ctx);
  if (r === "finalizado") throw new HttpError(409, "Este pedido já foi finalizado e não recebe mais mensagens.", "finalizado");
  return json({ ok: true }, 201, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/pedido/comprovante: imagem crua no corpo (sem multipart)
// ---------------------------------------------------------------------------
const MSG_IMAGEM = "Envie uma foto ou print em JPG, PNG ou WEBP, com até 5 MB.";

/** Lê o corpo parando assim que passar do limite (não depende do Content-Length declarado). */
async function lerAteLimite(req: Request, limite: number): Promise<Buffer> {
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > limite) throw new HttpError(413, MSG_IMAGEM, "imagem_grande");
  if (!req.body) throw new HttpError(400, MSG_IMAGEM, "sem_corpo");
  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel().catch(() => undefined);
      throw new HttpError(413, MSG_IMAGEM, "imagem_grande");
    }
    partes.push(value);
  }
  return Buffer.concat(partes);
}

export const postComprovante = mutacao("pedido/comprovante", async (ctx) => {
  const s = exigirSessao(ctx.req);
  const env = getSecurityEnv();
  const idIp = hmac(getKeyring(), "rl-ip", ipDoCliente(ctx.req.headers, env.DEPLOY_MODE)).toString("hex");
  // Redis fora = bloqueia (envio de arquivo é operação crítica).
  const [porIp, porSessao] = await Promise.all([
    contarOuFalhar("comprovante-ip", idIp, 20, 600),
    contarOuFalhar("comprovante-sessao", s.idRl, 10, 600),
  ]);
  if (!porIp.permitido || !porSessao.permitido) {
    throw new HttpError(429, MSG.muitasTentativas, "rate_limit", {
      "Retry-After": String(Math.max(porIp.tentarEmSeg, porSessao.tentarEmSeg)),
    });
  }

  const original = await lerAteLimite(ctx.req, LIMITE_BYTES);
  let img;
  try {
    img = await processarComprovante(original);
  } catch (e) {
    if (e instanceof ImagemInvalidaError) throw new HttpError(e.motivo === "tamanho" ? 413 : 400, MSG_IMAGEM, `imagem_${e.motivo}`);
    throw e;
  }

  // O banco confere sessão, estado e limite; o caminho segue o formato {banca}/{pedido}/{id}.webp.
  const estado = await rpc<EstadoBruto | null>("srv_viewer_state", { p_session_hash: s.hash }, "servico");
  if (!estado) semSessao(ctx);
  if (estado.pedido.status !== "pendente") {
    throw new HttpError(409, "Este pedido já foi finalizado e não recebe mais comprovantes.", "finalizado");
  }
  const id = randomUUID();
  const caminho = `${BUCKET}/${estado.banca.id}/${estado.pedido.id}/${id}.webp`;
  await subirArquivo(nomeNoBucket(caminho), img.webp, "image/webp");
  let r: string;
  try {
    r = await rpc<string>(
      "srv_viewer_add_attachment",
      {
        p_session_hash: s.hash,
        p_id: id,
        p_path: caminho,
        p_bytes: img.webp.length,
        p_width: img.largura,
        p_height: img.altura,
        p_sha256: toPgBytea(img.sha256),
      },
      "servico",
    );
  } catch (e) {
    await apagarArquivos([nomeNoBucket(caminho)]).catch(() => undefined);
    throw e;
  }
  if (r !== "ok") {
    // Não entrou no banco: o arquivo não pode ficar órfão no Storage.
    await apagarArquivos([nomeNoBucket(caminho)]).catch(() => undefined);
    if (r === "sessao") semSessao(ctx);
    if (r === "limite") throw new HttpError(409, "Você já mandou 5 comprovantes neste pedido.", "limite");
    throw new HttpError(409, "Este pedido já foi finalizado e não recebe mais comprovantes.", "finalizado");
  }
  return json({ id }, 201, ctx);
});

// POST /api/pedido/comprovante/ver: URL assinada de 60 s, só para o dono do pedido.
export const postVerComprovante = mutacao("pedido/comprovante/ver", async (ctx) => {
  const s = exigirSessao(ctx.req);
  const d = await lerCorpo(ctx.req, z.object({ id: zId }), 256);
  const lim = await contarOuPermitir("comprovante-ver", s.idRl, 60, 600);
  if (!lim.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit");
  const caminho = await rpc<string | null>("srv_viewer_attachment_path", { p_session_hash: s.hash, p_attachment: d.id }, "servico");
  if (!caminho) throw new HttpError(404, "Comprovante não encontrado.", "anexo");
  return json({ url: await urlAssinada(nomeNoBucket(caminho), 60) }, 200, ctx);
});
