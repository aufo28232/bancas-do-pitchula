/**
 * INTEGRAÇÃO (Etapa 6): comprovante de verdade no Storage, encerramento que apaga
 * tudo, trabalhador de limpeza e exclusão a pedido, contra Supabase local + Redis.
 * O teste obrigatório do plano: o arquivo SOME do Storage depois do encerramento.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postCriarBanca } from "@/lib/server/painel/bancas";
import { postComprovanteStaff, postEncerrarBanca } from "@/lib/server/painel/atendimento";
import { bancaPublica } from "@/lib/server/publico/banca";
import {
  postComprovante,
  postEstadoPedido,
  postExcluirDados,
  postVerComprovante,
} from "@/lib/server/publico/espectador";
import { postCriarPedido } from "@/lib/server/publico/pedido";
import { conectarBanco, exigirAmbiente, Navegador, novoStreamerLogado, TURNSTILE_TESTE } from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";
import { executarLimpeza, postLimpeza } from "./limpeza";
import { existeArquivo, nomeNoBucket } from "./storage";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE", "LIMPEZA_SECRET"]);
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
let dono: Awaited<ReturnType<typeof novoStreamerLogado>>;

const imagem = () =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 160, b: 90 } } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "exif-do-espectador" } } })
    .toBuffer();

async function novaBanca(nome: string) {
  const r = await dono.nav.post(postCriarBanca, { nome, totalCents: 50000, vagas: 5, ipLimit: false, idem: randomUUID() });
  expect(r.status).toBe(201);
  return { id: String(r.dados.id), codigo: /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "" };
}

/** Cria o pedido; o mesmo navegador já fica com a sessão dele (cookie, D-082). */
async function espectadorComPedido(codigo: string) {
  const cpf = gerarCpf();
  const nav = new Navegador();
  const r = await nav.post(postCriarPedido, {
    codigo, nome: "Bruna Arquivo Teste", pixTipo: "cpf", pixChave: mascararCpf(cpf), plataformaId: `br${cpf.slice(0, 5)}`,
    cpf: mascararCpf(cpf), privacidade: true, maioridade: true, turnstile: TURNSTILE_TESTE,
  });
  expect(r.status).toBe(201);
  const [o] = await sql<{ id: string; viewer_uid: string }[]>`select id, viewer_uid from app.orders order by seq desc limit 1`;
  return { nav, id: o?.id ?? "", viewer: o?.viewer_uid ?? "" };
}

const caminhos = (pedido: string) =>
  sql<{ id: string; storage_path: string }[]>`select id, storage_path from app.order_attachments where order_id = ${pedido}`;

