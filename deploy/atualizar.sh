#!/usr/bin/env bash
# Atualiza o site na VPS com a versão mais nova do GitHub (D-087).
#   bash deploy/atualizar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.yml ps
