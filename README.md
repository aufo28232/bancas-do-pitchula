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
| 6. Comprovantes, encerramento, retenção | **Concluída em 28/10/2026.** CI verde: lint, typecheck, 145 testes Vitest (com Storage real: o arquivo some depois do encerramento), 285 testes pgTAP, build, **19 testes E2E** e `pnpm audit` sem vulnerabilidades |
| 7. Endurecimento e entrega | **Concluída em 28/10/2026.** CI verde: lint, typecheck, 153 testes Vitest, 294 testes pgTAP, build, 26 testes E2E, `pnpm audit` sem vulnerabilidades e imagem Docker não-root. Ver [`RELATORIO-FINAL.md`](RELATORIO-FINAL.md) |

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
- **Bloqueio de pedidos indevidos** com a mesma mensagem genérica: CPF repetido, IP repetido (opcional) e banido. A fila não tem teto: aceita pedidos até a banca ser pausada, esgotar (vagas **pagas**) ou ser encerrada (D-032 revista).
- **Criptografia dos dados pessoais** (AES-256-GCM, chave só no servidor) e HMAC para duplicidade e banimentos.
- **Política de privacidade** (texto a validar com advogado).

A Etapa 4 entrega:

- **Página do pedido** `/pedido`: ao enviar o pedido, o espectador vai **direto para o chat** (sessão em cookie httpOnly, sem link para copiar; voltar ao site leva de volta ao pedido, D-082). Mostra posição na fila, quem está atendendo, os próprios dados **mascarados** e o chat com a equipe.
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

A Etapa 6 entrega:

- **Comprovante no chat:** JPG, PNG ou WEBP até 5 MB (máximo 5 por pedido). O servidor confere pelos bytes, re-encoda em WEBP sem metadados e guarda num bucket privado; ver é sempre por URL assinada de 60 s (no painel, fica na auditoria).
- **Encerrar banca** (streamer ou moderador, digitando o nome): apaga na hora pedidos, conversas, comprovantes e contas anônimas; o link morre e todo mundo conectado volta para "Aguardando banca...".
- **Encerramento automático:** pausada há 7 dias, esgotada há 24h ou aberta sem movimento há 7 dias.
- **Retenção de hora em hora:** bans vencidos, revisão anual vencida (D-020), chaves de idempotência, sessões, contas anônimas sem pedido e auditoria com mais de 12 meses.
- **"Excluir meus dados"** na página do pedido (D-018, D-076).

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
| Authentication → Rate Limits | **Anonymous users: 3000/h**; **Token refresh: 3000 por 5 min** | Todas as chamadas saem do nosso servidor (um IP só); os limites por espectador ficam no app (D-082) |
| Authentication → Password | Mínimo de **12** caracteres | O servidor também confere e checa senha vazada |
| Data API → Exposed schemas | **somente `api`** | Tabelas ficam fora da API (D-002) |
| Realtime → Settings | **"Allow public access": desligado** | Só canais privados, autorizados pela RLS de `realtime.messages` (D-008) |
| Database → Extensions | **pg_cron** e **pg_net** ligados (a migration cria os jobs) | Prazo de 5 min (D-043), encerramento automático, retenção e chamada da limpeza |
| Project Settings → Vault | Segredos `limpeza_url` (`https://SEU-SITE/api/interno/limpeza`) e `limpeza_segredo` (mesmo valor de `LIMPEZA_SECRET`) | O pg_cron chama a limpeza a cada hora (D-075) |
| Storage | Bucket **`comprovantes`** privado, 5 MB, só `image/webp` (a migration cria; confira) | Comprovantes (D-077) |
| Database → Migrations | `supabase link` + `supabase db push` | Aplica as migrations deste repositório |

Depois do primeiro deploy, rode `pnpm seed:owner` com as variáveis de produção, entre em `/painel/entrar` e cadastre o app autenticador.

## Colocando no ar

> Nada aqui afirma que a operação está autorizada ou em conformidade com a lei: os pontos jurídicos abertos estão em DECISIONS (marcados **[ADVOGADO]**) e no relatório final.

### 1. Contas e chaves

| Variável | Onde pegar | Observação |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase → Project Settings → API | A anon key é pública (vai para o navegador só para o Realtime) |
| `SUPABASE_SERVICE_ROLE_KEY` | Mesmo lugar ("service_role" / "secret") | **Só no servidor.** Quem tem esta chave lê o banco inteiro |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → Add site (seu domínio) | O *secret* também vai no Supabase (Attack Protection → Captcha) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | upstash.com → Redis → banco novo (região São Paulo) → REST API | Fora do ar = login, pedido e upload bloqueados (de propósito) |
| `HMAC_KEYS` | `openssl rand -base64 32` → `{"1":"<valor>"}` | Separada da cifra. **Guarde fora do servidor também** (cofre de senhas) |
| `DATA_ENC_KEYS` | `openssl rand -base64 32` → `{"1":"<valor>"}` | Perdeu esta chave = os dados dos pedidos abertos ficam ilegíveis |
| `LIMPEZA_SECRET` | `openssl rand -base64 48` | O mesmo valor vai no Vault do Supabase (`limpeza_segredo`) |
| `SITE_URL` | Seu domínio, com `https://` | Usado no CSRF e nos links |
| `DEPLOY_MODE`, `TRUSTED_PROXY_HOPS` | Ver os modos abaixo | Decide em qual IP confiar |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Cloudflare Zero Trust → Access → aplicação do `/painel` | Opcional, recomendado (D-079) |
| `PLATFORM_NAME`, `PLATFORM_SIGNUP_URL` | Texto e link da plataforma | Link vazio = some da página |

