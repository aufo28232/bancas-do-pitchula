import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast";
import { contrastPairs, theme } from "./theme";

describe("contraste WCAG", () => {
  it("calcula os extremos corretamente", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 10);
  });

  it("rejeita cor em formato inválido", () => {
    expect(() => relativeLuminance("laranja")).toThrow();
  });

  it.each(contrastPairs)("$uso passa no AA ($fg sobre $bg ≥ $min)", ({ fg, bg, min }) => {
    expect(contrastRatio(theme.colors[fg], theme.colors[bg])).toBeGreaterThanOrEqual(min);
  });

  it("branco sobre o laranja reprova (por isso o botão usa texto escuro)", () => {
    expect(contrastRatio("#FFFFFF", theme.colors.accent)).toBeLessThan(4.5);
  });
});
