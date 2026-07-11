# Production Deployment

The supported production topology is PM2 behind Nginx with Postgres. Docker Compose remains useful for local integration only; it is not the production release mechanism.

## Fixed Production Topology

```text
domain:      reliability.hihongrun.com
listen:      127.0.0.1:8787
source:      /data/claude_project/ai-product-reliability-kit
production:  /data/prod/ai-product-reliability-kit
env file:    /data/prod/ai-product-reliability-kit/.env.production
PM2 API:     ai-product-reliability-kit
PM2 worker:  ai-product-reliability-worker
```

The production directory is organized as:

```text
/data/prod/ai-product-reliability-kit/
├── .env.production
├── current -> releases/<active-release>
├── previous -> releases/<previous-release>
├── releases/
│   └── <UTC timestamp>-<git SHA>/
└── shared/
    └── backups/
```

Release contents are prepared before activation and are not edited in place afterward. `current` is replaced atomically. The one documented exception is a `.deploy-failed` diagnostic marker written into a failed release; it makes that release ineligible for manual rollback. `deploy/ecosystem.config.cjs` keeps one API process on `current/apps/dashboard/server.mjs` and one independent worker on `current/apps/dashboard/worker.mjs`. The worker uses the PostgreSQL scheduler lease, so a transient duplicate cannot execute the scheduler concurrently.

## Manual One-Time Preparation

These steps require an authorized operator. The deployment script does not install packages, modify Nginx, create the Postgres role/database, install cron, or activate an external monitoring provider.

1. Install Node.js 22, npm, PM2, Nginx, rsync, PostgreSQL client tools, and `sha256sum` on the Linux host.
2. Create the Postgres database and a least-privilege application role. Provision the required `pgcrypto` extension through an authorized database owner before relying on the application role for migrations.
3. Create the production directories and restrict ownership:

   ```bash
   sudo install -d -m 0750 -o apr -g apr /data/prod/ai-product-reliability-kit
   sudo install -d -m 0750 -o apr -g apr /data/prod/ai-product-reliability-kit/shared/backups
   sudo install -m 0640 -o apr -g apr /dev/null /var/log/ai-product-reliability-backup.log
   ```

4. Create `/data/prod/ai-product-reliability-kit/.env.production` as a regular file owned by the service account with mode `0600`. Populate at least:

   ```dotenv
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=8787
   PUBLIC_BASE_URL=https://reliability.hihongrun.com
   DATABASE_URL=postgresql://...
   APR_STORE_MODE=postgres
   APR_AUTH_REQUIRED=true
   APR_ADMIN_EMAIL=...
   APR_ADMIN_PASSWORD_HASH='pbkdf2_sha256$210000$...$...'
   APR_MASTER_API_KEY=...
   APR_INGEST_API_KEY=...
   APR_SESSION_SECRET=...
   APR_USER_ID_HMAC_SECRET=...
   APR_TRUSTED_PROXIES=127.0.0.1
   ```

   `APR_PROCESS_ROLE` and `APR_WORKER_ENABLED` are set per process by the PM2 ecosystem file; do not put one shared process role in `.env.production`.
   Quote the generated password hash so the shell does not expand its `$` separators. All API/session/HMAC secrets must be distinct.

   `APR_INGEST_API_KEY` is the platform-wide ingest boundary required for controlled migration/operations. Product applications do not share it. Register each product and store its reveal-once ingest-only key in that application's secret manager under an application-owned name such as `APR_PRODUCT_API_KEY`.

5. Copy the complete Nginx configuration from `docs/nginx-hihongrun-production.conf`, run `nginx -t`, then reload Nginx only after syntax validation succeeds.

Do not keep `.env`, `.env.local`, or `.env.production` in the source checkout. The deploy script refuses local `.env` and `.env.local` files and excludes all secret env files from releases.
The safe `.env.example` template is retained. Production execution always forces `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=8787`, `APR_STORE_MODE=postgres`, and `APR_AUTH_REQUIRED=true`, even if the protected env file contains different values.

## Optional Production Settings

Defaults come from `apps/dashboard/src/config.mjs`. Review them rather than copying arbitrary tuning from another service.

