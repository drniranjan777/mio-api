#!/usr/bin/env bash
# Run on the server as the "deploy" user:
#   bash /var/www/miodoctors/backend/deploy/deploy.sh          (pull + build + restart)
#   SKIP_PULL=1 bash /var/www/miodoctors/backend/deploy/deploy.sh
set -euo pipefail
APP=/var/www/miodoctors

if [ "${SKIP_PULL:-0}" != "1" ]; then
  echo "==> Pull latest code"
  git -C "$APP/backend" pull --ff-only
  git -C "$APP/admin" pull --ff-only
fi

echo "==> API dependencies"
cd "$APP/backend"
test -f .env || { echo "Missing $APP/backend/.env (cp deploy/backend.env.production.example .env)"; exit 1; }
chmod 600 .env
npm ci --omit=dev --no-audit --no-fund
mkdir -p "$APP/uploads"

echo "==> Database migrations"
npm run --silent migrate

echo "==> Admin panel build"
cd "$APP/admin"
npm ci --no-audit --no-fund
npm run build

echo "==> Restart API"
cd "$APP/backend"
pm2 startOrReload ecosystem.config.cjs
pm2 save

echo "==> Health check"
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:4000/api/v1/health >/dev/null; then echo "API is up"; exit 0; fi
  sleep 2
done
echo "API did not respond — check: pm2 logs mio-api --lines 50"; exit 1
