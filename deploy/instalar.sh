#!/usr/bin/env bash
# =====================================================================
# Instala o site na VPS (Ubuntu 24.04) com Docker + Cloudflare Tunnel (D-087).
# Rode como root, de dentro da pasta do repositório:
#   bash deploy/instalar.sh
# Pode rodar de novo sem problema: o que já está feito é pulado.
# Nenhum segredo é mostrado na tela nem gravado no repositório.
# =====================================================================
set -euo pipefail

DOMINIO="${DOMINIO:-bigbancas.com}"
PASTA_SEGREDOS=/etc/bancas
ENV_APP="$PASTA_SEGREDOS/bancas.env"
ENV_TUNEL="$PASTA_SEGREDOS/tunel.env"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

passo() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode como root (no terminal da Hostinger você já é root)."; exit 1
fi

passo "1/6 Atualizando o sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl git nano ufw unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

passo "2/6 Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker já instalado."
else
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
  systemctl enable --now docker
  ok "Docker instalado."
fi

passo "3/6 Firewall: só SSH entra (o site chega pelo túnel da Cloudflare)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ok "Firewall ligado."

passo "4/6 Variáveis do site ($ENV_APP)"
install -d -m 700 "$PASTA_SEGREDOS"
if [ ! -s "$ENV_APP" ]; then
  cat > "$ENV_APP" <<'MODELO'
# APAGUE estas 3 linhas e COLE aqui todo o conteúdo do arquivo vercel.env.
# Depois: Ctrl+O, Enter (salvar) e Ctrl+X (sair).
# (O instalador ajusta sozinho DEPLOY_MODE e SITE_URL para a VPS.)
MODELO
  chmod 600 "$ENV_APP"
  echo "Vai abrir o editor. Cole o conteúdo do vercel.env, salve (Ctrl+O, Enter) e saia (Ctrl+X)."
  read -rp "Aperte Enter para abrir o editor... " _
  nano "$ENV_APP"
fi
if ! grep -q '^SUPABASE_URL=' "$ENV_APP"; then
  echo "O arquivo $ENV_APP não tem SUPABASE_URL. Rode o instalador de novo e cole o vercel.env."; exit 1
fi
# Ajustes da VPS: túnel da Cloudflare (IP real confiável) e o domínio próprio.
sed -i -E '/^(DEPLOY_MODE|SITE_URL|TRUSTED_PROXY_HOPS|ENABLE_EXPERIMENTAL_COREPACK)=/d' "$ENV_APP"
printf 'DEPLOY_MODE=tunnel\nSITE_URL=https://%s\n' "$DOMINIO" >> "$ENV_APP"
chmod 600 "$ENV_APP"
ok "Variáveis prontas (DEPLOY_MODE=tunnel, SITE_URL=https://$DOMINIO)."

passo "5/6 Token do túnel da Cloudflare ($ENV_TUNEL)"
if [ ! -s "$ENV_TUNEL" ]; then
  echo "Cole o token do túnel (o texto longo que começa com eyJ). Ele NÃO aparece na tela."
  read -rsp "Token: " TOKEN; echo
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  case "$TOKEN" in
    eyJ*) ;;
    *) echo "Isso não parece o token (deveria começar com eyJ). Rode de novo."; exit 1 ;;
  esac
  umask 077
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$ENV_TUNEL"
  unset TOKEN
fi
chmod 600 "$ENV_TUNEL"
ok "Token guardado."

passo "6/6 Construindo e ligando o site (a primeira vez leva uns 5 minutos)"
cd "$RAIZ"
docker compose -f deploy/docker-compose.yml up -d --build

echo "Esperando o site responder..."
for _ in $(seq 1 40); do
  estado="$(docker inspect -f '{{.State.Health.Status}}' bancas-app-1 2>/dev/null || echo '?')"
  [ "$estado" = "healthy" ] && break
  sleep 5
done
docker compose -f deploy/docker-compose.yml ps
if [ "${estado:-}" = "healthy" ]; then
  ok "Pronto! Abra https://$DOMINIO (se ainda não abrir, confira a rota do túnel na Cloudflare)."
else
  echo "O site ainda não respondeu. Mande um print desta tela."
  docker compose -f deploy/docker-compose.yml logs --tail 30 app | grep -v -i -E 'token|secret|key' || true
fi
