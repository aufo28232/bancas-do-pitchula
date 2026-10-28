# DECISIONS.md — Bancas do Pitchula

> **Status: APROVADA em 27/10/2026.** O streamer aceitou todas as recomendações marcadas como [DECIDIR] e acrescentou os requisitos D-043 a D-046. Os itens **[ADVOGADO]** continuam pendentes de validação jurídica e não bloqueiam o desenvolvimento, mas bloqueiam a ida para produção.
> Cada decisão tem um status:
> - **Proposta**: recomendação técnica minha. Vale se você aprovar a arquitetura sem comentar.
> - **[DECIDIR]**: depende de você, porque muda regra de negócio ou produto.
> - **[ADVOGADO]**: precisa de validação jurídica.
>
> Quando uma decisão mudar, a entrada antiga não é apagada: ela recebe "Substituída por D-xxx".

---

## Resumo das perguntas (respondidas em 27/10/2026: todas as recomendações aceitas)

| # | Pergunta | Decisão (= recomendação aceita) |
|---|---|---|
| D-004 | Quando a banca esgota, os pendentes que sobraram são recusados na hora? | **Sim**, com "vagas esgotadas" |
| D-005 | Banca `aberta` esquecida fica aberta para sempre? | **Não**: encerra após 7 dias sem pedido novo |
| D-007 | Pedido recusado (ex.: comprovante ilegível) libera o CPF para um novo pedido na mesma banca? | **Não**: a pessoa reenvia o comprovante no mesmo chat |
| D-010 | "1 pedido por IP" pode ser ligado ou desligado depois que a banca recebeu pedidos? | **Sim**, valendo só para pedidos novos |
| D-014 | Moderador pode desbanir? | Só bans **da banca** que ele mesmo criou; bans globais, só o streamer |
| D-020 | Ban por CPF/Pix/ID que ninguém revisou em 12 meses | Cai sozinho 30 dias depois do vencimento |
| D-021 | Pedido entra na fila antes de mandar o comprovante? | **Sim**, com selo "sem comprovante" |
| D-022 | Exigir declaração "Tenho 18 anos ou mais"? | **Sim** (ver também D-034) |
| D-026 | Variáveis `NEXT_PUBLIC_*` não mudam sem rebuild. Trocar os nomes? | **Sim**: `PLATFORM_SIGNUP_URL` e `PLATFORM_NAME`, lidas em tempo de execução |
| D-032 | Limitar quantos pedidos pendentes uma banca acumula? | **Sim**: no máximo 3× as vagas restantes |
| D-033 | "Marcar como pago" errado pode ser desfeito? | **Não**: confirmação em 2 passos antes, sem desfazer |
| D-042 | Teto do valor total de uma banca | R$ 100.000 (o banco aceita até R$ 1 milhão; o teto da aplicação é configurável) |
| D-025 | Foto do streamer | **Resolvido:** foto recebida; paleta extraída |
| D-034 / D-035 | Pontos regulatórios e LGPD | Levar ao advogado antes de colocar no ar |

---

## D-001 · Stack e versões

**Status:** Implementada na Etapa 1 (27/10/2026). Versões exatas resolvidas pelo CI a partir das faixas de `scripts/deps.intent.json` (D-049):

| Pacote | Versão fixada |
|---|---|
| Node.js (CI e `.nvmrc`) | 26.12.1 (linha 26 LTS) |
| pnpm (`packageManager`) | 12.15.0 |
| next / eslint-config-next | 16.4.3 |
| react / react-dom | 19.2.9 |
| zod | 4.6.7 |
| typescript | 6.0.3 |
| tailwindcss / @tailwindcss/postcss | 4.3.3 |
| eslint | 9.39.5 |
| vitest | 4.1.12 |
| @types/node | 26.6.5 |
| @types/react / @types/react-dom | 19.3.0 |
| Supabase CLI (CI) | `latest` no momento (a fixar por versão na Etapa 7) |
| pg_prove (imagem do Supabase CLI) | 3.36 |

Proposta original (mantida como registro):

| Item | Escolha | Observação |
|---|---|---|
| Node.js | **26.x LTS** (última vista: 26.12.1, de 21/10/2026) | O Node 24 saiu do Active LTS em 20/10/2026 e o 26 está assumindo essa posição. **Se a hospedagem escolhida ainda não oferecer o Node 26**, usar 24.x LTS (manutenção até abr/2028). Não verificado: suporte da Hostinger ao Node 26 |
| Next.js | **16.4.x** (com o patch de segurança de 14/10/2026 ou posterior) | App Router, `output: "standalone"`, `proxy.ts` (nome atual do middleware no Next 16) |
| React | 19.3.x (a que vier com o Next 16.4) | |
| TypeScript | Estável atual, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | |
| Tailwind CSS | Estável atual (v4) | |
| Supabase | `@supabase/supabase-js`, `@supabase/ssr`, CLI `supabase` | Postgres 15+ com `pg_cron`, `pg_net`, `pgtap`, `supabase_vault` |
| Zod | Estável atual | Schemas compartilhados entre cliente e servidor |
| Upstash | `@upstash/redis` + `@upstash/ratelimit` | |
| Imagens | `sharp` | |
| TOTP | O próprio Supabase MFA | Sem biblioteca extra |
| Testes | Vitest, Playwright, pgTAP (via `supabase test db`) | |
| Pacotes | pnpm (versão fixada em `packageManager`) | |

**Regra:** todas as dependências entram com `pnpm add --save-exact` (sem `^`/`~`), com `pnpm-lock.yaml` versionado e `engines.node` fixado. A tabela acima ganha a versão exata de cada pacote no fim da Etapa 1.

**Por que as versões exatas ainda não estão aqui:** o registro do npm não estava acessível no ambiente onde este documento foi escrito. Em vez de chutar números, as versões serão lidas do registro no momento da instalação e registradas aqui. As linhas principais (Node 26, Next 16.4) foram conferidas nas páginas oficiais em 27/10/2026.

---

## D-002 · O navegador nunca acessa as tabelas

**Status:** Proposta

- **Decisão:** todas as tabelas ficam no schema `app`, que **não é exposto** pelo PostgREST. O único schema exposto é o `api`, só com funções. O navegador usa o Supabase **apenas** para Realtime. Leituras e escritas passam pelo servidor Next.js.
- **Alternativa:** o cliente consulta as tabelas direto com RLS, que é o padrão do Supabase.
- **Por quê:** (1) os dados estão cifrados e só o servidor tem a chave, então o cliente não teria o que fazer com eles; (2) o modo live precisa ser mascarado **no servidor**; (3) rate limit, CSRF e Zod só valem se o tráfego passar pelo servidor; (4) a superfície exposta fica mínima. O RLS continua existindo e sendo testado como segunda camada.
- **Custo:** mais endpoints no servidor.

## D-003 · Tempo real do espectador: login anônimo do Supabase (opção a)

**Status:** Proposta

