import { z } from "zod";
import { getSecurityEnv } from "@/lib/env";
import { HttpError, MSG } from "../errors";
import {
  entrarComSenha,
  fatoresDoUsuario,
  inscreverTotp,
  removerFatorProprio,
  sair,
  verificarTotp,
} from "../gotrue";
import { json, lerCorpo, mutacao } from "../http";
import { ipDoCliente } from "../ip";
import { getKeyring, hmac, toPgBytea } from "../keys";
import { bloqueioAtivo, limparFalhas, registrarFalha } from "../lockout";
import { rpc } from "../postgrest";
import { contarOuFalhar } from "../ratelimit";
import {
  cookieDispositivo,
  cookiesDeSaida,
  cookiesDeSessao,
  lerClaims,
  lerSessao,
  novoIdDispositivo,
  preAutenticado,
  resumoUserAgent,
} from "../sessao-staff";
import { zCodigoTotp, zEmail, zId, zSenhaLogin, zTurnstile } from "../validacao";

const MSG_CREDENCIAIS = "E-mail ou senha incorretos.";

function minutos(seg: number): string {
  const m = Math.ceil(seg / 60);
  return m <= 1 ? "1 minuto" : `${m} minutos`;
}

// ---------------------------------------------------------------------------
// POST /api/painel/auth/entrar: e-mail + senha + Turnstile (ARCHITECTURE §5.1)
// ---------------------------------------------------------------------------
const corpoEntrar = z.object({ email: zEmail, senha: zSenhaLogin, turnstile: zTurnstile });

