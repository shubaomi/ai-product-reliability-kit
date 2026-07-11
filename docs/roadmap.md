# Roadmap and Scope Boundaries

This page is an implementation inventory, not a go-live certificate. Exact local results, skips, manual Linux/real-service gates, and activation state belong in `docs/production-readiness-report.md`.

## Production V1 Baseline — Implemented

- Formal YAML product contracts with JSON Schema validation, v1.x compatibility, deprecation warnings, and migration advice.
- Evidence-aware CLI scoring with declared/detected/verified distinctions, correct exclusions, safe allowlisted verification, honest placeholder handling, reports, passports, and independent compliance upload.
- Production Node.js, Python, and Java 17 server SDKs with packaging and a shared resilience/contract test matrix.
- Four versioned/checksummed/transactional PostgreSQL migrations with advisory locking, environment-scoped replay protection, legacy compatibility, and retention indexes.
- Environment-isolated four-state runtime projection from health, configured monitor coverage/results, active structured alerts, and incidents.
- HTTP, collector, and event-freshness monitors with individual cadence/timeout/environment and pre-fetch SSRF revalidation.
- Four structured alert rules with thresholds/baselines, deduplication, cooldown, acknowledgement, resolution, and one recovery delivery.
- Incident ownership, timeline, linked alerts, recovery notes, reopen, incident packages, and state impact.
- Raw retention with transactional daily rollup, independent API/Worker processes, scheduler lease, and graceful shutdown.
- Action-first native Dashboard, imported/manual schema-validated onboarding, reveal-once ingest-only key plus server SDK snippets, keyed write/operator readback, first monitor, product detail, alert-linked incident operation, evidence-sourced passport, and explicit private-by-default redacted public status.
- Bounded secret-free audit records for login and sensitive configuration/incident/key/operations mutations.
- Backup/restore/drill command boundaries, prepared atomic releases, automatic/manual rollback, retention, two-process PM2 config, complete Nginx config, provider-neutral external-monitor asset, and manual Linux validation guidance. Exact pass evidence remains revision-specific.

## Activation Work — Manual

These are environmental evidence and authorization steps that must be produced before a production go-live claim. A repository template is not a passed or activated control:

1. Run the applicable manual checks on Linux for the exact revision, including real PostgreSQL, symlink deployment simulation, ShellCheck, Playwright, dependency audit, Maven, and `nginx -t`.
2. Review and create the protected production env file, database role/database, filesystem ownership, and backup/restore-drill schedule.
3. Validate and install the complete Nginx configuration, then perform the deployment acceptance checklist.
4. Import the provider-neutral liveness/readiness checks into a selected external uptime provider, configure two regions/notifications, and record a safe failure/recovery test. Until then it remains `PENDING MANUAL ENABLEMENT`.
5. Establish an ongoing cadence for backup verification, disposable restores, dependency updates, incident review, and release/retention review.

## Conditional Post-V1 Extensions

Add these only when production evidence justifies their cost:

- Data partitioning after row volume/query evidence shows current indexes and retention are insufficient.
- Additional language SDKs after an active product in that language is identified.
- A specific alert/monitor provider adapter after the provider is selected and manual translation becomes a repeated burden.
- Additional long-term aggregates after a concrete operational decision needs them.
- Higher availability/multiple workers after load or recovery objectives require it; the advisory lease already provides the coordination boundary.

## Explicitly Not Planned

The kit will not prebuild a full log platform, APM, session replay, BI/funnel/retention suite, general alert DSL, feature-flag service, SaaS tenancy/billing, cross-business automatic rollback platform, broad vendor-plugin marketplace, or multi-model consensus system. Individual products may use existing specialized tools; this repository does not duplicate them.

## Compatibility Policy

- Read compatible v1.x contracts and telemetry; add optional fields in minor versions.
- Warn on deprecated fields and provide migration advice without breaking old v1 clients.
- Reject unknown major versions with an explicit compatibility error.
- Use expand/contract PostgreSQL migrations and keep every migration compatible with the retained previous application release.
- Reserve a major version for semantic or required-field breaks.