- **Opção (a) escolhida:** login anônimo do Supabase, feito **pelo servidor** na troca do token, com o token do Turnstile repassado ao captcha do Supabase Auth. O `viewer_uid` fica vinculado ao pedido. O refresh token fica em cookie httpOnly e o navegador recebe só o access token curto (5 min), para o Realtime.
- **Opção (b) descartada:** JWT curto emitido pelo nosso servidor. Para isso o servidor precisaria guardar a **chave de assinatura de JWT do projeto Supabase**. Com essa chave é possível forjar qualquer JWT, inclusive de staff AAL2 ou `service_role`. Isso transformaria um vazamento do servidor Next em controle total do banco, sem passar pelo Auth. Com a opção (a), o servidor só guarda a service role key, que já é necessária de qualquer forma, e os tokens do espectador são emitidos e revogáveis pelo próprio Supabase Auth.
- **Pontos de atenção da opção (a):**
  - Usuários anônimos têm papel `authenticated` com `is_anonymous = true`. **Toda** política e função de staff exclui explicitamente `is_anonymous` (testado no pgTAP).
  - Habilitar captcha no Supabase Auth exige Turnstile em **todo** login, inclusive o do staff (o que é bom: D-038).
  - Usuários anônimos acumulam. A limpeza fica no cron (ARCHITECTURE §5.11).
  - O vínculo só acontece **depois** de validar o token do pedido. Um anônimo sem pedido não acessa nada.

## D-004 · Pendentes que sobram quando a banca esgota **[DECIDIR]**

- **Problema:** o enunciado diz que, em banca `esgotada`, "pedidos já abertos continuam na fila e podem ser atendidos", mas também que "nenhum pagamento pode ultrapassar o limite". Como não existe "desfazer pago", uma banca esgotada **nunca** volta a ter vaga, então esses pedidos jamais poderão ser pagos.
- **Recomendação:** no momento em que a última vaga é paga, a mesma transação recusa todos os pendentes com o motivo "vagas esgotadas". O espectador recebe o aviso na hora, em vez de esperar até 24h pelo encerramento.
- **Alternativa:** deixar os pendentes na fila até o encerramento, para o moderador recusar à mão.
- **Para banca `fechada`:** os pendentes continuam atendíveis normalmente, como pede o enunciado.

## D-005 · Banca `aberta` esquecida **[DECIDIR]**

- **Lacuna:** o enunciado encerra sozinho bancas `fechadas` (7 dias) e `esgotadas` (24h), mas uma banca `aberta` esquecida guardaria dados indefinidamente, contrariando o próprio objetivo da regra.
- **Recomendação:** encerrar automaticamente a banca `aberta` que passar **7 dias sem pedido novo e sem nenhuma ação de atendimento**.
- **Alternativa:** prazo máximo de vida da banca (ex.: 14 dias desde a criação).

## D-006 · "Em atendimento" é derivado, não é estado

**Status:** Proposta. Os estados gravados são `pendente | pago | recusado`. "Em atendimento" = pendente + trava ativa. A trava expira sozinha pelo tempo (sem job), e as transições ficam simples de provar.

## D-007 · Recusado libera o CPF? **[DECIDIR]**

- **Lacuna:** a constraint `unique(banca, cpf_hmac)` vale para todos os pedidos, inclusive os recusados. Quem teve o pedido recusado por "comprovante ilegível" não consegue abrir outro.
- **Recomendação:** manter assim. O moderador pede um novo print **no mesmo chat** antes de recusar, e a recusa vira decisão final. Isso também fecha a brecha de "tentar até passar".
- **Alternativa:** constraint parcial só sobre pedidos não recusados. Nesse caso, o motivo "banido" deve continuar bloqueando.

## D-008 · Canal de vagas: privado e somente leitura

**Status:** Proposta

- **Conflito:** o enunciado pede "um canal público de Broadcast". No Supabase, canal público aceita que **qualquer cliente envie** mensagens, e alguém poderia transmitir "0 vagas" ou "100 vagas" falsos para todos os espectadores.
- **Decisão:** canal **privado** `vagas:{code}`, com política de leitura para todos (anon e autenticados) e **nenhuma** política de escrita. Também desligar "Allow public access" no Realtime do projeto. Só os triggers do banco emitem eventos, e o payload é só `{restantes, total, status}`.
- **Verificação (Etapa 4):** o teste de integração entra no canal `vagas:{código}` só com a chave pública (papel `anon`) contra o Realtime local e confere que o evento chega, e que o mesmo cliente é recusado em `staff:*` e `pedido:*`. A página pública ainda faz `router.refresh()` a cada 30 s se o Realtime não conectar.

## D-009 · Posição na fila

**Status:** Proposta. O banco recalcula e envia a posição para cada pendente da banca quando a fila muda: custo O(n), adequado para algumas centenas. Se as bancas passarem de ~2.000 pendentes simultâneos, troca-se por um evento único "fila mudou", e cada espectador consulta a própria posição no servidor (com rate limit). D-032 limita esse número.

## D-010 · Alterar "1 pedido por IP" depois de criada **[DECIDIR]**

- **Recomendação:** pode ser alterado a qualquer momento e vale só para pedidos novos. Cada pedido guarda `ip_unique` no momento em que foi criado, e o índice único parcial usa essa coluna.
- **Alternativa:** travar junto com valor e vagas quando houver pedidos.

## D-011 · Normalização de IP

**Status:** Proposta. IPv4 inteiro. IPv6 agrupado pelo **/64**, porque cada aparelho costuma ter um /64 inteiro e conseguiria trocar de endereço à vontade dentro dele. O HMAC é calculado sobre essa forma canônica.

## D-012 · HIBP indisponível

**Status:** Proposta. Se a API do Have I Been Pwned falhar, a senha é **recusada** com "não foi possível validar a senha agora, tente em instantes". Segue a regra "na dúvida, segurança". O impacto é pequeno: só acontece ao criar ou trocar senha. Consulta por k-anonymity (5 primeiros caracteres do SHA-1) com `Add-Padding: true` e timeout de 3 s.

## D-013 · Rotação de chaves HMAC

**Status:** Proposta

- **Problema não coberto:** a rotação "com prefixo de versão" funciona bem para a cifra, porque dá para decifrar e cifrar de novo. Os **bans guardam só o HMAC** (por exigência da retenção), então não é possível recalculá-los com a chave nova.
- **Decisão:** cada HMAC guarda `hmac_key_version`. Durante a rotação, as checagens calculam o HMAC do valor com **todas as chaves ainda aceitas** e comparam com qualquer uma. Os pedidos são recalculados (decifrando). Os bans antigos continuam na versão antiga até expirar, ser levantados ou revisados (D-020). Quando não restar nenhum, a chave antiga sai.
- **Consequência:** rotação de HMAC é lenta (até 12 meses). Rotação de cifra é imediata.

## D-014 · Quem pode desbanir **[DECIDIR]**

- **Lacuna:** o enunciado dá a lista de banidos com "opção de desbanir", mas não diz quem pode usá-la.
- **Recomendação:** moderador só desbane bans **da banca** que **ele mesmo** criou (para corrigir um erro). Bans globais e bans de outros só o streamer desfaz. Tudo auditado.

## D-015 · Dados digitados no chat durante o modo live

**Status:** Proposta. O espectador pode escrever o próprio CPF ou Pix no chat, e o modo live do enunciado não cobre isso. Com o modo live ligado, o servidor mascara nas mensagens: sequências de 8 ou mais dígitos (com ou sem pontuação), e-mails e telefones. A revelação segue a mesma regra dos outros campos.

## D-016 · O que conta como "atividade" da trava

**Status:** Proposta. Renovam os 10 minutos: enviar mensagem, revelar dado, copiar Pix, abrir comprovante, mudar o estado. **Não renova:** ficar com a aba aberta (senão a trava nunca expiraria se o moderador saísse com o painel aberto).

