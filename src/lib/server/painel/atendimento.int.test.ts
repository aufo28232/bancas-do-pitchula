/**
 * INTEGRAÇÃO (Etapa 5): atendimento no painel contra Supabase local + Redis reais.
 * A concorrência é REAL: duas requisições ao mesmo tempo, de dois moderadores,
 * passando pelo PostgREST até o Postgres (DECISIONS D-071).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postCriarBanca, postEditarBanca, postStatusBanca } from "@/lib/server/painel/bancas";
import { postEstadoPedido } from "@/lib/server/publico/espectador";
import { postCriarPedido } from "@/lib/server/publico/pedido";
import {
  conectarBanco,
  exigirAmbiente,
  Navegador,
  novoModeradorLogado,
  novoStreamerLogado,
  TURNSTILE_TESTE,
} from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";
import {
  postAssumir,
  postBanir,
  postCopiarPix,
  postDetalhePedido,
  postFila,
  postForcarAssumir,
  postModoLive,
  postPagar,
  postRevelar,
  postSalvarResposta,
} from "./atendimento";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE"]);
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
let dono: Awaited<ReturnType<typeof novoStreamerLogado>>;
let mod1: Awaited<ReturnType<typeof novoModeradorLogado>>;
let mod2: Awaited<ReturnType<typeof novoModeradorLogado>>;

async function novaBanca(vagas: number): Promise<{ id: string; codigo: string }> {
  const r = await dono.nav.post(postCriarBanca, { nome: "Atendimento", totalCents: 1000 * vagas, vagas, ipLimit: false, idem: randomUUID() });
  expect(r.status).toBe(201);
  return { id: String(r.dados.id), codigo: /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "" };
}

async function novoPedido(codigo: string) {
  const cpf = gerarCpf();
  const email = `renata.${cpf}@exemplo.com`;
  const nav = new Navegador();
  const r = await nav.post(postCriarPedido, {
    codigo,
    nome: "Renata Quintas Lobo",
    pixTipo: "email",
    pixChave: email,
    plataformaId: `re${cpf.slice(0, 6)}`,
    cpf: mascararCpf(cpf),
    privacidade: true,
    maioridade: true,
    turnstile: TURNSTILE_TESTE,
  });
  expect(r.status).toBe(201);
  const [o] = await sql<{ id: string }[]>`select id from app.orders order by seq desc limit 1`;
  // O navegador que fez o pedido já tem a sessão dele (D-082).
  return { id: o?.id ?? "", cpf, email, espectador: nav };
}

const acao = (id: string) => ({ id, idem: randomUUID() });

beforeAll(async () => {
  dono = await novoStreamerLogado(sql);
  mod1 = await novoModeradorLogado(sql, dono.nav, "Mod Um");
  mod2 = await novoModeradorLogado(sql, dono.nav, "Mod Dois");
}, 120_000);

afterAll(async () => {
  await sql.end();
});

describe("modo live (padrão em todo login)", () => {
  it("fila e detalhe saem MASCARADOS do servidor; nada completo chega ao navegador", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);

    const fila = await mod1.nav.post(postFila, { banca: banca.id });
    expect(fila.status).toBe(200);
    expect(fila.dados.live).toBe(true);
    const detalhe = await mod1.nav.post(postDetalhePedido, { id: p.id });
    expect(detalhe.status).toBe(200);

    const tudo = JSON.stringify(fila.dados) + JSON.stringify(detalhe.dados);
    for (const proibido of [p.cpf, mascararCpf(p.cpf), p.email, "Quintas", "Renata"]) expect(tudo).not.toContain(proibido);
    expect(tudo).not.toMatch(/v\d+:[A-Za-z0-9_-]{20,}/); // nenhum texto cifrado vai para o navegador
    expect((detalhe.dados.dados as { nome: string }).nome).toBe("R*** Q*** L***");
  });

  it("revelar devolve SÓ aquele campo e fica na auditoria; copiar Pix também", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    expect((await mod1.nav.post(postAssumir, acao(p.id))).status).toBe(200);

    const cpf = await mod1.nav.post(postRevelar, { id: p.id, campo: "cpf" });
    expect(cpf.status).toBe(200);
    expect(cpf.dados).toEqual({ valor: mascararCpf(p.cpf) });
    const pix = await mod1.nav.post(postCopiarPix, { id: p.id });
    expect(pix.dados).toEqual({ valor: p.email });

    const audit = await sql<{ action: string; campo: string }[]>`
      select action, detail ->> 'campo' as campo from app.audit_log
       where order_id = ${p.id} and actor_id = ${mod1.id} and action in ('revelar', 'copiar_pix') order by id`;
    expect(audit).toEqual([
      { action: "revelar", campo: "cpf" },
      { action: "copiar_pix", campo: "pix" },
    ]);
  });

  it("desligar o modo live mostra os dados completos só naquela sessão e é auditado", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    expect((await mod2.nav.post(postModoLive, { ligado: false })).status).toBe(200);
    const d = await mod2.nav.post(postDetalhePedido, { id: p.id });
    expect((d.dados.dados as { cpf: string }).cpf).toBe(mascararCpf(p.cpf));
    // O outro moderador continua com o modo live ligado.
    const outro = await mod1.nav.post(postDetalhePedido, { id: p.id });
    expect((outro.dados.dados as { cpf: string }).cpf).toBe("***.***.***-**");
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from app.audit_log where action = 'modo_live_off' and actor_id = ${mod2.id}`;
    expect(a?.n).toBe(1);
    expect((await mod2.nav.post(postModoLive, { ligado: true })).status).toBe(200);
  });
});

describe("concorrência real (duas requisições ao mesmo tempo)", () => {
  it("dois moderadores assumem o mesmo pedido: só um fica com ele", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    const r = await Promise.all([mod1.nav.post(postAssumir, acao(p.id)), mod2.nav.post(postAssumir, acao(p.id))]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    const [o] = await sql<{ n: number }[]>`select count(*)::int as n from app.orders where id = ${p.id} and locked_by in (${mod1.id}, ${mod2.id})`;
    expect(o?.n).toBe(1);
  });

  it("a última vaga paga por dois ao mesmo tempo: só um pagamento entra", async () => {
    const banca = await novaBanca(2);
    const a = await novoPedido(banca.codigo);
    const b = await novoPedido(banca.codigo);
    const c = await novoPedido(banca.codigo);
    expect((await mod1.nav.post(postAssumir, acao(a.id))).status).toBe(200);
    expect((await mod1.nav.post(postPagar, acao(a.id))).status).toBe(200);
    expect((await mod1.nav.post(postAssumir, acao(b.id))).status).toBe(200);
    expect((await mod2.nav.post(postAssumir, acao(c.id))).status).toBe(200);

    const r = await Promise.all([mod1.nav.post(postPagar, acao(b.id)), mod2.nav.post(postPagar, acao(c.id))]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);

    const [bb] = await sql<{ paid_count: number; status: string }[]>`select paid_count, status from app.bancas where id = ${banca.id}`;
    expect(bb).toEqual({ paid_count: 2, status: "esgotada" });
    const estados = await sql<{ status: string; motivo: string | null }[]>`
      select status, refusal_reason as motivo from app.orders where id in (${b.id}, ${c.id}) order by status`;
    expect(estados).toEqual([
      { status: "pago", motivo: null },
      { status: "recusado", motivo: "vagas_esgotadas" },
    ]);
  });

  it("pagamento duplo: a mesma chave devolve o mesmo resultado; outra chave é recusada", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    await mod1.nav.post(postAssumir, acao(p.id));
    const chave = randomUUID();
    const [x, y] = await Promise.all([
      mod1.nav.post(postPagar, { id: p.id, idem: chave }),
      mod1.nav.post(postPagar, { id: p.id, idem: chave }),
    ]);
    // Duas chamadas simultâneas com a mesma chave: uma paga, a outra devolve o resultado guardado
    // ou é barrada pela trava do banco. Nunca há dois pagamentos.
    expect([x.status, y.status]).toContain(200);
    expect((await mod1.nav.post(postPagar, { id: p.id, idem: chave })).dados).toEqual(
      expect.objectContaining({ resultado: "ok", esgotou: false }),
    );
    expect((await mod1.nav.post(postPagar, acao(p.id))).status).toBe(409);
    const [b] = await sql<{ paid_count: number }[]>`select paid_count from app.bancas where id = ${banca.id}`;
    expect(b?.paid_count).toBe(1);
  });
});

describe("permissões e banimento", () => {
  it("moderador cria, edita e pausa banca (D-088); o streamer recebe alerta", async () => {
    const r = await mod1.nav.post(postCriarBanca, {
      nome: "Banca do Mod", totalCents: 30000, vagas: 3, ipLimit: false, idem: randomUUID(),
      casa: "Teste", linkAfiliado: "https://teste.com/mod",
    });
    expect(r.status).toBe(201);
    const id = String(r.dados.id);
    expect((await mod1.nav.post(postEditarBanca, { id, versao: 1, nome: "Banca do Mod 2" })).status).toBe(200);
    expect((await mod1.nav.post(postStatusBanca, { id, acao: "fechar" })).status).toBe(200);
    const [a] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.security_alerts where kind = 'banca_por_moderador' and user_id = ${dono.id}`;
    expect(a?.n).toBeGreaterThanOrEqual(1);
  });

  it("moderador NÃO força assumir nem edita respostas rápidas (a API recusa)", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    expect((await mod1.nav.post(postForcarAssumir, acao(p.id))).status).toBe(403);
    expect((await mod1.nav.post(postSalvarResposta, { rotulo: "X", texto: "Y" })).status).toBe(403);
  });

  it("banir pelo painel recusa o pedido pendente e o link do espectador para de funcionar", async () => {
    const banca = await novaBanca(5);
    const p = await novoPedido(banca.codigo);
    const espectador = p.espectador;
    expect((await espectador.post(postEstadoPedido, {})).status).toBe(200);

    const ban = await mod1.nav.post(postBanir, { ...acao(p.id), tipo: "cpf", escopo: "global", motivo: "Comprovante falso" });
    expect(ban.status).toBe(200);
    expect((await espectador.post(postEstadoPedido, {})).status).toBe(401);

    // Mesmo CPF em outra banca: bloqueado com a mensagem genérica.
    const outra = await novaBanca(5);
    const r = await new Navegador().post(postCriarPedido, {
      codigo: outra.codigo, nome: "Renata Quintas Lobo", pixTipo: "email", pixChave: `x${p.email}`,
      plataformaId: "outroid", cpf: mascararCpf(p.cpf), privacidade: true, maioridade: true, turnstile: TURNSTILE_TESTE,
    });
    expect(r.status).toBe(409);

    // IP: sem validade ou acima de 7 dias é recusado já na validação.
    const q = await novoPedido(banca.codigo);
    expect((await mod1.nav.post(postBanir, { ...acao(q.id), tipo: "ip", escopo: "global", motivo: "teste" })).status).toBe(400);
    expect((await mod1.nav.post(postBanir, { ...acao(q.id), tipo: "ip", escopo: "global", motivo: "teste", horas: 200 })).status).toBe(400);
    await sql`update app.bans set lifted_at = now(), lifted_by = ${dono.id} where source_order_id = ${p.id}`;
  });
});
