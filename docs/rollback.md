# Production Rollback

Rollback changes the application release symlink and reloads the PM2 API/worker stack. It does not reverse database migrations.

## Preconditions

- The target exists under `/data/prod/ai-product-reliability-kit/releases`.
- The target has no `.deploy-failed` marker and contains `.release-ready`, the API and worker entry points, and the PM2 ecosystem file.
- Applied migrations are backward-compatible with the target release.
- `.env.production` is a regular protected file in the production root.
- Postgres backup tools, PM2, curl, and the operations scripts are available.

## Automatic Deployment Rollback

After `deploy.sh` switches `current`, any PM2 reload, `/healthz`, `/readyz`, or PM2-save failure triggers automatic restoration of the previous target. The handler:

1. Writes `.deploy-failed` in the failed release.
2. Atomically restores the old `current` target.
3. Reloads the existing PM2 API and worker processes with updated environment.
4. Checks the restored release's liveness and readiness.
5. Saves PM2 state when possible.

No PM2 process deletion occurs. A retained legacy release without the worker entry point reloads the API and stops the worker compatibility process. If a first-ever deployment has no previous release, the unsafe `current` link is removed and both processes are stopped; an operator must diagnose before retrying.

## Operator-Initiated Rollback

Select `previous` automatically:

```bash
cd /data/claude_project/ai-product-reliability-kit
/bin/bash ./rollback.sh
```

Or select a retained release explicitly:

```bash
/bin/bash ./rollback.sh --release <release-id>
```

The script acquires the same exclusive release-operation lock used by deployment, validates that the release resolves inside the releases directory and is complete, creates a pre-rollback backup, atomically switches `current`, reloads PM2, checks both platform endpoints, and proves that exactly one API and one worker remain online beyond their minimum uptime. On any failed post-switch operation it explicitly restores the original target and reloads it.

## Verification

```bash
readlink -f /data/prod/ai-product-reliability-kit/current
readlink -f /data/prod/ai-product-reliability-kit/previous
pm2 status
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
curl -fsS https://reliability.hihongrun.com/healthz
curl -fsS https://reliability.hihongrun.com/readyz
```

Confirm the intended release ID, environment-isolated status, critical journeys, alerts, and incident state. Do not declare recovery from a 200 on the public status page alone.

## Database Caveat

There are no automatic down migrations. Migration 004 keeps legacy event writes compatible while adding environment-scoped replay protection and the shared deduplication ledger; migration 003 preserves legacy alert rows as disabled compatibility records with migration advice. Do not remove those compatibility layers or enable legacy alert rows during a rollback. If any applied migration is not compatible with the target release, application rollback is unsafe. Stop, preserve backups, and follow a separately reviewed database recovery plan. A production restore requires explicit destructive confirmation and quiesced API/Worker writers; prefer restoring into an isolated database first.

## Rollback Drill

The Linux operations test creates temporary releases, deploys through fake command boundaries, forces post-switch acceptance failure, and proves that `current` returns to the original target. It also proves a failed manual rollback restores its starting target. Before production use, separately exercise backup and disposable restore against a non-production PostgreSQL environment.
