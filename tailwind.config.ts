import type { Config } from "tailwindcss";
import { theme } from "./src/theme/theme";

// Carregado pelo Tailwind v4 via `@config` em src/app/globals.css.
// Toda cor vem do tema central (src/theme/theme.ts).
const config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { ...theme.colors },
      fontFamily: {
        display: ["var(--font-display)", "Impact", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: { ...theme.radius },
    },
  },
} satisfies Config;

export default config;
