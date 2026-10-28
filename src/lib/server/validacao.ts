import { z } from "zod";

/** Schemas compartilhados (o cliente usa os mesmos para feedback imediato). */
export const zEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const zSenhaLogin = z.string().min(1).max(256);
export const zTurnstile = z.string().min(1).max(2048);
export const zId = z.guid();
export const zApelido = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[\p{L}\p{N} ._-]+$/u);
export const zCodigoTotp = z.string().regex(/^\d{6}$/);
/** Token de 256 bits em base64url (43 caracteres). */
export const zTokenConvite = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
