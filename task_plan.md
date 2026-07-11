# Task Plan: AI Product Reliability Kit Production V1

## Goal

Complete the repository-scoped production V1 defined by `goal-objective.md`: trustworthy environment-isolated state, monitoring and alerting, security, scanner/CLI/SDK compatibility, durable Postgres operations, actionable Dashboard, production-safe PM2/Nginx release tooling, executable CI, aligned documentation, and evidence-backed verification—with no production deployment, external service mutation, commit, or push.

## Current Phase

Phase 7 — Full-system verification, documentation, readiness report, and local handoff

## Success Criteria

- Every requirement in the authoritative objective is mapped to implemented, conditional, or explicitly out-of-scope evidence in `docs/requirements-verdict.md`.
- All new behavior is covered by behavioral tests; no placeholder implementation, source-text assertion, or fake integration test is used as completion evidence.
- The explicit acceptance cases in the objective pass, including environment isolation, four-state derivation, cross-product 403, malformed JSON 400, alert lifecycle/dedup/recovery, monitor cadence, scanner evidence scoring, v1 compatibility, backup/restore, and simulated deployment rollback.
- Unit, integration, contract, security, E2E, and deployment checks are run and recorded. Host-unavailable checks are covered by Linux CI or reported honestly.
- `docs/production-readiness-report.md` identifies evidence, commands, results, limitations, manual production steps, and NOT IN SCOPE.
- The local Dashboard is running and reachable at handoff; Git contains only this goal's uncommitted changes.

## Phases

### Phase 1: Repository discovery, requirements verdict, and baseline

- [x] Read repository instructions plus README, docs, standard, skill, CLI, SDKs, Dashboard, automation, migrations, deployment assets, CI, and all tests.
- [x] Inventory tracked/untracked state and preserve all pre-existing user changes.
- [x] Record current architecture, data model, API/UI flows, test topology, and production constraints.
- [x] Run every locally available baseline suite and record exact commands/results.
- [x] Create `docs/requirements-verdict.md` with implemented / conditional / explicitly not-do classifications and requirement-to-evidence mapping.
- [x] Convert discovery into an implementation dependency order and regression-test matrix.
- **Verification:** baseline command log is complete; verdict covers every objective section; no non-goal files outside the repo changed.
- **Status:** complete

### Phase 2: Data, protocol, security, and API foundations

- [x] Add versioned transactional migrations with `schema_migrations` and concurrency protection.
- [x] Define protocol compatibility and validation boundaries for supported v1.x payloads.
- [x] Implement production config validation, request validation, privacy transforms, trusted-proxy/rate-limit boundaries, SSRF defense, and audit logging.
- [x] Implement product-scoped API key create/reveal-once/hash/scope/expiry/rotation/revocation/`last_used_at` lifecycle.
- [x] Add `/healthz` and `/readyz` with real dependency and migration readiness checks.
- **Verification:** failure-first unit/integration/security tests, including cross-product 403 and malformed JSON 400; real Postgres checks where available.
- **Status:** complete

### Phase 3: Trustworthy runtime state, monitoring, alerts, incidents, and retention

- [x] Isolate all operational state by `product_id + environment` and keep compliance scans separate.
- [x] Implement `unknown | operational | degraded | outage` derivation from health, monitor, freshness, and incident signals.
- [x] Make per-monitor interval, timeout, environment, maintenance window, thresholds, samples, windows, and baselines effective.
- [x] Implement the four structured alert rules, stable deduplication, cooldown, acknowledgement, resolution, and recovery notifications.
- [x] Implement incident lifecycle/ownership/timeline/recovery notes and state impact.
- [x] Add raw-data retention, cleanup, needed aggregates, API/worker separation, graceful shutdown, and single-scheduler locking.
- **Verification:** explicit state/alert/cadence/incident acceptance tests plus transactional/concurrency/retention Postgres integration tests.
- **Status:** complete (real PostgreSQL execution remains environment-gated to Linux CI)