export const postEntrar = mutacao("painel/entrar", async (ctx) => {
  const env = getSecurityEnv();
  const dados = await lerCorpo(ctx.req, corpoEntrar, 4096);
  const ring = getKeyring();
  const ip = ipDoCliente(ctx.req.headers, env.DEPLOY_MODE);
  const idIp = hmac(ring, "rl-ip", ip).toString("hex");
  const idConta = hmac(ring, "rl-conta", dados.email).toString("hex");

  // 1. Limites e bloqueio progressivo. Redis fora = 503 (falha fechada), ANTES de tocar no Auth.
  const [porIp, porConta] = await Promise.all([
    contarOuFalhar("login-ip", idIp, 10, 900),
    contarOuFalhar("login-conta", idConta, 10, 900),
  ]);
  if (!porIp.permitido || !porConta.permitido) {
    const espera = Math.max(porIp.tentarEmSeg, porConta.tentarEmSeg);
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${minutos(espera)}.`, "rate_limit", {
      "Retry-After": String(espera),
    });
  }
  const ids = [`conta:${idConta}`, `ip:${idIp}`];
  const bloqueio = await bloqueioAtivo(ids);
  if (bloqueio > 0) {
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${minutos(bloqueio)}.`, "bloqueado", {
      "Retry-After": String(bloqueio),
    });
  }

  // 2. Senha + captcha, verificados pelo Supabase Auth (D-054).
  const tokens = await entrarComSenha(dados.email, dados.senha, dados.turnstile);
  if (!tokens) {
    await registrarFalha(ids);
    await rpc("srv_login_failed", {}, "servico").catch(() => undefined);
    throw new HttpError(401, MSG_CREDENCIAIS, "credenciais");
  }

  const claims = lerClaims(tokens.access_token);
  if (!claims?.sub || !claims.session_id) {
    await sair(tokens.access_token);
    throw new HttpError(500, MSG.generico, "claims_ausentes");
  }

  // 3. Dispositivo conhecido? (alerta de dispositivo novo, enunciado §5)
  let dispositivo = lerSessao(ctx.req).dispositivo;
  if (!dispositivo || !/^[A-Za-z0-9_-]{22}$/.test(dispositivo)) dispositivo = novoIdDispositivo();
  ctx.setCookies.push(cookieDispositivo(dispositivo));
  const hashDispositivo = hmac(ring, "dispositivo", `${claims.sub}:${dispositivo}`);
  const local = env.DEPLOY_MODE === "managed" ? null : ctx.req.headers.get("cf-ipcountry");

  // 4. Só staff ATIVO ganha sessão do painel. Resposta idêntica à de senha errada.
  const registro = await rpc<{ novo_dispositivo: boolean; role: string }[]>(
    "srv_register_staff_session",
    {
      p_user: claims.sub,
      p_session: claims.session_id,
      p_device_hash: toPgBytea(hashDispositivo),
      p_ua_summary: resumoUserAgent(ctx.req.headers.get("user-agent")),
      p_location: local && /^[A-Z]{2}$/.test(local) ? local : null,
    },
    "servico",
  );
  if (registro.length === 0) {
    await sair(tokens.access_token);
    await registrarFalha(ids);
    throw new HttpError(401, MSG_CREDENCIAIS, "nao_staff");
  }

  await limparFalhas(`conta:${idConta}`);
  ctx.setCookies.push(...cookiesDeSessao(tokens));
  return json({ proximo: "/painel/mfa" }, 200, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/painel/auth/mfa/inscrever: cadastra o TOTP (staff em AAL1)
// ---------------------------------------------------------------------------
async function exigirPreAuth(req: Request): Promise<{ access: string; sessionId: string }> {
  const { access } = lerSessao(req);
  if (!access) throw new HttpError(401, MSG.sessao, "sem_sessao");
  const pre = await preAutenticado(access);
  const sessionId = lerClaims(access)?.session_id;
  if (!pre || !sessionId) throw new HttpError(401, MSG.sessao, "sem_preauth");
  return { access, sessionId };
}

export const postMfaInscrever = mutacao("painel/mfa/inscrever", async (ctx) => {
  await lerCorpo(ctx.req, z.object({}).strict(), 256);
  const { access } = await exigirPreAuth(ctx.req);

  const fatores = await fatoresDoUsuario(access);
  if (fatores === null) throw new HttpError(401, MSG.sessao, "fatores");
  const totp = fatores.filter((f) => f.factor_type === "totp");
  if (totp.some((f) => f.status === "verified")) {
    throw new HttpError(409, "O autenticador já está cadastrado. Use o código dele para entrar.", "ja_tem_mfa");
  }
  // Cadastro anterior que não foi concluído: descarta e começa de novo.
  for (const f of totp) await removerFatorProprio(access, f.id);

  const novo = await inscreverTotp(access);
  if (!novo) throw new HttpError(500, MSG.generico, "inscrever_falhou");
  return json({ fatorId: novo.id, qrCode: novo.qrCode, segredo: novo.secret }, 200, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/painel/auth/mfa/verificar: sobe a sessão para AAL2
// ---------------------------------------------------------------------------
const corpoVerificar = z.object({ fatorId: zId, codigo: zCodigoTotp });

export const postMfaVerificar = mutacao("painel/mfa/verificar", async (ctx) => {
  const dados = await lerCorpo(ctx.req, corpoVerificar, 512);
  const { access, sessionId } = await exigirPreAuth(ctx.req);

  const limite = await contarOuFalhar("mfa", hmac(getKeyring(), "rl-sessao", sessionId).toString("hex"), 5, 300);
  if (!limite.permitido) {
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${minutos(limite.tentarEmSeg)}.`, "rate_limit", {
      "Retry-After": String(limite.tentarEmSeg),
    });
  }

  const fatores = await fatoresDoUsuario(access);
  if (!fatores?.some((f) => f.id === dados.fatorId && f.factor_type === "totp")) {
    throw new HttpError(400, MSG.dadosInvalidos, "fator_alheio");
  }

  const tokens = await verificarTotp(access, dados.fatorId, dados.codigo);
  if (!tokens) throw new HttpError(400, "Código inválido. Confira o app autenticador e tente de novo.", "totp_invalido");

  ctx.setCookies.push(...cookiesDeSessao(tokens));
  return json({ proximo: "/painel" }, 200, ctx);
});

// ---------------------------------------------------------------------------
// POST /api/painel/auth/sair
// ---------------------------------------------------------------------------
export const postSair = mutacao("painel/sair", async (ctx) => {
  await lerCorpo(ctx.req, z.object({}).strict(), 256);
  const { access } = lerSessao(ctx.req);
  if (access) {
    // O banco encerra a sessão do PRÓPRIO JWT (verificado), nunca a de um id recebido.
    await rpc("preauth_end_session", {}, { token: access }).catch(() => undefined);
    await sair(access);
  }
  ctx.setCookies.push(...cookiesDeSaida());
  return json({ proximo: "/painel/entrar" }, 200, ctx);
});
