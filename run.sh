#!/usr/bin/env bash
# Build + run Buzzword Bingo — one container (web app + cloudflared tunnel).
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="buzzword-bingo"
NAME="buzzword-bingo"

# First run: create .env with a random operator key.
if [[ ! -f .env ]]; then
  echo "==> No .env — creating from .env.example"
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then KEY="$(openssl rand -hex 16)"; else KEY="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  sed -i.bak "s/^OPERATOR_KEY=.*/OPERATOR_KEY=$KEY/" .env && rm -f .env.bak
  echo "    generated OPERATOR_KEY=$KEY"
fi

PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]')"; PORT="${PORT:-3000}"

echo "==> Building $IMAGE…"
docker build -t "$IMAGE" .
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "==> Starting:"
echo "    Play      http://localhost:${PORT}/"
echo "    Operator  http://localhost:${PORT}/operator   (key in .env)"
echo
# Named volume keeps the SQLite DB across restarts.
exec docker run --rm --name "$NAME" \
  --env-file .env \
  -p "${PORT}:${PORT}" \
  -v buzzword-bingo-data:/data \
  "$IMAGE"
