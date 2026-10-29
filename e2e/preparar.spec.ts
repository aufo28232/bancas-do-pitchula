/**
 * Preparação (roda antes dos outros projetos): o streamer entra PELA TELA,
 * cadastra o app autenticador e cria uma banca. Exercita login, MFA, CSP e o
 * painel num navegador real.
 */
import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { criarStreamer } from "../src/lib/server/seed";
import { ateProximoPeriodoTotp, totp } from "../src/test/util";
import { esperarTurnstile, observarCsp, salvarEstado } from "./apoio";

test("streamer entra com MFA pela tela e cria uma banca", async ({ page }) => {
  const violacoes = observarCsp(page);

  const sql = postgres(process.env.DB_URL ?? "", { max: 1, onnotice: () => undefined });
  await sql`update app.staff set active = false, deactivated_at = now() where role = 'owner' and active`;
  await sql.end();
  const email = `e2e-${randomUUID().slice(0, 8)}@teste.local`;
  const senha = `E2e-${randomBytes(15).toString("base64url")}`;
  await criarStreamer({ email, senha, apelido: "Pitchula" });

  // Login
  await page.goto("/painel/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(senha);
  await esperarTurnstile(page);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/painel\/mfa$/);

  // Cadastro do autenticador (lendo a chave manual, como faria quem não consegue escanear)
  await page.screenshot({ path: "test-results/capturas/painel-mfa.png" });
  await page.getByRole("button", { name: "Gerar QR code" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await page.getByText("Não consegue escanear?").click();
  const segredo = ((await page.locator("details code").textContent()) ?? "").trim();
  expect(segredo).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel("Código de 6 dígitos").fill(totp(segredo));
  await page.getByRole("button", { name: "Ativar" }).click();
  try {
    await expect(page).toHaveURL(/\/painel$/, { timeout: 8_000 });
  } catch {
    await page.waitForTimeout(ateProximoPeriodoTotp());
    await page.getByLabel("Código de 6 dígitos").fill(totp(segredo));
    await page.getByRole("button", { name: "Ativar" }).click();
    await expect(page).toHaveURL(/\/painel$/);
  }

  // Criação da banca com prévia do valor por pessoa
  await page.getByRole("link", { name: "Nova banca" }).click();
  await page.getByLabel("Nome da banca").fill("Banca E2E");
  await page.getByLabel("Valor total (R$)").fill("3.000");
  await page.getByLabel("Quantidade de vagas").fill("100");
  // Casa e link de afiliado da banca (D-086).
  await page.getByLabel("Nome da casa").fill("Casa Teste");
  await page.getByLabel("Link de afiliado").fill("https://casa-teste.example/afiliado-e2e");
  await expect(page.getByText("R$ 30 por pessoa")).toBeVisible();
  await page.getByLabel(/Limitar a 1 pedido por IP/).uncheck(); // todos os testes saem do mesmo IP
  await page.getByRole("button", { name: "Criar banca" }).click();
  await expect(page.getByText("Banca criada")).toBeVisible();
  const link = ((await page.locator("code").first().textContent()) ?? "").trim();
  expect(link).toMatch(/\/[a-z0-9]{8}-[0-9]{4}-banca$/);
  salvarEstado({ link: new URL(link).pathname, email, senha, segredo });

  // A banca aparece na lista do painel
  await page.goto("/painel");
  await expect(page.getByText("Banca E2E")).toBeVisible();
  await page.screenshot({ path: "test-results/capturas/painel-bancas.png" });

  expect(violacoes).toEqual([]);
});
