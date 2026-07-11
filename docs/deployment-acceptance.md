# Deployment Acceptance Checklist

This checklist separates CI evidence, manual preparation, scripted deployment, and external activation. Checking a box must reflect observed evidence.

## CI Gate

- [ ] Root, Dashboard, Standard, CLI, Automation, and Node SDK lockfiles install with `npm ci`.
- [ ] Node and Python suites pass.
- [ ] Java Maven compilation and HTTP contract test pass.
- [ ] Real Postgres migration/integration tests pass through `004_integrity_and_upgrade_safety`, including environment-scoped ingest deduplication, ownership collisions, legacy upgrade compatibility, retention, and scheduler locking.
- [ ] Backup, checksum/archive verification, and disposable restore drill pass.
- [ ] Playwright desktop and mobile projects pass.
- [ ] `npm audit` gates pass at the configured severity.
- [ ] `bash -n` and ShellCheck pass for deploy, rollback, and operations scripts.
- [ ] The complete Nginx config passes `nginx -t` in Linux CI.
- [ ] Deployment failure simulation proves automatic previous-release restoration.

## Manual Preflight

- [ ] Production authorization and maintenance window are recorded.
- [ ] Source checkout is the intended reviewed revision, is clean, and contains no `.env` or `.env.local`. Any emergency `ALLOW_DIRTY_SOURCE=YES` exception is separately approved and recorded in release provenance.
- [ ] `.env.production` is a mode-0600 regular file outside releases.
- [ ] Postgres role/database and required extensions exist.
- [ ] `node`, `npm`, `pm2`, `rsync`, `curl`, `pg_dump`, `pg_restore`, `psql`, `sha256sum`, and Nginx are available.
- [ ] `current` and `previous`, if present, resolve inside the canonical releases directory.
- [ ] Disk has room for a new release and verified backup.
- [ ] The latest backup verifies and the latest scheduled restore drill is successful.
- [ ] Migrations were reviewed as compatible with the retained previous application release.
- [ ] Disabled legacy alert rows and their `migration_advice` were reviewed; none will be blindly enabled.
- [ ] The backup cron and logrotate templates remain uninstalled until their `apr` ownership, env-file access, backup path, and log path are reviewed.

## Scripted Deployment Evidence

- [ ] `./deploy.sh` exits successfully.
- [ ] Output records a new release ID and verified pre-deploy backup.
- [ ] `current` resolves to that release and `previous` resolves to the prior release.
- [ ] PM2 reports exactly one `ai-product-reliability-kit` and one `ai-product-reliability-worker` online beyond the configured `min_uptime`, without a process deletion/recreation outage.
- [ ] API environment reports `APR_PROCESS_ROLE=api`; worker environment reports `APR_PROCESS_ROLE=worker`.
- [ ] Local `/healthz` returns 200.
- [ ] Local `/readyz` returns 200 and reports required dependencies/migrations ready.
- [ ] `schema_migrations` records `001_initial`, `002_phase2_foundations`, `003_runtime_operations`, and `004_integrity_and_upgrade_safety` with the expected checksums.
- [ ] PM2 state is saved.
- [ ] No secret env file exists inside the release.
- [ ] `.release-source` records the full Git commit and clean/override state; `.release-ready` exists and `.deploy-failed` does not.

## Public and Nginx Verification

- [ ] `nginx -t` succeeds before reload.
- [ ] `https://reliability.hihongrun.com/healthz` returns 200.
- [ ] `https://reliability.hihongrun.com/readyz` returns 200.
- [ ] Login and authorized API access work through Nginx.
- [ ] A validated onboarding contract creates an ingest-only product key, a keyed test event is confirmed through operator readback, and the first monitor remains environment-scoped.
- [ ] Non-public products remain absent from Public Status.
- [ ] Public output contains no internal errors, keys, user data, or system-only details.
- [ ] Admin audit records exist for the onboarding/key/monitor mutations and contain no plaintext key or request secret.

## Rollback Evidence

- [ ] `rollback.sh` target selection is reviewed.
- [ ] The selected target has `.release-ready`, both process entry points, and no `.deploy-failed` marker.
- [ ] A pre-rollback backup is created and verified.
- [ ] `current` switches to the intended retained release.
- [ ] PM2 reload, local liveness, and readiness pass.
- [ ] The original release is restored automatically if rollback acceptance is intentionally failed in a non-production drill.

## Backup, Cron, and Restore Readiness

- [ ] The scheduled command has been run manually as `apr`; the emitted dump and checksum/archive verification succeed.
- [ ] `/var/log/ai-product-reliability-backup.log` exists with `apr:apr` ownership and the reviewed logrotate file preserves it.
- [ ] Cron and logrotate installation are recorded explicitly; repository templates alone do not count as installed.
- [ ] The production restore procedure is reviewed but not casually exercised: worker stops before API, unexpected database sessions are cleared, a verified pre-restore backup is retained, and both processes remain stopped on any restore/validation failure.
- [ ] A disposable restore drill—not the production database—proves archive restoration and migration inspection.

## External Monitoring

- [ ] Repository config still says `PENDING MANUAL ENABLEMENT` until the following steps finish.
- [ ] Liveness and readiness checks are imported into a selected external provider.
- [ ] Checks run from at least two regions outside the platform host.
- [ ] Notification secret is stored outside Git.
- [ ] A safe failure and recovery notification test is recorded.
- [ ] Only then is activation evidence recorded in the production-readiness report.

## Handoff Record

Record UTC time, operator, source revision, release ID, previous release ID, backup filename and checksum result, migration version, local/public endpoint results, PM2 status, Nginx validation result, external-monitor activation state, and any accepted limitations.
