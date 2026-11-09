#!/bin/sh
set -eu
umask 077
deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file=${COMPOSE_FILE:-"$deploy_dir/compose.local.yml"}
backup_dir=${BACKUP_DIR:-"$deploy_dir/../backups"}
mkdir -p "$backup_dir"
archive="$backup_dir/xiaomang-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
trap 'rm -f "$archive.partial"' EXIT HUP INT TERM
docker compose -f "$compose_file" exec -T mongo sh -c 'exec mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db "${MONGO_APP_DB:-xiaomang}" --archive --gzip' > "$archive.partial"
test -s "$archive.partial"
mv "$archive.partial" "$archive"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive" > "$archive.sha256"; else shasum -a 256 "$archive" > "$archive.sha256"; fi
if [ -n "${COS_BACKUP_URI:-}" ]; then
  coscli cp "$archive" "$COS_BACKUP_URI/$(basename "$archive")"
  coscli cp "$archive.sha256" "$COS_BACKUP_URI/$(basename "$archive.sha256")"
fi
# Retention applies only after a successful export and any configured remote upload.
find "$backup_dir" -type f -name 'xiaomang-*.archive.gz*' -mtime +7 -exec rm -f {} \;
printf '%s\n' "$archive"
