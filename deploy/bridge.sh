#!/bin/zsh
# Мостик рабочих событий: поднимает ssh-туннель к VDS, забирает очередь,
# пишет события через Calendar.app и глушит туннель. Запускается launchd раз в минуту.
set -euo pipefail

set -a; source ~/.config/blog-app/.env; set +a

TUNNEL_PORT=13060
ssh -o BatchMode=yes -o ConnectTimeout=8 -o ExitOnForwardFailure=yes \
  -p "${VPS_PORT:-22}" -L "${TUNNEL_PORT}:127.0.0.1:3060" "$VPS_USER@$VPS_HOST" -N &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
sleep 1

cd "$(dirname "$0")/.."
BRIDGE_BASE_URL="http://127.0.0.1:${TUNNEL_PORT}" npm run --silent bridge
