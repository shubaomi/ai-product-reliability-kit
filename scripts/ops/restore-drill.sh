#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

BACKUP_FILE="${BACKUP_FILE:-}"
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-}"
DRILL_VERIFY_SQL="${DRILL_VERIFY_SQL:-select 1}"
CREATEDB_BIN="${CREATEDB_BIN:-createdb}"
DROPDB_BIN="${DROPDB_BIN:-dropdb}"
PSQL_BIN="${PSQL_BIN:-psql}"

while (( $# )); do
    case "$1" in
        --backup) BACKUP_FILE="${2:-}"; shift 2 ;;
        --admin-url) DATABASE_ADMIN_URL="${2:-}"; shift 2 ;;
        --verify-sql) DRILL_VERIFY_SQL="${2:-}"; shift 2 ;;
        *) ops_die "Unknown restore-drill option: $1" ;;
    esac
done

[[ -n "$BACKUP_FILE" ]] || ops_die "A backup file is required"
[[ -n "$DATABASE_ADMIN_URL" ]] || ops_die "DATABASE_ADMIN_URL is required"
ops_validate_postgres_url "$DATABASE_ADMIN_URL"
ops_require_command "$CREATEDB_BIN"
ops_require_command "$DROPDB_BIN"
ops_require_command "$PSQL_BIN"
ops_require_command node

bash "$SCRIPT_DIR/verify-backup.sh" "$BACKUP_FILE"
drill_database="apr_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
ops_validate_identifier "drill database" "$drill_database"

cleanup_drill() {
    local status="$1"
    trap - EXIT
    set +e
    PGDATABASE="$DATABASE_ADMIN_URL" "$DROPDB_BIN" --if-exists "$drill_database" >/dev/null
    exit "$status"
}
trap 'cleanup_drill "$?"' EXIT

PGDATABASE="$DATABASE_ADMIN_URL" "$CREATEDB_BIN" "$drill_database"
target_url="$(APR_ADMIN_URL="$DATABASE_ADMIN_URL" APR_DRILL_DATABASE="$drill_database" node -e '
const url = new URL(process.env.APR_ADMIN_URL);
url.pathname = `/${process.env.APR_DRILL_DATABASE}`;
url.hash = "";
process.stdout.write(url.toString());
')"

BACKUP_FILE="$BACKUP_FILE" \
RESTORE_DATABASE_URL="$target_url" \
RESTORE_CONFIRM_DATABASE="$drill_database" \
RESTORE_ALLOW_DESTRUCTIVE=YES \
bash "$SCRIPT_DIR/restore-postgres.sh"

PGDATABASE="$target_url" "$PSQL_BIN" --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --command "$DRILL_VERIFY_SQL" >/dev/null
trap - EXIT
PGDATABASE="$DATABASE_ADMIN_URL" "$DROPDB_BIN" --if-exists "$drill_database" >/dev/null
printf 'Restore drill completed and disposable database removed: %s\n' "$drill_database"
