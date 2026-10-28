# syntax=docker/dockerfile:1
# =====================================================================
# Bancas do Pitchula: imagem de produção (modo 2 do README: VPS + Docker)
# - multi-stage: ferramentas de build não vão para a imagem final;
# - roda como usuário sem privilégio (uid 10001), sem shell de login;
# - nenhuma variável de ambiente entra na imagem: tudo é lido em tempo de
#   execução (docker run --env-file). Nunca copie .env para a imagem.
# =====================================================================
ARG NODE_VERSION=26.12.1

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.15.0 && npm cache clean --force
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=root:root /app/.next/standalone ./
# Código só leitura para o usuário da aplicação; só o cache de imagens é gravável.
RUN mkdir -p .next/cache && chown app:app .next/cache
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/privacidade').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
