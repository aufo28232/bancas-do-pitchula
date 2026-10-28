import { z } from "zod";
import { getSecurityEnv } from "@/lib/env";
import { gerarCodigoBanca } from "../codigo-banca";
import { HttpError, MSG } from "../errors";
import { json, lerCorpo, mutacao } from "../http";
import { getKeyring, hmac } from "../keys";
import { RpcError, rpc } from "../postgrest";
import { contarOuPermitir } from "../ratelimit";
import { exigirStaff } from "../sessao-staff";
import { zId } from "../validacao";

/** Teto de valor da aplicação (D-042). O banco aceita até R$ 1 milhão. */
export function tetoBancaCents(): number {
  const v = Number(process.env.BANCA_MAX_CENTS ?? "10000000");
  return Number.isSafeInteger(v) && v > 0 && v <= 100_000_000 ? v : 10_000_000;
}

async function limitePainel(userId: string): Promise<void> {
  const r = await contarOuPermitir("painel", hmac(getKeyring(), "rl-staff", userId).toString("hex"), 120, 60);
  if (!r.permitido) throw new HttpError(429, MSG.muitasTentativas, "rate_limit", { "Retry-After": String(r.tentarEmSeg) });
}

const zNomeBanca = z.string().trim().min(1).max(80);
const zCents = z.number().int().positive();
const zVagas = z.number().int().min(1).max(10_000);

function validarValores(totalCents: number | undefined, vagas: number | undefined): void {
  if (totalCents !== undefined && totalCents > tetoBancaCents()) {
    throw new HttpError(400, "Valor acima do limite configurado para uma banca.", "teto");
  }
  if (totalCents !== undefined && vagas !== undefined && totalCents < vagas) {
    throw new HttpError(400, "O valor por pessoa ficaria abaixo de R$ 0,01.", "por_pessoa_zero");
  }
}

// POST /api/painel/bancas/criar (só streamer) ----------------------------------
const corpoCriar = z.object({
  nome: zNomeBanca,
  totalCents: zCents,
  vagas: zVagas,
  ipLimit: z.boolean(),
  idem: zId,
});

export const postCriarBanca = mutacao("painel/bancas/criar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoCriar, 1024);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  validarValores(d.totalCents, d.vagas);

  // Código único gerado com CSPRNG; colisão (raríssima) -> tenta outro.
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const [b] = await rpc<{ id: string; code: string; per_person_cents: number; remainder_cents: number }[]>(
        "owner_create_banca",
        {
          p_code: gerarCodigoBanca(),
          p_name: d.nome,
          p_total_cents: d.totalCents,
          p_slots: d.vagas,
          p_ip_limit: d.ipLimit,
          p_idem: d.idem,
        },
        { token: staff.token },
      );
      if (!b) throw new HttpError(500, MSG.generico, "criar_sem_retorno");
      const link = `${new URL(getSecurityEnv().SITE_URL).origin}/${b.code}-banca`;
      return json({ id: b.id, link, porPessoaCents: b.per_person_cents, sobraCents: b.remainder_cents }, 201, ctx);
    } catch (e) {
      if (e instanceof RpcError && e.code === "23505") continue;
      throw e;
    }
  }
  throw new HttpError(500, MSG.generico, "codigo_colisao");
});

// POST /api/painel/bancas/editar (só streamer) ---------------------------------
const corpoEditar = z.object({
  id: zId,
  versao: z.number().int().min(1),
  nome: zNomeBanca,
  totalCents: zCents.optional(),
  vagas: zVagas.optional(),
  ipLimit: z.boolean().optional(),
});

export const postEditarBanca = mutacao("painel/bancas/editar", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoEditar, 1024);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  validarValores(d.totalCents, d.vagas);
  try {
    const versao = await rpc<number>(
      "owner_update_banca",
      {
        p_id: d.id,
        p_version: d.versao,
        p_name: d.nome,
        p_total_cents: d.totalCents ?? null,
        p_slots: d.vagas ?? null,
        p_ip_limit: d.ipLimit ?? null,
      },
      { token: staff.token },
    );
    return json({ versao }, 200, ctx);
  } catch (e) {
    if (e instanceof RpcError && e.code === "55000") {
      throw new HttpError(409, "Valor e vagas ficam travados depois do primeiro pedido. Para mudar, crie outra banca.", "travado");
    }
    if (e instanceof RpcError && e.code === "40001") {
      throw new HttpError(409, "Esta banca foi alterada em outra aba. Recarregue a página.", "versao");
    }
    throw e;
  }
});

// POST /api/painel/bancas/status (só streamer) ---------------------------------
const corpoStatus = z.object({ id: zId, acao: z.enum(["fechar", "reabrir"]) });

export const postStatusBanca = mutacao("painel/bancas/status", async (ctx) => {
  const d = await lerCorpo(ctx.req, corpoStatus, 256);
  const staff = await exigirStaff(ctx.req, { owner: true });
  await limitePainel(staff.userId);
  try {
    const status = await rpc<string>("owner_set_banca_status", { p_id: d.id, p_acao: d.acao }, { token: staff.token });
    return json({ status }, 200, ctx);
  } catch (e) {
    if (e instanceof RpcError && e.code === "55000") {
      throw new HttpError(409, "Essa mudança de estado não é possível agora.", "transicao");
    }
    throw e;
  }
});