### Phase 4: Scanner, CLI, protocol contracts, and production SDKs

- [x] Replace regex configuration parsing with YAML + JSON Schema validation and correct exclusions.
- [x] Implement declared/detected/verified evidence, honest scoring, and safe allowlisted `--verify` outcomes.
- [x] Add supported v1.x compatibility behavior, deprecation warnings, unknown-major errors, migration advice, and reusable contract fixtures.
- [x] Read-only inventory active Node/Python/Java projects under `E:\Projects` and classify language evidence.
- [x] Complete evidenced SDKs with packaging/versioning, timeouts, exponential backoff+jitter, bounded queues, idempotency, requeue, flush, fail-open, and dropped-event counters; mark unsupported thin adapters experimental.
- **Verification:** CLI behavioral tests, placeholder score regression, v1.0 compatibility tests, and cross-language contract tests.
- **Status:** complete

### Phase 5: Actionable Dashboard and public status

- [x] Prioritize actionable current problems on the home screen.
- [x] Implement end-to-end product onboarding and connectivity/first-monitor workflow.
- [x] Implement product detail with environment-aware state, releases, monitors, errors, journeys, alerts, ranges, filters, and actions.
- [x] Implement incident operation flows and dynamic evidence-sourced System Passport.
- [x] Make Public Status consume the same state model with explicit publication controls and redaction.
- [x] Add deterministic loading, empty, error, long-content, desktop, and mobile states.
- **Verification:** Playwright desktop/mobile flows for login, onboarding, details, incidents, public status, and layout overlap.
- **Status:** complete (validated YAML/manual onboarding, keyed connectivity, grouped errors, runtime journey signals, linked-alert incident flow, and 14 desktop/mobile E2E cases)

### Phase 6: Production operations, backup/restore, atomic release, rollback, and CI

- [x] Add `pg_dump` backup, restore, verification, restore-drill, retention, and cron assets for the PM2 environment.
- [x] Convert `deploy.sh` to version directories + atomic `current` symlink, compatible migration, health acceptance, and automatic rollback without `pm2 delete`.
- [x] Add independent `rollback.sh`, release retention, signal handling, and in-flight request draining.
- [x] Complete provider-neutral external monitoring assets and mark activation as manual.
- [x] Build root CI for lockfiles, Node, Python, Java, Postgres, Playwright, dependency/security checks, ShellCheck/bash syntax, and feasible Nginx validation.
- **Verification:** backup restores and verifies; deployment failure simulation rolls back; CI configuration executes real commands and Linux-only gaps are explicit.
- **Status:** complete (Linux symlink simulations, ShellCheck, real Postgres, and `nginx -t` remain configured CI gates because this Windows host lacks those runtimes)

### Phase 7: Full-system verification, documentation, readiness report, and local handoff

- [x] Run the complete unit/integration/contract/security/E2E/deployment verification matrix and fix failures.
- [x] Update README, architecture, dashboard, SDK, standard, production, runbook, rollback, roadmap, changelog, and Nginx documentation to match behavior.
- [x] Produce `docs/production-readiness-report.md` with implementation evidence, exact test results, limitations, manual production actions, and NOT IN SCOPE.
- [x] Review diff for scope purity, placeholder claims, secret leakage, and unsupported production-readiness language.
- [x] Start the usable local Dashboard and verify its access URL.
- **Verification:** all locally runnable checks pass, remaining environment-gated checks are honestly documented/covered in CI, no known P0 remains, and Git contains only goal changes.
- **Status:** complete for the locally available matrix; PostgreSQL/Linux CI, production activation, and external monitoring remain explicit authorized-operator gates.

## Key Questions

