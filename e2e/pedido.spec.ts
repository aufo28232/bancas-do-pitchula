/**
 * Página do pedido (Etapa 4) num navegador real, desktop e celular:
 * fragmento apagado, posição, beep ao ser assumido, prazo de 5 min, chat,
 * tela inicial abrindo a banca atual e saída do link quando a banca é encerrada.
 * Os eventos do painel (assumir, prazo) são simulados direto no banco: o painel
 * de atendimento chega na Etapa 5.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { gerarCpf } from "../src/test/util";
import { esperarTurnstile, lerEstado, observarCsp } from "./apoio";

const sql = postgres(process.env.DB_URL ?? "", { max: 1, onnotice: () => undefined });
test.afterAll(async () => {
  await sql.end();
});

/** Conta os bipes tocados (o áudio de verdade é gerado; só contamos os osciladores). */
async function instrumentarAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __bipes: number; AudioContext: typeof AudioContext };
    w.__bipes = 0;
    const Original = w.AudioContext;
    w.AudioContext = class extends Original {
      override createOscillator(): OscillatorNode {
        const o = super.createOscillator();
        const start = o.start.bind(o);
        o.start = (...a: Parameters<OscillatorNode["start"]>) => {
          w.__bipes += 1;
          return start(...a);
        };
        return o;
      }
    };
  });
}

const bipes = (page: Page) => page.evaluate(() => (window as unknown as { __bipes: number }).__bipes);

/** Faz o pedido pela página da banca; o navegador cai direto no /pedido (D-082). */
async function fazerPedido(page: Page): Promise<void> {
  const cpf = gerarCpf();
  await page.goto(lerEstado().link);
  await page.getByLabel("Nome completo").fill("Paula Fila Viva");
  await page.getByText("E-mail", { exact: true }).click();
  await page.getByLabel("Chave Pix (E-mail)").fill(`fila.${cpf}@exemplo.com`);
  await page.getByLabel(/^CPF cadastrado na /).fill(cpf);
  await page.getByLabel(/política de privacidade/).check();
  await page.getByLabel("Tenho 18 anos ou mais.").check();
  await esperarTurnstile(page);
  await page.getByRole("button", { name: "Enviar pedido" }).click();
  await expect(page).toHaveURL(/\/pedido$/);
}

test("acompanha o pedido: posição, beep ao ser assumido, prazo e chat", async ({ page }, info) => {
  await instrumentarAudio(page);
  const violacoes = observarCsp(page);
  await fazerPedido(page);
  const [pedido] = await sql<{ id: string }[]>`select id from app.orders order by seq desc limit 1`;
  const [staff] = await sql<{ user_id: string }[]>`select user_id from app.staff where active order by created_at desc limit 1`;
  expect(pedido && staff).toBeTruthy();
  if (!pedido || !staff) return;

  // Nenhum token na barra de endereço: a sessão é um cookie httpOnly.
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  await expect(page.getByText("Sua posição na fila")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("[data-posicao]")).toHaveAttribute("data-posicao", /^\d+$/);
  await expect(page.getByText("Atualizando ao vivo.")).toBeVisible();
  // Dados próprios aparecem mascarados.
  await expect(page.getByText(/^\*\*\*\.\*\*\*\.\*\*\d-\d\d$/)).toBeVisible();
  await expect(page.getByText("Paula F. V.")).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.screenshot({ path: `test-results/capturas/pedido-fila-${info.project.name}.png`, fullPage: info.project.name === "celular" });

  // Som: precisa de um clique (regra dos navegadores). O clique toca um bipe de teste.
  await page.getByRole("button", { name: "Ativar som" }).click();
  await expect(page.getByRole("button", { name: "Som ativado" })).toBeVisible();
  const antes = await bipes(page);
  expect(antes).toBeGreaterThanOrEqual(1);

  // Moderador assume (simulado no banco): bipe + aviso, via Realtime.
  await sql`update app.orders set locked_by = ${staff.user_id}, locked_at = now(), lock_activity_at = now() where id = ${pedido.id}`;
  await expect(page.getByText(/assumiu seu pedido/)).toBeVisible();
  await expect(page.getByText("Em atendimento")).toBeVisible();
  await expect.poll(() => bipes(page)).toBeGreaterThanOrEqual(antes + 2);

  // Moderador mandou mensagem: começa o prazo de 5 min (D-043).
  await sql`insert into app.order_messages (order_id, author, staff_id, body) values (${pedido.id}, 'staff', ${staff.user_id}, 'Manda o comprovante, por favor')`;
  await sql`update app.orders set reply_deadline_at = now() + interval '5 minutes' where id = ${pedido.id}`;
  await expect(page.getByText("Manda o comprovante, por favor")).toBeVisible();
  const relogio = page.locator("[data-prazo]");
  await expect(relogio).toContainText(/^[45]:\d\d/);
  await page.screenshot({ path: `test-results/capturas/pedido-prazo-${info.project.name}.png` });

  // Resposta do espectador para o relógio.
  await page.getByLabel("Sua mensagem").fill("Enviando agora!");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByText("Enviando agora!")).toBeVisible();
  await expect(relogio).toHaveCount(0);

  // Prazo vencido: o pedido é encerrado e o chat fecha.
  await sql`update app.orders set reply_deadline_at = now() - interval '1 second' where id = ${pedido.id}`;
  await sql`select app.expire_unanswered()`;
  await expect(page.getByRole("heading", { name: "Pedido encerrado" })).toBeVisible();
  await expect(page.getByText("O tempo para responder acabou.")).toBeVisible();
  await expect(page.getByLabel("Sua mensagem")).toHaveCount(0);

  expect(violacoes).toEqual([]);
});

test("sem pedido neste navegador, /pedido mostra aviso e não vaza nada", async ({ page }) => {
  await page.goto("/pedido");
  await expect(page.getByRole("heading", { name: "Nenhum pedido aqui" })).toBeVisible({ timeout: 45_000 });
});

test("tela inicial abre a banca mais recente e o link encerrado deixa de valer", async ({ page }) => {
  const violacoes = observarCsp(page);
  // Banca descartável só para este teste (encerrar não pode afetar os outros).
  const codigo = `${randomBytes(4).toString("hex")}-${String(1000 + (randomBytes(2).readUInt16BE(0) % 9000))}`;
  const [staff] = await sql<{ user_id: string }[]>`select user_id from app.staff where active and role = 'owner' limit 1`;
  const [b] = await sql<{ id: string }[]>`
    insert into app.bancas (code, code_hash, name, total_cents, slots, ip_limit, created_by, created_at)
    values (${codigo}, ${createHash("sha256").update(codigo).digest()}, 'Banca relâmpago', 50000, 5, false, ${staff?.user_id ?? ""},
            now() + interval '1 hour')
    returning id`;
  await sql`insert into app.banca_stats (banca_id) values (${b?.id ?? ""})`;

  // A tela inicial abre direto a banca criada por último (D-084), sem contagem de vagas.
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/${codigo}-banca$`));
  await expect(page.getByRole("heading", { name: "Banca relâmpago" })).toBeVisible();
  await expect(page.locator("[data-ao-vivo]")).toHaveAttribute("data-ao-vivo", "sim");
  await expect(page.getByText(/vagas restantes/)).toHaveCount(0);

  // Encerrada: o código some e quem está na página sai do link (D-044).
  await sql`update app.bancas set status = 'encerrada', ended_at = now(), code = null where id = ${b?.id ?? ""}`;
  await expect(page).not.toHaveURL(new RegExp(`/${codigo}-banca$`));
  expect(violacoes).toEqual([]);
});
