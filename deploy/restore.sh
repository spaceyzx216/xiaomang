#!/bin/sh
set -eu
archive=${1:?Usage: restore.sh /absolute/path/to/backup.archive.gz}
test -s "$archive"
deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file=${COMPOSE_FILE:-"$deploy_dir/compose.local.yml"}
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$archive.sha256"; else shasum -a 256 -c "$archive.sha256"; fi
# Restore into an empty application database. Never use --drop against a live database.
docker compose -f "$compose_file" exec -T mongo sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '\''quit(db.getSiblingDB(process.env.MONGO_APP_DB || "xiaomang").getCollectionNames().length ? 2 : 0)'\'
docker compose -f "$compose_file" exec -T mongo sh -c 'exec mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --stopOnError' < "$archive"
