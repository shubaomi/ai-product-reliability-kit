#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/data/prod/ai-product-reliability-kit/shared/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_LABEL="${BACKUP_LABEL:-predeploy}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
SHA256SUM_BIN="${SHA256SUM_BIN:-sha256sum}"

[[ -n "$DATABASE_URL" ]] || ops_die "DATABASE_URL is required"
ops_validate_postgres_url "$DATABASE_URL"
ops_validate_identifier "BACKUP_LABEL" "$BACKUP_LABEL"
ops_require_positive_integer "BACKUP_RETENTION_DAYS" "$BACKUP_RETENTION_DAYS"
ops_require_command "$PG_DUMP_BIN"
ops_require_command "$PG_RESTORE_BIN"
ops_require_command "$SHA256SUM_BIN"

umask 077
mkdir -p "$BACKUP_DIR"
resolved_backup_dir="$(readlink -f -- "$BACKUP_DIR")"
[[ -n "$resolved_backup_dir" && "$resolved_backup_dir" != "/" ]] || ops_die "Refusing unsafe backup directory: $BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$resolved_backup_dir/apr-${BACKUP_LABEL}-${timestamp}-$$.dump"
partial_path="$final_path.partial"
trap 'rm -f -- "$partial_path"' ERR INT TERM

export PGDATABASE="$DATABASE_URL"
"$PG_DUMP_BIN" --format=custom --no-owner --no-privileges --file "$partial_path"
"$PG_RESTORE_BIN" --list "$partial_path" >/dev/null
mv -f -- "$partial_path" "$final_path"
(cd "$resolved_backup_dir" && "$SHA256SUM_BIN" "$(basename "$final_path")") > "$final_path.sha256"
chmod 600 "$final_path" "$final_path.sha256"
trap - ERR INT TERM

BACKUP_DIR="$resolved_backup_dir" BACKUP_RETENTION_DAYS="$BACKUP_RETENTION_DAYS" bash "$SCRIPT_DIR/prune-backups.sh"
printf 'BACKUP_FILE=%s\n' "$final_path"
