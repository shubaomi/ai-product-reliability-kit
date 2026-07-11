#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

BACKUP_DIR="${BACKUP_DIR:-/data/prod/ai-product-reliability-kit/shared/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

ops_require_positive_integer "BACKUP_RETENTION_DAYS" "$BACKUP_RETENTION_DAYS"
[[ -d "$BACKUP_DIR" ]] || exit 0

resolved_backup_dir="$(readlink -f -- "$BACKUP_DIR")"
[[ -n "$resolved_backup_dir" && "$resolved_backup_dir" != "/" ]] || ops_die "Refusing unsafe backup directory: $BACKUP_DIR"

while IFS= read -r -d '' backup; do
    rm -f -- "$backup" "$backup.sha256"
done < <(find "$resolved_backup_dir" -maxdepth 1 -type f -name 'apr-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -print0)
