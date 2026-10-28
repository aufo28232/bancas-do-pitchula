import { defineConfig, devices } from "@playwright/test";

/**
 * Testes de ponta a ponta contra o BUILD de produção (standalone), com Supabase
 * local, Redis e Turnstile em modo de teste. Ver README.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1, // mesmo banco e mesmos limites de taxa
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  },
  projects: [
    { name: "preparar", testMatch: /preparar\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "desktop", testIgnore: /preparar\.spec\.ts/, dependencies: ["preparar"], use: { ...devices["Desktop Chrome"] } },
    { name: "celular", testIgnore: /preparar\.spec\.ts/, dependencies: ["preparar"], use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node .next/standalone/server.js",
    url: "http://localhost:3000/privacidade",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: "3000",
      HOSTNAME: "0.0.0.0",
      // Limites menores só para o teste não esperar 30 s entre pedidos do mesmo IP.
      RL_PEDIDO_RAJADA_SEG: "1",
      RL_PEDIDO_POR_10MIN: "100",
    },
  },
});
