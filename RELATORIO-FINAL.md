# Relatório final · Bancas do Pitchula

Data: 28/10/2026. Base: commit `__SHA__` (CI `__RUN__`).

Este relatório separa o que está **implementado e testado**, o que **depende de configuração** sua, o que **não foi verificado** e o que é **decisão jurídica**. Nenhum item afirma conformidade legal ou imunidade a ataques.

## 1. Resultado dos testes (CI no GitHub Actions)

Comando de pronto: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build && pnpm test:e2e`, mais `pnpm audit --audit-level high` e o build da imagem Docker.

| Verificação | Resultado |
|---|---|
| ESLint (`--max-warnings=0`) | __LINT__ |
| TypeScript (`tsc --noEmit`, estrito) | __TYPECHECK__ |
| Vitest (unidade + integração com Supabase local, Redis e Storage reais) | __VITEST__ |
| pgTAP (`supabase test db`) | __PGTAP__ |
| Build de produção (`.next/standalone`) | __BUILD__ |
| Playwright (Chromium, desktop e celular, contra o build de produção) | __E2E__ |
| `pnpm audit --audit-level high` | __AUDIT__ |
| Imagem Docker (build, uid 10001, responde com os cabeçalhos) | __DOCKER__ |

Saída completa de cada passo: branch `ci-logs` do repositório (capturas de tela em `capturas/`).

## 2. Implementado e testado

| Área | O que existe | Onde é testado |
|---|---|---|
| Fundação | Schemas `app` (tabelas, fora da API) e `api` (só funções); RLS em 100% das tabelas; privilégios mínimos por papel | pgTAP 01–04 |
| Painel: acesso | Login pelo servidor, Turnstile, bloqueio progressivo, MFA TOTP obrigatório, convites de uso único, HIBP, sessões revogáveis, inatividade de 8h, alerta de dispositivo novo, cadastro público barrado no banco | Vitest `painel.int`, pgTAP 07, E2E `preparar` |
| Bancas e pedido | Criação/edição/pausa, página pública, formulário validado igual no navegador e no servidor, anti-duplicidade (CPF, IP opcional), fila com teto, cifra AES-256-GCM e HMAC | Vitest `pedido.int`, pgTAP 08, E2E `banca` |
| Pedido do espectador | Token no fragmento trocado por cookie, dados mascarados, chat, prazo de 5 min, bipe/vibração/título, tempo real só leitura com RLS por canal | Vitest `espectador.int` (Realtime real), pgTAP 09, E2E `pedido` |
| Atendimento | Fila ao vivo, travas, forçar assumir, pagar em 2 passos (esgota e recusa sobras), recusar, banir/desbanir, modo live mascarado no servidor, revelar/copiar Pix auditados, pânico Alt+Q, respostas rápidas | Vitest `atendimento.int` (concorrência real), pgTAP 10, E2E `painel` |
| Comprovantes e exclusão | Upload com limite no fluxo, tipo pelos bytes, re-encode WEBP sem metadados, bucket privado, URL de 60 s; encerrar apaga tudo na hora; encerramento automático; retenção; "excluir meus dados" | Vitest `imagem`, `encerramento.int` (arquivo some do Storage), pgTAP 11, E2E `painel` |
| Endurecimento | Cloudflare Access conferido no servidor, IP por proxies confiáveis, auditoria legível com cadeia de hash, sinais de fraude, rotação da chave de cifra, Dockerfile não-root, cabeçalhos de segurança | Vitest `cf-access`, `seguranca`, `falhas.int`, `rotacao.int`, pgTAP 12, E2E `seguranca`, passo Docker do CI |

## 3. Depende de configuração sua (não funciona sem isso)

1. Criar o projeto no Supabase e aplicar a tabela "Supabase em produção" do README (Auth, captcha, JWT de 300 s, schemas expostos, Realtime sem acesso público, pg_cron/pg_net, Vault, bucket).
2. Gerar e guardar as chaves da tabela "Contas e chaves" do README (`HMAC_KEYS`, `DATA_ENC_KEYS`, `LIMPEZA_SECRET`) com cópia num cofre de senhas.
3. Chaves de **produção** do Turnstile (hoje o projeto usa as chaves de teste da Cloudflare, que aprovam qualquer um).
4. Upstash Redis de produção.
5. Escolher o modo de deploy, ajustar `DEPLOY_MODE` e, no modo gerenciado, medir `TRUSTED_PROXY_HOPS` em `/painel/diagnostico`.
6. (Recomendado) Cloudflare Access no `/painel`.
7. Rodar `pnpm seed:owner` em produção e cadastrar o autenticador.

## 4. Não verificado

- **Hospedagem real:** nada foi publicado. Os testes rodam no CI com Supabase local. O comportamento da Hostinger (proxies, limites, Node 26) não foi medido.
- **Quantos proxies a Hostinger coloca na frente** (D-058/D-078): precisa ser medido no deploy.
- **pg_cron e pg_net no Supabase de produção:** as migrations criam os jobs; no CI eles existem, mas a chamada horária da limpeza via Vault + pg_net não foi exercida (no CI a limpeza é chamada direto).
- **Envio de e-mail de alerta:** não implementado (D-080).
- **Desempenho com muitas pessoas ao mesmo tempo:** sem teste de carga. A posição na fila foi otimizada (D-068), mas o limite prático não foi medido.
- **Leitores de tela reais:** a acessibilidade foi conferida com o axe (WCAG A/AA) e teclado; não com NVDA/VoiceOver.

## 5. Pendências jurídicas **[ADVOGADO]**

Itens que dependem de um advogado e que o sistema **não** resolve sozinho (detalhes em DECISIONS):

- D-034: condicionar a banca a depósito em plataforma de apostas; link de afiliado (`rel="sponsored"`); situação do operador; público menor de idade na Twitch; comprovante como dado financeiro de terceiro; tributação.
- D-035: bases legais propostas (LGPD) para cada dado.
- D-018/D-076: manter HMAC de CPF e IP depois da exclusão a pedido, para impedir pedido duplicado.
- Texto da política de privacidade (`/privacidade`), inclusive sobre backups do Supabase.
- D-022: a declaração de maioridade é só autodeclaração.

## 6. Riscos que sobram

Ver `SECURITY.md` ("Riscos que sobram") e `ARCHITECTURE.md` §7.
