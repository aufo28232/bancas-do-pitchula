import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Comprovante enviado pelo espectador (ARCHITECTURE §5.10):
 * - só JPEG, PNG ou WEBP, decidido pelos BYTES (extensão e Content-Type são ignorados);
 * - limite de pixels antes de decodificar (bomba de descompressão) e no máximo 8000 px por lado;
 * - aplica a rotação do EXIF, reduz para no máximo 2000 px e RE-ENCODA em WEBP SEM
 *   metadados: o arquivo guardado nunca é o original (some EXIF, GPS e qualquer
 *   conteúdo escondido de arquivos "poliglotas").
 */
export const LIMITE_BYTES = 5 * 1024 * 1024;
const LIMITE_LADO = 8000;
const LIMITE_PIXELS = 25_000_000;
const SAIDA_MAX = 2000;

export class ImagemInvalidaError extends Error {
  constructor(readonly motivo: "tamanho" | "tipo" | "dimensao" | "corrompida") {
    super(`imagem inválida: ${motivo}`);
    this.name = "ImagemInvalidaError";
  }
}

export function tipoPelosBytes(b: Buffer): "jpeg" | "png" | "webp" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export type Comprovante = { webp: Buffer; largura: number; altura: number; sha256: Buffer };

export async function processarComprovante(original: Buffer): Promise<Comprovante> {
  if (original.length === 0 || original.length > LIMITE_BYTES) throw new ImagemInvalidaError("tamanho");
  const tipo = tipoPelosBytes(original);
  if (!tipo) throw new ImagemInvalidaError("tipo");

  const opcoes = { limitInputPixels: LIMITE_PIXELS, failOn: "error" as const, sequentialRead: true };
  let meta: sharp.Metadata;
  try {
    meta = await sharp(original, opcoes).metadata();
  } catch {
    throw new ImagemInvalidaError("corrompida");
  }
  // O formato que o decodificador leu precisa ser o mesmo dos bytes mágicos.
  if (meta.format !== tipo) throw new ImagemInvalidaError("tipo");
  if (!meta.width || !meta.height || meta.width > LIMITE_LADO || meta.height > LIMITE_LADO) {
    throw new ImagemInvalidaError("dimensao");
  }
  if ((meta.pages ?? 1) > 1) throw new ImagemInvalidaError("tipo"); // animação/múltiplas páginas

  try {
    const { data, info } = await sharp(original, opcoes)
      .rotate()
      .resize({ width: SAIDA_MAX, height: SAIDA_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { webp: data, largura: info.width, altura: info.height, sha256: createHash("sha256").update(data).digest() };
  } catch {
    throw new ImagemInvalidaError("corrompida");
  }
}
