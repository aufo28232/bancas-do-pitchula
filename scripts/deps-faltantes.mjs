#!/usr/bin/env node
// Sai com código 1 se algum pacote de deps.intent.json ainda não estiver no package.json.
import { readFileSync } from "node:fs";
const intent = JSON.parse(readFileSync(new URL("./deps.intent.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const faltam = ["dependencies", "devDependencies"].flatMap((g) =>
  Object.keys(intent[g]).filter((n) => !pkg[g]?.[n]),
);
if (faltam.length) {
  process.stdout.write(`faltam: ${faltam.join(", ")}\n`);
  process.exit(1);
}
