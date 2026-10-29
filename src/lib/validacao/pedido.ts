import { z } from "zod";

/**
 * Validação do formulário de pedido. O MESMO código roda no navegador (feedback
 * imediato) e no servidor (fonte da verdade). Não importa nada do servidor.
 */

export const TIPOS_PIX = ["cpf", "email", "telefone", "aleatoria"] as const;
export type TipoPix = (typeof TIPOS_PIX)[number];

export const ROTULO_TIPO_PIX: Record<TipoPix, string> = {
  cpf: "CPF",
  email: "E-mail",
  telefone: "Telefone",
  aleatoria: "Chave aleatória",
};

export const soDigitos = (s: string) => s.replace(/\D/g, "");

/** CPF com dígitos verificadores; recusa sequências repetidas (111.111.111-11). */
export function cpfValido(entrada: string): boolean {
  const d = soDigitos(entrada);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const n = [...d].map(Number);
  const dv = (ate: number) => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += (n[i] ?? 0) * (ate + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === n[9] && dv(10) === n[10];
}

/** Máscara progressiva 000.000.000-00. */
export function mascaraCpf(entrada: string): string {
  const d = soDigitos(entrada).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
}

/** Máscara progressiva (00) 00000-0000. */
export function mascaraTelefone(entrada: string): string {
  let d = soDigitos(entrada);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_ALEATORIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normaliza a chave Pix conforme o tipo. Retorna null se for inválida.
 * - cpf: 11 dígitos válidos
 * - email: minúsculas, até 77 caracteres (limite do DICT)
 * - telefone: +55 + DDD + número (celular com 9 na frente ou fixo de 8 dígitos)
 * - aleatoria: UUID em minúsculas
 */
export function normalizarPix(tipo: TipoPix, entrada: string): string | null {
  const v = entrada.trim();
  switch (tipo) {
    case "cpf": {
      const d = soDigitos(v);
      return cpfValido(d) ? d : null;
    }
    case "email": {
      const e = v.toLowerCase();
      return e.length <= 77 && REGEX_EMAIL.test(e) ? e : null;
    }
    case "telefone": {
      let d = soDigitos(v);
      if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
      if (d.length !== 10 && d.length !== 11) return null;
      if (!/^[1-9][1-9]/.test(d)) return null; // DDD
      if (d.length === 11 && d[2] !== "9") return null; // celular começa com 9
      return `+55${d}`;
    }
    case "aleatoria": {
      const a = v.toLowerCase();
      return REGEX_ALEATORIA.test(a) ? a : null;
    }
  }
}

/** Nome completo: pelo menos nome e sobrenome, só letras (com acento), espaço, hífen, apóstrofo e ponto. */
export function normalizarNome(entrada: string): string {
  return entrada.normalize("NFC").replace(/\s+/g, " ").trim();
}

export const MENSAGENS = {
  nome: "Escreva seu nome completo (nome e sobrenome).",
  pixChave: "Chave Pix inválida para o tipo escolhido.",
  cpf: "CPF inválido. Confira os números.",
  privacidade: "Você precisa marcar que leu a política de privacidade.",
  maioridade: "Só maiores de 18 anos podem participar.",
  turnstile: "Aguarde a verificação de segurança terminar.",
} as const;

export const pedidoSchema = z
  .object({
    codigo: z.string().regex(/^[a-z0-9]{8}-[0-9]{4}$/),
    nome: z
      .string()
      .transform(normalizarNome)
      .pipe(
        z
          .string()
          .min(5, MENSAGENS.nome)
          .max(120, MENSAGENS.nome)
          .regex(/^[\p{L}][\p{L}'.-]*( [\p{L}][\p{L}'.-]*)+$/u, MENSAGENS.nome),
      ),
    pixTipo: z.enum(TIPOS_PIX),
    pixChave: z.string().max(120, MENSAGENS.pixChave),
    cpf: z.string().max(20, MENSAGENS.cpf).refine(cpfValido, MENSAGENS.cpf),
    privacidade: z.literal(true, MENSAGENS.privacidade),
    maioridade: z.literal(true, MENSAGENS.maioridade),
    turnstile: z.string().min(1, MENSAGENS.turnstile).max(2048),
  })
  .superRefine((d, ctx) => {
    if (!normalizarPix(d.pixTipo, d.pixChave)) {
      ctx.addIssue({ code: "custom", path: ["pixChave"], message: MENSAGENS.pixChave });
    }
  });

export type PedidoEntrada = z.input<typeof pedidoSchema>;
export type Pedido = z.output<typeof pedidoSchema>;