| Variable | Default | Operational/security effect |
| --- | --- | --- |
| `APR_CORS_ORIGINS` | empty | Exact origins allowed for browser CORS and CSP connect sources. Keep empty unless a reviewed browser origin needs API access. |
| `APR_MONITOR_HOST_ALLOWLIST` | empty | Explicit hostname exceptions to normal DNS/private-address SSRF rejection. An entry bypasses that network-address rejection, so add only reviewed targets. URLs are still revalidated immediately before fetch. |
| `APR_ALLOWED_ENVIRONMENTS` | `production,staging,development,local,test` | Collector and registry environment allowlist. Narrow it if production policy does not accept all defaults. |
| `APR_MAX_BODY_BYTES` | `524288` | HTTP request-body ceiling; Nginx also uses `client_max_body_size 512k`. |
| `APR_MAX_BATCH_SIZE` | `500` | Maximum telemetry items per ingest request. |
| `APR_MAX_STRING_LENGTH` | `4096` | General nested telemetry string limit. |
| `APR_MAX_PRODUCT_ID_LENGTH` | `128` | API product-ID ceiling; formal `product.yml` has the stricter schema pattern. |
| `APR_MAX_CLOCK_SKEW_SECONDS` | `300` | Maximum accepted future timestamp skew. |
| `APR_MAX_PAST_EVENT_AGE_SECONDS` | `604800` | Maximum raw telemetry age accepted at ingest. |
| `APR_RATE_LIMIT_WINDOW_MS` | `60000` | Window shared by the separate general, login, and ingest buckets. |
| `APR_RATE_LIMIT_MAX` | `600` | General requests per client/window. |
| `APR_LOGIN_RATE_LIMIT_MAX` | `20` | Login attempts per client/window. |
| `APR_INGEST_RATE_LIMIT_MAX` | `600` | Ingest/compliance writes per client/window. |
| `APR_WORKER_INTERVAL_MS` | `60000` | Worker wake-up cadence; each monitor's own interval still controls whether it is due. |
| `APR_RETENTION_INTERVAL_MS` | `86400000` | Frequency at which the worker attempts retention under the advisory lease. |
| `APR_RAW_RETENTION_DAYS` | `30` | Raw event/error/health/monitor/delivery retention before transactional rollup and deletion. |
| `APR_TELEMETRY_STALE_SECONDS` | `300` | Default freshness horizon used by operational state. |
| `APR_GRACEFUL_SHUTDOWN_MS` | `30000` | API drain deadline before PM2 may force connection closure; PM2 `kill_timeout` is 35 seconds. |
| `APR_INCIDENT_LOOKBACK_HOURS` | `24` | Evidence window used for generated incident packages. |
| `APR_ALERT_WEBHOOK_URL` | empty | Generic alert/recovery webhook. Production requires HTTPS when set. |
| `APR_ALERT_FEISHU_WEBHOOK_URL` | empty | Existing Feishu alert/recovery boundary. Production requires HTTPS when set; no additional provider list is implied. |

`APR_PROCESS_ROLE` and `APR_WORKER_ENABLED` are intentionally absent from this tuning table because the PM2 ecosystem owns them independently for API and Worker.

## Upgrade-Safety Review

The migration runner applies four ordered files. Migration 003 converts legacy free-form alert rows only into a disabled compatibility representation. It preserves the original condition and writes `config.migration_advice`; review and recreate each rule with an explicit environment and supported structured type. Do not simply enable the migrated row.

Migration 004 introduces replay protection keyed by `product_id + environment + idempotency_key` for every telemetry type, preserves legacy event writes through a compatibility trigger, backfills alert-instance rule types, archives duplicate legacy status pages before adding one-row-per-product uniqueness, and adds retention indexes. These are forward-only changes; verify them on a copy/CI service and retain compatibility with the previous application release before production deployment.

## Atomic Deployment

From the source checkout:

```bash
cd /data/claude_project/ai-product-reliability-kit
chmod +x deploy.sh rollback.sh scripts/ops/*.sh
./deploy.sh
```

`deploy.sh` performs these steps in order:

1. Acquires the shared deploy/rollback lock, validates paths, required commands, identifiers, the env file, and required values.
2. Creates a new preparation directory under `releases/` and rsyncs source into it without secrets or runtime data; it becomes an activated release only after dependency install, backup, migration, and `.release-ready` preparation succeed.
3. Runs `npm ci --omit=dev` for the Standard package and Dashboard.
4. Creates a custom-format `pg_dump`, verifies it with `pg_restore --list`, and writes a SHA-256 checksum.
5. Runs forward-only, backward-compatible migrations from the new release.
6. Atomically switches `current` to the new release.
7. Reloads both PM2 ecosystem processes with updated environment. A first deployment or API/worker migration uses `startOrReload` only when one of the named processes is not registered; later releases use `pm2 reload`.
8. Requires both `http://127.0.0.1:8787/healthz` and `/readyz` to return success, then requires exactly one API and one worker process to remain `online` beyond the PM2 `min_uptime` boundary.
9. Saves PM2 state, updates `previous`, and prunes old unprotected releases.

The script never deletes either PM2 process. If any post-switch step fails, it restores the previous `current` target, reloads the stack, and rechecks the previous release. A retained legacy release without `worker.mjs` uses the compatibility path: reload the API and stop, but do not delete, the newer worker. A `.deploy-failed` marker remains in the failed release for diagnosis.

