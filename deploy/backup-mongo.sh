#!/usr/bin/env bash
# Daily MongoDB + uploaded images backup, keeps 14 days. Installed by DEPLOYMENT.md step 11:
#   crontab -e  →  30 2 * * * /var/www/miodoctors/backend/deploy/backup-mongo.sh
set -euo pipefail
DIR=/var/backups/miodoctors
mkdir -p "$DIR"
URI=$(grep '^MONGODB_URI=' /var/www/miodoctors/backend/.env | cut -d= -f2-)
STAMP=$(date +%F_%H%M)
mongodump --uri="$URI" --archive="$DIR/mio_doctors_$STAMP.gz" --gzip --quiet
# Uploaded images (banners) — the database only stores their file names.
if [ -d /var/www/miodoctors/uploads ]; then
  tar -czf "$DIR/mio_uploads_$STAMP.tar.gz" -C /var/www/miodoctors uploads
fi
find "$DIR" \( -name 'mio_doctors_*.gz' -o -name 'mio_uploads_*.tar.gz' \) -mtime +14 -delete
