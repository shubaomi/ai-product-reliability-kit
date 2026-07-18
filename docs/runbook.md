# Production Runbook

This runbook covers the PM2 + Nginx deployment at `reliability.hihongrun.com`. It does not authorize production access or external service changes.

## Fast Triage

Run on the production host as an authorized operator:

```bash
pm2 status
pm2 logs ai-product-reliability-kit --lines 200
pm2 logs ai-product-reliability-worker --lines 200
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
readlink -f /data/prod/ai-product-reliability-kit/current
readlink -f /data/prod/ai-product-reliability-kit/previous
```

Interpretation:

- `/healthz` failing: the Node process or local listener is unavailable. Inspect PM2 before Nginx.
- `/healthz` passing and `/readyz` failing: the process is alive but Postgres, migrations, or another required dependency is not ready. Do not route or declare recovery.
- API healthy but monitor runs not advancing: inspect `ai-product-reliability-worker`, then the PostgreSQL scheduler lease and monitor due times. Do not enable an embedded worker in the API process.
- Both local checks passing but the public domain failing: inspect Nginx, TLS, firewall, DNS, and the external monitor.
- Public status showing `unknown`, `degraded`, or `outage`: inspect the named product/environment signals and unresolved incidents; do not overwrite Production evidence with Staging evidence.

## Release Diagnosis

```bash
current=/data/prod/ai-product-reliability-kit/current
readlink -f "$current"
find /data/prod/ai-product-reliability-kit/releases -mindepth 2 -maxdepth 2 -name .deploy-failed -print -exec cat {} \;
pm2 describe ai-product-reliability-kit
pm2 describe ai-product-reliability-worker
```

Do not edit a release directory in place. Correct source, run tests, and create a new release. A failed release is retained for diagnosis until release retention removes it.

## Database and Migrations

```bash
set -a
. /data/prod/ai-product-reliability-kit/.env.production
set +a
psql "$DATABASE_URL" -c 'select version, applied_at from schema_migrations order by version'
```

If readiness reports a migration problem, stop before another deployment. Preserve the current release and backup evidence. Migrations are forward-only and must be compatible with the retained previous release.

The SQL diagnostics below assume this protected environment has been loaded in the current authorized shell. Do not paste `DATABASE_URL` into tickets, chat, or shell history.

After an upgrade, confirm all four expected versions and inspect deliberately disabled legacy alert rows:

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select id, product_id, environment, type, enabled, config->>'original_condition' as original_condition, config->>'migration_advice' as migration_advice from alerts where config->>'legacy_migration' = 'true' order by product_id, id"
```

Do not enable these rows. Recreate the intended rule with an explicit environment and one of `availability_failure`, `telemetry_stale`, `error_spike`, or `journey_drop`, verify its thresholds/baseline, then retain or remove the disabled row through a separately reviewed change.

## Worker, Monitor, and State Diagnosis

If the API is ready but monitor evidence is not advancing, inspect definitions and their latest runs without changing scheduler ownership:

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select m.product_id, m.environment, m.id, m.type, m.severity, m.enabled, max(r.checked_at) as last_run from monitors m left join monitor_runs r on r.monitor_id = m.id group by m.product_id, m.environment, m.id, m.type, m.severity, m.enabled order by m.product_id, m.environment, m.id"
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select pid, granted, classid, objid, objsubid from pg_locks where locktype = 'advisory' order by granted desc, pid"
```

- No row in `monitor_runs` for an enabled critical monitor is an explicit `unknown`, not a pass.
- A stale critical run returns the environment to `unknown`; a current failure degrades it and repeated critical failure can make it an outage.
- A lease held briefly by the Worker is expected. A persistent lock with no progress requires correlating its PID in `pg_stat_activity` and the Worker logs before restarting anything.
- Use the authenticated `POST /api/scheduler/run-once` only as a deliberate diagnostic. It is admin-only and audited; do not enable an embedded API scheduler or create a second unmanaged Worker.
- Always inspect one `product_id + environment`. A Staging success is irrelevant to a Production failure.

## Alert Delivery and Incident Response

