# Buzzword Bingo — single container: Node web app + cloudflared, one tunnel.
# Multi-stage so better-sqlite3's native build tools stay out of the runtime image.

# ---- builder: compile deps (incl. native better-sqlite3) ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM node:20-bookworm-slim
ARG CLOUDFLARED_VERSION=2024.12.2
ARG TARGETARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" \
      -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js db.js bingo.js buzzwords.js ./
COPY public ./public
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

ENV PORT=3200 \
    NODE_ENV=production \
    DATA_DIR=/data
EXPOSE 3200
VOLUME ["/data"]
USER node

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD curl -sf -o /dev/null http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "./entrypoint.sh"]
