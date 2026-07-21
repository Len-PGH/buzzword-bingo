#!/bin/sh
# Buzzword Bingo — boot the web app, open a cloudflared tunnel, hand the public
# URL back to the app (for the join QR). One container, one public URL.
set -eu

PORT="${PORT:-3000}"

echo "[bb] starting web app on :${PORT}"
node server.js &

# Wait for the app to be healthy.
i=0; while [ "$i" -lt 40 ]; do curl -sf -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null && break; i=$((i+1)); sleep 0.5; done
echo "[bb] web app up"

if [ "${NO_TUNNEL:-0}" = "1" ]; then
  echo "[bb] NO_TUNNEL=1 — LAN only, no public URL"
  wait
  exit 0
fi

publish() {
  echo "======================================================================"
  echo "  PUBLIC URL (players join here):  $1"
  echo "======================================================================"
  curl -sf -o /dev/null -X POST -H "Content-Type: application/json" \
    --data "{\"url\":\"$1\"}" "http://127.0.0.1:${PORT}/api/public-url" \
    && echo "[bb] posted public url to app" \
    || echo "[bb] warn: could not post public url"
}

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  # Stable NAMED tunnel — hostname/ingress configured in the Cloudflare dashboard.
  echo "[bb] starting NAMED cloudflared tunnel (stable URL)…"
  cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
  if [ -n "${PUBLIC_URL:-}" ]; then
    sleep 3
    publish "$PUBLIC_URL"
  else
    echo "[bb] WARN: TUNNEL_TOKEN set but PUBLIC_URL missing — set it to your hostname (https://…)"
  fi
  wait
  exit 0
fi

echo "[bb] starting cloudflared quick tunnel…"
cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" 2>/tmp/cf.log &
url=""
i=0
while [ "$i" -lt 40 ]; do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf.log 2>/dev/null | head -1 || true)
  [ -n "$url" ] && break
  i=$((i + 1)); sleep 1
done
if [ -n "$url" ]; then publish "$url"; else echo "[bb] WARN: no tunnel URL captured"; fi

wait
