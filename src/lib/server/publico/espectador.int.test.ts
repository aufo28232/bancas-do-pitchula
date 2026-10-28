/**
 * INTEGRAÇÃO (Etapa 4): página do pedido, chat, prazo de 5 min e Realtime,
 * contra Supabase local (Auth + PostgREST + Realtime) e Redis reais. Nada mockado.
 * O cliente do Realtime é o MESMO pacote usado no navegador.
 */
import { randomUUID } from "node:crypto";
import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postCriarBanca } from "@/lib/server/painel/bancas";
import { conectarBanco, esperar, exigirAmbiente, Navegador, novoStreamerLogado, TURNSTILE_TESTE } from "@/test/integracao";
import { gerarCpf, mascararCpf } from "@/test/util";
import { postCriarPedido } from "./pedido";
import { COOKIE_PEDIDO, COOKIE_PEDIDO_RT, postEstadoPedido, postMensagemPedido, postRealtimePedido } from "./espectador";

exigirAmbiente(["DATA_ENC_KEYS", "DATA_ENC_ACTIVE"]);
process.env.RL_PEDIDO_RAJADA_SEG = "1";
process.env.RL_PEDIDO_POR_10MIN = "100";

const sql = conectarBanco();
let dono: Awaited<ReturnType<typeof novoStreamerLogado>>;
let banca: { id: string; codigo: string };
const clientes: RealtimeClient[] = [];

/** Cria o pedido: o MESMO navegador que enviou já fica com a sessão do pedido (D-082). */
async function novoPedido(): Promise<{ cpf: string; email: string; id: string; nav: Navegador }> {
  const cpf = gerarCpf();
  const email = `joana.${cpf}@exemplo.com`;
  const nav = new Navegador();
  const r = await nav.post(postCriarPedido, {
    codigo: banca.codigo,
    nome: "Joana Prado Lima",
    pixTipo: "email",
    pixChave: email,
    plataformaId: `jo${cpf.slice(0, 6)}`,
    cpf: mascararCpf(cpf),
    privacidade: true,
    maioridade: true,
    turnstile: TURNSTILE_TESTE,
  });
  expect(r.status).toBe(201);
  expect(r.dados).toEqual({ proximo: "/pedido" });
  const [o] = await sql<{ id: string }[]>`select id from app.orders where banca_id = ${banca.id} order by seq desc limit 1`;
  return { cpf, email, id: o?.id ?? "", nav };
}

function clienteRealtime(token: string | null): RealtimeClient {
  const base = new URL("realtime/v1", `${process.env.SUPABASE_URL ?? ""}/`);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const anon = process.env.SUPABASE_ANON_KEY ?? "";
  const c = new RealtimeClient(base.toString(), { params: { apikey: anon } });
  void c.setAuth(token ?? anon);
  clientes.push(c);
  return c;
}

type Recebido = { event: string; payload: Record<string, unknown> };

/** Entra num canal PRIVADO e devolve o estado final (SUBSCRIBED ou erro) e o que chegar depois. */
function entrar(c: RealtimeClient, topico: string): Promise<{ estado: string; canal: RealtimeChannel; recebidos: Recebido[] }> {
  const recebidos: Recebido[] = [];
  const canal = c.channel(topico, { config: { private: true, broadcast: { self: true } } });
  canal.on("broadcast", { event: "*" }, (m: { event: string; payload?: unknown }) => {
    recebidos.push({ event: m.event, payload: (m.payload ?? {}) as Record<string, unknown> });
  });
  return new Promise((resolve) => {
    const limite = setTimeout(() => resolve({ estado: "TIMEOUT", canal, recebidos }), 15_000);
    canal.subscribe((status) => {
      const estado = String(status);
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(estado)) {
        clearTimeout(limite);
        resolve({ estado, canal, recebidos });
      }
    });
  });
}

async function ate(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (cond()) return true;
    await esperar(100);
  }
  return cond();
}

beforeAll(async () => {
  dono = await novoStreamerLogado(sql);
  const r = await dono.nav.post(postCriarBanca, { nome: "Banca ao vivo", totalCents: 300000, vagas: 10, ipLimit: true, idem: randomUUID() });
  expect(r.status).toBe(201);
  banca = { id: String(r.dados.id), codigo: /\/([a-z0-9]{8}-[0-9]{4})-banca$/.exec(String(r.dados.link))?.[1] ?? "" };
});

