#!/usr/bin/env bash
# Daily MongoDB backup, keeps 14 days. Installed by DEPLOYMENT.md step 11:
#   crontab -e  →  30 2 * * * /var/www/miodoctors/backend/deploy/backup-mongo.sh
set -euo pipefail
DIR=/var/backups/miodoctors
mkdir -p "$DIR"
URI=$(grep '^MONGODB_URI=' /var/www/miodoctors/backend/.env | cut -d= -f2-)
mongodump --uri="$URI" --archive="$DIR/mio_doctors_$(date +%F_%H%M).gz" --gzip --quiet
find "$DIR" -name 'mio_doctors_*.gz' -mtime +14 -delete