## D-017 · Atalho de pânico

**Status:** Proposta. Padrão `Alt+Q` (não conflita com atalhos comuns do Chrome, Edge e Firefox no Windows), configurável por usuário. O mesmo atalho volta. Também há um botão visível no topo do painel.

## D-018 · Acesso do espectador após o encerramento e exclusão a pedido

**Status:** Aprovada; o primeiro item foi **substituído por D-044**

- ~~O link do pedido continua funcionando depois do encerramento, até a exclusão automática (30 dias).~~ → Agora o encerramento apaga tudo na hora e o espectador vai para a tela inicial (D-044).
- Botão "Excluir meus dados" no `/pedido`: com o pedido pendente, recusa e apaga; com o pedido pago ou recusado, apaga os dados pessoais na hora. Os HMACs de CPF e IP continuam enquanto a banca existir, para impedir um novo pedido duplicado na mesma banca. **[ADVOGADO]** confirmar se isso é aceitável (legítimo interesse em prevenção a fraude).

## D-019 · Encadeamento de hash na auditoria

**Status:** Proposta. Cada linha guarda `row_hash = SHA-256(prev_hash ‖ conteúdo)`. Isso não impede o superusuário do banco de mexer, mas torna a mexida **detectável** (`pnpm audit:verify`). A exclusão de 12 meses guarda o hash da última linha apagada como âncora.

## D-020 · Revisão anual de bans **[DECIDIR]**

- **Lacuna:** "revisados a cada 12 meses", mas quem revisa e o que acontece se ninguém revisar?
- **Recomendação:** o painel do streamer mostra "bans com revisão vencida". Se ninguém reconfirmar em até 30 dias após o vencimento, o ban **cai sozinho** e é apagado (minimização de dados). Reconfirmar empurra a revisão por mais 12 meses e fica auditado.

## D-021 · Comprovante e fila

**Status:** **[DECIDIR]** para a primeira parte; o resto é Proposta

- O formulário do enunciado não tem campo de comprovante: ele é enviado no chat. **Recomendação:** o pedido entra na fila na hora, com o selo "sem comprovante" e um filtro no painel. **Alternativa:** só entra na fila depois do primeiro comprovante.
- Máximo de 5 comprovantes por pedido e 30 mensagens por pedido por hora.
- O chat do espectador fica só leitura depois de pago ou recusado.

## D-022 · Declaração de maioridade **[DECIDIR]**

- **Recomendação:** checkbox obrigatório "Tenho 18 anos ou mais". A plataforma de apostas exige maioridade, e a audiência da Twitch inclui menores. Dados de menores têm regras próprias na LGPD (art. 14). É uma declaração, não uma verificação, e o advogado deve dizer se basta (D-034).

## D-023 · Página do pedido mostra os próprios dados mascarados

**Status:** Proposta. Em `/pedido`, o espectador vê os próprios dados parcialmente (ex.: "CPF ***.***.**9-01", "Pix: e-mail j***@g***.com"). Se o link vazar, quem abrir não vê os dados completos.

## D-024 · Tipografia

**Status:** Proposta (sujeita aos arquivos de marca)

- Display: **Big Shoulders** (800/900), condensada e pesada, com cara de pôster de evento, para o valor e os títulos. A "Big Shoulders Display" foi unificada pelo Google Fonts na família "Big Shoulders", nome que o Next 16.4 usa (confirmado no CI em 27/10/2026)
- Texto: **Instrument Sans**, neutra e legível, menos óbvia que Inter
- Dados no painel: **IBM Plex Mono**, com algarismos tabulares para valores e posições
- **Alternativas consideradas:** Anton + Inter (comum demais); Bebas Neue (excessivamente usada em sites gerados); Archivo Black (boa, mas menos condensada).

## D-025 · Foto do streamer e paleta

**Status:** Resolvida em 27/10/2026

- O link do catbox estava bloqueado na rede deste ambiente. O streamer enviou a foto diretamente: 991×1088, JPEG, **sem EXIF**. Ela fica salva em `public/pitchula.jpg` e é servida por `next/image` (AVIF/WEBP, `priority`). Enquadramento padrão: `object-position: 52% 18%`.
- **Cor de destaque:** `#EE781C`, o laranja da fumaça, que é a cor dominante da foto (quantização em 8 cores; a média dos pixels laranja saturados dá `#EF832E`).
- **Contrastes medidos** (WCAG): texto `#F2EFEA` sobre o fundo `#0B0B0C` = 17,2:1; secundário `#A39E96` = 7,4:1; laranja sobre o fundo = 6,9:1. O texto do botão laranja precisa ser **escuro** (`#0B0B0C`, 6,9:1): branco sobre o laranja dá só 2,9:1 e reprova no AA.
- **Descartadas:** o ciano/roxo do logo na camiseta (seria um degradê roxo/azul, que o enunciado pede para evitar, e uma segunda cor de destaque) e o marrom escuro da sombra (contraste baixo).
- Vale até os arquivos oficiais de marca chegarem; aí eles substituem esta paleta no arquivo de tema.

## D-026 · `NEXT_PUBLIC_*` não muda sem rebuild **[DECIDIR]**

- **Conflito:** o enunciado quer o link de cadastro e o nome da plataforma em `NEXT_PUBLIC_PLATFORM_SIGNUP_URL` e `NEXT_PUBLIC_PLATFORM_NAME`, "para poder ser trocado ou removido sem novo deploy de código". O Next.js **embute** variáveis `NEXT_PUBLIC_*` no JavaScript **na hora do build**. Trocar o valor exigiria um novo build.
- **Recomendação:** renomear para `PLATFORM_SIGNUP_URL` e `PLATFORM_NAME` (só servidor), lidas em **tempo de execução** pelos Server Components e passadas para a página já renderizada. Trocar o valor passa a exigir só reiniciar o processo, sem build nem código. Valor vazio esconde o link. O link é validado com Zod (só `https://`).
- **Alternativa:** manter os nomes `NEXT_PUBLIC_*` e aceitar que mudar exige rebuild (sem alteração de código).

## D-027 · Sessões do staff: refresh token nunca vai para o navegador

**Status:** Proposta. Os cookies do `@supabase/ssr` ficam `httpOnly`, `Secure`, `SameSite=Strict`, com prefixo `__Host-`. O navegador recebe apenas o access token (5 min) por um endpoint próprio, para o Realtime. XSS não consegue roubar uma sessão de longa duração.

## D-028 · JWT curto e inatividade de 8h

**Status:** Proposta

- Duração do JWT: **300 s** (`jwt_expiry` no `config.toml` e no painel do Supabase).
- Inatividade de 8h: implementação própria via `staff_sessions.last_seen_at`, checada no servidor **e** em `current_staff_role()`. Não depende de recursos de plano pago do Supabase.

## D-029 · Revogação de sessão

**Status:** Proposta. **Não verificado:** a forma exata de apagar uma sessão no Supabase Auth atual (endpoint admin de logout ou `DELETE` em `auth.sessions` por função `SECURITY DEFINER`) será confirmada na Etapa 2 contra a versão instalada. Independentemente disso, `staff_sessions.revoked_at` é checado em toda chamada, então a revogação vale na próxima requisição mesmo que o Supabase demore.

## D-030 · Rate limits e falha fechada

**Status:** Proposta (valores ajustáveis por variável de ambiente)