afterAll(async () => {
  for (const c of clientes) c.disconnect();
  await sql.end();
});

describe("sessão do pedido", () => {
  it("criar o pedido já liga o navegador a ele: cookie httpOnly e conta anônima vinculada", async () => {
    const p = await novoPedido();
    expect(p.nav.cookies.get(COOKIE_PEDIDO)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.nav.cookies.get(COOKIE_PEDIDO_RT)).toBeTruthy();
    expect((await p.nav.post(postEstadoPedido, {})).status).toBe(200);

    const [o] = await sql<{ viewer_uid: string | null; anonimo: boolean | null; sessoes: number }[]>`
      select o.viewer_uid, u.is_anonymous as anonimo,
             (select count(*)::int from app.order_sessions s where s.order_id = o.id) as sessoes
        from app.orders o left join auth.users u on u.id = o.viewer_uid
       where o.id = ${p.id}`;
    expect(o?.anonimo).toBe(true);
    expect(o?.sessoes).toBe(1);
  });

  it("pedido recusado (CPF repetido): nenhum cookie e nenhuma conta anônima sobrando", async () => {
    const p = await novoPedido();
    const [antes] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users where is_anonymous`;
    const nav = new Navegador();
    const r = await nav.post(postCriarPedido, {
      codigo: banca.codigo, nome: "Joana Prado Lima", pixTipo: "email", pixChave: `x${p.email}`, plataformaId: "outro1",
      cpf: mascararCpf(p.cpf), privacidade: true, maioridade: true, turnstile: TURNSTILE_TESTE,
    });
    expect(r.status).toBe(409);
    expect(nav.cookies.has(COOKIE_PEDIDO)).toBe(false);
    const [depois] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users where is_anonymous`;
    expect(depois?.n).toBe(antes?.n);
  });

  it("sem cookie de sessão não há estado (401)", async () => {
    expect((await new Navegador().post(postEstadoPedido, {})).status).toBe(401);
  });
});

describe("estado e chat", () => {
  it("mostra posição e os próprios dados MASCARADOS: nada completo sai do servidor", async () => {
    const p = await novoPedido();
    const nav = p.nav;
    const r = await nav.post(postEstadoPedido, {});
    expect(r.status).toBe(200);
    const texto = JSON.stringify(r.dados);
    expect(texto).not.toContain(p.cpf);
    expect(texto).not.toContain(p.email);
    expect(texto).not.toContain("Prado Lima");
    expect(texto).not.toMatch(/v\d+:[A-Za-z0-9_-]{20,}/); // nenhum texto cifrado
    const dados = r.dados.dados as Record<string, string>;
    expect(dados.cpf).toMatch(/^\*\*\*\.\*\*\*\.\*\*\d-\d\d$/);
    expect(dados.pix).toMatch(/^j\*\*\*@e\*\*\*\.com$/);
    expect(dados.nome).toBe("Joana P. L.");
    expect((r.dados.pedido as { posicao: number }).posicao).toBeGreaterThanOrEqual(1);
  });

  it("mensagem do espectador entra no chat; texto vazio é recusado", async () => {
    const p = await novoPedido();
    const nav = p.nav;
    expect((await nav.post(postMensagemPedido, { texto: "   " })).status).toBe(400);
    // O limite de 1 mensagem a cada 2 s conta também a tentativa inválida (o limite vem antes da validação).
    expect((await nav.post(postMensagemPedido, { texto: "rápido demais" })).status).toBe(429);
    await esperar(2100);
    expect((await nav.post(postMensagemPedido, { texto: "Oi, já depositei <b>ok</b>" })).status).toBe(201);
    const r = await nav.post(postEstadoPedido, {});
    const msgs = r.dados.mensagens as { autor: string; texto: string }[];
    expect(msgs.some((m) => m.autor === "espectador" && m.texto === "Oi, já depositei <b>ok</b>")).toBe(true);
  });

  it("prazo de 5 min: resposta no prazo zera o relógio; depois do prazo o pedido é encerrado", async () => {
    const p = await novoPedido();
    const nav = p.nav;

    await sql`update app.orders set locked_by = ${dono.id}, locked_at = now(), lock_activity_at = now(),
                     reply_deadline_at = now() + interval '5 minutes' where id = ${p.id}`;
    expect((await nav.post(postMensagemPedido, { texto: "Respondendo no prazo" })).status).toBe(201);
    const [o1] = await sql<{ prazo: Date | null }[]>`select reply_deadline_at as prazo from app.orders where id = ${p.id}`;
    expect(o1?.prazo).toBeNull();

    await sql`update app.orders set reply_deadline_at = now() - interval '1 second' where id = ${p.id}`;
    await esperar(2100); // janela de 1 mensagem a cada 2 s
    const tarde = await nav.post(postMensagemPedido, { texto: "Atrasado" });
    expect(tarde.status).toBe(409);
    const e = await nav.post(postEstadoPedido, {});
    expect((e.dados.pedido as { status: string; motivo: string }).status).toBe("recusado");
    expect((e.dados.pedido as { status: string; motivo: string }).motivo).toBe("sem_resposta");
  });
});

