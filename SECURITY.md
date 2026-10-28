# Segurança

Este documento diz **onde estão os segredos, como trocá-los e o que fazer num incidente**. O desenho das proteções está em [`ARCHITECTURE.md`](ARCHITECTURE.md) (§4 permissões, §6 criptografia, §7 modelo de ameaças, §8 cabeçalhos) e as escolhas em [`DECISIONS.md`](DECISIONS.md).

Nada aqui garante imunidade a ataques ou conformidade legal. São medidas para reduzir riscos, testadas no CI, com os riscos que sobram listados abaixo.

## Como avisar sobre uma falha

Fale **em particular** com o streamer (não abra issue pública nem comente na live). Diga o que viu, onde e como reproduzir. Não teste com dados de outras pessoas.

## Segredos

| Segredo | Onde fica | O que acontece se vazar | Como trocar |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Só no servidor do app | Leitura e escrita de todo o banco (os dados pessoais continuam cifrados) | Supabase → API → gerar nova → atualizar a variável → reiniciar |
| `DATA_ENC_KEYS` | Só no servidor do app (+ cópia no seu cofre de senhas) | Com um dump do banco, decifra nome, CPF, Pix e ID dos pedidos abertos | "Rotação da chave de cifra" |
| `HMAC_KEYS` | Só no servidor do app (+ cofre) | Permite testar se um CPF/Pix/IP está banido ou repetido | "Rotação da chave HMAC" |
| `LIMPEZA_SECRET` | Servidor do app + Vault do Supabase | Alguém dispara a limpeza (só apaga o que já está na fila) | Gerar novo, trocar nos dois lugares |
| `TURNSTILE_SECRET_KEY` | Servidor do app + Supabase (Captcha) | Bots passam pelo Turnstile | Cloudflare → Turnstile → rotacionar → trocar nos dois lugares |
| `UPSTASH_REDIS_REST_TOKEN` | Servidor do app | Alguém apaga os contadores (rate limit) | Upstash → Reset password/token → trocar |
| Senha + autenticador do staff | Cada pessoa | Conta tomada (ainda precisa do código do app autenticador) | Streamer: Equipe → resetar MFA; a pessoa troca a senha |

Regras: nada de segredo em código, em print, em canal da live ou no chat. `.env` real nunca vai para o Git (o `.gitignore` e o `.dockerignore` bloqueiam). Logs têm lista de campos permitidos: valores sensíveis nunca chegam a eles.

## Rotação da chave de cifra (`DATA_ENC_KEYS`)

1. Gere a nova chave: `openssl rand -base64 32`.
2. Adicione como próxima versão **sem ativar**: `{"1":"<antiga>","2":"<nova>"}`, `DATA_ENC_ACTIVE=1`. Reinicie.
3. Ative: `DATA_ENC_ACTIVE=2`. Reinicie. Pedidos novos já saem com `v2:`.
4. Re-cifre o que já existe: `DB_URL=<conexão direta> DATA_ENC_KEYS=... DATA_ENC_ACTIVE=2 pnpm rotate:data`. Pode interromper e rodar de novo; mostra só contagens e grava `rotacao_chave` na auditoria.
5. Quando o script disser "ainda em versão antiga: 0", remova a versão 1 de `DATA_ENC_KEYS` e reinicie.

Como os pedidos somem no encerramento (no máximo 7 dias), outra saída é ativar a nova e esperar todas as bancas antigas encerrarem antes de remover a antiga.

## Rotação da chave HMAC (`HMAC_KEYS`)

Os bans guardam só o HMAC e não dá para recalcular sem o dado original. Por isso:

1. Adicione a nova versão e ative (`HMAC_ACTIVE=2`). As checagens de duplicidade e de banimento comparam com **todas** as versões presentes (D-013).
2. Mantenha a versão antiga enquanto houver ban ativo criado com ela: `select count(*) from app.bans where hmac_key_version = 1 and lifted_at is null;`. Bans de IP expiram em até 7 dias; os demais, na revisão anual (D-020).
3. Com a contagem em zero e nenhuma banca aberta de antes da troca, remova a versão antiga.

## Incidente: o que fazer

1. **Conta do staff suspeita:** Painel → Sessões → derrubar as sessões; Equipe → remover ou resetar MFA. Funciona na hora (o banco confere a sessão em toda chamada).
2. **Dado sendo exposto ao vivo:** `Alt+Q` esconde o painel; feche a cena no OBS.
3. **Suspeita de vazamento do servidor ou das chaves:** troque `SUPABASE_SERVICE_ROLE_KEY`, `DATA_ENC_KEYS` (rotação acima), `HMAC_KEYS` e `LIMPEZA_SECRET`; derrube todas as sessões; encerre as bancas abertas (apaga os pedidos).
4. **Banco mexido por fora:** Painel → Auditoria mostra se a cadeia de hash quebrou e a partir de qual registro (D-019).
5. **Dependência fora do ar:** login, pedido e upload ficam bloqueados de propósito e voltam sozinhos. Não desligue as proteções para "liberar".
6. Registre o que aconteceu, o que foi afetado e o que foi feito. Vazamento de dado pessoal pode exigir comunicação à ANPD e aos titulares: confirme com o advogado.

## O que o CI confere em toda mudança

- Lint (sem `dangerouslySetInnerHTML`, sem `style` inline, sem `console`), TypeScript estrito.
- Vitest com Supabase e Redis reais: login, MFA, convites, sessões, pedido, cifra, tempo real (canais de outros pedidos recusados), concorrência no pagamento, upload malicioso, encerramento apagando o arquivo do Storage, dependências fora do ar.
- pgTAP: RLS em todas as tabelas, privilégios mínimos por papel, transições de estado, travas, auditoria append-only.
- Playwright no build de produção: fluxos do espectador e do painel, acessibilidade (axe), CSP sem violações, cabeçalhos de segurança, CSRF.
- `pnpm audit --audit-level high` e build da imagem Docker (usuário não-root).

## Riscos que sobram

Ver `ARCHITECTURE.md` §7, coluna "Risco residual". Os principais:

- **Servidor do app comprometido** dá acesso aos dados enquanto durar (as chaves ficam nele).
- **Modo de deploy gerenciado:** as regras por IP podem ser contornadas por quem chegar direto na origem.
- **Phishing em tempo real** do código do autenticador (sem WebAuthn). O Cloudflare Access reduz isso.
- **Backups do Supabase** guardam dados já apagados até expirarem.
- **Moderador com modo live desligado** vê os dados dos pedidos que atende (fica na auditoria).
