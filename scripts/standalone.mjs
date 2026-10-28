#!/usr/bin/env node
// O build "standalone" do Next não copia public/ nem .next/static/.
// Este passo deixa .next/standalone pronto para rodar com `node server.js`.
import { cpSync, existsSync } from "node:fs";

if (!existsSync(".next/standalone")) {
  process.stderr.write("Pasta .next/standalone não encontrada. Rode `next build` antes.\n");
  process.exit(1);
}
cpSync("public", ".next/standalone/public", { recursive: true });
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
process.stdout.write("standalone pronto: .next/standalone (public e .next/static copiados)\n");