| Rota | Limite | Chave | Redis fora |
|---|---|---|---|
| Criar pedido | 5 / 10 min; 1 a cada 30 s | IP-HMAC | **Bloqueia** |
| Criar pedido (global por banca) | 600 / min | banca | **Bloqueia** |
| Troca de token do pedido | 20 / 10 min | IP-HMAC | **Bloqueia** |
| Mensagem do espectador | 30 / h e 1 a cada 2 s | pedido | Bloqueia |
| Upload | 10 / h | pedido + IP-HMAC | **Bloqueia** |
| Login | 10 / 15 min por IP; bloqueio progressivo por conta | IP-HMAC, e-mail-HMAC | **Bloqueia** |
| MFA (verificação) | 5 / 5 min | sessão | **Bloqueia** |
| Aceite de convite | 10 / h | IP-HMAC | **Bloqueia** |
| Revelar dado | 60 / 10 min | staff | Bloqueia |
| Demais APIs do painel | 300 / min | staff | Permite, com log de alerta |
| Página pública (GET) | Fica com a Cloudflare (WAF/rate rules) | — | — |

## D-031 · Modos de deploy e IP real

**Status:** Proposta. `DEPLOY_MODE` ∈ `managed | cloudflare_locked | tunnel`. `CF-Connecting-IP` só é aceito nos dois últimos. No `managed`, o painel mostra o aviso de que as regras por IP estão enfraquecidas. **Não verificado:** como a hospedagem Node gerenciada da Hostinger entrega o IP do cliente e se a origem é acessível sem passar pela Cloudflare. Será testado na prática antes do deploy.

## D-032 · Teto de pedidos pendentes **[DECIDIR]**

- **Lacuna:** nada limita quantos pedidos uma banca de 10 vagas recebe. Centenas de pessoas entregariam CPF e Pix sem chance real de receber. Isso fere a minimização de dados da LGPD e enche a fila.
- **Recomendação:** recusar novos pedidos (com "Fila cheia, tenta de novo daqui a pouco") quando os pendentes passarem de **3× as vagas restantes** (configurável por banca).
- **Revista em 28/10/2026 (pedido do streamer):** **sem teto**. A fila aceita quantos pedidos chegarem enquanto a banca estiver aberta; quem fecha as entradas é pausar, esgotar (todas as vagas **pagas**) ou encerrar. O teto continua possível por banca (`pending_factor`), mas fica desligado. Efeito colateral: mais gente entrega CPF e Pix sem chance de receber. Os pendentes que sobram são recusados na hora em que a banca esgota (D-004) e tudo é apagado no encerramento (D-044). O limite de 600 pedidos por minuto por banca (anti-robô) continua.

## D-033 · Pagamento marcado por engano **[DECIDIR]**

- **Lacuna:** "pago" é estado final, e o enunciado proíbe transições inválidas. Um clique errado consumiria a vaga para sempre.
- **Recomendação:** sem "desfazer". Em vez disso, confirmação em 2 passos ("Confirmar Pix de R$ 30,00 para J*** S***?"), já que o Pix também não se desfaz.
- **Alternativa:** ação "corrigir" exclusiva do streamer, que volta o pedido para pendente e devolve a vaga, com auditoria. Aumenta a superfície de fraude interna.

## D-034 · Sensibilidade regulatória **[ADVOGADO]**

Não presumo que a operação esteja autorizada e **nenhum texto do site vai afirmar isso**. Os pontos abaixo são perguntas para o advogado, não conclusões jurídicas:

1. **Condicionar o recebimento a um depósito na plataforma de apostas.** A Lei 14.790/2023 e as portarias da SPA/MF restringem bônus, vantagens e incentivos ligados a apostas. Avaliar se a "banca" pode ser enquadrada como incentivo, mesmo paga pelo streamer e não pelo operador.
2. **Link de cadastro com `rel="sponsored"` (afiliado).** É publicidade de apostas. Avaliar as regras de publicidade e jogo responsável das portarias (advertências obrigatórias, símbolo 18+, proibição de direcionar a menores, só operadores autorizados). O link fica em variável justamente para poder ser **removido** sem mexer no código (D-026).
3. **Situação do operador.** Verificar se a 4fly consta da lista de operadores autorizados pela SPA/MF. Pelo que conheço, operadores autorizados usam domínio `.bet.br`, e o link recebido é de outro domínio. O advogado deve confirmar.
4. **Audiência com menores.** A Twitch tem público menor de idade, e a declaração de D-022 é só autodeclaração.
5. **Comprovante de depósito** é dado financeiro de terceiro (operação na plataforma), tratado só para conferência.
6. **Tributação** dos valores distribuídos: fora do escopo técnico.

**Funcionalidades mais sensíveis:** o link de afiliado (item 2), a exigência do comprovante de depósito (itens 1 e 5) e qualquer texto que associe a banca a ganhos. Os textos da interface serão neutros e descritivos ("Preenche aí e manda o comprovante"), sem promessa de ganho.

## D-035 · Bases legais propostas (LGPD) **[ADVOGADO]**

| Dado | Finalidade | Base legal proposta | Observação |
|---|---|---|---|
| Nome completo | Conferir com o titular da chave Pix | Art. 7º, V (procedimentos a pedido do titular / execução) | |
| Chave Pix | Fazer o pagamento | Art. 7º, V | |
| CPF cadastrado na 4fly | Conferir o comprovante; impedir duplicidade | Art. 7º, V + art. 7º, IX (legítimo interesse: prevenção a fraude) | Legítimo interesse exige teste de balanceamento documentado (art. 10) |
| ID na 4fly | Idem | Idem | |
| Comprovante de depósito | Conferir elegibilidade | Art. 7º, V | |
| IP | Segurança, rate limit, antifraude, regra 1/IP | Art. 7º, IX | Ver Marco Civil abaixo |
| HMACs em bans | Prevenção a fraude | Art. 7º, IX | Pseudonimizado ≠ anonimizado (art. 13, §4º) |
| Mensagens do chat | Atendimento | Art. 7º, V | |
| Dados do staff e auditoria | Segurança e responsabilização | Art. 7º, IX e VI (exercício regular de direitos) | |
| Cookies | Só os estritamente necessários | Sem consentimento (não há analytics) | |

Pontos para o advogado:
- **Consentimento não é usado como base.** O checkbox é de **ciência** da política, não de consentimento.
- **Marco Civil da Internet (art. 15):** provedores de aplicação que sejam **pessoa jurídica** com fins econômicos devem guardar registros de acesso por **6 meses**. Isso pode conflitar com a retenção curta de IP. É preciso saber se o controlador é pessoa física ou jurídica.
- Dado de alto risco ≠ "dado sensível" no sentido legal (art. 5º, II). CPF e dados financeiros não são sensíveis por definição, mas recomenda-se um **RIPD** (art. 38).
- **Encarregado ou canal de contato** (art. 41; agentes de pequeno porte têm regras simplificadas): definir quem responde e por qual e-mail.
- **Transferência internacional** (art. 33): ver D-036.

## D-036 · Regiões dos serviços

**Status:** Proposta. Supabase na região **São Paulo (sa-east-1)**. Upstash na região mais próxima disponível (preferência por São Paulo). Cloudflare é global por natureza. **Não verificado:** disponibilidade de São Paulo no Upstash no plano escolhido. Se algum dado sair do Brasil, isso entra na política de privacidade (D-035).

## D-037 · Dados dos moderadores

