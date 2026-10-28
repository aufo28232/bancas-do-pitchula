import { Big_Shoulders, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

// Fontes auto-hospedadas pelo next/font (baixadas no build, servidas do próprio domínio).
// Escolha e alternativas: DECISIONS D-024.

/** Display condensada e pesada: valor da banca e títulos. */
// "Big Shoulders" é o nome atual da antiga "Big Shoulders Display" (o Google Fonts unificou a família).
// O next/font não tem métricas de fallback para ela, então o fallback é declarado à mão.
export const fontDisplay = Big_Shoulders({
  subsets: ["latin"],
  weight: ["800", "900"],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["Impact", "Haettenschweiler", "Arial Narrow Bold", "sans-serif"],
});

/** Texto corrido. */
export const fontSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

/** Dados tabulares no painel. */
export const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});
