/**
 * Re-cifra os pedidos com a chave ATIVA (DATA_ENC_ACTIVE). Ver SECURITY.md.
 *
 * Uso (com a conexão direta do Postgres do Supabase em DB_URL):
 *   DB_URL=... DATA_ENC_KEYS='{"1":"...","2":"..."}' DATA_ENC_ACTIVE=2 pnpm rotate:data
 *
 * Mostra só contagens. Pode ser interrompido e rodado de novo.
 */
import postgres from "postgres";
import { getChavesDeCifra } from "../src/lib/server/cripto";
import { rotacionarCifra } from "../src/lib/server/rotacao";

async function main(): Promise<void> {
  if (!process.env.DB_URL) {
    process.stdout.write("Defina DB_URL (conexão direta do Postgres).\n");
    process.exit(1);
  }
  const ring = getChavesDeCifra();
  const sql = postgres(process.env.DB_URL, { max: 1, onnotice: () => undefined });
  try {
    const r = await rotacionarCifra(sql, ring);
    const [resto] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.orders
       where data_erased_at is null
         and (full_name_enc not like ${`v${ring.active}:%`} or cpf_enc not like ${`v${ring.active}:%`}
              or pix_key_enc not like ${`v${ring.active}:%`} or platform_id_enc not like ${`v${ring.active}:%`})`;
    process.stdout.write(`pedidos re-cifrados: ${r.pedidos}; ainda em versão antiga: ${resto?.n ?? "?"}\n`);
    if ((resto?.n ?? 1) === 0) process.stdout.write("Pronto: a chave antiga já pode ser removida de DATA_ENC_KEYS.\n");
  } finally {
    await sql.end();
  }
}

main().catch(() => {
  process.stdout.write("Falhou (nenhum valor é mostrado). Confira as variáveis e rode de novo.\n");
  process.exit(1);
});
