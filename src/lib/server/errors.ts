/** Erro com mensagem SEGURA para o usuário (sem detalhes internos). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly reason: string = "http_error",
    readonly headers: Record<string, string> = {},
  ) {
    super(reason);
    this.name = "HttpError";
  }
}

export type Dependency = "redis" | "turnstile" | "hibp" | "supabase";

/** Serviço externo fora do ar. As operações críticas FALHAM FECHADO com isto. */
export class DependencyUnavailableError extends Error {
  constructor(readonly dependency: Dependency) {
    super(`dependência indisponível: ${dependency}`);
    this.name = "DependencyUnavailableError";
  }
}

export const MSG = {
  generico: "Não foi possível concluir agora. Tente de novo.",
  indisponivel: "Serviço temporariamente indisponível. Tente de novo em instantes.",
  sessao: "Sua sessão expirou. Entre de novo.",
  semPermissao: "Você não tem permissão para isso.",
  csrf: "Requisição recusada. Recarregue a página e tente de novo.",
  muitasTentativas: "Muitas tentativas. Espere um pouco e tente de novo.",
  dadosInvalidos: "Confira os dados e tente de novo.",
} as const;