1. Which objective requirements are already complete, partially implemented, absent, or contradicted by current behavior?
2. Which test suites are genuinely behavioral, and which current checks only inspect source text or use fake persistence?
3. What is the smallest dependency order that avoids rewriting the existing Node.js/native Dashboard/Postgres architecture?
4. Which Node, Python, and Java SDKs have evidence from active local projects, and which must remain experimental?
5. Which checks cannot run on this Windows host and therefore require Linux CI or an explicit readiness limitation?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Treat the attached objective file as authoritative scope | The `/goal` wrapper only names the file; the file contains the actual delivery and acceptance contract. |
| Keep existing Node.js, native Dashboard, Postgres, PM2, and Nginx architecture | Explicit requirement; framework replacement would add scope and risk. |
| Use repository-root planning files | The goal spans many phases and contexts; durable local records are required by the selected planning skill. |
| Use failure-first behavioral tests for each change | Required by the objective and prevents false completion from source-text checks. |
| Never infer Linux validation from Windows | Prior repo evidence shows Bash/Nginx may be unavailable locally; CI/reporting must remain honest. |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Initial objective read displayed UTF-8 text as mojibake | 1 | Re-read explicitly with `Get-Content -Encoding UTF8`. |
| Goal creation reported an unfinished goal already exists | 1 | Queried the active goal and confirmed `/goal` had already registered the wrapper objective; continued under it. |
| PATH Java runtime/compiler cannot open configured `jvm.cfg` | 1 | Found valid JDK 21; use it via command-local environment overrides and retain Linux CI coverage. |
| New Phase 3 model tests initially fail with missing modules | 1 | Expected failure-first evidence; implement `status-model.mjs` and `alert-rules.mjs`. |
| Error-spike test fixture lacked state-isolation dimensions | 1 | Corrected the fixture to include `product_id` and `environment`. |
| Guessed Standard test filenames were wrong | 1 | Use repository file discovery before targeted reads; package test glob had already verified the actual suite. |
| Python SDK closed enqueue exhausts injected ID iterator | 1 | Move the closed/fail-open guard before ID generation and rerun all Python SDK tests. |
| Interrupted Phase 3 integration leaves new endpoints at 405 | 1 | Complete store/server/scheduler integration against the already-written behavior tests. |
| Combined Phase 3 red suite hung in incomplete shutdown path | 1 | Kill only owned test PIDs and use bounded per-file tests until `server.shutdown()` is implemented. |
| Onboarding E2E matched both page and hero headings | 1 | Keep the intentional repeated product name and scope the assertion to the page-level `h1`. |
| Newly opened incident was created but remained off-screen on Overview | 1 | Switch to the Incidents tab after creation so the operator gets immediate feedback and actions. |
| Node SDK package declared the repository root as a runtime dependency | 1 | Remove the accidental circular local dependency, regenerate its lockfile, and add pack/install gates to CI. |
| Final audit found status/dedup/ownership/restore/SDK/UI gaps after the first green matrix | 1 | Reopened Phases 5–7, added failure-first regressions, and fixed each confirmed invariant rather than treating prior passes as completion. |
| Local real-PostgreSQL execution is unavailable (`APR_TEST_DATABASE_URL`, Docker, and `psql` absent) | 1 | Added fresh-schema, legacy-upgrade, concurrency, ownership, replay, deferred-FK, and restore-sentinel CI gates; keep them explicitly unverified locally. |
| Long-running command output detached from the tool cell before final summary | 1 | Re-ran through a persistent command session and polled the actual process exit code; do not infer success from truncated output. |

## Guardrails

- Modify only `E:\Projects\ai-product-reliability-kit`; any `E:\Projects` technology inventory is read-only.
- Preserve pre-existing user changes and avoid unrelated refactors or cleanup.
- Do not commit, push, deploy production, mutate external services, or claim manual activation occurred.
- Do not add general alert DSL, full logging/APM/replay/BI, SaaS tenancy/billing, feature flags, cross-business rollback, broad vendor plugins, or unsupported SDK claims.
- Re-read this plan before major decisions and update it after each phase.
