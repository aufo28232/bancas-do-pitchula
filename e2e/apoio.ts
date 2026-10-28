import { expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ARQUIVO_ESTADO = fileURLToPath(new URL("./.estado.json", import.meta.url));

export type Estado = { link: string; email: string; senha: string; segredo: string };

export function salvarEstado(e: Estado): void {
  writeFileSync(ARQUIVO_ESTADO, JSON.stringify(e));
}

export function lerEstado(): Estado {
  return JSON.parse(readFileSync(ARQUIVO_ESTADO, "utf8")) as Estado;
}

/** Coleta violações de CSP reportadas no console (a página não pode ter nenhuma). */
export function observarCsp(page: Page): string[] {
  const violacoes: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect|frame)/i.test(t)) violacoes.push(t.slice(0, 300));
  });
  return violacoes;
}

/** Espera o Turnstile (chave de teste) devolver o token. */
export async function esperarTurnstile(page: Page): Promise<void> {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, { timeout: 45_000 });
}