Production defaults are fixed. The source Git checkout must be clean. `ALLOW_DIRTY_SOURCE=YES` is only for an explicitly reviewed recovery deployment; the release records the full commit, dirty state, and override in `.release-source`. `SOURCE_DIR`, `PROD_DIR`, `RELEASE_ID`, and command-path overrides exist only to support deterministic sandbox tests and controlled recovery.

## Backup, Verification, Restore, and Drill

Create and verify a backup:

```bash
set -a
. /data/prod/ai-product-reliability-kit/.env.production
set +a

BACKUP_DIR=/data/prod/ai-product-reliability-kit/shared/backups \
BACKUP_RETENTION_DAYS=14 \
/data/prod/ai-product-reliability-kit/current/scripts/ops/backup-postgres.sh

BACKUP_FILE=/data/prod/ai-product-reliability-kit/shared/backups/apr-....dump \
/data/prod/ai-product-reliability-kit/current/scripts/ops/verify-backup.sh
```

Restore is intentionally destructive and requires both an opt-in and the exact connected database name. Do not run it while either application writer is active. In an authorized maintenance window, first create a verified pre-restore backup, stop the worker and API, and confirm there are no unexpected database sessions. Then run:

```bash
BACKUP_FILE=/secure/path/apr-backup.dump \
RESTORE_DATABASE_URL='postgresql://...' \
RESTORE_CONFIRM_DATABASE='<exact database name from RESTORE_DATABASE_URL>' \
RESTORE_ALLOW_DESTRUCTIVE=YES \
/data/prod/ai-product-reliability-kit/current/scripts/ops/restore-postgres.sh
```

If restore fails, keep both processes stopped and preserve the pre-restore backup. After success, inspect migrations and critical records, start both processes from the production PM2 ecosystem, verify local liveness/readiness and PM2 stability, and save PM2 state. The exact quiesce, inspection, restore, and restart sequence is in `docs/runbook.md`.

Prefer a disposable restore drill before any production restore:

```bash
BACKUP_FILE=/secure/path/apr-backup.dump \
DATABASE_ADMIN_URL='postgresql://.../postgres' \
DRILL_VERIFY_SQL='select count(*) from schema_migrations' \
/data/prod/ai-product-reliability-kit/current/scripts/ops/restore-drill.sh
```

The drill creates a uniquely named database, restores and verifies it, and removes it through an exit trap. Use `.pgpass` or another host-level secret mechanism where possible; never commit database URLs.

The cron template is `deploy/cron/ai-product-reliability-backup.cron`. Its first line is deliberately `PENDING MANUAL INSTALLATION`. It runs as the existing `apr` service account, which owns the mode-0600 production env file, backup directory, and pre-created log. Review and install both templates manually:

```bash
sudo cp deploy/cron/ai-product-reliability-backup.cron /etc/cron.d/ai-product-reliability-backup
sudo cp deploy/cron/ai-product-reliability-backup.logrotate /etc/logrotate.d/ai-product-reliability-backup
sudo chmod 0644 /etc/cron.d/ai-product-reliability-backup /etc/logrotate.d/ai-product-reliability-backup
```

After installation, run the cron command once as `apr`, verify the emitted dump/checksum, and confirm log rotation ownership. A scheduled backup does not quiesce writers and is appropriate for PostgreSQL `pg_dump`; a destructive restore is different and always requires the explicit API/Worker stop and session inspection above.

## Rollback

Automatic rollback runs when deployment fails after switching `current`. For an operator-initiated rollback:

```bash
cd /data/claude_project/ai-product-reliability-kit
./rollback.sh
```

By default, `rollback.sh` selects `previous`. Select an explicit retained release with:

```bash
./rollback.sh --release 20260710T140000Z-abc123def456
```

The rollback script holds the same release-operation lock as deployment. It rejects releases marked `.deploy-failed` or missing the `.release-ready`, API, worker, or ecosystem files; creates a backup; switches `current`; reloads PM2; verifies liveness/readiness and both process uptimes; and restores the original release if rollback acceptance fails. It does not run down migrations. Every schema change must remain compatible with the prior application release for the documented retention window. See `docs/rollback.md`.

## External Monitoring

`deploy/monitoring/external-monitor.example.yml` is provider-neutral and is explicitly marked:

```text
PENDING MANUAL ENABLEMENT
```

Translate/import it into the selected external uptime provider, configure at least two external regions and a notification destination, then test failure and recovery. Do not change the activation status or claim external coverage until a human verifies polling from outside the platform host. No provider has been contacted by repository automation.

## CI and Acceptance

The root Linux workflow runs deterministic Node installs, SDK packaging/install checks, Python tests, a real Java Maven contract, Postgres integration and backup/restore drill, Playwright desktop/mobile workflows, npm audit, Bash syntax, ShellCheck, and `nginx -t`. CI does not deploy.

Use `docs/deployment-acceptance.md` for the preflight, post-deploy, rollback, backup, Nginx, and external-monitor checklist. Use `docs/runbook.md` during normal operations.