**Status:** Proposta. O espectador só vê o **apelido** do moderador ("Fulano está atendendo"), nunca o nome real ou o e-mail. As sessões guardam só um resumo do user-agent e a localização aproximada (país/cidade).

## D-038 · Turnstile também no login do staff

**Status:** Proposta. É consequência de D-003, porque o captcha do Supabase Auth vale para todos os logins. Na prática, é uma camada a mais contra força bruta.

## D-039 · CSRF

**Status:** Proposta. Três camadas: cookies `SameSite=Strict`; token double-submit assinado com HMAC em header próprio para Route Handlers; checagem de `Origin`/`Sec-Fetch-Site` em toda mutação. Server Actions já checam `Origin` no Next, e mesmo assim passam pela mesma verificação.

## D-040 · E-mail de alerta

**Status:** Proposta. Opcional. Sem `SMTP_*` configurado, os alertas aparecem só no painel. O e-mail nunca leva dados de espectadores.

## D-041 · Notificação sonora

**Status:** Proposta. Os navegadores bloqueiam som sem interação prévia. O painel pede um clique em "Ativar som" no início do turno, e a notificação visual (título da aba e destaque na fila) funciona sempre.

## D-042 · Teto do valor da banca **[DECIDIR]**

**Recomendação:** o banco aceita até R$ 1.000.000 (`check`) como proteção contra erro de digitação absurdo. A aplicação limita a **R$ 100.000** por padrão, configurável. Valores acima pedem confirmação extra.

## D-043 · Prazo de 5 min para o espectador responder

**Status:** Aprovada (requisito novo do streamer, 27/10/2026)

- **Regra:** depois que um moderador assume o pedido e manda uma mensagem, o espectador tem **5 minutos** para responder (texto ou comprovante). Se não responder, o pedido **expira**.
- **Detalhes que eu defini** (diga se quiser outra coisa):
  - O prazo só começa com mensagem do moderador **que está com a trava**. Assumir sem mandar mensagem não inicia contagem.
  - Cada nova mensagem do moderador **reinicia** os 5 min. Qualquer resposta do espectador **para** o relógio.
  - Liberar a trava, pagar ou recusar cancela o prazo.
  - Expirar = **recusado com o motivo "sem resposta"**. Pela D-007 (aprovada), isso não libera o CPF para um novo pedido na mesma banca, e a tela avisa isso de forma clara junto da contagem.
  - O espectador vê a contagem regressiva e ouve um beep quando o prazo começa (D-046). O moderador vê o tempo restante na fila.
- **Implementação:** `orders.reply_deadline_at`, mais o job do pg_cron a cada 15 s, mais uma checagem preguiçosa em toda função que mexe no pedido. Assim, a expiração vale mesmo que o job atrase: uma mensagem enviada aos 5min01s é recusada.
- **Alternativas consideradas:** expirar o pedido de volta para "aguardando" no fim da fila. Mais gentil, mas deixa o espectador ocupar a fila indefinidamente.

## D-044 · Encerrar a banca apaga tudo na hora

**Status:** Aprovada (requisito novo do streamer, 27/10/2026). **Substitui** a retenção de 30 dias do enunciado e o primeiro item de D-018.

- **Regra:** quando o streamer ou um moderador encerra a banca (ou o encerramento automático acontece):
  1. **Todos os pedidos são apagados na hora** (dados pessoais, mensagens, comprovantes, sessões), inclusive os pagos.
  2. **O link da banca deixa de existir.** O código é apagado e nunca é reaproveitado, e a rota passa a redirecionar para `/`.
  3. **Todo mundo conectado** (página da banca e chats dos pedidos) é levado para a tela inicial, que mostra **"Aguardando banca..."** com animação.
- **O que continua guardado (sem dados pessoais):** os totais da banca (recebidos, pagos, recusados, total pago, sobra), o nome e as datas da banca, a auditoria de 12 meses (quem pagou qual ID de pedido, quando) e os bans (só HMAC).
- **Efeitos:**
  - Para a LGPD, é **melhor**: menos tempo guardando dado pessoal (minimização).
  - **Risco T23:** sem os dados, o sistema não consegue mostrar para quem foi um Pix se houver reclamação depois. O comprovante continua no app do banco do streamer. **[ADVOGADO]** confirmar se não há obrigação de guarda (ver Marco Civil em D-035).
  - **Risco T22:** encerrar é irreversível. Por isso, a confirmação exige digitar o nome da banca.
  - Backups do Supabase ainda guardam os dados até expirarem; isso vai documentado na política e no README.
- **Arquivos do Storage:** a Edge Function é chamada na hora do encerramento, e o cron de hora em hora pega o que falhar.

## D-045 · Moderadores também podem encerrar a banca

**Status:** Aprovada (interpretação do requisito "se o streamer ou os adms encerrou")

- **Mudança na matriz de permissões:** moderador AAL2 pode **encerrar** a banca. Criar, editar, fechar e reabrir continuam só com o streamer.
- **Proteções:** confirmação digitando o nome da banca, chave de idempotência, auditoria com o autor e alerta no painel do streamer.
- Se você preferir que só o streamer encerre, é uma linha na função e na matriz.

## D-046 · Beep quando o pedido é assumido

**Status:** Aprovada (requisito novo do streamer, 27/10/2026)

- **Beep quando o moderador assume o pedido**, para o espectador escutar. Acrescentei um **segundo beep, mais curto, quando o moderador manda mensagem**, porque é aí que começam os 5 min (D-043), e esse é o aviso que mais importa para não perder o pedido.
- **Som gerado no navegador** com a Web Audio API (oscilador). Sem arquivo de áudio: nada a baixar e nada a liberar na CSP.
- **Limitação dos navegadores:** som só toca depois que a pessoa toca na página. O `/pedido` mostra "Ativar som 🔔" na chegada, e qualquer toque na página também libera.
- **Reforços:** vibração no Android (`navigator.vibrate`; o iPhone não suporta); título da aba piscando ("🔔 Atendimento iniciado"); destaque visual na tela.
- **Não verificado / limitação:** com o celular bloqueado ou o navegador em segundo plano, o sistema operacional pode silenciar o som. Resolver isso exigiria notificações push (service worker + permissão), fora do escopo atual.

## D-047 · Tela inicial

**Status:** Aprovada

- `/` mostra só "Aguardando banca..." com animação: fundo escuro com grain, título em Big Shoulders Display, três pontos pulsando no laranja e uma linha de varredura lenta. A animação para com `prefers-reduced-motion`. Também aparecem os links da Twitch e do Instagram e o aviso de site oficial.
- A tela inicial **não lista** a banca aberta: o link continua vindo da live. Se quiser um botão "Banca aberta, entrar" quando houver banca, é uma mudança pequena.

## D-048 · Cadastro público barrado NO BANCO, login anônimo ligado

**Status:** Implementada e **verificada no CI** (Etapa 2). Substitui a versão da Etapa 1.

