#!/usr/bin/env bash
# Run on the server as the "deploy" user:
#   bash <api repo>/deploy/deploy.sh          (pull + build + restart)
#   SKIP_PULL=1 bash <api repo>/deploy/deploy.sh
# Paths: the API repo is the one this script lives in. The admin repo defaults to
# a sibling folder named "admin"; set ADMIN_DIR in the API .env (or the
# environment) for another layout. Uploads go to UPLOADS_DIR from .env.
set -euo pipefail
API_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_value() { grep -E "^$1=" "$API_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
ADMIN_DIR=${ADMIN_DIR:-$(env_value ADMIN_DIR)}
ADMIN_DIR=${ADMIN_DIR:-$(dirname "$API_DIR")/admin}
UPLOADS_DIR=$(env_value UPLOADS_DIR)
UPLOADS_DIR=${UPLOADS_DIR:-$(dirname "$API_DIR")/uploads}
test -d "$ADMIN_DIR" || { echo "Admin repo not found at $ADMIN_DIR (set ADMIN_DIR in $API_DIR/.env)"; exit 1; }

if [ "${SKIP_PULL:-0}" != "1" ]; then
  echo "==> Pull latest code"
  git -C "$API_DIR" pull --ff-only
  git -C "$ADMIN_DIR" pull --ff-only
fi

echo "==> API dependencies"
cd "$API_DIR"
test -f .env || { echo "Missing $API_DIR/.env (cp deploy/backend.env.production.example .env)"; exit 1; }
chmod 600 .env
npm ci --omit=dev --no-audit --no-fund
mkdir -p "$UPLOADS_DIR"

echo "==> Database migrations"
npm run --silent migrate

echo "==> Admin panel build"
cd "$ADMIN_DIR"
npm ci --no-audit --no-fund
npm run build

echo "==> Restart API"
cd "$API_DIR"
# Fork ↔ cluster (REDIS_URL added/removed) can't be changed by a reload: PM2 keeps
# the old mode. Recreate the process once in that case (a few seconds offline).
WANT_MODE=$(node -p "require('./ecosystem.config.cjs').apps[0].exec_mode + '_mode'")
HAVE_MODE=$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s||'[]').find(a=>a.name==='mio-api');console.log(p?p.pm2_env.exec_mode:'')})")
if [ -n "$HAVE_MODE" ] && [ "$HAVE_MODE" != "$WANT_MODE" ]; then
  echo "    switching mio-api from $HAVE_MODE to $WANT_MODE"
  pm2 delete mio-api
fi
pm2 startOrReload ecosystem.config.cjs
pm2 save

echo "==> Health check"
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:4000/api/v1/health >/dev/null; then echo "API is up"; exit 0; fi
  sleep 2
done
echo "API did not respond — check: pm2 logs mio-api --lines 50"; exit 1
