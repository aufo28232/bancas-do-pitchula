/**
 * Validação e re-encode do comprovante com o sharp de verdade (sem mock).
 */
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImagemInvalidaError, LIMITE_BYTES, processarComprovante, tipoPelosBytes } from "./imagem";

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 30 } } }).png().toBuffer();

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "aceitou";
  } catch (e) {
    return e instanceof ImagemInvalidaError ? e.motivo : `outro: ${String(e)}`;
  }
}

/** PNG de 1x1 com o cabeçalho (IHDR) dizendo outra largura/altura, com CRC correto. */
async function pngMentindoTamanho(w: number, h: number): Promise<Buffer> {
  const b = Buffer.from(await png(1, 1));
  // assinatura (8) + tamanho (4) + "IHDR" (4) -> largura em 16, altura em 20; CRC depois dos 13 bytes de dados.
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt32BE(crc32(b.subarray(12, 29)) >>> 0, 29);
  return b;
}

describe("comprovante: tipo decidido pelos bytes", () => {
  it("reconhece JPEG, PNG e WEBP pelos bytes mágicos", async () => {
    expect(tipoPelosBytes(await png(2, 2))).toBe("png");
    expect(tipoPelosBytes(await sharp(await png(2, 2)).jpeg().toBuffer())).toBe("jpeg");
    expect(tipoPelosBytes(await sharp(await png(2, 2)).webp().toBuffer())).toBe("webp");
  });

  it("arquivo de texto com extensão de imagem é recusado", async () => {
    expect(await motivo(processarComprovante(Buffer.from("isto não é um png, é texto")))).toBe("tipo");
  });

  it("GIF (e qualquer outro formato) é recusado", async () => {
    expect(await motivo(processarComprovante(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")))).toBe("tipo");
  });
});

describe("comprovante: limites", () => {
  it("acima de 5 MB é recusado antes de decodificar", async () => {
    const grande = Buffer.alloc(LIMITE_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(grande);
    expect(await motivo(processarComprovante(grande))).toBe("tamanho");
  });

  it("PNG declarando 20000×20000 px é recusado (bomba de descompressão)", async () => {
    expect(await motivo(processarComprovante(await pngMentindoTamanho(20000, 20000)))).toBe("dimensao");
  });

  it("PNG truncado é recusado", async () => {
    const inteiro = await png(400, 300);
    expect(await motivo(processarComprovante(inteiro.subarray(0, Math.floor(inteiro.length / 2))))).toBe("corrompida");
  });
});

describe("comprovante: o arquivo guardado nunca é o original", () => {
  it("re-encoda em WEBP e reduz para no máximo 2000 px", async () => {
    const r = await processarComprovante(await png(3000, 1000));
    const meta = await sharp(r.webp).metadata();
    expect(meta.format).toBe("webp");
    expect([r.largura, r.altura]).toEqual([2000, 667]);
    expect(r.sha256).toHaveLength(32);
  });

  it("remove o EXIF de verdade (inclusive dados escondidos nele)", async () => {
    const comExif = await sharp(await png(50, 50))
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "segredo-no-exif", Artist: "gps-falso" } } })
      .toBuffer();
    expect(comExif.includes(Buffer.from("segredo-no-exif"))).toBe(true);
    const r = await processarComprovante(comExif);
    expect(r.webp.includes(Buffer.from("segredo-no-exif"))).toBe(false);
    expect((await sharp(r.webp).metadata()).exif).toBeUndefined();
  });

  it("aplica a rotação do EXIF antes de descartar os metadados", async () => {
    const deitada = await sharp(await png(100, 50)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await processarComprovante(deitada);
    expect([r.largura, r.altura]).toEqual([50, 100]);
  });

  it("arquivo poliglota (JPEG com HTML e ZIP grudados no fim): o conteúdo extra some", async () => {
    const jpeg = await sharp(await png(60, 40)).jpeg().toBuffer();
    const poliglota = Buffer.concat([jpeg, Buffer.from("<script>alert(1)</script>"), Buffer.from("PK\x03\x04zip-escondido", "latin1")]);
    // Ou o decodificador recusa, ou a saída é um WEBP novo sem o conteúdo grudado.
    const r = await processarComprovante(poliglota).catch((e: unknown) => e);
    if (r instanceof ImagemInvalidaError) {
      expect(r.motivo).toBe("corrompida");
      return;
    }
    const saida = (r as Awaited<ReturnType<typeof processarComprovante>>).webp;
    expect(saida.includes(Buffer.from("<script>"))).toBe(false);
    expect(saida.includes(Buffer.from("zip-escondido"))).toBe(false);
  });
});