- **O que o CI mostrou:** desligar o cadastro por e-mail no Supabase (`[auth.email] enable_signup = false`) desliga também o **login** por e-mail ("Email logins are disabled"). E desligar o cadastro geral desliga o login anônimo do espectador (D-003). Nenhum interruptor do Auth atende ao enunciado sozinho.
- **Decisão:** o Auth fica com o provedor de e-mail ligado, e quem barra o cadastro é o **Postgres**. Um trigger `BEFORE INSERT` em `auth.users` só deixa o Supabase Auth (papel `supabase_auth_admin`) criar usuário **não anônimo** se o servidor tiver pré-autorizado aquele e-mail há menos de 10 minutos (`app.auth_provisioning`, uso único, só o hash do e-mail). Isso só acontece no seed do streamer e no aceite de convite.
- **Provado nos testes de integração:**
  - `POST /auth/v1/signup` com e-mail é recusado.
  - Nem a API admin com a service role cria conta sem a pré-autorização.
  - O login anônimo continua funcionando.
- **Risco residual:** contas anônimas podem ser criadas pela API pública. Elas não acessam nenhuma tabela (pgTAP 04/07) e exigem captcha.

## D-049 · Como as versões exatas são fixadas

**Status:** Proposta (Etapa 1)

- **Problema:** o ambiente onde o código é escrito não alcança o registro do npm. O GitHub Actions alcança.
- **Decisão:** `scripts/deps.intent.json` declara a faixa pretendida de cada pacote. Na **primeira** execução do CI, `scripts/pin-deps.mjs` resolve cada faixa para a maior versão estável, grava a versão **exata** no `package.json` (sem `^`/`~`) e o `packageManager` do pnpm, gera o `pnpm-lock.yaml`, roda todas as verificações e devolve esses arquivos ao repositório. Dali em diante, o CI usa `--frozen-lockfile`.
- **Faixas escolhidas:** Next 16.4+ (contém o patch de 14/10/2026), React 19, Zod 4, TypeScript 5.9–6.x (fica de fora o TS 7 nativo, por compatibilidade com o plugin do Next), ESLint 9 (o `eslint-config-next` acompanha a versão do Next), Tailwind 4, Vitest 3–4.
- A tabela final de versões entra aqui depois da primeira execução, copiada de `scripts/pinned-versions.md`.
- **Pendente (Etapa 7):** fixar as GitHub Actions por SHA de commit, em vez de tag de versão.

## D-050 · RLS sem FORCE

**Status:** Proposta (Etapa 1). Substitui o "ENABLE + FORCE" da proposta inicial.

- Com `FORCE ROW LEVEL SECURITY`, o próprio dono das tabelas passaria a ser filtrado pela RLS. As funções `SECURITY DEFINER` (pagar, recusar, encerrar...) rodam como o dono, e a função que as políticas chamam (`current_staff_role`) também, o que causaria recursão e bloqueio.
- O dono (`postgres`) nunca é usado pela aplicação: o servidor usa o JWT do staff (`authenticated`) ou a `service_role`, que não têm privilégio direto nas tabelas (provado no pgTAP 02).

## D-051 · `exactOptionalPropertyTypes` desligado

**Status:** Proposta (Etapa 1). O `tsconfig` usa `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`. `exactOptionalPropertyTypes` (citado em D-001) ficou de fora porque costuma conflitar com os tipos gerados pelo Next em `.next/types`. Pode voltar se o CI mostrar que não há conflito.

## D-052 · Pasta de tema

**Status:** Proposta (Etapa 1). O "arquivo de tema central" é a pasta `src/theme/`: `theme.ts` (cores, foto, logo, raios), lido pelo Tailwind, e `fonts.ts` (as fontes ficam separadas porque o `next/font` exige chamadas literais no módulo). Um teste confere o contraste AA de todos os pares de cor usados como texto.

## D-053 · Alerta de dispositivo novo só a partir do segundo dispositivo

**Status:** Implementada (Etapa 2). O primeiro login de uma conta registra o dispositivo sem alerta (não há com o que comparar). A partir daí, todo login de um dispositivo desconhecido gera alerta no painel do streamer. O dispositivo é reconhecido por um cookie aleatório de 1 ano, guardado como HMAC junto com o id do usuário.

## D-054 · Turnstile do login verificado pelo Supabase Auth

**Status:** Implementada (Etapa 2). Os tokens do Turnstile são de uso único. Como o captcha do Supabase Auth está ligado (necessário para proteger o login anônimo), o token do formulário de login vai direto para o Auth, que verifica. O nosso servidor não verifica de novo, senão o token chegaria ao Auth já gasto. No aceite de convite (que usa a API admin, sem captcha), quem verifica é o nosso servidor. Nos dois casos, Cloudflare fora do ar = recusa.

## D-055 · `style-src-attr 'unsafe-inline'` na CSP

**Status:** Implementada (Etapa 2). `<script>` e `<style>` inline continuam proibidos (só com nonce). Atributos `style="..."` são liberados porque o `next/image` (foto da página da banca, Etapa 3) depende deles para posicionar a imagem. Injetar um atributo exigiria injetar HTML, e o React escapa todo texto. O lint também proíbe `style` nos nossos componentes.

## D-056 · Clientes HTTP próprios no servidor

**Status:** Implementada (Etapa 2). O servidor fala com o Supabase Auth (GoTrue), o PostgREST e o Upstash pelas APIs REST com `fetch`, em vez de `@supabase/supabase-js`, `@supabase/ssr` e `@upstash/redis`. Isso dá controle total sobre timeouts, falha fechada e onde ficam os tokens (o refresh token nunca vai para um storage no navegador), com zero dependências de runtime a mais. O `supabase-js` entra na Etapa 4, só no navegador e só para o Realtime.

## D-057 · Sessão do staff em cookies `__Host-` e renovação no `proxy.ts`

**Status:** Implementada (Etapa 2).
- Cookies `__Host-bp_at` (access, ~5 min) e `__Host-bp_rt` (refresh, 8h deslizantes): `HttpOnly`, `Secure`, `SameSite=Strict`, sem `Domain`.
- O `proxy.ts` renova a sessão no servidor quando faltam menos de 60 s para o access vencer. Server Components não conseguem gravar cookies, por isso a renovação fica no proxy. Se o Auth recusar a renovação (sessão revogada), os cookies são apagados.

## D-058 · IP do cliente na hospedagem gerenciada

**Status:** Implementada (Etapa 2). No modo `managed`, o IP é o **último** valor de `X-Forwarded-For`, o que o proxy da hospedagem acrescenta. O primeiro valor é controlado pelo cliente. **Não verificado:** quantos proxies a Hostinger coloca na frente; se forem dois ou mais, o valor certo é outro, e isso precisa ser medido no deploy (Etapa 7). Nos modos `cloudflare_locked` e `tunnel`, só `CF-Connecting-IP`.

## D-059 · Redis de verdade nos testes

**Status:** Implementada (Etapa 2). No CI, os testes usam um Redis 7 real atrás do `serverless-redis-http`, um proxy que implementa a mesma API REST do Upstash. Não é mock: os comandos rodam num Redis. Em produção, a URL e o token passam a ser os do Upstash. "Redis fora do ar" é testado apontando para uma porta fechada.

## D-060 · CSRF: double submit com cookie `__Host-` (sem assinatura)

**Status:** Implementada (Etapa 2). Substitui o "token assinado" de D-039. A assinatura protege contra cookie plantado por subdomínio ou por conexão sem TLS, e o prefixo `__Host-` já impede as duas coisas. Toda mutação exige:
1. `Origin` igual ao `SITE_URL`;
2. `Sec-Fetch-Site: same-origin` (quando enviado);
3. header `x-csrf-token` igual ao cookie `__Host-bp_csrf`.

Testado na integração (sem token, outra origem, cross-site).

## D-061 · Logout pelo JWT verificado