Nenhuma chave é `NEXT_PUBLIC_`: trocar um valor exige só reiniciar o processo. **Nunca** versione `.env` com valores reais.

### 2. Banco

1. `supabase link --project-ref <ref>` e `supabase db push` (aplica as migrations).
2. Aplique a tabela "Supabase em produção" acima (Auth, Realtime, extensões, Vault, Storage).
3. Deploy do app (um dos modos abaixo) e `pnpm seed:owner --email ... --apelido Pitchula` com as variáveis de produção.
4. Entre em `/painel/entrar`, cadastre o app autenticador e abra `/painel/diagnostico` para conferir o IP (modo 1).

### 3. Modos de deploy

| | 1. Node gerenciado (ex.: Hostinger) | 2. VPS + Docker + Nginx | 3. VPS + Cloudflare Tunnel |
|---|---|---|---|
| `DEPLOY_MODE` | `managed` | `cloudflare_locked` | `tunnel` |
| IP confiável para "1 pedido por IP" e bans de IP | **Não** (enfraquecido; o painel avisa) | Sim, se a origem só aceitar a Cloudflare | Sim |
| Origem escondida | Depende da hospedagem (não verificado) | Firewall + Authenticated Origin Pulls | Nenhuma porta aberta |

**Modo 1: Node gerenciado.** Build: `pnpm install --frozen-lockfile && pnpm build`. Start: `node .next/standalone/server.js` (porta em `PORT`). Configure as variáveis no painel da hospedagem. Depois do deploy, abra `/painel/diagnostico`: se "Seu IP" não for o seu IP real, ajuste `TRUSTED_PROXY_HOPS` (quantos proxies a hospedagem coloca na frente, D-058/D-078). Mesmo certo, alguém que descubra o endereço direto da origem consegue forjar o IP: por isso as regras por IP ficam marcadas como enfraquecidas.

**Modo 2: VPS + Docker + Nginx.**

```bash
docker build -t bancas .
docker run -d --name bancas --restart unless-stopped --env-file /etc/bancas.env -p 127.0.0.1:3000:3000 bancas
```

A imagem roda como usuário sem privilégio (uid 10001), sem npm, e não leva nenhum segredo (tudo vem do `--env-file`, que deve ter permissão `600`). No Nginx, HTTPS na frente e: `set_real_ip_from` **só** com as faixas da Cloudflare (<https://www.cloudflare.com/ips/>), `real_ip_header CF-Connecting-IP`, e repasse do cabeçalho `CF-Connecting-IP`. No firewall (ufw/iptables), libere 443 só para as faixas da Cloudflare e ligue *Authenticated Origin Pulls*. Sem isso, use `managed`.

**Modo 3: VPS + Cloudflare Tunnel.** Rode o container como no modo 2 (porta só em `127.0.0.1`) e o `cloudflared` apontando para `http://127.0.0.1:3000`. Não abra nenhuma porta de entrada no servidor.

**Cloudflare Access (recomendado nos três modos).** Crie uma aplicação *Self-hosted* para `seu-dominio/painel*` e `seu-dominio/api/painel*` com a política de quem pode entrar (e-mails do streamer e dos moderadores). Copie o *Application Audience (AUD) Tag* para `CF_ACCESS_AUD` e o domínio da equipe para `CF_ACCESS_TEAM_DOMAIN`. O servidor confere o JWT do Access em toda requisição do painel; no modo 1 isso fecha o caminho de quem chega direto na origem.

### 4. Backups e exclusão

Os backups do Supabase guardam o banco como estava: um pedido apagado (encerramento ou exclusão a pedido) continua no backup até ele expirar, conforme o plano contratado. A política de privacidade precisa dizer isso. Restaurar um backup traz de volta dados já apagados; nesse caso, encerre as bancas restauradas logo em seguida.

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
| `pnpm rotate:data` | Re-cifra os pedidos com a chave ativa (rotação, ver SECURITY.md) |

## Estrutura

```
src/app/            páginas (App Router)
src/components/     componentes de interface
src/config/site.ts  identidade fixa (links oficiais, aviso de site oficial)
src/lib/server/     código só de servidor (env, cripto, sessão, rate limit, Storage, limpeza)
src/lib/client/     código de navegador (chamadas à API, tempo real, alertas)
src/theme/          TEMA CENTRAL: theme.ts (cores, foto, logo) e fonts.ts
supabase/migrations SQL executável: schemas, tabelas, RLS, auditoria
supabase/tests/     testes pgTAP
scripts/            seed do streamer, rotação de chave, fixação de versões
e2e/                testes Playwright (contra o build de produção)
Dockerfile          imagem de produção (modo 2)
SECURITY.md         segredos, rotação, incidente
RELATORIO-FINAL.md  o que está implementado, testado, pendente e não verificado
```
