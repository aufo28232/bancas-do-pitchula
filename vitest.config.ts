import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Os testes de integração (*.int.test.ts) usam o MESMO banco: rodam em sequência.
    fileParallelism: false,
    // A verificação do TOTP pode esperar o próximo período de 30 s.
    testTimeout: 90_000,
    hookTimeout: 180_000,
  },
});