**Status:** Implementada (Etapa 2). O logout chama `api.preauth_end_session()` com o próprio JWT do usuário, e o banco tira o `session_id` do token **verificado** pelo PostgREST. Nenhuma rota aceita um id de sessão vindo do cookie lido sem verificação. A primeira versão desta etapa usava a service role com o id do cookie e foi corrigida antes de subir.

## D-062 · Retenção da auditoria apaga só o trecho inicial contínuo

**Status:** Implementada (Etapa 2). A rotina de 12 meses apaga o trecho **inicial contínuo** de registros antigos da cadeia, nunca um registro recente. A cadeia continua verificável a partir da âncora. Teste dedicado no pgTAP 06.

## D-063 · Limites de pedido configuráveis

**Status:** Implementada (Etapa 3). Os limites por IP (5 pedidos a cada 10 min e 1 a cada 30 s) e o teto do valor da banca (R$ 100 mil) vêm de variáveis de ambiente com padrões seguros e faixas validadas. Os testes usam rajada de 1 s para não esperar 30 s entre pedidos. Em produção, os padrões valem se nada for configurado.

## D-064 · Build standalone com os arquivos estáticos

**Status:** Implementada (Etapa 3). `next build` com `output: "standalone"` não copia `public/` nem `.next/static/`. O `pnpm build` roda `scripts/standalone.mjs` em seguida, e `node .next/standalone/server.js` serve tudo (foto inclusive). Os testes E2E rodam contra esse mesmo build de produção.

## D-065 · `upgrade-insecure-requests` só com HTTPS

**Status:** Implementada (Etapa 3). A diretiva só entra na CSP quando `SITE_URL` é `https://`. Em `http://localhost` ela forçava os recursos para `https://localhost` e quebrava a página (visto nos testes E2E).

## D-066 · O que o pedido guarda e como compara

**Status:** Implementada (Etapa 3).
- **Cifrados (AES-GCM, AAD por pedido e coluna):** nome normalizado (espaços), CPF (só dígitos), chave Pix normalizada e ID na plataforma como digitado.
- **HMAC com domínio separado:**
  - `cpf`: dígitos do CPF.
  - `pix`: tipo + chave normalizada.
  - `pid`: ID em minúsculas.
  - `ip`: forma canônica, com IPv6 agrupado no /64.
- Duplicidade e banimento comparam com o HMAC em todas as versões de chave aceitas (D-013).
- O banco recusa texto não cifrado nos campos `*_enc` (check `is_ciphertext`, testado).

## D-067 · Leitura do fragmento pelo próprio app, não por script inline

**Status:** Implementada (Etapa 4). A ARCHITECTURE previa um `<script>` inline com nonce. Na prática, o primeiro efeito do componente da página lê o fragmento e o apaga com `history.replaceState` antes de montar o Turnstile, que é o único script de terceiro de `/pedido`. Os scripts que carregam antes são do próprio site. Evita um segundo ponto de leitura do token e um script inline a mais na CSP. O E2E confere que a barra de endereço fica sem `#`.

## D-068 · Posição na fila enviada só a quem muda

**Status:** Implementada (Etapa 4). Pedido novo entra no fim, então só ele recebe a posição. Quando um pendente sai da fila (pago, recusado, expirado), só os que estavam atrás dele recebem a nova posição. Antes, D-009 previa reenviar para todos a cada mudança.

## D-069 · Sessão do espectador em dois cookies

**Status:** Implementada (Etapa 4). `__Host-bp_ped` guarda a sessão do pedido (o banco tem só o hash, validade de 30 dias). `__Host-bp_ped_rt` guarda o refresh token da conta anônima do Supabase. A cada `POST /api/pedido/realtime` o servidor renova a conta anônima e devolve só o access token de 5 min; o refresh token novo volta para o cookie. Link inválido apaga a conta anônima criada na tentativa. Contas anônimas antigas serão limpas pela rotina de retenção (Etapa 6).

## D-070 · E2E da Etapa 4 simula o painel pelo banco

**Status:** Implementada (Etapa 4). Assumir o pedido, mandar a mensagem que inicia o prazo e encerrar a banca ainda não têm tela (Etapa 5). O E2E faz essas mudanças direto no Postgres local, e todo o resto passa pelo caminho real: os triggers emitem o Broadcast, o Realtime entrega e a página reage. Na Etapa 5 esses passos passam a ser feitos pela tela do painel.

## D-071 · Concorrência testada com requisições simultâneas, não com dblink

**Status:** Implementada (Etapa 5). O plano previa pgTAP com duas conexões via `dblink`. Isso não funciona dentro do pgTAP: cada arquivo roda numa transação que nunca é confirmada, e uma conexão `dblink` não enxerga os dados dessa transação. Os testes de concorrência ficaram na integração (Vitest): dois moderadores reais disparam a mesma ação **ao mesmo tempo** pelo PostgREST (última vaga paga por dois, dois assumindo o mesmo pedido, pagamento duplo com a mesma chave). As regras sequenciais (transições, travas, prazo, idempotência) continuam no pgTAP 10.

## D-072 · Tempo real do painel com o access token do staff

**Status:** Implementada (Etapa 5), conforme D-027. `POST /api/painel/realtime` devolve o access token atual do staff (vale até 5 min; o proxy renova no servidor) só para entrar no canal `staff:{banca}`. Os eventos desse canal levam só id e estado; o painel busca os dados no servidor, que aplica o modo live.

## D-073 · Streamer paga ou recusa sem assumir

**Status:** Implementada (Etapa 5). A tabela de §5.6 dizia "trava pelo próprio moderador (ou owner)". Ficou assim: moderador precisa estar com a trava; o streamer pode pagar ou recusar direto **se ninguém estiver com o pedido**. Se um moderador estiver atendendo, nem o streamer passa por cima sem antes "forçar assumir" (que é auditado).

## D-074 · Mensagens do espectador: 30 por hora

**Status:** Implementada (Etapa 5), conforme D-021. Além de 10 por minuto e 1 a cada 2 s, o chat do espectador aceita no máximo 30 mensagens por hora por pedido (Redis fora = bloqueia). O limite de 5 comprovantes chega com os uploads (Etapa 6).

## D-075 · Limpeza de arquivos e contas anônimas pelo servidor da aplicação

**Status:** Implementada (Etapa 6). A ARCHITECTURE previa uma Edge Function `purge-storage`. Troquei por uma rota do próprio app, `POST /api/interno/limpeza`, protegida por `Authorization: Bearer LIMPEZA_SECRET` (comparação em tempo constante; sem a variável, a rota não existe).
- **Por quê:** o mesmo código roda nos 3 modos de deploy e no CI, sem um segundo runtime (Deno) para manter e testar. O teste obrigatório ("o arquivo some do Storage") roda contra o Storage local de verdade.
- **Quem chama:** (1) o próprio servidor, logo depois de encerrar uma banca ou de uma exclusão a pedido, sem segurar a resposta (`after` do Next); (2) o pg_cron a cada hora, via pg_net, lendo a URL e o segredo do **Vault** do Supabase (`limpeza_url`, `limpeza_segredo`); (3) qualquer cron externo, se a hospedagem preferir.
- **O banco continua no controle:** encerramento automático, retenção e prazos rodam no pg_cron (`app.auto_end_bancas`, `app.retencao`). A rota também roda essa manutenção (`api.srv_maintenance`), para quem hospedar sem pg_cron.
- **Filas:** `storage_purge_queue` (arquivos) e `auth_purge_queue` (contas anônimas), com até 5 tentativas e erro registrado sem dado pessoal.

