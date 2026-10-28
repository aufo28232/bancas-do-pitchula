# Bancas do Pitchula

Aplicação para o streamer Pitchula e seus moderadores receberem pedidos de banca e registrarem os pagamentos feitos via Pix. O sistema **não** executa pagamentos.

- [`ARCHITECTURE.md`](ARCHITECTURE.md): componentes, modelo de dados, permissões, fluxos, ameaças e plano de etapas
- [`DECISIONS.md`](DECISIONS.md): decisões (D-001 em diante), alternativas e pendências jurídicas

## Status por etapa

| Etapa | Situação |
|---|---|
| Arquitetura | Aprovada em 27/10/2026 |
| 1. Fundação (estrutura, Supabase local, migrations, RLS) | **Concluída em 27/10/2026.** CI verde |
| 2. Autenticação do painel (login, MFA, convites, sessões, revogação) | **Concluída em 27/10/2026.** CI verde: lint, typecheck, 57 testes Vitest (19 de integração contra Supabase + Redis reais), 122 testes pgTAP, build e `pnpm audit` sem vulnerabilidades |
| 3. Bancas, página pública e pedido do espectador | **Concluída em 28/10/2026.** CI verde: lint, typecheck, 105 testes Vitest (35 de integração), 149 testes pgTAP, build, **10 testes E2E no Chromium** (desktop e celular) e `pnpm audit` sem vulnerabilidades |
| 4. Página do pedido, chat, prazo de 5 min e tempo real | **Concluída em 28/10/2026.** CI verde: lint, typecheck, 120 testes Vitest (44 de integração, incluindo o Realtime de verdade), 184 testes pgTAP, build, **16 testes E2E** (desktop e celular) e `pnpm audit` sem vulnerabilidades |
| 5. Painel de atendimento | **Concluída em 28/10/2026.** CI verde: lint, typecheck, 130 testes Vitest (incluindo concorrência real), 242 testes pgTAP, build, **18 testes E2E** (streamer e espectador em navegadores separados) e `pnpm audit` sem vulnerabilidades |
| 6 e 7 | Não iniciadas |

O que a Etapa 1 entrega:

- Projeto Next.js (App Router, TypeScript strict, Tailwind 4) com `output: "standalone"`
- Tema central e paleta tirada da foto
- Tela inicial "Aguardando banca..."
- Modelo de dados completo com RLS, constraints e auditoria append-only
- Testes pgTAP e Vitest
- CI no GitHub Actions

A Etapa 2 entrega:

- Login do painel feito pelo servidor, com Turnstile, limite de tentativas e bloqueio progressivo (Redis; fora do ar = bloqueia).
- MFA por app autenticador obrigatório para tudo no painel.
- Convites de moderador de uso único (24h), com checagem de senha vazada.
- Sessões com alerta de dispositivo novo, revogação imediata, inatividade de 8h e reset de MFA pelo streamer.
- Cadastro público barrado no banco.
- CSP com nonce e proteção CSRF em todas as mutações.

A Etapa 3 entrega:

- **Painel:** criar banca com prévia do valor por pessoa e da sobra, editar (valor e vagas travam depois do primeiro pedido), pausar e reabrir. Clique duplo não cria duas bancas.
- **Página pública** `/{código}-banca`: foto do streamer, valor em destaque, vagas restantes e link de cadastro na plataforma (configurável).
- **Formulário do espectador** com máscaras e validação igual no navegador e no servidor (CPF com dígito verificador, Pix por tipo), Turnstile verificado no servidor e declaração de maioridade.
- **Bloqueio de pedidos indevidos** com a mesma mensagem genérica: CPF repetido, IP repetido (opcional), banido e fila cheia.
- **Criptografia dos dados pessoais** (AES-256-GCM, chave só no servidor) e HMAC para duplicidade e banimentos.
- **Política de privacidade** (texto a validar com advogado).

A Etapa 4 entrega:

- **Página do pedido** `/pedido#token`: o token sai da barra de endereço na hora e vira uma sessão em cookie httpOnly. Mostra posição na fila, quem está atendendo, os próprios dados **mascarados** e o chat com a equipe.
- **Tempo real** (Supabase Realtime, canais privados, só leitura): posição, mensagens, "pedido assumido" com **bipe**, vibração e título piscando, contagem regressiva do **prazo de 5 min** e volta para "Aguardando banca..." quando a banca é encerrada. Sem conexão, a página continua atualizando por polling.
- **Prazo de resposta:** depois que o moderador manda mensagem, o espectador tem 5 min; senão o pedido é encerrado (job a cada 15 s + checagem a cada acesso).
- **Vagas ao vivo** na página da banca, com animação.

A Etapa 5 entrega:

