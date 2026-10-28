/**
 * TEMA CENTRAL: cores, foto, logo e raios.
 * As fontes ficam em ./fonts.ts, porque o next/font exige chamadas literais no módulo.
 * O Tailwind lê este arquivo (tailwind.config.ts), então trocar uma cor aqui troca no site inteiro.
 *
 * Paleta tirada da foto do streamer (DECISIONS D-025). Quando os arquivos oficiais
 * de marca chegarem, eles substituem estes valores aqui, e só aqui.
 */
export const theme = {
  colors: {
    /** Fundo quase preto. */
    bg: "#0B0B0C",
    /** Superfícies (painel, campos em foco). */
    surface: "#141414",
    /** Linhas e divisórias decorativas (não usar para texto). */
    line: "#2A2826",
    /** Texto principal. */
    fg: "#F2EFEA",
    /** Texto secundário. */
    "fg-muted": "#A39E96",
    /** Única cor de destaque: laranja da fumaça da foto. */
    accent: "#EE781C",
    /** Texto sobre o laranja (branco reprova no AA: 2,9:1). */
    "accent-fg": "#0B0B0C",
  },
  photo: {
    src: "/pitchula.jpg",
    width: 991,
    height: 1088,
    /** Enquadramento no rosto. */
    objectPosition: "52% 18%",
    alt: "Pitchula, de moletom preto, em frente a uma fumaça laranja",
  },
  /** Logo oficial ainda não recebido. Enquanto for null, usa-se o nome em texto. */
  logo: null as null | { src: string; width: number; height: number; alt: string },
  radius: {
    none: "0px",
    sm: "2px",
    md: "4px",
  },
} as const;

export type ThemeColor = keyof typeof theme.colors;

/** Pares de texto/fundo que precisam passar no WCAG AA (verificados em teste). */
export const contrastPairs: ReadonlyArray<{
  fg: ThemeColor;
  bg: ThemeColor;
  min: number;
  uso: string;
}> = [
  { fg: "fg", bg: "bg", min: 4.5, uso: "texto principal no fundo" },
  { fg: "fg-muted", bg: "bg", min: 4.5, uso: "texto secundário no fundo" },
  { fg: "fg", bg: "surface", min: 4.5, uso: "texto principal no painel" },
  { fg: "fg-muted", bg: "surface", min: 4.5, uso: "texto secundário no painel" },
  { fg: "accent", bg: "bg", min: 4.5, uso: "laranja como texto/ícone no fundo" },
  { fg: "accent", bg: "surface", min: 4.5, uso: "laranja como texto no painel" },
  { fg: "accent-fg", bg: "accent", min: 4.5, uso: "texto do botão laranja" },
];
