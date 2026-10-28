/**
 * Logger estruturado com LISTA DE CAMPOS PERMITIDOS (ARCHITECTURE §6.5).
 * Qualquer campo fora da lista é descartado, não "mascarado": assim nenhum
 * dado pessoal, token ou corpo de requisição chega aos logs por acidente.
 */
const PERMITIDOS = new Set([
  "evento",
  "requestId",
  "rota",
  "status",
  "motivo",
  "dependencia",
  "codigo",
  "duracaoMs",
  "tentativas",
  "quantidade",
]);

type Nivel = "info" | "warn" | "error";
type Valor = string | number | boolean | null | undefined;

export function log(nivel: Nivel, campos: Record<string, Valor>): void {
  const linha: Record<string, Valor> = { ts: new Date().toISOString(), nivel };
  for (const [k, v] of Object.entries(campos)) {
    if (!PERMITIDOS.has(k) || v === undefined) continue;
    linha[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  const saida = nivel === "error" ? process.stderr : process.stdout;
  saida.write(JSON.stringify(linha) + "\n");
}

/** Exposto para testes: devolve só os campos que o logger aceitaria. */
export function camposPermitidos(campos: Record<string, Valor>): string[] {
  return Object.keys(campos).filter((k) => PERMITIDOS.has(k));
}
