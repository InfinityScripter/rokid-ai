#!/bin/zsh
# Деплой бота на VDS одной командой: проверка типов → rsync src и манифестов →
# зависимости → перезапуск systemd-юнита rokid-ai → проверка, что бот жив.
# Реквизиты VDS — те же, что у блога: ~/.config/blog-app/.env
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source ~/.config/blog-app/.env; set +a
PORT="${VPS_PORT:-22}"
HOST="$VPS_USER@$VPS_HOST"

echo "→ проверка типов"
npm run --silent ts

echo "→ тесты"
npm test --silent

echo "→ копирую src/ и манифесты на VDS"
rsync -rtc --delete -e "ssh -p $PORT" src/ "$HOST:/opt/rokid-ai/src/"
rsync -rtc -e "ssh -p $PORT" package.json package-lock.json "$HOST:/opt/rokid-ai/"

echo "→ зависимости на VDS (быстро, если ничего не менялось)"
ssh -p "$PORT" "$HOST" 'cd /opt/rokid-ai && npm install --omit=dev --no-audit --no-fund --loglevel=error'

echo "→ перезапуск rokid-ai"
ssh -p "$PORT" "$HOST" '
  systemctl restart rokid-ai
  sleep 3
  if systemctl -q is-active rokid-ai; then
    echo "юнит поднялся, последние строки лога:"
    journalctl -u rokid-ai -n 5 --no-pager
  else
    echo "❌ юнит НЕ поднялся, лог падения:"
    journalctl -u rokid-ai -n 30 --no-pager
    exit 1
  fi
'
echo "✅ бот на VDS обновлён и работает"