- **Atendimento** (`/painel/bancas/{id}/atendimento`): fila ao vivo (pendentes por padrão, filtro "sem comprovante", aba de finalizados), resumo da banca, chat com respostas rápidas e bipe para pedido novo e resposta do espectador.
- **Travas:** assumir, liberar e (só o streamer) forçar assumir. A trava cai com 10 min sem atividade. A mensagem do moderador inicia o prazo de 5 min do espectador.
- **Pagar** com confirmação em 2 passos. A última vaga esgota a banca e recusa na hora os pendentes que sobraram. Recusar com motivo e nota. Clique duplo não paga duas vezes.
- **Banir** a partir do pedido (CPF, Pix, ID ou IP por até 7 dias, global ou só na banca), sem ninguém digitar o dado. Lista de banidos sem o valor; desbanir segue D-014.
- **Modo live** ligado em todo login: os dados saem mascarados do servidor (inclusive CPF/Pix digitados no chat). Revelar mostra por 5 s e fica na auditoria; copiar Pix vai direto para a área de transferência.
- **Atalho de pânico** `Alt+Q` (ou o botão no canto) esconde a tela inteira.
- **Respostas rápidas** editáveis pelo streamer.

## Pré-requisitos (desenvolvimento local)

- Node.js **26 LTS** (veja `.nvmrc`)
- pnpm (versão exata em `package.json` → `packageManager`)
- Docker (Docker Desktop no Windows/macOS), para o Supabase local
- Supabase CLI: <https://supabase.com/docs/guides/local-development/cli/getting-started>

## Rodando localmente

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local          # ajuste os valores; nunca versione este arquivo

# Redis local com a mesma API REST do Upstash (só para desenvolvimento)
docker network create bancas-dev
docker run -d --name bancas-redis --network bancas-dev redis:7-alpine
docker run -d --name bancas-srh --network bancas-dev -p 8079:80 \
  -e SRH_MODE=env -e SRH_TOKEN=token-local-de-teste -e SRH_CONNECTION_STRING=redis://bancas-redis:6379 \
  hiett/serverless-redis-http:latest

export SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA   # chave de teste da Cloudflare
supabase start                      # aplica as migrations; `supabase status` mostra URL e chaves
# copie API URL, anon key e service_role key para SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY no .env.local
# gere a chave HMAC: openssl rand -base64 32  ->  HMAC_KEYS={"1":"<chave>"}

pnpm seed:owner --email voce@exemplo.com --apelido Pitchula   # cria a conta do streamer (pede a senha)
pnpm dev                            # http://localhost:3000/painel/entrar
```

No Windows (PowerShell), as variáveis ficam assim: `$env:SUPABASE_AUTH_CAPTCHA_SECRET="1x0000000000000000000000000000000AA"`.

`pnpm test` inclui os testes de integração e precisa do Supabase local e do Redis rodando, com as variáveis do `.env.example` exportadas no terminal.

## Supabase em produção (o que configurar no painel do projeto)

Estes valores espelham o `supabase/config.toml` e precisam ser aplicados à mão no projeto de produção:

| Onde | Configuração | Por quê |
|---|---|---|
| Authentication → Sign In / Providers | **Email: ligado**; "Allow new users to sign up": ligado | Desligar o provedor de e-mail desliga o login (D-048). O cadastro público é barrado pelo trigger do banco |
| Authentication → Sign In / Providers | **Anonymous sign-ins: ligado** | Espectador no tempo real (Etapa 4, D-003) |
| Authentication → Sign In / Providers | Telefone e provedores sociais: desligados | Superfície mínima |
| Authentication → Attack Protection | **Captcha: Turnstile**, com o *secret* de produção | Protege login e login anônimo (D-054) |
| Authentication → Multi-Factor | TOTP ligado; telefone desligado | MFA obrigatório |
| Authentication → Sessions / JWT | **JWT expiry: 300 s** | Revogação vale rápido (D-028) |
| Authentication → Password | Mínimo de **12** caracteres | O servidor também confere e checa senha vazada |
| Data API → Exposed schemas | **somente `api`** | Tabelas ficam fora da API (D-002) |
| Realtime → Settings | **"Allow public access": desligado** | Só canais privados, autorizados pela RLS de `realtime.messages` (D-008) |
| Database → Extensions | **pg_cron** ligado (a migration cria o job de 15 s) | Expira pedidos sem resposta (D-043) |
| Database → Migrations | `supabase link` + `supabase db push` | Aplica as migrations deste repositório |

Depois do primeiro deploy, rode `pnpm seed:owner` com as variáveis de produção, entre em `/painel/entrar` e cadastre o app autenticador.

## Critério de pronto de cada etapa

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

A partir da Etapa 3, também `pnpm test:e2e` (Playwright contra o build de produção; antes, rode `pnpm exec playwright install chromium`). O mesmo conjunto roda no GitHub Actions (`.github/workflows/ci.yml`), que também sobe o Supabase local e roda `pnpm audit --audit-level high`.

| Comando | O que faz |
|---|---|
| `pnpm lint` | ESLint (proíbe `dangerouslySetInnerHTML`, `style` inline e `console`) |
| `pnpm typecheck` | Gera os tipos de rota do Next e roda `tsc --noEmit` |
| `pnpm test` | Vitest (unitários) |
| `pnpm test:db` | pgTAP contra o Supabase local (`supabase test db`): RLS, privilégios, constraints e auditoria |
| `pnpm build` | Build de produção (`.next/standalone`) |
| `pnpm test:e2e` | Playwright no Chromium, desktop e celular: login com MFA pela tela, criação de banca, pedido, acessibilidade (axe), teclado e ausência de violações de CSP |
| `pnpm seed:owner` | Cria a conta do streamer (uma vez) |

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
