#!/usr/bin/env bash
# Creates a compressed backup of the database in ./backups and keeps the latest 14.
# Usage:  npm run backup
# Restore: gunzip -c backups/agent-YYYYMMDD-HHMM.sql.gz | psql "$DATABASE_URL"
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
mkdir -p backups
FILE="backups/agent-$(TZ=Australia/Melbourne date +%Y%m%d-%H%M).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$FILE"
ls -1t backups/agent-*.sql.gz | tail -n +15 | xargs -r rm --
echo "Backup saved to $FILE"
