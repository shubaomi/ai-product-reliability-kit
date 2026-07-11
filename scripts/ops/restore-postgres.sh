#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

BACKUP_FILE="${BACKUP_FILE:-}"
RESTORE_DATABASE_URL="${RESTORE_DATABASE_URL:-}"
RESTORE_CONFIRM_DATABASE="${RESTORE_CONFIRM_DATABASE:-}"
RESTORE_ALLOW_DESTRUCTIVE="${RESTORE_ALLOW_DESTRUCTIVE:-NO}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"

while (( $# )); do
    case "$1" in
        --backup) BACKUP_FILE="${2:-}"; shift 2 ;;
        --target-url) RESTORE_DATABASE_URL="${2:-}"; shift 2 ;;
        --confirm-database) RESTORE_CONFIRM_DATABASE="${2:-}"; shift 2 ;;
        --allow-destructive) RESTORE_ALLOW_DESTRUCTIVE="YES"; shift ;;
        *) ops_die "Unknown restore option: $1" ;;
    esac
done

[[ "$RESTORE_ALLOW_DESTRUCTIVE" == "YES" ]] || ops_die "Set RESTORE_ALLOW_DESTRUCTIVE=YES or pass --allow-destructive"
[[ -n "$BACKUP_FILE" ]] || ops_die "A backup file is required"
[[ -n "$RESTORE_DATABASE_URL" ]] || ops_die "RESTORE_DATABASE_URL is required"
[[ -n "$RESTORE_CONFIRM_DATABASE" ]] || ops_die "RESTORE_CONFIRM_DATABASE is required"
ops_validate_postgres_url "$RESTORE_DATABASE_URL"
ops_validate_identifier "RESTORE_CONFIRM_DATABASE" "$RESTORE_CONFIRM_DATABASE"
ops_require_command "$PG_RESTORE_BIN"
ops_require_command "$PSQL_BIN"

PG_RESTORE_BIN="$PG_RESTORE_BIN" bash "$SCRIPT_DIR/verify-backup.sh" "$BACKUP_FILE"
export PGDATABASE="$RESTORE_DATABASE_URL"
actual_database="$("$PSQL_BIN" --no-psqlrc --tuples-only --no-align --command 'select current_database()')"
actual_database="${actual_database//$'\r'/}"
actual_database="${actual_database//$'\n'/}"
[[ "$actual_database" == "$RESTORE_CONFIRM_DATABASE" ]] || ops_die "Restore confirmation mismatch: connected to '$actual_database'"

"$PG_RESTORE_BIN" --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction "$BACKUP_FILE"
"$PSQL_BIN" --no-psqlrc --set ON_ERROR_STOP=1 --command 'select 1' >/dev/null
printf 'Restore completed and connection verified for database: %s\n' "$actual_database"
