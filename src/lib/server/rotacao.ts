import type { Sql } from "postgres";
import { cifrar, decifrar, versaoDoCifrado, type Campo } from "./cripto";
import type { HmacKeyring } from "./keys";

/**
 * Rotação da chave de cifra (SECURITY.md, "Rotação da chave de cifra").
 * Re-cifra com a versão ATIVA todo campo de pedido que ainda está em outra versão.
 * Lotes pequenos, uma transação por lote, `FOR UPDATE SKIP LOCKED` (não briga com o
 * atendimento ao vivo) e retomável: rodar de novo continua de onde parou.
 * Nunca imprime nem registra valores, só contagens.
 */
const CAMPOS = [
  ["full_name_enc", "orders.full_name_enc"],
  ["cpf_enc", "orders.cpf_enc"],
  ["pix_key_enc", "orders.pix_key_enc"],
  ["platform_id_enc", "orders.platform_id_enc"],
] as const satisfies readonly (readonly [string, Campo])[];

type Linha = { id: string; full_name_enc: string; cpf_enc: string; pix_key_enc: string; platform_id_enc: string | null };

export async function rotacionarCifra(
  sql: Sql,
  ring: HmacKeyring,
  opcoes: { lote?: number; banca?: string } = {},
): Promise<{ pedidos: number }> {
  const ativa = `v${ring.active}:%`;
  const lote = opcoes.lote ?? 200;
  let total = 0;
  for (;;) {
    const n = await sql.begin(async (tx) => {
      const linhas = await tx<Linha[]>`
        select id, full_name_enc, cpf_enc, pix_key_enc, platform_id_enc
          from app.orders
         where data_erased_at is null
           and (full_name_enc not like ${ativa} or cpf_enc not like ${ativa}
                or pix_key_enc not like ${ativa} or platform_id_enc not like ${ativa})
           ${opcoes.banca ? tx`and banca_id = ${opcoes.banca}` : tx``}
         order by id
         limit ${lote}
         for update skip locked`;
      for (const l of linhas) {
        const novo: Record<string, string> = {};
        for (const [coluna, campo] of CAMPOS) {
          const atual = l[coluna];
          if (atual === null) continue; // pedido sem ID na casa (D-089)
          novo[coluna] = versaoDoCifrado(atual) === ring.active ? atual : cifrar(ring, campo, l.id, decifrar(ring, campo, l.id, atual));
        }
        await tx`
          update app.orders
             set full_name_enc = ${novo.full_name_enc ?? l.full_name_enc}, cpf_enc = ${novo.cpf_enc ?? l.cpf_enc},
                 pix_key_enc = ${novo.pix_key_enc ?? l.pix_key_enc}, platform_id_enc = ${novo.platform_id_enc ?? l.platform_id_enc}
           where id = ${l.id}`;
      }
      return linhas.length;
    });
    total += n;
    if (n < lote) break;
  }
  if (total > 0) {
    await sql`select app.audit('rotacao_chave', null, 'sistema',
                p_detail => jsonb_build_object('para', ${ring.active}::int, 'quantidade', ${total}::int))`;
  }
  return { pedidos: total };
}
