import { z } from "zod";
import { HttpError, MSG } from "../errors";
import { adminApagarFator, adminFatores } from "../gotrue";
import { json, lerCorpo, mutacao } from "../http";
import { getKeyring, hmac } from "../keys";
import { rpc } from "../postgrest";
import { contarOuPermitir } from "../ratelimit";
import { cookiesDeSaida, exigirStaff } from "../sessao-staff";
import { zId } from "../validacao";

async function limitePainel(userId: string): Promise<void> {
  const r = await contarOuPermitir("painel", hmac(getKeyring(), "rl-staff", userId).toString("hex"), 120, 60);
  if (!r.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(r.tentarEmSeg) });
}

const corpoUsuario = z.object({ userId: zId });

// POST /api/painel/equipe/remover (só streamer) --------------------------------
export const postRemoverModerador = mutacao("painel/equipe/remover", async (ctx) => {
  const dados = await lerCorpo(ctx.req, corpoUsuario, 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  await rpc("owner_deactivate_staff", { p_user: dados.userId }, { token: staff.token });
  return json({ ok: true }, 200, ctx);
});

// POST /api/painel/equipe/resetar-mfa (só streamer) ----------------------------
export const postResetarMfa = mutacao("painel/equipe/resetar-mfa", async (ctx) => {
  const dados = await lerCorpo(ctx.req, corpoUsuario, 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);

  // 1. Banco: autoriza (owner AAL2, alvo é moderador ativo), derruba as sessões e audita.
  await rpc("owner_prepare_mfa_reset", { p_user: dados.userId }, { token: staff.token });

  // 2. Auth: apaga os fatores. Repetir é seguro (idempotente).
  const fatores = await adminFatores(dados.userId);
  let falhou = fatores === null;
  for (const f of fatores ?? []) {
    if (!(await adminApagarFator(dados.userId, f.id))) falhou = true;
  }
  if (falhou) {
    throw new HttpError(
      502,
      "As sessões foram derrubadas, mas o autenticador não foi apagado. Tente de novo.",
      "apagar_fator",
    );
  }
  return json({ ok: true }, 200, ctx);
});

// POST /api/painel/sessoes/revogar (dono da sessão ou streamer) ------------------
export const postRevogarSessao = mutacao("painel/sessoes/revogar", async (ctx) => {
  const dados = await lerCorpo(ctx.req, z.object({ sessionId: zId }), 256);
  const staff = await exigirStaff(ctx.req);
  await limitePainel(staff.userId);
  await rpc("staff_revoke_session", { p_session: dados.sessionId }, { token: staff.token });
  if (dados.sessionId === staff.sessionId) {
    ctx.setCookies.push(...cookiesDeSaida());
    return json({ proximo: "/painel/entrar" }, 200, ctx);
  }
  return json({ ok: true }, 200, ctx);
});

// POST /api/painel/alertas/ciente (só streamer) -----------------------------------
export const postAlertaCiente = mutacao("painel/alertas/ciente", async (ctx) => {
  const dados = await lerCorpo(ctx.req, z.object({ id: zId }), 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  await rpc("owner_ack_alert", { p_id: dados.id }, { token: staff.token });
  return json({ ok: true }, 200, ctx);
});
