# AI Product Reliability Kit

AI Product Reliability Kit is a local-first reliability control plane for small teams operating AI-built products. It combines a formal product contract, evidence-aware scanner, production server SDKs, an environment-isolated operations Dashboard, structured monitoring and incident workflows, and PM2/Nginx/PostgreSQL release tooling.

The production V1 implementation and its verification assets are present in this repository. That does **not** mean this checkout has been deployed, that external monitoring is active, or that manual Linux-only validation has passed for the current revision. Treat a gate as passed only when its result is recorded for the exact revision; start with the [complete server deployment guide](docs/server-deployment-guide.md), then use the [production reference](docs/production.md) and [readiness report](docs/production-readiness-report.md) for configuration and evidence.

## What Is Included

- `standard/` — YAML product contract, JSON Schemas, v1.x compatibility, health, event, release, and operational standards.
- `cli/` — Scanner with declared/detected/verified evidence, honest scoring, safe allowlisted `--verify`, report/passport output, and compliance upload.
- `sdks/` — Installable Node.js, Python, and Java 17 server SDKs with bounded queues, timeout/retry, idempotency, requeue, drop counters, and shutdown flush.
- `apps/dashboard/` — Native operations UI, validated YAML/manual onboarding, collector API, versioned PostgreSQL migrations, stores, state projection, incidents, public status, and an independently runnable worker.
- `automation/` — Provider-neutral monitor, four-rule alert, status-page, and incident-package generation from `product.yml`.
- `deploy/` and `scripts/ops/` — Two-process PM2 topology, external-monitor template, cron example, backup/restore/drill, release retention, and deployment simulations.
- `skill/ai-product-reliability/` — Reusable Codex audit/implementation workflow.
- `templates/` and `examples/` — Adoption starting points. The example intentionally contains placeholders and is expected to score below 100 until they are replaced and verified.

## Local Setup

Prerequisites: Node.js 20+ (production uses 22), npm, and Python 3.10+ for the Python SDK tests. Java 17+ and Maven are required for the Java contract.

```bash
npm ci
npm ci --prefix standard
npm ci --prefix cli
npm ci --prefix automation
npm ci --prefix apps/dashboard
```

Run the evidence-aware example scan:

```bash
node cli/src/index.mjs scan examples/node-nextjs --verify
```

Start the local JSON-backed Dashboard:

```bash
npm run dashboard
```

Open `http://127.0.0.1:8787`. Local mode is unauthenticated unless `APR_AUTH_REQUIRED=true`; production always fails closed unless auth, PostgreSQL, trusted-proxy, and secret settings are valid.

Use **Register product** to import and validate a complete `product.yml`, or build the same complete contract through the manual form. Publication defaults to private. Onboarding then reveals one product-scoped, ingest-only key, shows server-side Node/Python/Java snippets that read it from `APR_PRODUCT_API_KEY`, proves a keyed ingest plus operator readback, and unlocks the first environment-scoped monitor. The key value is shown once; store it in that product's server-side secret manager before leaving the step.

Useful CLI flows:

```bash
# Machine-readable report
node cli/src/index.mjs scan examples/node-nextjs --json --out .tmp/example-report.json

# Generate provider-neutral operations artifacts
node cli/src/index.mjs automate examples/node-nextjs --out .tmp/automation-example

# Upload a compliance scan (kept separate from operational health)
node cli/src/index.mjs push examples/node-nextjs --dashboard-url http://127.0.0.1:8787 --api-key "$APR_API_KEY"
```

Docker Compose is available for local PostgreSQL integration. It is not the production release mechanism:

```bash
cp .env.example .env
npm --prefix apps/dashboard run hash-password -- "choose-a-strong-password"
docker compose up -d --build
```

## Trust Model

- Operational state is computed per `product_id + environment` as `unknown`, `operational`, `degraded`, or `outage` from fresh health, configured monitors and their runs, active structured alerts, and unresolved incidents. A critical monitor with no run remains unknown; missing data never becomes healthy, and Staging cannot mask Production.
- Compliance scans are independent evidence and never change operational state.
- Only four structured alert rules exist: availability failure, telemetry stale, error spike, and critical-journey drop. The kit does not contain a general alert DSL.
- Product API keys are reveal-once, hashed at rest, product-scoped, expirable, rotatable, revocable, and limited to `ingest` and/or `read`. Product SDKs should use a product-scoped ingest key through the application-owned name `APR_PRODUCT_API_KEY`; the platform-wide ingest key is reserved for controlled migration/operations.
- Idempotency is scoped by `product_id + environment + idempotency_key` across all telemetry types. Reusing a key in Staging cannot suppress a Production signal.
- Public status is private by default, opt-in through the validated `public_status.enabled` boolean, Production-only, and projected through an allowlist that excludes owners, raw reasons, keys, payloads, and internal status-page bodies.
- Sensitive login, product/configuration, key, incident, maintenance, scheduler, and retention mutations produce bounded audit records without plaintext secrets or copied request bodies.
- Browser/mobile clients must not embed product keys. The production SDKs are server-side clients; untrusted clients should send through their own authenticated backend proxy.

## Production Topology

The supported production path is fixed:

```text
reliability.hihongrun.com
        ↓ Nginx
127.0.0.1:8787
        ↓
PM2 API:    ai-product-reliability-kit
PM2 Worker: ai-product-reliability-worker
        ↓
PostgreSQL
```

Source is `/data/claude_project/ai-product-reliability-kit`; activated release application contents are not edited in place under `/data/prod/ai-product-reliability-kit/releases`, with atomic `current` and `previous` links. A failed release may receive only the documented `.deploy-failed` diagnostic marker. `deploy.sh` backs up, migrates, switches, reloads, accepts, and automatically restores the prior release on failure. It never uses `pm2 delete`.

GitHub stores the reviewed source but performs no CI or deployment for this repository. An authorized operator pulls a clean reviewed commit on the server and runs the repository's atomic `deploy.sh`; Docker Compose is not used in production.

For a new server, follow the documents in this order:

1. [Complete server deployment guide](docs/server-deployment-guide.md) — Debian/Ubuntu packages, service account, PostgreSQL, secrets, DNS/TLS, Nginx, first deploy, PM2 startup, backup cron, external monitoring, later deploys, and rollback.
2. [Production configuration reference](docs/production.md) — fixed topology, environment variables, release semantics, backup/restore behavior, and operational constraints.
3. [Deployment acceptance checklist](docs/deployment-acceptance.md) — revision-specific Linux, PostgreSQL, Nginx, PM2, backup, rollback, and public endpoint evidence.
4. [Production runbook](docs/runbook.md) and [rollback guide](docs/rollback.md) — diagnosis, incidents, key compromise, restore, and recovery.

## Verification

```bash
npm test
npm run test:ops
npm run test:e2e

# Java (example)
mvn -f sdks/java/pom.xml verify
```

Real PostgreSQL, Linux symlink rollback, ShellCheck, and Nginx validation require a Linux environment and must be run manually before production. If they have not run for the current revision, treat them as unverified—not implied by local Windows success.

## Documentation

- [Architecture](docs/architecture.md)
- [Dashboard and API](docs/dashboard.md)
- [SDKs](docs/sdk.md)
- [Complete server deployment guide](docs/server-deployment-guide.md)
- [Production configuration reference](docs/production.md)
- [Deployment acceptance checklist](docs/deployment-acceptance.md)
- [Production readiness report](docs/production-readiness-report.md)
- [Runbook](docs/runbook.md)
- [Rollback](docs/rollback.md)
- [Roadmap and boundaries](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
