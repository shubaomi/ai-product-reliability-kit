# Complete Server Deployment Guide

This is the start-to-finish production deployment path for AI Product Reliability Kit. It is written for an authorized operator returning to the project after time away and starts from a clean Debian/Ubuntu server.

The supported production model is deliberately fixed:

```text
reliability.hihongrun.com
        -> Nginx TLS reverse proxy
        -> 127.0.0.1:8787
        -> PM2 API: ai-product-reliability-kit
        -> PM2 Worker: ai-product-reliability-worker
        -> PostgreSQL
```

Docker Compose is only for local integration. GitHub does not deploy this project and this repository intentionally contains no GitHub automation. Production changes happen only when an operator pulls a reviewed commit on the server and runs `deploy.sh`.

## 1. Before You Begin

Assumptions:

- The server runs a supported Debian or Ubuntu release with `sudo` and systemd.
- `reliability.hihongrun.com` can be pointed to the server.
- Node.js 22 can be installed system-wide and used by the `apr` service account.
- PostgreSQL runs locally in the examples below. A managed PostgreSQL service is also valid if its database, role, extension, network, TLS, and backup policy are provisioned separately.
- The existing hihongrun Nginx configuration may serve other applications. Never overwrite it without a backup and a reviewed diff.

Record the intended Git commit before starting. Do not call the deployment production-ready until the manual Linux, real-PostgreSQL, backup/restore, ShellCheck, and Nginx gates pass for that exact revision.

## 2. Configuration Inventory

| File or resource | Required action | Purpose |
| --- | --- | --- |
| `/data/claude_project/ai-product-reliability-kit` | Clone and update as `apr` | Clean Git source checkout; never store production secrets here |
| `/data/prod/ai-product-reliability-kit/.env.production` | Create manually as mode `0600`, owner `apr:apr` | Production database, authentication, proxy, and secret settings |
| `docs/nginx-hihongrun-production.conf` | Review and merge/install as root | Complete shared hihongrun Nginx configuration, including this site |
| `/etc/nginx/ssl/hihongrun-zerossl-fullchain.crt` | Provision or change Nginx paths | TLS certificate covering `reliability.hihongrun.com` |
| `/etc/nginx/ssl/hihongrun-zerossl.key` | Provision as root-only or change Nginx paths | TLS private key |
| `deploy/ecosystem.config.cjs` | Do not edit during normal deployment | Versioned PM2 definition for one API and one Worker |
| `/etc/cron.d/ai-product-reliability-backup` | Install only after a successful manual backup | Daily PostgreSQL backup at 02:17 server time |
| `/etc/logrotate.d/ai-product-reliability-backup` | Install with the cron file | Weekly backup-log rotation, eight retained rotations |
| `deploy/monitoring/external-monitor.example.yml` | Import manually into an external provider | Public liveness/readiness checks; remains pending until tested |
| PM2 systemd unit | Generate with `pm2 startup` after the first deployment | Restores the saved API/Worker process list after reboot |

Do not normally edit `deploy.sh`, `rollback.sh`, the PM2 ecosystem, or files inside an activated release. A code or deployment change must be committed, pulled into the source checkout, and released through `deploy.sh`.

## 3. Install Server Software

Install the Linux packages required at runtime and by the manual validation gates:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates cron curl git logrotate nginx openssl rsync \
  postgresql postgresql-client \
  coreutils util-linux shellcheck \
  python3 python3-pip openjdk-17-jdk maven
```

Install Node.js **22.x** through the operating system's approved installation method. Do not use an unpinned `latest` release. Then install PM2 system-wide:

```bash
node --version
npm --version
sudo npm install --global pm2
pm2 --version
```

`node --version` must report `v22.x`. The `apr` account created in the next step must be able to execute `node`, `npm`, and `pm2`; a root-only NVM installation does not satisfy that requirement.

## 4. Create the Service Account and Directories

Create a non-login service account if it does not already exist:

```bash
if ! id -u apr >/dev/null 2>&1; then
  sudo useradd --system --user-group --create-home \
    --home-dir /var/lib/apr --shell /usr/sbin/nologin apr
fi
```

Create the source and production locations:

```bash
sudo install -d -m 0755 -o apr -g apr /data/claude_project
sudo install -d -m 0750 -o apr -g apr /data/prod/ai-product-reliability-kit
sudo install -d -m 0750 -o apr -g apr \
  /data/prod/ai-product-reliability-kit/shared/backups
