#!/usr/bin/env node
// Resolve as faixas de scripts/deps.intent.json para versões EXATAS e grava no package.json.
// Usado uma vez (e sempre que uma dependência for adicionada ou atualizada de propósito).
// Depois disso, `pnpm install --frozen-lockfile` garante a mesma árvore em todo lugar.
//
// Uso: node scripts/pin-deps.mjs
// Requer: npm e pnpm no PATH e acesso ao registro do npm.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const intent = JSON.parse(readFileSync(join(root, "scripts/deps.intent.json"), "utf8"));
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

/** Maior versão estável (sem pré-release) que satisfaz a faixa. */
function resolve(name, range) {
  const out = execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const parsed = JSON.parse(out);
  const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => !v.includes("-"));
  if (list.length === 0) throw new Error(`Nenhuma versão estável de ${name} em ${range}`);
  return list[list.length - 1];
}

const resolved = { dependencies: {}, devDependencies: {} };
const pending = [];

for (const group of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(intent[group])) {
    if (range.startsWith("=")) {
      pending.push({ group, name, same: range.slice(1) });
      continue;
    }
    resolved[group][name] = resolve(name, range);
  }
}
for (const { group, name, same } of pending) {
  const v = resolved.dependencies[same] ?? resolved.devDependencies[same];
  if (!v) throw new Error(`${name} deve acompanhar ${same}, que não foi resolvido`);
  resolved[group][name] = v;
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
pkg.dependencies = sortObj(resolved.dependencies);
pkg.devDependencies = sortObj(resolved.devDependencies);

const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
pkg.packageManager = `pnpm@${pnpmVersion}`;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const nodeVersion = process.version.replace(/^v/, "");
const lines = [
  "# Versões fixadas",
  "",
  `Geradas por \`scripts/pin-deps.mjs\` em ${new Date().toISOString()}.`,
  "",
  "| Pacote | Versão | Faixa pretendida |",
  "|---|---|---|",
  `| node (CI) | ${nodeVersion} | .nvmrc |`,
  `| pnpm | ${pnpmVersion} | latest |`,
  ...["dependencies", "devDependencies"].flatMap((g) =>
    Object.entries(pkg[g]).map(([n, v]) => `| ${n} | ${v} | ${intent[g][n]} |`),
  ),
  "",
];
writeFileSync(join(root, "scripts/pinned-versions.md"), lines.join("\n"));
process.stdout.write(lines.join("\n"));
