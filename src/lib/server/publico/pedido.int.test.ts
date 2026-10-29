/**
 * INTEGRAÇÃO (Etapa 3): criação de banca pelo painel e pedido do espectador,
 * contra Supabase local + Redis reais. Nada mockado.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decifrar, getChavesDeCifra, hmacsDeDado } from "@/lib/server/cripto";
import { getKeyring, toPgBytea } from "@/lib/server/keys";
import { postCriarBanca, postEditarBanca, postStatusBanca } from "@/lib/server/painel/bancas";
import {
  conectarBanco,
  ENDERECO_FECHADO,
  esperar,
  exigirAmbiente,
  Navegador,
  novoStreamerLogado,
  TURNSTILE_TESTE,
} from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";
import { bancaPublica } from "./banca";
import { COOKIE_PEDIDO } from "./espectador";
import { MSG_BLOQUEADO, postCriarPedido } from "./pedido";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE"]);

// Testes rápidos: rajada de 1 s por IP (o padrão de produção é 30 s).
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
let dono: Awaited<ReturnType<typeof novoStreamerLogado>>;

async function criarBanca(opcoes: { ipLimit: boolean; totalCents?: number; vagas?: number; nome?: string }) {
  const r = await dono.nav.post(postCriarBanca, {
    nome: opcoes.nome ?? "Banca de teste",
    totalCents: opcoes.totalCents ?? 300000,
    vagas: opcoes.vagas ?? 100,
    ipLimit: opcoes.ipLimit,
    idem: randomUUID(),
  });
  expect(r.status).toBe(201);
  const codigo = /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "";
  return { id: String(r.dados.id), codigo };
}

function pedido(codigo: string, cpf = gerarCpf(), extra: Record<string, unknown> = {}) {
  return {
    codigo,
    nome: "Maria da Silva",
    pixTipo: "email",
    pixChave: `maria.${cpf}@exemplo.com`,
    cpf: mascararCpf(cpf),
    privacidade: true,
    maioridade: true,
    turnstile: TURNSTILE_TESTE,
    ...extra,
  };
}

const pedidosDaBanca = async (bancaId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from app.orders where banca_id = ${bancaId}`)[0]?.n;

beforeAll(async () => {
  dono = await novoStreamerLogado(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("bancas no painel", () => {
  it("clique duplo (mesma chave de idempotência) não cria duas bancas", async () => {
    const corpo = { nome: "Duplo clique", totalCents: 10000, vagas: 3, ipLimit: true, idem: randomUUID() };
    const a = await dono.nav.post(postCriarBanca, corpo);
    const b = await dono.nav.post(postCriarBanca, corpo);
    expect(a.status).toBe(201);
    expect(b.dados.id).toBe(a.dados.id);
    expect(a.dados.porPessoaCents).toBe(3333);
    expect(a.dados.sobraCents).toBe(1);
  });

  it("valor acima do teto e valor por pessoa zero são recusados", async () => {
    expect((await dono.nav.post(postCriarBanca, { nome: "X", totalCents: 999_999_999, vagas: 1, ipLimit: true, idem: randomUUID() })).status).toBe(400);
    expect((await dono.nav.post(postCriarBanca, { nome: "X", totalCents: 5, vagas: 10, ipLimit: true, idem: randomUUID() })).status).toBe(400);
  });
});

describe("casa e link de afiliado por banca (D-086)", () => {
  it("guarda casa e link da banca; link que não é https é recusado", async () => {
    const base = { nome: "Banca Casa", totalCents: 30000, vagas: 3, ipLimit: false };
    for (const linkAfiliado of ["http://teste.com/x", "javascript:alert(1)", "https://teste.com/a b"]) {
      const r = await dono.nav.post(postCriarBanca, { ...base, idem: randomUUID(), casa: "Teste", linkAfiliado });
      expect(r.status).toBe(400);
    }
    const ok = await dono.nav.post(postCriarBanca, {
      ...base, idem: randomUUID(), casa: "Teste", linkAfiliado: "https://teste.com/iujdnsajdas",
    });
    expect(ok.status).toBe(201);
    const codigo = /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(ok.dados.link))?.[1] ?? "";
    const pub = await bancaPublica(codigo);
    expect(pub).toMatchObject({ platform_name: "Teste", signup_url: "https://teste.com/iujdnsajdas" });
  });
});

describe("pedido do espectador", () => {
  let banca: { id: string; codigo: string };
  const cpf = gerarCpf();
  const nav = new Navegador();

  beforeAll(async () => {
    banca = await criarBanca({ ipLimit: true });
  });

  it("cria o pedido, já liga o navegador a ele (sem link) e guarda tudo CIFRADO", async () => {
    const r = await nav.post(postCriarPedido, pedido(banca.codigo, cpf));
    expect(r.status).toBe(201);
    // Vai direto para o chat: nenhum link ou token sai na resposta (D-082).
    expect(r.dados).toEqual({ proximo: "/pedido" });
    expect(nav.cookies.get(COOKIE_PEDIDO)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [o] = await sql<{ id: string; full_name_enc: string; cpf_enc: string; pix_key_enc: string; token_bytes: number; sessoes: number }[]>`
      select id, full_name_enc, cpf_enc, pix_key_enc, octet_length(access_token_hash) as token_bytes,
             (select count(*)::int from app.order_sessions s where s.order_id = o.id) as sessoes
        from app.orders o where banca_id = ${banca.id}`;
    expect(o).toBeDefined();
    if (!o) return;
    // No banco: nada em claro, só hashes.
    expect(o.full_name_enc).not.toContain("Maria");
    expect(o.cpf_enc).not.toContain(cpf);
    expect(o.token_bytes).toBe(32);
    expect(o.sessoes).toBe(1);
    // Com a chave (só no servidor), volta o original.
    const chaves = getChavesDeCifra();
    expect(decifrar(chaves, "orders.full_name_enc", o.id, o.full_name_enc)).toBe("Maria da Silva");
    expect(decifrar(chaves, "orders.cpf_enc", o.id, o.cpf_enc)).toBe(cpf);
  });

  it("mesmo CPF de outro IP: recusado com mensagem genérica", async () => {
    const r = await new Navegador().post(postCriarPedido, pedido(banca.codigo, cpf));
    expect(r.status).toBe(409);
    expect(r.dados.erro).toBe(MSG_BLOQUEADO);
  });

  it("mesmo IP com outro CPF (regra ligada): recusado com a MESMA mensagem", async () => {
    await esperar(1100);
    const r = await nav.post(postCriarPedido, pedido(banca.codigo));
    expect(r.status).toBe(409);
    expect(r.dados.erro).toBe(MSG_BLOQUEADO);
  });

  it("CPF banido: recusado com a MESMA mensagem (não revela o motivo)", async () => {
    const banido = gerarCpf();
    await sql`
      insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by, review_due_at)
      values ('cpf', ${hmacsDeDado(getKeyring(), "cpf", banido).ativo}, ${getKeyring().active}, 'global', 'fraude', ${dono.id}, now() + interval '12 months')`;
    const r = await new Navegador().post(postCriarPedido, pedido(banca.codigo, banido));
    expect(r.status).toBe(409);
    expect(r.dados.erro).toBe(MSG_BLOQUEADO);
  });

  it("valor e vagas travam depois do primeiro pedido; o nome continua editável", async () => {
    const [b] = await sql<{ version: number }[]>`select version from app.bancas where id = ${banca.id}`;
    const travado = await dono.nav.post(postEditarBanca, { id: banca.id, versao: b?.version, nome: "Nova", totalCents: 500000 });
    expect(travado.status).toBe(409);
    const nome = await dono.nav.post(postEditarBanca, { id: banca.id, versao: b?.version, nome: "Banca renomeada" });
    expect(nome.status).toBe(200);
  });

  it("dados inválidos não gravam nada", async () => {
    const antes = await pedidosDaBanca(banca.id);
    const r = await new Navegador().post(postCriarPedido, pedido(banca.codigo, "11111111111"));
    expect(r.status).toBe(400);
    expect(await pedidosDaBanca(banca.id)).toBe(antes);
  });

  it("sem token CSRF: recusado antes de qualquer coisa", async () => {
    const r = await new Navegador().post(postCriarPedido, pedido(banca.codigo), { semCsrf: true });
    expect(r.status).toBe(403);
  });

  it("sem o token do Turnstile: recusado e nada é gravado", async () => {
    const antes = await pedidosDaBanca(banca.id);
    const r = await new Navegador().post(postCriarPedido, pedido(banca.codigo, gerarCpf(), { turnstile: "" }));
    expect(r.status).toBe(400);
    expect(await pedidosDaBanca(banca.id)).toBe(antes);
  });

  it("Redis fora do ar: pedido BLOQUEADO (503), nada gravado", async () => {
    const antes = await pedidosDaBanca(banca.id);
    const original = process.env.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_URL = ENDERECO_FECHADO;
    try {
      expect((await new Navegador().post(postCriarPedido, pedido(banca.codigo))).status).toBe(503);
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = original;
    }
    expect(await pedidosDaBanca(banca.id)).toBe(antes);
  });

  it("os logs do servidor não contêm nome, CPF, chave Pix nem o token", async () => {
    const saidas: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const capturar = (chunk: unknown) => {
      saidas.push(String(chunk));
      return true;
    };
    process.stdout.write = capturar as typeof process.stdout.write;
    process.stderr.write = capturar as typeof process.stderr.write;
    const outroCpf = gerarCpf();
    const navLog = new Navegador();
    try {
      await navLog.post(postCriarPedido, pedido(banca.codigo, outroCpf, { nome: "Joana Rastreável" }));
      await new Navegador().post(postCriarPedido, pedido(banca.codigo, outroCpf)); // duplicado também loga
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const tudo = saidas.join("\n");
    expect(tudo.length).toBeGreaterThan(0);
    expect(tudo).not.toContain(outroCpf);
    expect(tudo).not.toContain(mascararCpf(outroCpf));
    expect(tudo).not.toContain("Rastreável");
    expect(tudo).not.toContain(`maria.${outroCpf}`);
    expect(tudo).not.toContain(navLog.cookies.get(COOKIE_PEDIDO) ?? "sessao-ausente");
  });
});

describe("regras da banca", () => {
  it("com a regra de IP desligada, o mesmo IP faz pedidos com CPFs diferentes", async () => {
    const banca = await criarBanca({ ipLimit: false });
    const nav = new Navegador();
    expect((await nav.post(postCriarPedido, pedido(banca.codigo))).status).toBe(201);
    await esperar(1100);
    expect((await nav.post(postCriarPedido, pedido(banca.codigo))).status).toBe(201);
  });

  it("banca pausada não aceita pedido; reaberta volta a aceitar", async () => {
    const banca = await criarBanca({ ipLimit: false });
    expect((await dono.nav.post(postStatusBanca, { id: banca.id, acao: "fechar" })).status).toBe(200);
    const fechada = await new Navegador().post(postCriarPedido, pedido(banca.codigo));
    expect(fechada.status).toBe(409);
    expect(String(fechada.dados.erro)).toMatch(/não está recebendo/);
    expect((await dono.nav.post(postStatusBanca, { id: banca.id, acao: "reabrir" })).status).toBe(200);
    expect((await new Navegador().post(postCriarPedido, pedido(banca.codigo))).status).toBe(201);
  });

  it("limite por IP: passou do limite, 429", async () => {
    const banca = await criarBanca({ ipLimit: false });
    const nav = new Navegador();
    process.env.RL_PEDIDO_POR_10MIN = "2";
    try {
      expect((await nav.post(postCriarPedido, pedido(banca.codigo))).status).toBe(201);
      await esperar(1100);
      expect((await nav.post(postCriarPedido, pedido(banca.codigo))).status).toBe(201);
      await esperar(1100);
      expect((await nav.post(postCriarPedido, pedido(banca.codigo))).status).toBe(429);
    } finally {
      process.env.RL_PEDIDO_POR_10MIN = "100";
    }
  });

  it("toPgBytea gera o formato que o Postgres entende", async () => {
    const bytes = Buffer.from([1, 2, 255]);
    const [r] = await sql<{ ok: boolean }[]>`select (${toPgBytea(bytes)}::text)::bytea = ${bytes} as ok`;
    expect(r?.ok).toBe(true);
  });
});
