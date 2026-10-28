/**
 * Painel de atendimento (Etapa 5) num navegador real: o streamer entra com MFA,
 * atende um pedido feito por um espectador em OUTRO navegador e os dois lados
 * conversam ao vivo. Confere o modo live (dados mascarados por padrão, revelar
 * volta a mascarar e é auditado), o pagamento em 2 passos e o atalho de pânico.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { ateProximoPeriodoTotp, gerarCpf, totp } from "../src/test/util";
import { esperarTurnstile, lerEstado, observarCsp } from "./apoio";

const sql = postgres(process.env.DB_URL ?? "", { max: 1, onnotice: () => undefined });
test.afterAll(async () => {
  await sql.end();
});

async function entrarComoStreamer(page: Page): Promise<void> {
  const { email, senha, segredo } = lerEstado();
  await page.goto("/painel/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(senha);
  await esperarTurnstile(page);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/painel\/mfa$/);
  await page.getByLabel("Código de 6 dígitos").fill(totp(segredo));
  await page.getByRole("button", { name: "Confirmar" }).click();
  try {
    await expect(page).toHaveURL(/\/painel$/, { timeout: 8_000 });
  } catch {
    // Código do mesmo período já usado em outro teste: espera o próximo.
    await page.waitForTimeout(ateProximoPeriodoTotp());
    await page.getByLabel("Código de 6 dígitos").fill(totp(segredo));
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page).toHaveURL(/\/painel$/);
  }
}

async function pedidoDoEspectador(page: Page, nome: string): Promise<{ cpf: string; link: string }> {
  const cpf = gerarCpf();
  await page.goto(lerEstado().link);
  await page.getByLabel("Nome completo").fill(nome);
  await page.getByText("E-mail", { exact: true }).click();
  await page.getByLabel("Chave Pix (E-mail)").fill(`painel.${cpf}@exemplo.com`);
  await page.getByLabel(/^ID na /).fill(`pn${cpf.slice(0, 6)}`);
  await page.getByLabel(/^CPF cadastrado na /).fill(cpf);
  await page.getByLabel(/política de privacidade/).check();
  await page.getByLabel("Tenho 18 anos ou mais.").check();
  await esperarTurnstile(page);
  await page.getByRole("button", { name: "Enviar pedido" }).click();
  await expect(page.getByText("Pedido enviado!")).toBeVisible();
  const link = ((await page.locator("code").first().textContent()) ?? "").trim();
  return { cpf, link };
}

test("streamer atende um pedido ao vivo: modo live, chat com prazo, revelar, pagar e pânico", async ({ page, browser }, info) => {
  test.skip(info.project.name === "celular", "o atendimento completo roda no desktop; o celular confere o layout abaixo");
  const violacoes = observarCsp(page);

  // Espectador, em outro navegador.
  const ctxEspectador = await browser.newContext({ baseURL: "http://localhost:3000", locale: "pt-BR" });
  const espectador = await ctxEspectador.newPage();
  const nome = "Zelia Painel Teste";
  const mascarado = "Z*** P*** T***";
  const { cpf, link } = await pedidoDoEspectador(espectador, nome);
  await espectador.goto(link);
  await expect(espectador.getByText("Sua posição na fila")).toBeVisible({ timeout: 45_000 });

  // Streamer no painel.
  await entrarComoStreamer(page);
  await page.getByRole("link", { name: /^Atender/ }).first().click();
  await expect(page.getByRole("heading", { name: "Banca E2E" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Modo live: ligado" })).toBeVisible();
  await expect(page.getByText("Fila ao vivo.")).toBeVisible();

  // Modo live: o nome completo não está na página (nem escondido no HTML).
  const item = page.locator("[data-fila] button", { hasText: mascarado }).last();
  await expect(item).toBeVisible();
  expect(await page.content()).not.toContain(nome);
  expect(await page.content()).not.toContain(cpf);

  await item.click();
  await expect(page.getByRole("heading", { name: /^Pedido #\d+$/ })).toBeVisible();
  await expect(page.locator('[data-campo="cpf"]')).toHaveText("***.***.***-**");
  await page.getByRole("button", { name: "Assumir" }).click();
  await expect(page.locator("[data-status]")).toContainText("Com você");

  // Espectador vê que foi assumido, ao vivo.
  await expect(espectador.getByText(/assumiu seu pedido/)).toBeVisible();

  // Resposta rápida + enviar: começa o prazo de 5 min dos dois lados.
  await page.getByRole("group", { name: "Respostas rápidas" }).getByRole("button", { name: "Comprovante ilegível" }).click();
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.locator("[data-prazo-painel]")).toContainText(/^[45]:\d\d/);
  await expect(espectador.getByText(/Não deu pra ler o comprovante/)).toBeVisible();
  await expect(espectador.locator("[data-prazo]")).toBeVisible();

  // Espectador responde: o relógio para dos dois lados e o painel recebe a mensagem.
  await espectador.getByLabel("Sua mensagem").fill(`Segue de novo, meu cpf ${cpf}`);
  await espectador.getByRole("button", { name: "Enviar" }).click();
  await expect(espectador.locator("[data-prazo]")).toHaveCount(0);
  await expect(page.getByText("Segue de novo, meu cpf")).toBeVisible();
  await expect(page.locator("[data-prazo-painel]")).toHaveCount(0);
  // D-015: o CPF digitado no chat também aparece mascarado no modo live.
  expect(await page.content()).not.toContain(cpf);

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.screenshot({ path: "test-results/capturas/painel-atendimento.png", fullPage: true });

  // Revelar: mostra por 5 s, volta a mascarar e fica na auditoria.
  const [pedido] = await sql<{ id: string }[]>`select id from app.orders order by seq desc limit 1`;
  await page.locator("dd", { has: page.locator('[data-campo="cpf"]') }).getByRole("button", { name: "Revelar" }).click();
  await expect(page.locator('[data-campo="cpf"]')).toHaveText(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
  await expect(page.locator('[data-campo="cpf"]')).toHaveText("***.***.***-**", { timeout: 8_000 });
  const [audit] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.audit_log where action = 'revelar' and order_id = ${pedido?.id ?? ""} and detail ->> 'campo' = 'cpf'`;
  expect(audit?.n).toBe(1);

  // Pânico: Alt+Q esconde tudo; de novo, volta.
  await page.keyboard.press("Alt+KeyQ");
  await expect(page.getByText("Painel oculto")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Banca E2E" })).toBeHidden();
  await page.screenshot({ path: "test-results/capturas/painel-panico.png" });
  await page.keyboard.press("Alt+KeyQ");
  await expect(page.getByRole("heading", { name: "Banca E2E" })).toBeVisible();

  // Pagar em 2 passos: o pedido sai da fila e o espectador vê na hora.
  await page.getByRole("button", { name: "Marcar pago" }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirmar pagamento" })).toContainText(/Confirmar Pix de R\$\s?30 para Z\*\*\* P\*\*\* T\*\*\*\?/);
  await page.getByRole("button", { name: "Confirmar pagamento" }).click();
  await expect(page.getByText("Pagamento registrado.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-fila] button", { hasText: mascarado })).toHaveCount(0);
  await expect(espectador.getByRole("heading", { name: "Pagamento registrado" })).toBeVisible();

  await ctxEspectador.close();
  expect(violacoes).toEqual([]);
});

test("painel no celular: fila e pedido em telas separadas, sem rolagem horizontal", async ({ page }, info) => {
  test.skip(info.project.name !== "celular", "layout do celular");
  await entrarComoStreamer(page);
  await page.getByRole("link", { name: /^Atender/ }).first().click();
  await expect(page.getByRole("heading", { name: "Banca E2E" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const primeiro = page.locator("[data-fila] button").first();
  if (await primeiro.count()) {
    await primeiro.click();
    await expect(page.getByRole("button", { name: "Voltar para a fila" })).toBeVisible();
    await expect(page.locator("[data-fila]")).toBeHidden();
  }
  await page.screenshot({ path: "test-results/capturas/painel-celular.png", fullPage: true });
});
