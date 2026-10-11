# syntax=docker/dockerfile:1
# Main node images, built from the repository root:
#   docker build -f deploy/docker/Dockerfile --target main  .
#   docker build -f deploy/docker/Dockerfile --target caddy .
# Native modules (better-sqlite3, argon2) compile in the build stage on the
# same Debian and Node as the runtime stage, for the architecture being built.
ARG NODE_VERSION=24.12.0
ARG CADDY_VERSION=2.10.2

FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
  && pnpm --filter @willcord/server deploy --prod --legacy /out/apps/server \
  && cp -R migrations /out/migrations

# The Node process is PID 1 and receives SIGTERM directly: it closes
# connections, the database and the data directory lock (main.lock).
FROM node:${NODE_VERSION}-bookworm-slim AS main
ENV NODE_ENV=production \
    DATA_DIR=/var/lib/willcord \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /out /opt/willcord
RUN install -d -o node -g node -m 0700 /var/lib/willcord
USER node
WORKDIR /opt/willcord/apps/server
VOLUME /var/lib/willcord
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM caddy:${CADDY_VERSION} AS caddy
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv/web
