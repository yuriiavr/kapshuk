#!/usr/bin/env bash
# Розгортання на ноутбук із HA: інтерфейс збираємо тут, туди веземо сервер і збірку, залежності ставимо без dev.
# База на ноутбуці (~/.local/share/kapshuk) не чіпається.
set -euo pipefail
HOST=${KAPSHUK_HOST:-godos@192.168.31.94}
cd "$(dirname "$0")/.."

npm run build
tar -czf - package.json package-lock.json server dist deploy | ssh "$HOST" '
  set -e
  export PATH=/snap/node/current/bin:$PATH
  mkdir -p ~/kapshuk && cd ~/kapshuk && rm -rf server dist deploy && tar -xzf -
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  mkdir -p ~/.config/systemd/user && cp deploy/kapshuk.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable kapshuk >/dev/null 2>&1 || true
  systemctl --user restart kapshuk
  sleep 2
  systemctl --user is-active kapshuk
'
