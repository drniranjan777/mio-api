#!/usr/bin/env bash
# One-time MongoDB setup on the server, driven by backend/.env:
#   bash /var/www/miodoctors/backend/deploy/setup-mongo-users.sh
#
# - mio_app password: taken from MONGODB_URI in .env; if it still says CHANGE_ME,
#   a strong one is generated and written into .env.
# - mongoAdmin password: generated and saved to /root/mongo-admin-password.txt
#   (root-only). Nothing is printed on screen.
# - Then turns on MongoDB authentication and checks the app can connect.
# Run it BEFORE authentication is enabled (fresh install). Safe to re-run: it
# stops if authentication is already on.
set -euo pipefail
ENV_FILE=/var/www/miodoctors/backend/.env

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — run: cp deploy/backend.env.production.example .env"; exit 1; }
chmod 600 "$ENV_FILE"

if grep -q '^ *authorization: *enabled' /etc/mongod.conf; then
  echo "MongoDB authentication is already enabled — users were created before. Nothing to do."
  exit 0
fi

URI=$(grep '^MONGODB_URI=' "$ENV_FILE" | cut -d= -f2-)
APP_PW=$(printf '%s' "$URI" | sed -nE 's#^mongodb://mio_app:([^@]+)@.*#\1#p')

if [ -z "$APP_PW" ] || [ "$APP_PW" = "CHANGE_ME" ]; then
  APP_PW=$(openssl rand -hex 24)
  NEW_URI="mongodb://mio_app:${APP_PW}@127.0.0.1:27017/mio_doctors?authSource=mio_doctors"
  sed -i "s#^MONGODB_URI=.*#MONGODB_URI=${NEW_URI}#" "$ENV_FILE"
  echo "• Generated a new mio_app password and saved it in .env"
else
  case "$APP_PW" in
    *[!A-Za-z0-9._~-]*) echo "The mio_app password in .env has special characters. Use letters and digits only (or set CHANGE_ME to generate one)."; exit 1 ;;
  esac
  echo "• Using the mio_app password already in .env"
fi

ADMIN_PW=$(openssl rand -hex 24)

# Passwords go through environment variables, not the command line.
APP_PW="$APP_PW" ADMIN_PW="$ADMIN_PW" mongosh --quiet --eval '
  db.getSiblingDB("admin").createUser({ user: "mongoAdmin", pwd: process.env.ADMIN_PW, roles: ["root"] });
  db.getSiblingDB("mio_doctors").createUser({
    user: "mio_app", pwd: process.env.APP_PW, roles: [{ role: "readWrite", db: "mio_doctors" }]
  });
'
printf '%s\n' "$ADMIN_PW" | sudo tee /root/mongo-admin-password.txt >/dev/null
sudo chmod 600 /root/mongo-admin-password.txt
echo "• Created users mongoAdmin and mio_app (mongoAdmin password: sudo cat /root/mongo-admin-password.txt)"

printf 'security:\n  authorization: enabled\n' | sudo tee -a /etc/mongod.conf >/dev/null
sudo systemctl restart mongod
sleep 3

URI=$(grep '^MONGODB_URI=' "$ENV_FILE" | cut -d= -f2-)
if mongosh "$URI" --quiet --eval 'db.runCommand({ ping: 1 }).ok' | grep -q 1; then
  echo "• Authentication is on and the API can connect with the credentials in .env"
else
  echo "✖ Could not connect with MONGODB_URI from .env — check: sudo systemctl status mongod"; exit 1
fi
