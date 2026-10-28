/**
 * Página pública da banca, no desktop e no celular (projetos do playwright.config).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { gerarCpf } from "../src/test/util";
import { esperarTurnstile, lerEstado, observarCsp } from "./apoio";

async function preencher(page: Page, cpf: string): Promise<void> {
  await page.getByLabel("Nome completo").fill("Maria da Silva");
  await page.getByText("E-mail", { exact: true }).click();
  await page.getByLabel("Chave Pix (E-mail)").fill(`e2e.${cpf}@exemplo.com`);
  await page.getByLabel(/^ID na /).fill(`e2e${cpf.slice(0, 6)}`);
  await page.getByLabel(/^CPF cadastrado na /).fill(cpf);
  await page.getByLabel(/política de privacidade/).check();
  await page.getByLabel("Tenho 18 anos ou mais.").check();
  await esperarTurnstile(page);
}

test("mostra a banca, aceita o pedido e recusa o mesmo CPF com mensagem genérica", async ({ page }, info) => {
  const { link } = lerEstado();
  const violacoes = observarCsp(page);
  await page.goto(link);

  await expect(page.getByText("Banca do Pitchula", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Banca E2E" })).toBeVisible();
  await expect(page.getByText("R$ 30", { exact: true })).toBeVisible();
  // A contagem de vagas não aparece mais para o público (D-084).
  await expect(page.getByText(/vagas restantes/)).toHaveCount(0);
  await expect(page.getByRole("img", { name: /Pitchula/ })).toBeVisible();

  // Sem rolagem horizontal (celular e desktop).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Link de cadastro na plataforma, com os atributos exigidos.
  const cadastro = page.getByRole("link", { name: /Cadastre-se aqui/ });
  await expect(cadastro).toHaveAttribute("target", "_blank");
  await expect(cadastro).toHaveAttribute("rel", "noopener noreferrer nofollow sponsored");

  // Acessibilidade (WCAG A/AA, inclui contraste), sem contar o widget da Cloudflare.
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude("[data-turnstile]").analyze();
  const graves = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(graves.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Capturas para revisão visual (publicadas junto com os logs do CI).
  const foto = page.getByRole("img", { name: /Pitchula/ });
  await expect.poll(() => foto.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await esperarTurnstile(page);
  await page.screenshot({ path: `test-results/capturas/banca-${info.project.name}.png`, fullPage: info.project.name === "celular" });

  const cpf = gerarCpf();
  await preencher(page, cpf);
  await page.getByRole("button", { name: "Enviar pedido" }).click();
  // Vai direto para o chat do pedido, sem link para copiar (D-082).
  await expect(page).toHaveURL(/\/pedido$/);
  await expect(page.getByText("Sua posição na fila")).toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: `test-results/capturas/pedido-enviado-${info.project.name}.png` });

  // Voltar para o link da banca (ou para o início) leva de volta ao pedido.
  await page.goto(link);
  await expect(page).toHaveURL(/\/pedido$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/pedido$/);

  // Mesmo CPF de novo, de outro navegador: mensagem genérica, sem dizer qual dado repetiu.
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto(link);
  await preencher(page, cpf);
  await page.getByRole("button", { name: "Enviar pedido" }).click();
  await expect(page.locator("#erro-geral")).toHaveText("Não foi possível registrar seu pedido nesta banca.");

  expect(violacoes).toEqual([]);
});

test("enviar com erros foca o primeiro campo inválido e anuncia o erro", async ({ page }) => {
  await page.goto(lerEstado().link);
  await page.getByLabel("Nome completo").fill("Maria");
  await page.getByRole("button", { name: "Enviar pedido" }).click();
  const nome = page.getByLabel("Nome completo");
  await expect(nome).toBeFocused();
  await expect(nome).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Escreva seu nome completo (nome e sobrenome).")).toBeVisible();
  await expect(page.locator("#erro-geral")).not.toBeEmpty();
});

test("dá para preencher e enviar só com o teclado", async ({ page, isMobile }) => {
  test.skip(isMobile, "navegação por teclado é verificada no desktop");
  await page.goto(lerEstado().link);
  const cpf = gerarCpf();

  await page.getByLabel("Nome completo").focus();
  await page.keyboard.type("Joana Teclado");
  await page.keyboard.press("Tab"); // grupo de rádio (CPF marcado)
  await expect(page.getByRole("radio", { name: "CPF" })).toBeFocused();
  await page.keyboard.press("ArrowRight"); // E-mail
  await expect(page.getByRole("radio", { name: "E-mail" })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Chave Pix (E-mail)")).toBeFocused();
  await page.keyboard.type(`teclado.${cpf}@exemplo.com`);
  await page.keyboard.press("Tab");
  await page.keyboard.type(`tec${cpf.slice(0, 5)}`);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/^CPF cadastrado na /)).toBeFocused();
  await page.keyboard.type(cpf);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space"); // privacidade
  await page.keyboard.press("Tab"); // link da política
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space"); // maioridade
  await expect(page.getByLabel(/política de privacidade/)).toBeChecked();
  await expect(page.getByLabel("Tenho 18 anos ou mais.")).toBeChecked();
  await esperarTurnstile(page);
  await page.getByLabel(/^CPF cadastrado na /).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pedido$/);
});

test("link de banca inexistente sai do link (vai para a banca atual ou para a espera)", async ({ page }) => {
  const violacoes = observarCsp(page);
  await page.goto("/zzzzzzzz-0000-banca");
  await expect(page).not.toHaveURL(/zzzzzzzz-0000/);
  await expect(page.getByRole("heading").first()).toBeVisible();
  expect(violacoes).toEqual([]);
});

test("política de privacidade acessível e sem violações graves", async ({ page }) => {
  await page.goto("/privacidade");
  await expect(page.getByRole("heading", { name: "Privacidade" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
});
