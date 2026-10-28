/**
 * Cria a conta do streamer (owner).
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm seed:owner --email voce@exemplo.com --apelido Pitchula
 *
 * A senha é pedida no terminal (ou lida de SEED_OWNER_PASSWORD, para automação).
 * Mínimo de 12 caracteres e sem aparecer em vazamentos (Have I Been Pwned).
 * Depois do primeiro login, o painel obriga o cadastro do app autenticador (MFA).
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { criarStreamer } from "../src/lib/server/seed";

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = argumento("email");
  const apelido = argumento("apelido") ?? "Pitchula";
  if (!email) {
    stdout.write("Informe --email.\n");
    process.exit(1);
  }

  let senha = process.env.SEED_OWNER_PASSWORD;
  if (!senha) {
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write("Atenção: a senha aparece na tela enquanto você digita. Faça isso fora da live.\n");
    senha = await rl.question("Senha do streamer (mínimo 12 caracteres): ");
    rl.close();
  }

  const id = await criarStreamer({ email, senha, apelido, hibpUrl: process.env.HIBP_API_URL });
  stdout.write(`Conta do streamer criada (id ${id}). Entre em /painel/entrar e cadastre o app autenticador.\n`);
}

main().catch((e: unknown) => {
  stdout.write(`Falhou: ${e instanceof Error ? e.message : "erro desconhecido"}\n`);
  process.exit(1);
});
