import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getSecurityEnv } from "@/lib/env";
import { HttpError, MSG } from "../errors";
import { adminApagarUsuario, adminCriarUsuario } from "../gotrue";
import { json, lerCorpo, mutacao } from "../http";
import { ipDoCliente } from "../ip";
import { getKeyring, hmac, toPgBytea } from "../keys";
import { rpc } from "../postgrest";
import { contarOuFalhar, contarOuPermitir } from "../ratelimit";
import { exigirStaff } from "../sessao-staff";
import { MENSAGEM_SENHA, problemaDeTamanho, senhaVazada } from "../senha";
import { verificarTurnstile } from "../turnstile";
import { zApelido, zEmail, zId, zTokenConvite, zTurnstile } from "../validacao";

const MSG_CONVITE_INVALIDO = "Convite inválido, expirado ou já usado. Peça um novo ao streamer.";

/** O banco guarda só o SHA-256 do token (ARCHITECTURE §6.4). */
export function hashDoToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function limitePainel(userId: string): Promise<void> {
  const r = await contarOuPermitir("painel", hmac(getKeyring(), "rl-staff", userId).toString("hex"), 120, 60);
  if (!r.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(r.tentarEmSeg) });
}

// POST /api/painel/convites/criar (só streamer) ------------------------------
export const postCriarConvite = mutacao("painel/convites/criar", async (ctx) => {
  const dados = await lerCorpo(ctx.req, z.object({ apelido: zApelido }), 512);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);

  const token = randomBytes(32).toString("base64url");
  const id = await rpc<string>(
    "owner_create_invite",
    { p_token_hash: toPgBytea(hashDoToken(token)), p_display_name: dados.apelido },
    { token: staff.token },
  );
  const link = `${new URL(getSecurityEnv().SITE_URL).origin}/painel/convite#${token}`;
  // O link aparece UMA vez. O banco não tem como reconstruí-lo.
  return json({ id, link }, 201, ctx);
});

// POST /api/painel/convites/revogar (só streamer) ----------------------------
export const postRevogarConvite = mutacao("painel/convites/revogar", async (ctx) => {
  const dados = await lerCorpo(ctx.req, z.object({ id: zId }), 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  await rpc("owner_revoke_invite", { p_id: dados.id }, { token: staff.token });
  return json({ ok: true }, 200, ctx);
});

// POST /api/painel/convites/aceitar (público, com o token do link) ------------
const corpoAceitar = z.object({
  token: zTokenConvite,
  email: zEmail,
  senha: z.string().min(1).max(512),
  apelido: zApelido,
  turnstile: zTurnstile,
});

export const postAceitarConvite = mutacao("painel/convites/aceitar", async (ctx) => {
  const env = getSecurityEnv();
  const dados = await lerCorpo(ctx.req, corpoAceitar, 4096);

  const ip = ipDoCliente(ctx.req.headers, env.DEPLOY_MODE);
  const limite = await contarOuFalhar("convite-ip", hmac(getKeyring(), "rl-ip", ip).toString("hex"), 10, 3600);
  if (!limite.permitido) {
    throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(limite.tentarEmSeg) });
  }

  if (!(await verificarTurnstile(dados.turnstile, ip))) {
    throw new HttpError(400, "Não foi possível confirmar que você é uma pessoa. Recarregue e tente de novo.", "turnstile");
  }

  const problema = problemaDeTamanho(dados.senha);
  if (problema) throw new HttpError(400, MENSAGEM_SENHA[problema], `senha_${problema}`);

  const hashToken = toPgBytea(hashDoToken(dados.token));
  const valido = await rpc<{ id: string }[]>("srv_check_invite", { p_token_hash: hashToken }, "servico");
  if (valido.length === 0) throw new HttpError(400, MSG_CONVITE_INVALIDO, "convite_invalido");

  // Senha vazada? HIBP fora do ar = recusa (HibpIndisponivelError vira 503).
  if (await senhaVazada(dados.senha, env.HIBP_API_URL)) {
    throw new HttpError(400, MENSAGEM_SENHA.vazada, "senha_vazada");
  }

  const criado = await adminCriarUsuario(dados.email, dados.senha);
  if (criado === "conflito") {
    throw new HttpError(400, "Não foi possível concluir o cadastro com esse e-mail.", "email_conflito");
  }
  if (!criado) throw new HttpError(500, MSG.generico, "criar_usuario");

  // Consumo ATÔMICO no banco: se outro aceite chegou antes, desfaz a conta criada.
  let consumido = false;
  try {
    consumido = await rpc<boolean>(
      "srv_consume_invite",
      { p_token_hash: hashToken, p_user: criado.id, p_display_name: dados.apelido },
      "servico",
    );
  } finally {
    if (!consumido) await adminApagarUsuario(criado.id).catch(() => undefined);
  }
  if (!consumido) throw new HttpError(400, MSG_CONVITE_INVALIDO, "convite_corrida");

  return json({ proximo: "/painel/entrar" }, 201, ctx);
});