Inspect active alert/incident ownership and recent delivery failures:

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select product_id, environment, rule_type, severity, status, occurrence_count, last_seen_at, last_notified_at from alert_instances where status in ('open','acknowledged') order by severity, last_seen_at desc"
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select product_id, environment, severity, status, owner, updated_at from incidents where status in ('open','acknowledged') order by severity, updated_at desc"
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select delivered_at, product_id, environment, alert_id, notification_type, channel, status, response from alert_deliveries where status <> 'sent' order by delivered_at desc limit 100"
```

1. Acknowledge the alert/incident and assign an owner; acknowledgement preserves deduplication and does not claim recovery.
2. Link the relevant active alerts to the incident so the timeline retains the operational evidence.
3. Check the affected environment, latest release, monitor runs, health, and dependencies. Use a maintenance window only for known planned work; it must not hide an unrelated incident.
4. Generic and Feishu webhook URLs must be HTTPS in production. A failed delivery is persisted. Correct the destination/secret, notify the owner through an authorized fallback, and allow the same dedup instance to follow its cooldown rather than creating a duplicate rule.
5. Resolve only after the signal recovers and record what changed plus how recovery was verified. A remaining active alert may correctly keep state degraded after the incident closes.

## Product-Key Compromise and Audit Review

For a leaked product key, use the product's **Configuration** view or the admin key API to rotate/revoke it. Rotation revokes the old hash and returns the replacement secret once. Update the product server's `APR_PRODUCT_API_KEY`, send a keyed test event, confirm operator readback and `last_used_at`, then remove any stale secret copy. A key for another product is not a substitute.

For compromise of `APR_MASTER_API_KEY`, `APR_INGEST_API_KEY`, or `APR_SESSION_SECRET`, generate a distinct replacement through the approved secret mechanism, update only the protected mode-0600 production env, reload the PM2 ecosystem with `--update-env`, and verify login plus the affected machine path. Session-secret rotation invalidates existing browser sessions. These platform secrets are deliberately distinct; never copy one value into another field.

Do not rotate `APR_USER_ID_HMAC_SECRET` as a routine credential step. It changes identifier correlation for new telemetry while existing hashes remain, so it requires an explicit privacy/data migration plan and separately reviewed acceptance evidence.

Review bounded audit evidence without selecting API-key hashes or request payloads:

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "select created_at, product_id, actor_type, actor_id, action, target_type, target_id, source_ip, metadata from audit_logs order by created_at desc limit 200"
```

Audit coverage includes login attempts, product/compliance mutations, monitor/alert/status-page registration, key lifecycle, incident lifecycle/packages, maintenance, alert acknowledgement, scheduler runs, and retention runs. The audit log is redacted operational evidence, not a complete application log or a copy of the request body.

## Public Status and Privacy

- Publication is private unless the validated contract explicitly sets `public_status.enabled: true` or an admin deliberately enables it.
- Public state is Production-only and uses the same server-derived model, but exposes only allowlisted name/slug/state/time/summary/components.
- Compare `/api/status` and `/status/:slug` with the authenticated product detail after a change. Owners, raw reasons, internal status body, keys, user identifiers, and error payloads must remain absent.
- If uncertain, unpublish first, verify the private projection, and investigate through the authenticated Dashboard. Never add internal diagnostics to the public summary as a shortcut.

## Backup Operations

List and verify recent backups:

```bash
ls -lht /data/prod/ai-product-reliability-kit/shared/backups
BACKUP_FILE=/data/prod/ai-product-reliability-kit/shared/backups/apr-....dump \
  /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/verify-backup.sh
```

A file existing is not sufficient evidence. Verification requires its checksum and a readable custom-format archive. Perform the disposable restore drill after database changes and at the documented operating cadence:

```bash
BACKUP_FILE=/secure/path/apr-backup.dump \
DATABASE_ADMIN_URL='postgresql://.../postgres' \
DRILL_VERIFY_SQL='select count(*) from schema_migrations' \
  /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/restore-drill.sh
```

Never point a drill at the production database. `restore-postgres.sh` requires `RESTORE_ALLOW_DESTRUCTIVE=YES` and exact database-name confirmation.

For the installed scheduled job, review `/var/log/ai-product-reliability-backup.log`, confirm it ran as `apr`, verify the newest emitted dump/checksum, and check that the logrotate file retains `apr:apr` ownership. `PENDING MANUAL INSTALLATION` remains true until both cron and logrotate are installed and an operator records a successful manual run.

## Authorized Production Restore