describe("tempo real (Supabase Realtime de verdade)", () => {
  it("espectador ouve SÓ o próprio pedido; não ouve outro pedido nem o painel; não consegue emitir", async () => {
    const meu = await novoPedido();
    const outro = await novoPedido();
    const nav = meu.nav;
    const navOutro = outro.nav;

    const cred = await nav.post(postRealtimePedido, {});
    expect(cred.status).toBe(200);
    const token = String(cred.dados.token);
    expect((cred.dados.topicos as { pedido: string }).pedido).toBe(`pedido:${meu.id}`);
    // Renovação gira o refresh token (o antigo deixa de valer).
    expect(nav.cookies.get(COOKIE_PEDIDO_RT)).toBeTruthy();

    const ouvinte = await entrar(clienteRealtime(token), `pedido:${meu.id}`);
    expect(ouvinte.estado).toBe("SUBSCRIBED");
    expect((await entrar(clienteRealtime(token), `pedido:${outro.id}`)).estado).not.toBe("SUBSCRIBED");
    expect((await entrar(clienteRealtime(token), `staff:${banca.id}`)).estado).not.toBe("SUBSCRIBED");

    // Evento vindo do BANCO chega (controle positivo): moderador assume o pedido.
    await sql`update app.orders set locked_by = ${dono.id}, locked_at = now(), lock_activity_at = now() where id = ${meu.id}`;
    expect(await ate(() => ouvinte.recebidos.some((m) => m.event === "assumido"))).toBe(true);
    const assumido = ouvinte.recebidos.find((m) => m.event === "assumido");
    expect(assumido?.payload.atendente).toBe("Pitchula");
    expect(JSON.stringify(ouvinte.recebidos)).not.toMatch(/v\d+:[A-Za-z0-9_-]{20,}|@exemplo\.com/);

    // Tentativa de emitir pelo cliente: ninguém recebe (não há política de INSERT).
    const emissor = await entrar(clienteRealtime(token), `pedido:${meu.id}`);
    expect(emissor.estado).toBe("SUBSCRIBED");
    await emissor.canal.send({ type: "broadcast", event: "falso", payload: { status: "pago" } });
    await esperar(2500);
    expect(ouvinte.recebidos.some((m) => m.event === "falso")).toBe(false);
  });

  it("moderador com MFA ouve o canal do painel; visitante (anon) ouve as vagas ao vivo", async () => {
    const staff = await entrar(clienteRealtime(dono.nav.access ?? ""), `staff:${banca.id}`);
    expect(staff.estado).toBe("SUBSCRIBED");

    const vagas = await entrar(clienteRealtime(null), `vagas:${banca.codigo}`);
    expect(vagas.estado).toBe("SUBSCRIBED");
    expect((await entrar(clienteRealtime(null), `staff:${banca.id}`)).estado).not.toBe("SUBSCRIBED");

    await sql`update app.bancas set paid_count = paid_count + 1 where id = ${banca.id}`;
    expect(await ate(() => vagas.recebidos.some((m) => m.event === "vagas"))).toBe(true);
    expect(vagas.recebidos.find((m) => m.event === "vagas")?.payload.restantes).toBe(9);
    await sql`update app.bancas set paid_count = paid_count - 1 where id = ${banca.id}`;

    // Novo pedido: o painel recebe só id e estado, sem dados pessoais.
    await novoPedido();
    expect(await ate(() => staff.recebidos.some((m) => m.event === "fila"))).toBe(true);
    expect(JSON.stringify(staff.recebidos)).not.toMatch(/v\d+:[A-Za-z0-9_-]{20,}|@exemplo\.com|Joana/);
  });
});
