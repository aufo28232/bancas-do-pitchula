import { z } from "zod";

/**
 * Variáveis de ambiente lidas EM TEMPO DE EXECUÇÃO pelo servidor (DECISIONS D-026).
 * Nada aqui é NEXT_PUBLIC_: trocar um valor exige só reiniciar o processo, não rebuild.
 * Esta lista cresce a cada etapa; .env.example documenta todas.
 */
export const serverEnvSchema = z.object({
  /** Nome da plataforma usado nos textos (ex.: "4fly"). */
  PLATFORM_NAME: z.string().trim().min(1).max(40),
  /** Link de cadastro na plataforma. Vazio = o link some da página. Só https. */
  PLATFORM_SIGNUP_URL: z
    .union([z.literal(""), z.url({ protocol: /^https$/ })])
    .default(""),
  /** Modo de deploy: decide se CF-Connecting-IP é confiável (D-031). */
  DEPLOY_MODE: z.enum(["managed", "cloudflare_locked", "tunnel"]).default("managed"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Lê e valida o ambiente. Lança erro sem mostrar os valores (só os nomes dos campos). */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const campos = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Variáveis de ambiente inválidas: ${campos}`);
  }
  return result.data;
}

export function getServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}
