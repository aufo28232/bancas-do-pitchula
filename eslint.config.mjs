import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Texto de chat e qualquer dado do usuário é SEMPRE texto puro (ARCHITECTURE §7, T12).
      "react/no-danger": "error",
      // Sem style inline: a CSP não libera 'unsafe-inline' para estilos.
      "react/forbid-dom-props": ["error", { forbid: ["style"] }],
      "react/forbid-component-props": ["error", { forbid: ["style"] }],
      // Nada de console: os logs passam pelo logger com lista de campos permitidos.
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "supabase/**", "scripts/**"]),
]);
