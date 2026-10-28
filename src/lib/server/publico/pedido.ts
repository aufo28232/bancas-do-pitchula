import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSecurityEnv } from "@/lib/env";
import { normalizarPix, normalizarPlataformaId, pedidoSchema, soDigitos } from "@/lib/validacao/pedido";
import { cifrar, getChavesDeCifra, hmacsDeDado } from "../cripto";
import { HttpError, MSG } from "../errors";
import { json, lerCorpo, mutacao } from "../http";
import { ipDoCliente } from "../ip";
import { getKeyring, hmac, toPgBytea } from "../keys";
import { rpc } from "../postgrest";
import { contarOuFalhar } from "../ratelimit";
import { verificarTurnstile } from "../turnstile";

/**
 * POST /api/bancas/pedido: criação de pedido pelo espectador (ARCHITECTURE §5.4).
 * Ordem: CSRF -> rate limit (Redis fora = bloqueia) -> Turnstile no servidor
 * (fora = bloqueia) -> Zod -> normalização -> HMACs + cifra -> função atômica no banco.
 * Bloqueio por banimento, CPF repetido ou IP repetido devolve a MESMA mensagem.
 */
/** Limites ajustáveis por variável de ambiente (D-030), com padrões seguros. */
export function limitesPedido(): { porJanela: number; rajadaSeg: number } {
  const porJanela = Number(process.env.RL_PEDIDO_POR_10MIN ?? "5");
  const rajadaSeg = Number(process.env.RL_PEDIDO_RAJADA_SEG ?? "30");
  return {
    porJanela: Number.isInteger(porJanela) && porJanela >= 1 && porJanela <= 100 ? porJanela : 5,
    rajadaSeg: Number.isInteger(rajadaSeg) && rajadaSeg >= 1 && rajadaSeg <= 300 ? rajadaSeg : 30,
  };
}

export const MSG_BLOQUEADO = "Não foi possível registrar seu pedido nesta banca.";
const MSG_INDISPONIVEL = "Esta banca não está recebendo pedidos agora.";
const MSG_FILA_CHEIA = "A fila está cheia agora. Tenta de novo daqui a pouco.";

export const postCriarPedido = mutacao("bancas/pedido", async (ctx) => {
  const env = getSecurityEnv();
  const anel = getKeyring();
  const ip = ipDoCliente(ctx.req.headers, env.DEPLOY_MODE);
  const idIp = hmac(anel, "rl-ip", ip).toString("hex");

  // 1. Limites por IP (padrão: 5 a cada 10 min e 1 a cada 30 s). Redis fora = 503.
  const lim = limitesPedido();
  const [janela, rajada] = await Promise.all([
    contarOuFalhar("pedido-ip", idIp, lim.porJanela, 600),
    contarOuFalhar("pedido-ip-rajada", idIp, 1, lim.rajadaSeg),
  ]);
  if (!janela.permitido || !rajada.permitido) {
    const espera = Math.max(janela.permitido ? 0 : janela.tentarEmSeg, rajada.permitido ? 0 : rajada.tentarEmSeg);
    throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(espera) });
  }

  // 2. Validação completa (o mesmo schema do navegador).
  const d = await lerCorpo(ctx.req, pedidoSchema, 4096);

  const porBanca = await contarOuFalhar("pedido-banca", d.codigo, 600, 60);
  if (!porBanca.permitido) throw new HttpError(429, MSG_FILA_CHEIA, "rate_limit_banca", { "Retry-After": "30" });

  // 3. Turnstile verificado no servidor ANTES de qualquer gravação.
  if (!(await verificarTurnstile(d.turnstile, ip))) {
    throw new HttpError(400, "Não foi possível confirmar que você é uma pessoa. Recarregue e tente de novo.", "turnstile");
  }

  // 4. Normalização para HMAC (duplicidade e banimentos) e cifra dos dados pessoais.
  const pix = normalizarPix(d.pixTipo, d.pixChave);
  if (!pix) throw new HttpError(400, MSG.dadosInvalidos, "pix");
  const cpf = soDigitos(d.cpf);
  const plataformaId = normalizarPlataformaId(d.plataformaId);

  const cifras = getChavesDeCifra();
  const id = randomUUID();
  const hCpf = hmacsDeDado(anel, "cpf", cpf);
  const hPix = hmacsDeDado(anel, "pix", `${d.pixTipo}:${pix}`);
  const hPid = hmacsDeDado(anel, "pid", plataformaId);
  const hIp = hmacsDeDado(anel, "ip", ip);

  // 5. Token de acesso ao pedido: 256 bits; o banco guarda só o SHA-256.
  const token = randomBytes(32).toString("base64url");
  const hashToken = createHash("sha256").update(token, "utf8").digest();

  const resultado = await rpc<string>(
    "public_create_order",
    {
      p_code: d.codigo,
      p_id: id,
      p_full_name_enc: cifrar(cifras, "orders.full_name_enc", id, d.nome),
      p_cpf_enc: cifrar(cifras, "orders.cpf_enc", id, cpf),
      p_pix_type: d.pixTipo,
      p_pix_key_enc: cifrar(cifras, "orders.pix_key_enc", id, pix),
      p_platform_id_enc: cifrar(cifras, "orders.platform_id_enc", id, d.plataformaId),
      p_cpf_hmac: toPgBytea(hCpf.ativo),
      p_pix_hmac: toPgBytea(hPix.ativo),
      p_platform_id_hmac: toPgBytea(hPid.ativo),
      p_ip_hmac: toPgBytea(hIp.ativo),
      p_hmac_version: anel.active,
      p_cpf_hmacs: hCpf.todos.map(toPgBytea),
      p_pix_hmacs: hPix.todos.map(toPgBytea),
      p_platform_id_hmacs: hPid.todos.map(toPgBytea),
      p_ip_hmacs: hIp.todos.map(toPgBytea),
      p_access_token_hash: toPgBytea(hashToken),
    },
    "servico",
  );

  if (resultado === "indisponivel") throw new HttpError(409, MSG_INDISPONIVEL, "indisponivel");
  if (resultado === "fila_cheia") throw new HttpError(429, MSG_FILA_CHEIA, "fila_cheia", { "Retry-After": "60" });
  if (resultado !== "ok") throw new HttpError(409, MSG_BLOQUEADO, "bloqueado");

  // O token vai no FRAGMENTO (#): não chega ao servidor, a logs nem ao Referer.
  return json({ link: `${new URL(env.SITE_URL).origin}/pedido#${token}` }, 201, ctx);
});