sudo install -m 0640 -o apr -g apr /dev/null \
  /var/log/ai-product-reliability-backup.log
```

Verify the runtime tools as the service account:

```bash
sudo -u apr -H node --version
sudo -u apr -H npm --version
sudo -u apr -H pm2 --version
```

Only Nginx should listen publicly on ports 80 and 443. Never expose port 8787 through the firewall or cloud security group.

## 5. Clone the Reviewed Source

For a first checkout:

```bash
sudo -u apr -H git clone \
  https://github.com/shubaomi/ai-product-reliability-kit.git \
  /data/claude_project/ai-product-reliability-kit
```

Select and record the reviewed `main` revision:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
git fetch origin
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test ! -e .env
test ! -e .env.local
git rev-parse HEAD
'
```

The final command prints the exact commit that will be deployed. Stop if the checkout is dirty. Do not use `git reset --hard` to hide unknown server changes.

## 6. Provision PostgreSQL

For PostgreSQL on the same server, open an administrative session:

```bash
sudo -u postgres psql
```

Create the application role and database. `\password apr` prompts without putting the password in shell history:

```sql
CREATE ROLE apr LOGIN;
\password apr
CREATE DATABASE ai_product_reliability OWNER apr;
\connect ai_product_reliability
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\q
```

Use a distinct strong password. A random hexadecimal password from `openssl rand -hex 24` is URL-safe. The resulting application URL has this shape:

```text
postgresql://apr:<password>@127.0.0.1:5432/ai_product_reliability
```

If the password contains URL-reserved characters, percent-encode it before placing it in `DATABASE_URL`.

Test TCP password authentication:

```bash
psql -h 127.0.0.1 -U apr -d ai_product_reliability -W \
  -c 'select current_database(), current_user'
```

If local TCP authentication is rejected, locate the active `pg_hba.conf`:

```bash
sudo -u postgres psql -tAc 'show hba_file'
```

Add a narrowly scoped rule only when the existing policy requires it:

```text
host ai_product_reliability apr 127.0.0.1/32 scram-sha-256
```

Then reload PostgreSQL and repeat the connection test:

```bash
sudo systemctl reload postgresql
```

Do not run integration tests against the production database. Create a separate disposable test database for the real-PostgreSQL validation described next.

## 7. Run the Manual Pre-Deployment Gates

Install deterministic dependencies from lockfiles:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
npm ci
npm ci --prefix standard
npm ci --prefix cli
npm ci --prefix automation
npm ci --prefix apps/dashboard
npm ci --prefix sdks/node
'
```

Run the locally executable suites:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
npm test
npm run test:ops
mvn --batch-mode --no-transfer-progress -f sdks/java/pom.xml clean verify
bash -n deploy.sh rollback.sh scripts/ops/*.sh
shellcheck -x -P SCRIPTDIR deploy.sh rollback.sh scripts/ops/*.sh
npm audit --audit-level=high
'
```

For Playwright on this host, install its Chromium dependencies once and then run the desktop/mobile suite before starting production on port 8787:

```bash
cd /data/claude_project/ai-product-reliability-kit
sudo ./node_modules/.bin/playwright install-deps chromium
sudo -u apr -H bash -lc '
cd /data/claude_project/ai-product-reliability-kit
npx playwright install chromium
npm run test:e2e
'
```

Create a dedicated non-production database, run the real PostgreSQL suite, and remove the test database only after the suite finishes:

```bash
sudo -u postgres createdb --owner=apr apr_reliability_test

sudo -u apr -H bash -lc '
cd /data/claude_project/ai-product-reliability-kit
read -rsp "PostgreSQL apr password: " APR_DB_PASSWORD; echo
export APR_TEST_DATABASE_URL="postgresql://apr:${APR_DB_PASSWORD}@127.0.0.1:5432/apr_reliability_test"
npm --prefix apps/dashboard run test:postgres
unset APR_DB_PASSWORD APR_TEST_DATABASE_URL
'

sudo -u postgres dropdb apr_reliability_test
```

