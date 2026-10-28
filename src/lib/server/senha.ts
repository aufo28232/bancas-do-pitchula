import { createHash } from "node:crypto";

/**
 * Política de senha do staff (enunciado §5):
 * - mínimo de 12 caracteres (contados como caracteres, não bytes), máximo de 128;
 * - checagem contra senhas vazadas feita pelo NOSSO servidor, na API
 *   k-anonymity do Have I Been Pwned: só os 5 primeiros caracteres do SHA-1
 *   saem do servidor, com padding para esconder o tamanho da resposta.
 * Se o HIBP estiver fora, a senha é RECUSADA (falha fechada, D-012).
 *
 * Este arquivo não importa nada do projeto: também é usado pelo script de seed.
 */
export const SENHA_MIN = 12;
export const SENHA_MAX = 128;

export class HibpIndisponivelError extends Error {
  constructor() {
    super("HIBP indisponível");
    this.name = "HibpIndisponivelError";
  }
}

export type ProblemaSenha = "curta" | "longa";

export function problemaDeTamanho(senha: string): ProblemaSenha | null {
  const n = [...senha].length;
  if (n < SENHA_MIN) return "curta";
  if (n > SENHA_MAX) return "longa";
  return null;
}

/**
 * true = a senha aparece em vazamentos conhecidos.
 * Tenta duas vezes (falhas de rede passageiras); se as duas falharem, lança
 * HibpIndisponivelError e quem chama RECUSA a senha (falha fechada).
 */
export async function senhaVazada(senha: string, baseUrl = "https://api.pwnedpasswords.com"): Promise<boolean> {
  const sha1 = createHash("sha1").update(senha, "utf8").digest("hex").toUpperCase();
  const prefixo = sha1.slice(0, 5);
  const sufixo = sha1.slice(5);

  let texto: string | null = null;
  for (let tentativa = 0; tentativa < 2 && texto === null; tentativa++) {
    if (tentativa > 0) await new Promise((r) => setTimeout(r, 400));
    try {
      const resposta = await fetch(`${baseUrl.replace(/\/$/, "")}/range/${prefixo}`, {
        headers: { "Add-Padding": "true", "User-Agent": "bancas-do-pitchula" },
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (resposta.ok) texto = await resposta.text();
    } catch {
      texto = null;
    }
  }
  if (texto === null) throw new HibpIndisponivelError();

  for (const linha of texto.split("\n")) {
    const [suf, contagem] = linha.trim().split(":");
    // Com padding, entradas falsas vêm com contagem 0.
    if (suf === sufixo && Number(contagem) > 0) return true;
  }
  return false;
}

export const MENSAGEM_SENHA: Record<ProblemaSenha | "vazada" | "indisponivel", string> = {
  curta: `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`,
  longa: `A senha pode ter no máximo ${SENHA_MAX} caracteres.`,
  vazada: "Essa senha já apareceu em vazamentos de dados. Escolha outra.",
  indisponivel: "Não foi possível validar a senha agora. Tente de novo em instantes.",
};
