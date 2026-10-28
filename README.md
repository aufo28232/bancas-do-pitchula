# Bancas do Pitchula

Aplicação para o streamer Pitchula e seus moderadores receberem pedidos de banca e registrarem os pagamentos feitos via Pix. O sistema **não** executa pagamentos.

- [`ARCHITECTURE.md`](ARCHITECTURE.md): componentes, modelo de dados, permissões, fluxos, ameaças e plano de etapas
- [`DECISIONS.md`](DECISIONS.md): decisões (D-001 em diante), alternativas e pendências jurídicas

## Status por etapa

| Etapa | Situação |
|---|---|
| Arquitetura | Aprovada em 27/10/2026 |
| 1. Fundação (estrutura, Supabase local, migrations, RLS) | **Concluída em 27/10/2026.** CI verde: lint, typecheck, 20 testes Vitest, 83 testes pgTAP, build e `pnpm audit` sem vulnerabilidades |
| 2 a 7 | Não iniciadas |

O que a Etapa 1 entrega:

- Projeto Next.js (App Router, TypeScript strict, Tailwind 4) com `output: "standalone"`
- Tema central e paleta tirada da foto
- Tela inicial "Aguardando banca..."
- Modelo de dados completo com RLS, constraints e auditoria append-only
- Testes pgTAP e Vitest
- CI no GitHub Actions

Ainda **não há** login, formulário, painel nem tempo real (etapas 2 a 5).

## Pré-requisitos (desenvolvimento local)

- Node.js **26 LTS** (veja `.nvmrc`)
- pnpm (versão exata em `package.json` → `packageManager`)
- Docker (Docker Desktop no Windows/macOS), para o Supabase local
- Supabase CLI: <https://supabase.com/docs/guides/local-development/cli/getting-started>

## Rodando localmente

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local          # ajuste os valores; nunca versione este arquivo
export SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA   # chave de teste da Cloudflare
supabase start                      # sobe Postgres, Auth, Realtime e Storage locais e aplica as migrations
pnpm dev                            # http://localhost:3000
```

No Windows (PowerShell), a variável fica assim: `$env:SUPABASE_AUTH_CAPTCHA_SECRET="1x0000000000000000000000000000000AA"`.

## Critério de pronto de cada etapa

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

A partir da Etapa 3, também `pnpm test:e2e`. O mesmo conjunto roda no GitHub Actions (`.github/workflows/ci.yml`), que também sobe o Supabase local e roda `pnpm audit --audit-level high`.

| Comando | O que faz |
|---|---|
| `pnpm lint` | ESLint (proíbe `dangerouslySetInnerHTML`, `style` inline e `console`) |
| `pnpm typecheck` | Gera os tipos de rota do Next e roda `tsc --noEmit` |
| `pnpm test` | Vitest (unitários) |
| `pnpm test:db` | pgTAP contra o Supabase local (`supabase test db`): RLS, privilégios, constraints e auditoria |
| `pnpm build` | Build de produção (`.next/standalone`) |

## Estrutura

```
src/app/            páginas (App Router)
src/components/     componentes de interface
src/config/site.ts  identidade fixa (links oficiais, aviso de site oficial)
src/lib/            código de servidor (env, e nas próximas etapas: cripto, rate limit...)
src/theme/          TEMA CENTRAL: theme.ts (cores, foto, logo) e fonts.ts
supabase/migrations SQL executável: schemas, tabelas, RLS, auditoria
supabase/tests/     testes pgTAP
scripts/            fixação de versões das dependências
```

As seções sobre Supabase em produção, Turnstile, Upstash, Cloudflare e os três modos de deploy entram aqui nas etapas 2 e 7.