Run a backup and disposable restore drill against non-production PostgreSQL before go-live. The exact commands are under [Backup, Verification, Restore, and Drill](production.md#backup-verification-restore-and-drill). Record every result against the reviewed commit. A skipped real-service test is not a pass.

## 8. Create the Protected Production Environment

Generate four distinct secrets, recording them directly in the approved server-side secret location:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Use the four different values for:

- `APR_MASTER_API_KEY`
- `APR_INGEST_API_KEY`
- `APR_SESSION_SECRET`
- `APR_USER_ID_HMAC_SECRET`

Generate the admin password hash without placing the password on the command line:

```bash
sudo -u apr -H bash -lc '
read -rsp "Admin password: " APR_ADMIN_PASSWORD; echo
export APR_ADMIN_PASSWORD
cd /data/claude_project/ai-product-reliability-kit
npm --prefix apps/dashboard run hash-password
unset APR_ADMIN_PASSWORD
'
```

Copy the printed `pbkdf2_sha256$...` value. Create the env file only if it does not exist, then edit it:

```bash
sudo test -e /data/prod/ai-product-reliability-kit/.env.production || \
  sudo install -m 0600 -o apr -g apr /dev/null \
    /data/prod/ai-product-reliability-kit/.env.production
sudo chown apr:apr /data/prod/ai-product-reliability-kit/.env.production
sudo chmod 0600 /data/prod/ai-product-reliability-kit/.env.production
sudoedit /data/prod/ai-product-reliability-kit/.env.production
```

Required contents:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://reliability.hihongrun.com
DATABASE_URL=postgresql://apr:<password>@127.0.0.1:5432/ai_product_reliability
APR_STORE_MODE=postgres
APR_AUTH_REQUIRED=true
APR_ADMIN_EMAIL=<real-admin-email>
APR_ADMIN_PASSWORD_HASH='pbkdf2_sha256$210000$...$...'
APR_MASTER_API_KEY=<unique-secret-at-least-32-characters>
APR_INGEST_API_KEY=<different-secret-at-least-32-characters>
APR_SESSION_SECRET=<different-secret-at-least-32-characters>
APR_USER_ID_HMAC_SECRET=<different-secret-at-least-32-characters>
APR_TRUSTED_PROXIES=127.0.0.1
```

Do not add `APR_PROCESS_ROLE` or `APR_WORKER_ENABLED`; the versioned PM2 ecosystem assigns those values separately to the API and Worker. Keep CORS and the monitor-host allowlist empty unless a reviewed requirement exists. Optional limits, retention, and webhook settings are documented in [Production Deployment](production.md#optional-production-settings).

Validate the file without printing its secrets:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
set -a
. /data/prod/ai-product-reliability-kit/.env.production
set +a
cd /data/claude_project/ai-product-reliability-kit
node --input-type=module -e \
  "import { loadConfig, validateConfig } from './apps/dashboard/src/config.mjs'; validateConfig(loadConfig()); console.log('production config valid')"
'
```

Stop and correct the named setting if validation fails.

## 9. Configure DNS, TLS, Firewall, and Nginx

Create the DNS `A` record for `reliability.hihongrun.com`. Add an `AAAA` record only if the server is intentionally reachable and firewalled over IPv6.

The canonical Nginx file expects:

```text
/etc/nginx/ssl/hihongrun-zerossl-fullchain.crt
/etc/nginx/ssl/hihongrun-zerossl.key
```

The certificate must cover `reliability.hihongrun.com`. If the server uses Let's Encrypt or different certificate paths, update every relevant `ssl_certificate` and `ssl_certificate_key` directive in the installed Nginx configuration. Keep the private key owned by root and unreadable by ordinary users.

After obtaining or renewing the certificate through the server's approved certificate provider, verify ownership and permissions for the canonical paths:

```bash
sudo chown root:root \
  /etc/nginx/ssl/hihongrun-zerossl-fullchain.crt \
  /etc/nginx/ssl/hihongrun-zerossl.key
sudo chmod 0644 /etc/nginx/ssl/hihongrun-zerossl-fullchain.crt
sudo chmod 0600 /etc/nginx/ssl/hihongrun-zerossl.key
```

If different paths are configured, apply equivalent permissions there. Never copy certificate private-key material into this repository.

`docs/nginx-hihongrun-production.conf` is the **complete shared hihongrun configuration** and contains other sites. Do not blindly overwrite an unknown production file. First locate the active configuration and back it up. For the established `/etc/nginx/conf.d/hihongrun.conf` layout:

```bash
if [ -f /etc/nginx/conf.d/hihongrun.conf ]; then
  sudo cp -a /etc/nginx/conf.d/hihongrun.conf \
    "/etc/nginx/conf.d/hihongrun.conf.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  sudo diff -u /etc/nginx/conf.d/hihongrun.conf \
    /data/claude_project/ai-product-reliability-kit/docs/nginx-hihongrun-production.conf || true
else
  echo "No existing /etc/nginx/conf.d/hihongrun.conf; review the complete repository config before installing it."
fi
```

Review the diff. The deployed configuration must contain exactly one `ai_product_reliability_app` upstream pointing to `127.0.0.1:8787`, the `reliability.hihongrun.com` TLS server, and the domain in the HTTP-to-HTTPS redirect. Avoid duplicate `map`, `upstream`, `default_server`, or `server_name` declarations.

If the server's active shared configuration matches the repository layout and the full diff is approved, install the reviewed file:

```bash
sudo install -m 0644 -o root -g root \
  /data/claude_project/ai-product-reliability-kit/docs/nginx-hihongrun-production.conf \
  /etc/nginx/conf.d/hihongrun.conf
sudo nginx -t
```

If the server uses `sites-available` or contains local changes not represented by the repository file, merge only the reviewed reliability upstream/server/redirect blocks into the existing configuration. Do not reload Nginx when `nginx -t` fails. Keep the successful configuration staged until the application is running.

If UFW is part of the server policy, keep SSH access and allow only Nginx publicly:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw status
```

Do not add an allow rule for port 8787.

## 10. Perform the First Atomic Deployment

Run the deployment as `apr`, from the clean source checkout:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
./deploy.sh
'
```

The script validates production configuration, creates an immutable release, installs production dependencies, creates and verifies a PostgreSQL backup, applies migrations, switches `current` atomically, starts/reloads the API and Worker, verifies `/healthz` and `/readyz`, proves PM2 stability, saves PM2 state, and prunes old releases.

If post-switch acceptance fails, it attempts to restore the previous release automatically. On a first-ever deployment there is no previous release, so it removes the unsafe `current` link and stops both processes for diagnosis.

Do not use `ALLOW_DIRTY_SOURCE=YES` during normal deployment.

## 11. Enable PM2 Startup and Nginx Traffic

After the first successful deployment, ask PM2 to print the systemd installation command:

```bash
sudo -u apr -H pm2 startup
```

Run the exact root command printed by PM2. It should target user `apr` and home `/var/lib/apr`. Then save the process list:

```bash
sudo -u apr -H pm2 save
```

Verify the local application before reloading Nginx:

```bash
sudo -u apr -H pm2 status
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

Only after those checks and `nginx -t` succeed:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://reliability.hihongrun.com/healthz
curl -fsS https://reliability.hihongrun.com/readyz
```

Verify that the PM2 systemd unit and Nginx are enabled for reboot, then perform a planned reboot test when the maintenance window allows it:

```bash
sudo systemctl is-enabled nginx
sudo systemctl list-unit-files | grep -E '^pm2-apr\.service'
```

## 12. Verify the First Release

Record the release links and process details:

```bash
readlink -f /data/prod/ai-product-reliability-kit/current
readlink -f /data/prod/ai-product-reliability-kit/previous || true
sudo -u apr -H pm2 describe ai-product-reliability-kit
sudo -u apr -H pm2 describe ai-product-reliability-worker
```

Verify the migration ledger without printing `DATABASE_URL`:

```bash
sudo -u apr -H bash -lc '
set -a
. /data/prod/ai-product-reliability-kit/.env.production
set +a
psql "$DATABASE_URL" \
  -c "select version, applied_at from schema_migrations order by version"
'
```

Confirm all four migrations, `001` through `004`. Then complete the authenticated acceptance flows:

- Admin login works.
- A product can be onboarded from valid YAML or the manual form.
- Its ingest-only key is shown once, stored outside Git, and cannot access another product.
- A keyed test event can be read back through the operator session.
- Production and Staging states remain isolated.
- The first monitor runs and influences state.
- Incident acknowledgement, assignment, resolution, and recovery note work.
- Public status remains private unless explicitly enabled and exposes no internal data.
- Audit records exist for sensitive operations without plaintext secrets.

Complete every checkbox in [Deployment Acceptance Checklist](deployment-acceptance.md) before recording go-live.

## 13. Install and Test Scheduled Backups

Do not install cron until a manual backup succeeds. Run one as `apr`:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
set -a
. /data/prod/ai-product-reliability-kit/.env.production
set +a
BACKUP_DIR=/data/prod/ai-product-reliability-kit/shared/backups \
BACKUP_RETENTION_DAYS=14 \
BACKUP_LABEL=manual \
  /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/backup-postgres.sh
'
```

The command prints `BACKUP_FILE=...`. Verify that exact file:

```bash
sudo -u apr -H env BACKUP_FILE=/data/prod/ai-product-reliability-kit/shared/backups/<backup-file>.dump \
  /bin/bash /data/prod/ai-product-reliability-kit/current/scripts/ops/verify-backup.sh
```

Install the reviewed templates:

```bash
sudo install -m 0644 -o root -g root \
  /data/claude_project/ai-product-reliability-kit/deploy/cron/ai-product-reliability-backup.cron \
  /etc/cron.d/ai-product-reliability-backup
sudo install -m 0644 -o root -g root \
  /data/claude_project/ai-product-reliability-kit/deploy/cron/ai-product-reliability-backup.logrotate \
  /etc/logrotate.d/ai-product-reliability-backup
sudo logrotate -d /etc/logrotate.d/ai-product-reliability-backup
sudo systemctl status cron
```

The supplied cron runs daily at 02:17 in the server's timezone, keeps backups for 14 days, and appends to `/var/log/ai-product-reliability-backup.log`. Logrotate runs weekly, keeps eight rotations, compresses old logs, and recreates the log as `apr:apr` mode `0640`.

Check the result the next day:

```bash
sudo tail -n 100 /var/log/ai-product-reliability-backup.log
ls -lht /data/prod/ai-product-reliability-kit/shared/backups
```

A dump file existing is not enough; verify its checksum and archive readability. Schedule periodic disposable restore drills as described in the production runbook.

## 14. Activate External Monitoring Manually

Import `deploy/monitoring/external-monitor.example.yml` into the selected external uptime provider. Configure:

- `/healthz` every 60 seconds, 5-second timeout, alert after three failures.
- `/readyz` every 60 seconds, 5-second timeout, alert after two failures.
- At least two monitoring regions outside this server.
- A notification destination whose secret is stored outside Git.

Run and record a safe failure/recovery test. Keep the repository status `PENDING MANUAL ENABLEMENT` until an external provider has actually polled and notified successfully. Internal checks cannot prove that the public host is reachable.

## 15. Routine Code Deployment

For later releases, first pull only fast-forward changes and require a clean checkout:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
git fetch origin
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test ! -e .env
test ! -e .env.local
git rev-parse HEAD
'
```

Record that commit and run the applicable commands from [Run the Manual Pre-Deployment Gates](#7-run-the-manual-pre-deployment-gates). Because GitHub automation is intentionally absent, do not skip this manual revision-specific validation. After it passes, deploy without changing the checkout:

```bash
sudo -u apr -H bash -lc '
set -euo pipefail
cd /data/claude_project/ai-product-reliability-kit
test -z "$(git status --porcelain)"
./deploy.sh
'
```

Repeat the local/public health, readiness, PM2, migration, and acceptance checks after every deployment. GitHub receives code; it does not run these commands or deploy the server.

## 16. Rollback

To return to `previous`:

```bash
sudo -u apr -H bash -lc '
cd /data/claude_project/ai-product-reliability-kit
/bin/bash ./rollback.sh
'
```

To choose a retained release:

```bash
sudo -u apr -H bash -lc '
cd /data/claude_project/ai-product-reliability-kit
/bin/bash ./rollback.sh --release <release-id>
'
```

Rollback switches application files and reloads PM2; it does not run database down migrations. Confirm that applied migrations remain compatible with the target release. Follow [Production Rollback](rollback.md) and use [Production Runbook](runbook.md) for diagnosis or an authorized restore.

## 17. Operating Checklist

Daily:

- Review both PM2 processes and restart counts.
- Review unresolved alerts/incidents and failed alert deliveries.
- Check readiness, backup logs, newest backup, and disk capacity.

Weekly:

- Verify a backup archive and checksum.
- Review retained releases/backups and product-key expiry/last use.
- Sample sensitive-operation audit records.

After schema, backup, or restore-tool changes:

- Run a disposable PostgreSQL restore drill.
- Inspect the migration ledger and disabled legacy alert migration advice.

After Nginx or TLS changes:

- Run `nginx -t`, local checks, public checks, and an external monitor failure/recovery test.

For exact incident, key-compromise, restore, database, Worker, and public-status procedures, keep [Production Runbook](runbook.md) available to the operator.