beforeAll(async () => {
  dono = await novoStreamerLogado(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("comprovante", () => {
  it("vai para o Storage como WEBP novo, sem EXIF; só o dono e o staff conseguem ver", async () => {
    const banca = await novaBanca("Banca Comprovante");
    const e = await espectadorComPedido(banca.codigo);
    const envio = await e.nav.post(postComprovante, new Uint8Array(await imagem()));
    expect(envio.status).toBe(201);

    const [a] = await caminhos(e.id);
    expect(a?.storage_path).toMatch(/^comprovantes\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/);
    expect(await existeArquivo(nomeNoBucket(a?.storage_path ?? ""))).toBe(true);

    // O dono abre pela URL assinada (60 s): é WEBP e o EXIF não está lá.
    const ver = await e.nav.post(postVerComprovante, { id: a?.id });
    expect(ver.status).toBe(200);
    const arquivo = await fetch(String(ver.dados.url));
    expect(arquivo.status).toBe(200);
    const bytes = Buffer.from(await arquivo.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe("webp");
    expect(bytes.includes(Buffer.from("exif-do-espectador"))).toBe(false);

    // Outro espectador não vê; o staff vê e fica na auditoria.
    const outro = await espectadorComPedido(banca.codigo);
    expect((await outro.nav.post(postVerComprovante, { id: a?.id })).status).toBe(404);
    expect((await dono.nav.post(postComprovanteStaff, { anexo: a?.id })).status).toBe(200);
    const [aud] = await sql<{ n: number }[]>`select count(*)::int as n from app.audit_log where action = 'abrir_comprovante' and order_id = ${e.id}`;
    expect(aud?.n).toBe(1);

    // O estado do pedido mostra o comprovante no chat.
    const estado = await e.nav.post(postEstadoPedido, {});
    expect((estado.dados.mensagens as { anexo: string | null }[]).some((m) => m.anexo === a?.id)).toBe(true);
  });

  it("texto com cara de imagem e arquivo acima de 5 MB são recusados, e nada vai para o Storage", async () => {
    const banca = await novaBanca("Banca Arquivo Ruim");
    const e = await espectadorComPedido(banca.codigo);
    expect((await e.nav.post(postComprovante, new Uint8Array(Buffer.from("<html>não sou imagem</html>")))).status).toBe(400);
    const grande = Buffer.alloc(5 * 1024 * 1024 + 10);
    Buffer.from([0xff, 0xd8, 0xff]).copy(grande);
    expect((await e.nav.post(postComprovante, new Uint8Array(grande))).status).toBe(413);
    expect(await caminhos(e.id)).toHaveLength(0);
  });
});

describe("encerrar banca (D-044)", () => {
  it("apaga pedidos, comprovantes do Storage e contas anônimas; o link deixa de existir", async () => {
    const banca = await novaBanca("Banca Para Encerrar");
    const e = await espectadorComPedido(banca.codigo);
    expect((await e.nav.post(postComprovante, new Uint8Array(await imagem()))).status).toBe(201);
    const [a] = await caminhos(e.id);
    const nome = nomeNoBucket(a?.storage_path ?? "");
    expect(await existeArquivo(nome)).toBe(true);

    expect((await dono.nav.post(postEncerrarBanca, { id: banca.id, nome: "Outro Nome", idem: randomUUID() })).status).toBe(400);
    const r = await dono.nav.post(postEncerrarBanca, { id: banca.id, nome: "banca para encerrar", idem: randomUUID() });
    expect(r.status).toBe(200);

    // Banco: nada do pedido sobrou; o link morreu.
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from app.orders where banca_id = ${banca.id}`;
    expect(n?.n).toBe(0);
    expect(await bancaPublica(banca.codigo)).toBeNull();
    expect((await e.nav.post(postEstadoPedido, {})).status).toBe(401);

    // Trabalhador de limpeza (o encerramento já disparou um; este garante o fim da fila).
    await executarLimpeza();
    expect(await existeArquivo(nome)).toBe(false);
    const [u] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users where id = ${e.viewer}`;
    expect(u?.n).toBe(0);
    const [fila] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.storage_purge_queue where storage_path = ${a?.storage_path ?? ""} and done_at is null`;
    expect(fila?.n).toBe(0);
  });
});

describe("exclusão a pedido do titular (D-018)", () => {
  it("apaga dados, chat e comprovante; o mesmo CPF não volta a pedir na mesma banca", async () => {
    const banca = await novaBanca("Banca Exclusao");
    const e = await espectadorComPedido(banca.codigo);
    expect((await e.nav.post(postComprovante, new Uint8Array(await imagem()))).status).toBe(201);
    const [a] = await caminhos(e.id);

    expect((await e.nav.post(postExcluirDados, { confirmar: true })).status).toBe(200);
    expect((await e.nav.post(postEstadoPedido, {})).status).toBe(401);
    await executarLimpeza();
    expect(await existeArquivo(nomeNoBucket(a?.storage_path ?? ""))).toBe(false);

    const [o] = await sql<{ status: string; motivo: string; enc: string; apagado: boolean }[]>`
      select status, refusal_reason as motivo, cpf_enc as enc, data_erased_at is not null as apagado from app.orders where id = ${e.id}`;
    expect(o).toEqual({ status: "recusado", motivo: "exclusao_a_pedido", enc: expect.stringMatching(/^v0:/), apagado: true });
  });
});

describe("rota do trabalhador de limpeza", () => {
  it("sem o segredo: 401; com o segredo: roda a manutenção e a limpeza", async () => {
    const chamar = (auth?: string) =>
      postLimpeza(new Request("http://localhost/api/interno/limpeza", { method: "POST", headers: auth ? { authorization: auth } : {} }));
    expect((await chamar()).status).toBe(401);
    expect((await chamar("Bearer errado-errado-errado-errado-errado-errado")).status).toBe(401);
    const ok = await chamar(`Bearer ${process.env.LIMPEZA_SECRET ?? ""}`);
    expect(ok.status).toBe(200);
    const corpo = (await ok.json()) as { manutencao: Record<string, number>; limpeza: Record<string, number> };
    expect(corpo.manutencao).toHaveProperty("bans");
    expect(corpo.limpeza).toHaveProperty("arquivos");
  });
});
