import type { TipoPix } from "@/lib/validacao/pedido";

/**
 * Máscaras dos dados pessoais mostrados na página do pedido (D-023).
 * Se o link vazar, quem abrir NÃO vê os dados completos. O servidor aplica a
 * máscara antes de responder: o valor completo nunca chega ao navegador.
 */
const ast = (n: number) => "*".repeat(Math.max(0, n));

/** "João Pedro da Silva" -> "João P. d. S." */
export function mascararNome(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  const [primeiro, ...resto] = partes;
  if (!primeiro) return "";
  return [primeiro, ...resto.map((p) => `${[...p][0] ?? ""}.`)].join(" ");
}

/** "12345678901" -> "***.***.**9-01" */
export function mascararCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return "***.***.***-**";
  return `***.***.**${d.slice(8, 9)}-${d.slice(9)}`;
}

/** "joao.silva@gmail.com" -> "j***@g***.com" */
export function mascararEmail(email: string): string {
  const [usuario = "", dominio = ""] = email.split("@");
  const pontos = dominio.split(".");
  const tld = pontos.length > 1 ? pontos.slice(1).join(".") : "";
  const host = pontos[0] ?? "";
  return `${usuario.slice(0, 1)}***@${host.slice(0, 1)}***${tld ? `.${tld}` : ""}`;
}

/** "+5521987654321" -> "(**) *****-4321" */
export function mascararTelefone(tel: string): string {
  const d = tel.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  return `(**) ${ast(Math.max(0, d.length - 6))}-${d.slice(-4)}`;
}

/** UUID -> "1a2b****-****-****-********9z8y" */
export function mascararAleatoria(chave: string): string {
  if (chave.length < 12) return ast(chave.length);
  return chave.slice(0, 4) + chave.slice(4, -4).replace(/[^-]/g, "*") + chave.slice(-4);
}

export function mascararPix(tipo: TipoPix, chave: string): string {
  switch (tipo) {
    case "cpf":
      return mascararCpf(chave);
    case "email":
      return mascararEmail(chave);
    case "telefone":
      return mascararTelefone(chave);
    case "aleatoria":
      return mascararAleatoria(chave);
  }
}

/** ID na plataforma: só os 3 últimos caracteres. */
export function mascararPlataformaId(id: string): string {
  if (id.length <= 3) return ast(id.length);
  return ast(Math.min(8, id.length - 3)) + id.slice(-3);
}
