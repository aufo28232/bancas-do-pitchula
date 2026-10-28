/**
 * INTEGRAÇÃO (Etapa 7): dependências fora do ar. Cada uma é "derrubada" apontando
 * a URL para uma porta onde nada escuta. A resposta precisa ser SEGURA: erro
 * genérico, nada gravado pela metade e nenhum detalhe interno na resposta.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postEntrar } from "@/lib/server/painel/auth";
import { postCriarBanca } from "@/lib/server/painel/bancas";
import { postEstadoPedido } from "@/lib/server/publico/espectador";
import { postCriarPedido } from "@/lib/server/publico/pedido";
import { conectarBanco, ENDERECO_FECHADO, exigirAmbiente, Navegador, novoStreamerLogado, TURNSTILE_TESTE } from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE"]);
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
const original = { ...process.env };
let codigo = "";

beforeAll(async () => {
  const dono = await novoStreamerLogado(sql);
  const r = await dono.nav.post(postCriarBanca, { nome: "Banca Falhas", totalCents: 10000, vagas: 5, ipLimit: false, idem: randomUUID() });
  codigo = /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "";
});

afterEach(() => {
  process.env.SUPABASE_URL = original.SUPABASE_URL;
  process.env.TURNSTILE_VERIFY_URL = original.TURNSTILE_VERIFY_URL;
  if (original.TURNSTILE_VERIFY_URL === undefined) delete process.env.TURNSTILE_VERIFY_URL;
});

afterAll(async () => {
  await sql.end();
});

function semDetalhes(dados: Record<string, unknown>): void {
  const texto = JSON.stringify(dados);
  expect(texto).not.toMatch(/stack|ECONNREFUSED|fetch failed|127\.0\.0\.1|postgres|supabase/i);
  expect(Object.keys(dados).sort()).toEqual(["erro", "requestId"]);
}

const pedido = () => {
  const cpf = gerarCpf();
  return {
    codigo, nome: "Caio Falha Total", pixTipo: "cpf", pixChave: mascararCpf(cpf), plataformaId: "caio123",
    cpf: mascararCpf(cpf), privacidade: true, maioridade: true, turnstile: TURNSTILE_TESTE,
  };
};

const contarPedidos = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from app.orders o join app.bancas b on b.id = o.banca_id where b.code = ${codigo}`)[0]?.n;

describe("dependências fora do ar", () => {
  it("Cloudflare Turnstile fora: pedido BLOQUEADO (503) e nada gravado", async () => {
    const antes = await contarPedidos();
    process.env.TURNSTILE_VERIFY_URL = ENDERECO_FECHADO;
    const r = await new Navegador().post(postCriarPedido, pedido());
    expect(r.status).toBe(503);
    semDetalhes(r.dados);
    expect(await contarPedidos()).toBe(antes);
  });

  it("Supabase fora: login e página do pedido respondem 503 genérico", async () => {
    process.env.SUPABASE_URL = ENDERECO_FECHADO;
    const login = await new Navegador().post(postEntrar, { email: "alguem@teste.local", senha: "uma-senha-qualquer", turnstile: TURNSTILE_TESTE });
    expect(login.status).toBe(503);
    semDetalhes(login.dados);

    const nav = new Navegador();
    nav.cookies.set("__Host-bp_ped", "A".repeat(43));
    const estado = await nav.post(postEstadoPedido, {});
    expect(estado.status).toBe(503);
    semDetalhes(estado.dados);
  });

  it("Supabase fora na criação do pedido: 503 e nenhum link é entregue", async () => {
    process.env.SUPABASE_URL = ENDERECO_FECHADO;
    const r = await new Navegador().post(postCriarPedido, pedido());
    expect(r.status).toBe(503);
    expect(r.dados).not.toHaveProperty("link");
  });
});
