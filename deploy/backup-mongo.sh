#!/usr/bin/env bash
# Daily MongoDB + uploaded images backup, keeps 14 days. Installed by DEPLOYMENT.md step 11:
#   crontab -e  →  30 2 * * * <api repo>/deploy/backup-mongo.sh
# Reads MONGODB_URI and UPLOADS_DIR from the API .env next to this script.
set -euo pipefail
umask 077
API_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_value() { grep -E "^$1=" "$API_DIR/.env" | tail -n1 | cut -d= -f2- || true; }
DIR=/var/backups/miodoctors
mkdir -p "$DIR"
cd "$DIR"
URI=$(env_value MONGODB_URI)
[ -n "$URI" ] || { echo "MONGODB_URI missing in $API_DIR/.env"; exit 1; }
UPLOADS_DIR=$(env_value UPLOADS_DIR)
UPLOADS_DIR=${UPLOADS_DIR:-$(dirname "$API_DIR")/uploads}
STAMP=$(date +%F_%H%M)
mongodump --uri="$URI" --archive="$DIR/mio_doctors_$STAMP.gz" --gzip --quiet
# Refuse to keep an empty/corrupt archive
gzip -t "$DIR/mio_doctors_$STAMP.gz"
# Uploaded images (banners) — the database only stores their file names.
if [ -d "$UPLOADS_DIR" ]; then
  tar -czf "$DIR/mio_uploads_$STAMP.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
fi
find "$DIR" \( -name 'mio_doctors_*.gz' -o -name 'mio_uploads_*.tar.gz' \) -mtime +14 -delete
