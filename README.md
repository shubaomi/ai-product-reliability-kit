# AI Product Reliability Kit

Reusable standards, SDKs, dashboard, automation, templates, a Codex skill, and a CLI for making AI-built products easier to understand, monitor, debug, and safely evolve.

The repository includes a production-ready v1 dashboard path: Postgres persistence, API key authentication, reliable ingestion validation, scheduled monitors, alert delivery hooks, public status pages, AI incident packages, Docker Compose deployment, and multi-language SDKs.

## What Is Included

- `standard/` - Core reliability standard, product contract schema, event, health, and release compatibility guidance.
- `cli/` - Dependency-light Node.js CLI that scans a project and reports missing reliability controls.
- `sdks/` - Lightweight Node, Python, and Java clients for the ingestion protocol.
- `apps/dashboard/` - Central dashboard, collector API, Postgres store, scheduler, status pages, and incident packages.
- `automation/` - Monitor, alert, status page, and AI incident package generator.
- `skill/ai-product-reliability/` - Codex skill for auditing or improving projects with this standard.
- `templates/` - Product contract, documentation, CI, and smoke test templates.
- `examples/node-nextjs/` - Minimal example project that follows the MVP standard.
- `docs/` - Architecture, production deployment, dashboard, SDK, automation, and roadmap notes.

## Quick Start

```bash
cd E:/Projects/ai-product-reliability-kit
node cli/src/index.mjs scan examples/node-nextjs
```

Start the dashboard:

```bash
npm run dashboard
```

Push the example product and scan result into the dashboard:

```bash
node cli/src/index.mjs push examples/node-nextjs
```

Generate monitors, alerts, status page, and AI incident package:

```bash
node cli/src/index.mjs automate examples/node-nextjs --out .tmp/automation-example
```

Register those generated operations artifacts with the running dashboard:

```bash
node cli/src/index.mjs automate examples/node-nextjs --out .tmp/automation-example --register-dashboard
```

## Production Deployment

Prepare `.env`, generate secrets, and run the Postgres-backed platform:

```bash
cp .env.example .env
npm --prefix apps/dashboard run hash-password -- "replace-with-a-strong-password"
docker compose up -d --build
```

Use `APR_MASTER_API_KEY` for admin CLI operations and `APR_INGEST_API_KEY` in product SDKs:

```bash
node cli/src/index.mjs push examples/node-nextjs --dashboard-url http://localhost:8787 --api-key replace-with-master-key
```

See `docs/production.md` for the full production setup.

Write a system passport draft into a target project:

```bash
node cli/src/index.mjs scan E:/Projects/my-product --write-passport
```

Create JSON output:

```bash
node cli/src/index.mjs scan E:/Projects/my-product --json --out report.json
```

## Use the Skill

The reusable Codex skill lives at:

```text
skill/ai-product-reliability
```

Copy or symlink that folder into your Codex skills directory when you want it auto-discovered. The skill tells an AI agent to audit a project with the same standard, use the CLI when available, generate a minimal adoption plan, and verify changes by rerunning the scan.

## MVP Success Criteria

A scanned project should produce:

- Product contract coverage.
- Missing reliability controls.
- Risk grade and weighted score.
- Prioritized adoption plan.
- System passport draft.

## Runtime Success Criteria

- SDKs send product, event, error, health, and release envelopes to `/api/ingest`.
- Dashboard shows registered products, health, events, errors, monitors, alerts, and public status pages.
- Automation generates provider-neutral monitor definitions, alert rules, status page draft, and AI incident package from `product.yml`.
- Production deployments use Postgres, authentication, API keys, scheduler execution, alert delivery records, and Docker Compose.

## Adoption Model

Existing projects should start with the CLI and templates. Do not rewrite the product first. Add the smallest missing controls in this order:

1. Product contract.
2. Health checks.
3. Error tracking and release version.
4. Core journey events.
5. CI checks and smoke tests.
6. Runbooks and rollback notes.

New projects should copy `templates/product.yml` and the docs/CI/test templates before feature work begins.