## D-076 · Exclusão a pedido mantém só o mínimo

**Status:** Implementada (Etapa 6), conforme D-018. O botão "Excluir meus dados" (`/pedido`) troca nome, CPF, Pix e ID por valores que não decifram (`v0:`), apaga chat, comprovantes e sessões, revoga o link e põe a conta anônima na fila. Ficam: estado do pedido (para os agregados) e os HMACs de **CPF e IP** (para impedir um novo pedido duplicado na mesma banca). Os HMACs de Pix e ID são trocados por valores aleatórios. Tudo some de vez no encerramento da banca. **[ADVOGADO]** continua valendo a pergunta de D-018.

## D-077 · Comprovante enviado como arquivo cru

**Status:** Implementada (Etapa 6). O navegador manda a imagem no corpo (`application/octet-stream`), sem multipart. O servidor lê o fluxo e **para** ao passar de 5 MB (não confia no `Content-Length`), decide o tipo pelos bytes, confere dimensões antes de decodificar e re-encoda em WEBP sem metadados (sharp). O arquivo vai para o bucket privado `comprovantes` com nome gerado pelo servidor (`{banca}/{pedido}/{uuid}.webp`); se o banco recusar (limite de 5, pedido finalizado), o arquivo é apagado na hora. Ver é sempre por URL assinada de 60 s, pedida na hora do clique; no painel, cada abertura fica na auditoria.

## D-078 · Quantos proxies confiar no modo gerenciado

**Status:** Implementada (Etapa 7), resolve a pendência de D-058. `TRUSTED_PROXY_HOPS` (1 a 5, padrão 1) diz quantos proxies da hospedagem ficam na frente; o IP usado é o dessa posição, contando do fim do `X-Forwarded-For`. Cabeçalho com menos valores do que o esperado = IP "desconhecido" (todo mundo no mesmo balde, mais restritivo). A página `/painel/diagnostico` (só o streamer) mostra quantos valores chegam e qual IP as regras enxergam, para acertar o número na hospedagem real. **Continua não verificado** quantos proxies a Hostinger usa: precisa ser medido no deploy.

## D-079 · Cloudflare Access conferido pelo servidor

**Status:** Implementada (Etapa 7). Com `CF_ACCESS_TEAM_DOMAIN` e `CF_ACCESS_AUD` preenchidos, o `proxy.ts` exige em todo `/painel` e `/api/painel` o JWT do Access válido: RS256 com as chaves públicas da equipe (cache de 1h), `aud`, emissor e validade. Sem o JWT, com JWT inválido ou se as chaves não puderem ser buscadas: 403 (falha fechada). Testado com chaves geradas no teste (assinatura de outra chave, `kid` desconhecido, `alg` trocado, corpo adulterado, `aud`/emissor errados, vencido). Sem as variáveis, fica desligado.

## D-080 · E-mail de alerta não implementado

**Status:** Pendente (Etapa 7). D-040 era opcional. Os alertas (dispositivo novo, banca encerrada por moderador, falha na retenção) aparecem no painel do streamer. As variáveis `SMTP_*` saíram do `.env.example` para não sugerir algo que não existe.

## D-081 · Auditoria legível e sinais de fraude

**Status:** Implementada (Etapa 7). `/painel/auditoria` (só o streamer) lista quem fez o quê e quando, sem dados pessoais, e confere a cadeia de hash (D-019) a cada abertura. No pedido, o painel avisa quando a mesma chave Pix ou o mesmo ID aparece em outro pedido da banca e quando o mesmo comprovante (SHA-256 do arquivo re-encodado) foi enviado em outro pedido (T9). Encerramento feito por moderador gera alerta para o streamer (T22). Revelar dado tem limite próprio de 30 por minuto por pessoa (T21).

## D-082 · Pedido vai direto para o chat, sem link

**Status:** Implementada (28/10/2026, pedido do streamer). Substitui o "link com token no fragmento" de §5.5.
- Ao enviar o pedido, o servidor já cria a sessão do pedido no **mesmo navegador** (cookie httpOnly, Secure, SameSite=Strict, 30 dias) e a página vai direto para `/pedido`. Não existe mais link para copiar, mostrar na live ou mandar em print.
- **Voltar ao site:** quem já tem pedido aberto e abre o link da banca (ou a página inicial) cai direto no próprio pedido. A marca de "tem pedido" fica no `localStorage` só para evitar uma consulta em toda visita; a sessão de verdade é o cookie, que o JavaScript não lê. Banca encerrada = pedido apagado = a marca é esquecida.
- **Turnstile:** o token do formulário vai para o captcha nativo do Supabase Auth na criação da conta anônima do espectador (mesmo esquema do login, D-054). Pedido recusado (duplicado, banido, banca fechada) apaga essa conta na hora.
- **Troca:** quem limpar os dados do navegador ou trocar de aparelho perde o acesso ao pedido (o pedido continua na fila do painel). Era o preço de não ter link.
- **Limites do Supabase Auth:** como todas as chamadas saem do nosso servidor (um IP só), os limites por IP do Auth valem para o site inteiro. Em produção, suba em Authentication → Rate Limits: usuários anônimos (ex.: 3000/h) e renovação de token (ex.: 3000/5 min). Os limites por espectador continuam no app (Redis). Alternativa a avaliar: o encaminhamento de IP do Supabase (`Sb-Forwarded-For`, exige chave secreta nova).

## D-083 · Exclusão a pedido feita pela equipe, não por botão

**Status:** Implementada (28/10/2026, pedido do streamer). O botão "Excluir meus dados" saiu da página do pedido. O espectador pede pelo chat (a política de privacidade diz isso) e o moderador clica em "Apagar dados" no pedido: mesmo efeito de D-076, com auditoria `exclusao_dados` e o autor. O direito de pedir a exclusão continua (LGPD art. 18): só mudou quem aperta o botão. **[ADVOGADO]** confirmar se o canal pelo chat basta.

---

## Registro de mudanças

| Data | Mudança |
|---|---|
| 27/10/2026 | Proposta inicial (D-001 a D-042) |
| 27/10/2026 | Aprovação de todas as recomendações; foto recebida e paleta definida (D-025); novos requisitos: prazo de 5 min (D-043), encerrar apaga tudo e leva para "Aguardando banca..." (D-044), moderador pode encerrar (D-045), beep ao assumir (D-046), tela inicial (D-047) |
| 27/10/2026 | Etapa 1: cadastro/anônimo no Auth (D-048), fixação de versões via CI (D-049), RLS sem FORCE (D-050), tsconfig (D-051), pasta de tema (D-052) |
| 27/10/2026 | Etapa 2: D-048 revisada (trigger no banco), D-053 a D-062 |
| 28/10/2026 | Etapa 3: D-063 a D-066 |
| 28/10/2026 | Etapa 4: D-008 verificada, D-067 a D-070 |
| 28/10/2026 | Etapa 5: D-071 a D-074 |
| 28/10/2026 | Etapa 6: D-075 a D-077 |
| 28/10/2026 | Etapa 7: D-078 a D-081 |
| 28/10/2026 | Pedido direto para o chat (D-082) e fila sem teto (D-032 revista) |
| 28/10/2026 | Exclusão a pedido pela equipe (D-083) |
