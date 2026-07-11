#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

BACKUP_FILE="${BACKUP_FILE:-${1:-}}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
SHA256SUM_BIN="${SHA256SUM_BIN:-sha256sum}"

[[ -n "$BACKUP_FILE" ]] || ops_die "Set BACKUP_FILE or pass a backup path"
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || ops_die "Backup must be a regular non-symlink file: $BACKUP_FILE"
[[ -s "$BACKUP_FILE" ]] || ops_die "Backup is empty: $BACKUP_FILE"
[[ -f "$BACKUP_FILE.sha256" && ! -L "$BACKUP_FILE.sha256" ]] || ops_die "Missing backup checksum: $BACKUP_FILE.sha256"
ops_require_command "$PG_RESTORE_BIN"
ops_require_command "$SHA256SUM_BIN"

backup_dir="$(cd "$(dirname "$BACKUP_FILE")" && pwd)"
backup_name="$(basename "$BACKUP_FILE")"
(cd "$backup_dir" && "$SHA256SUM_BIN" --check --status "$backup_name.sha256") || ops_die "Backup checksum verification failed"
archive_list="$("$PG_RESTORE_BIN" --list "$BACKUP_FILE")" || ops_die "pg_restore could not read the backup archive"
[[ -n "$archive_list" ]] || ops_die "Backup archive contains no restorable entries"

printf 'Backup verified: %s\n' "$BACKUP_FILE"
