# Changelog

All notable repository changes are documented here. Versions follow the individual package manifests; the repository-wide production V1 work is currently unreleased.

## Unreleased — Production V1

### Added

- Formal YAML + JSON Schema product parsing, schema-validated private-by-default `public_status`, shared v1.x protocol negotiation, deprecation warnings, migration advice, and cross-language fixtures.
- Evidence-aware CLI scanner with safe allowlisted verification and independent compliance-scan upload.
- Production-resilient Node.js, Python, and Java 17 server SDK packages.
- Four versioned/checksummed/transactional PostgreSQL migrations, API key lifecycle, bounded secret-free audit records, compliance scans, retention aggregates, maintenance windows, alert instances, incidents, and scheduler lease.
- Environment-scoped ingest replay protection for all telemetry types plus compatibility handling for legacy event uniqueness, alert rows, and duplicate status pages.
- Environment-isolated `unknown | operational | degraded | outage` model from health, configured monitor coverage/results, active structured alerts, and incidents, shared by operator and public projections.
- Per-monitor cadence/timeout/environment, immediate SSRF revalidation, four structured alert rules, deduplication/cooldown/acknowledgement/recovery, and incident lifecycle.
- Independent API and Worker entry points plus a two-process PM2 ecosystem.
- Action-first responsive Dashboard with imported/manual validated onboarding, reveal-once ingest-only product key, Node/Python/Java `APR_PRODUCT_API_KEY` snippets, keyed connectivity/readback, first monitor, alert-linked incidents, passport/public status, and desktop/mobile Playwright coverage.
- PostgreSQL backup, verification, guarded restore, disposable restore drill, backup/release retention, cron template, atomic deploy, independent rollback, and provider-neutral external-monitor template.
- Manual Linux validation guidance for deterministic installs, Node/Python/Java/PostgreSQL/Playwright contracts, dependency audit, Bash/ShellCheck, deployment simulations, and Nginx syntax.
- Start-to-finish Debian/Ubuntu server deployment guide covering service-account setup, PostgreSQL provisioning, protected production configuration, DNS/TLS/Nginx integration, PM2 startup, backup cron/logrotate, acceptance, routine releases, and rollback.
- Production readiness, deployment acceptance, and requirement-verdict documentation.

### Changed

- Compliance evidence no longer creates synthetic operational health/event signals.
- Missing or stale runtime evidence now remains `unknown`; successful Staging evidence cannot mask Production.
- Public status is private by default, schema-validated opt-in, Production-only, and allowlisted.
- Legacy free-form alert rows upgrade into disabled compatibility records with their original condition and migration advice; operators must recreate reviewed structured rules.
- Production deployment is PM2 + Nginx + PostgreSQL with atomic activated releases; Docker Compose is local integration only, and a failed release may receive the documented diagnostic marker.
- Production configuration fails closed for unsafe binding/storage/auth/proxy/secret/password-hash settings.

### Removed

- Source-text-only Java verification.
- Regex-only product configuration parsing.
- Placeholder evidence receiving a perfect scanner score.
- In-place deployment and `pm2 delete` release behavior.

### Activation Status

- No production deployment, Git push, external monitor activation, or external service mutation was performed by this change.
- Configured Linux-only and real-PostgreSQL gates must pass for the exact revision before production authorization; their presence is not a pass result. See `docs/production-readiness-report.md`.
