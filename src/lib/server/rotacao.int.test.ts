/**
 * INTEGRAÇÃO (Etapa 7): rotação da chave de cifra no banco de verdade.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postCriarBanca } from "@/lib/server/painel/bancas";
import { postCriarPedido } from "@/lib/server/publico/pedido";
import { conectarBanco, exigirAmbiente, Navegador, novoStreamerLogado, TURNSTILE_TESTE } from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";
import { chavesDeCifra, decifrar } from "./cripto";
import { rotacionarCifra } from "./rotacao";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE"]);
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
let banca = "";
const cpfs: string[] = [];

beforeAll(async () => {
  const dono = await novoStreamerLogado(sql);
  const r = await dono.nav.post(postCriarBanca, { nome: "Banca Rotacao", totalCents: 10000, vagas: 5, ipLimit: false, idem: randomUUID() });
  banca = String(r.dados.id);
  const codigo = /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "";
  for (let i = 0; i < 3; i++) {
    const cpf = gerarCpf();
    cpfs.push(cpf);
    const p = await new Navegador().post(postCriarPedido, {
      codigo, nome: "Rita Rotacao Chave", pixTipo: "cpf", pixChave: mascararCpf(cpf), plataformaId: `rr${i}`,
      cpf: mascararCpf(cpf), privacidade: true, maioridade: true, turnstile: TURNSTILE_TESTE,
    });
    expect(p.status).toBe(201);
  }
});

afterAll(async () => {
  await sql.end();
});

it("re-cifra tudo com a nova versão, os valores continuam os mesmos e rodar de novo não faz nada", async () => {
  const atual = JSON.parse(process.env.DATA_ENC_KEYS ?? "{}") as Record<string, string>;
  const versaoAtual = Number(process.env.DATA_ENC_ACTIVE ?? "1");
  const nova = versaoAtual + 1;
  const ring = chavesDeCifra(JSON.stringify({ ...atual, [nova]: randomBytes(32).toString("base64") }), nova);

  expect((await rotacionarCifra(sql, ring, { lote: 2, banca })).pedidos).toBe(3);
  const linhas = await sql<{ id: string; cpf_enc: string; full_name_enc: string }[]>`
    select id, cpf_enc, full_name_enc from app.orders where banca_id = ${banca}`;
  for (const l of linhas) {
    expect(l.cpf_enc.startsWith(`v${nova}:`)).toBe(true);
    expect(cpfs).toContain(decifrar(ring, "orders.cpf_enc", l.id, l.cpf_enc));
    expect(decifrar(ring, "orders.full_name_enc", l.id, l.full_name_enc)).toBe("Rita Rotacao Chave");
  }
  expect((await rotacionarCifra(sql, ring, { banca })).pedidos).toBe(0);
  const [a] = await sql<{ n: number }[]>`select count(*)::int as n from app.audit_log where action = 'rotacao_chave'`;
  expect(a?.n).toBeGreaterThanOrEqual(1);
  // Volta a banca para a chave do ambiente (outros testes não dependem dela, mas fica limpo).
  await sql`delete from app.orders where banca_id = ${banca}`;
});
