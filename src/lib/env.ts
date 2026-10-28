import { z } from "zod";

/**
 * Variáveis de ambiente lidas EM TEMPO DE EXECUÇÃO pelo servidor (DECISIONS D-026).
 * Nada aqui é NEXT_PUBLIC_: trocar um valor exige só reiniciar o processo, não rebuild.
 * Os grupos são separados para que cada módulo exija só o que usa.
 * .env.example documenta todas.
 */

const deployMode = z.enum(["managed", "cloudflare_locked", "tunnel"]).default("managed");

export const serverEnvSchema = z.object({
  /** Nome da plataforma usado nos textos (ex.: "4fly"). */
  PLATFORM_NAME: z.string().trim().min(1).max(40),
  /** Link de cadastro na plataforma. Vazio = o link some da página. Só https. */
  PLATFORM_SIGNUP_URL: z.union([z.literal(""), z.url({ protocol: /^https$/ })]).default(""),
  /** Modo de deploy: decide se CF-Connecting-IP é confiável (D-031). */
  DEPLOY_MODE: deployMode,
});

export const supabaseEnvSchema = z.object({
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

export const securityEnvSchema = z.object({
  /** Origem pública do site: usada na checagem de Origin (CSRF) e nos links de convite. */
  SITE_URL: z.url({ protocol: /^https?$/ }),
  DEPLOY_MODE: deployMode,
  /** JSON {"versão": "chave base64 de 32 bytes"} (D-013). */
  HMAC_KEYS: z.string().min(2),
  HMAC_ACTIVE: z.coerce.number().int().min(1),
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  TURNSTILE_VERIFY_URL: z
    .url({ protocol: /^https?$/ })
    .default("https://challenges.cloudflare.com/turnstile/v0/siteverify"),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https?$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  HIBP_API_URL: z.url({ protocol: /^https?$/ }).default("https://api.pwnedpasswords.com"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type SupabaseEnv = z.infer<typeof supabaseEnvSchema>;
export type SecurityEnv = z.infer<typeof securityEnvSchema>;

/** Valida contra um schema. O erro cita só os NOMES dos campos, nunca os valores. */
export function parseEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined>): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const campos = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Variáveis de ambiente inválidas: ${campos}`);
  }
  return result.data;
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}

export function getServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}

export function getSupabaseEnv(): SupabaseEnv {
  return parseEnv(supabaseEnvSchema, process.env);
}

export function getSecurityEnv(): SecurityEnv {
  return parseEnv(securityEnvSchema, process.env);
}