A production restore is a maintenance-window operation, not a live repair. Keep the pre-restore backup even after recovery.

1. Load the protected environment and create a separately labelled backup while the current system is still running:

   ```bash
   set -a
   . /data/prod/ai-product-reliability-kit/.env.production
   set +a
   BACKUP_DIR=/data/prod/ai-product-reliability-kit/shared/backups \
   BACKUP_RETENTION_DAYS=14 \
   BACKUP_LABEL=prerestore \
     /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/backup-postgres.sh
   ```

   Verify the emitted backup path and checksum/archive before proceeding.

2. Stop new background and API writes, in that order:

   ```bash
   pm2 stop ai-product-reliability-worker
   pm2 stop ai-product-reliability-kit
   ```

3. Inspect remaining sessions. Do not restore until every non-operator session is understood and inactive:

   ```bash
   psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
     "select pid, usename, application_name, client_addr, state, xact_start from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by xact_start nulls last"
   ```

4. Run the destructive restore only after checking the URL and exact database name twice:

   ```bash
   BACKUP_FILE=/secure/path/apr-backup.dump \
   RESTORE_DATABASE_URL="$DATABASE_URL" \
   RESTORE_CONFIRM_DATABASE='<exact database name from DATABASE_URL>' \
   RESTORE_ALLOW_DESTRUCTIVE=YES \
     /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/restore-postgres.sh
   ```

5. Validate the restored data before allowing writes, then start both roles from the fixed production ecosystem and run acceptance:

   ```bash
   psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -c 'select version, applied_at from schema_migrations order by version'
   export NODE_ENV=production HOST=127.0.0.1 PORT=8787 APR_STORE_MODE=postgres APR_AUTH_REQUIRED=true
   APR_CURRENT_LINK=/data/prod/ai-product-reliability-kit/current \
   APR_API_APP_NAME=ai-product-reliability-kit \
   APR_WORKER_APP_NAME=ai-product-reliability-worker \
     pm2 startOrReload /data/prod/ai-product-reliability-kit/current/deploy/ecosystem.config.cjs --env production --update-env
   curl -fsS http://127.0.0.1:8787/healthz
   curl -fsS http://127.0.0.1:8787/readyz
   pm2 describe ai-product-reliability-kit
   pm2 describe ai-product-reliability-worker
   pm2 save
   ```

If any restore or validation step fails, leave both roles stopped, preserve the failed-state evidence and pre-restore backup, and escalate. Do not start against a partially restored database.

## Rollback Decision

Rollback when a new release fails readiness, causes a confirmed regression, or cannot be safely mitigated without code changes. Use:

```bash
cd /data/claude_project/ai-product-reliability-kit
/bin/bash ./rollback.sh
```

See `docs/rollback.md` for target selection and failure recovery. Database rollback is not automatic; confirm the previous application remains compatible with the applied migration.

## Nginx and Public Reachability

```bash
sudo nginx -t
sudo systemctl status nginx
curl -fsS https://reliability.hihongrun.com/healthz
curl -fsS https://reliability.hihongrun.com/readyz
```

Only reload Nginx after `nginx -t` succeeds. The canonical full configuration is `docs/nginx-hihongrun-production.conf`.

## External Monitoring

The repository config remains `PENDING MANUAL ENABLEMENT` until an operator imports `deploy/monitoring/external-monitor.example.yml`, verifies multi-region polling, and records test-failure/recovery evidence. Internal self-checks cannot prove the host is externally reachable.

## Routine Cadence

- Daily: review PM2 restarts, unresolved alerts/incidents, failed alert deliveries, readiness, backup job result, and disk capacity.
- Weekly: verify a backup, review release/backup retention, inspect product-key `last_used_at`/expiry, and sample sensitive-operation audit records.
- After schema or restore-tool changes: perform a disposable restore drill and inspect disabled legacy-rule migration advice plus the migration ledger.
- After Nginx/TLS changes: run `nginx -t`, local checks, public checks, and an external monitor test.
- After deployment-tool changes: run the sandbox rollback simulation on a Linux host before production use.

## Evidence to Capture

Record UTC timestamps, active/previous release IDs, health/readiness responses, PM2 status, migration version, backup filename/checksum verification, rollback result, and external-monitor state. Never paste keys, cookies, database passwords, or full user payloads into incident notes.
