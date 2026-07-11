# Findings & Decisions

## Requirements

- The authoritative objective is `C:\Users\hongr\.codex\attachments\85f7b2bd-457a-4192-922f-25868e4d98ec\goal-objective.md`.
- Scope is a complete, long-lived production V1 across code, migrations, tests, CI, operations, Dashboard, CLI, SDKs, documentation, and deployment readiness.
- Completion requires evidence-backed behavior, not placeholders, fake integration tests, or source-text assertions.
- Repository writes are limited to `E:\Projects\ai-product-reliability-kit`; other projects may only be inventoried read-only for Node/Python/Java usage evidence.
- No commit, push, production deployment, or external-service mutation is authorized.
- The production topology is fixed: `reliability.hihongrun.com` → Nginx → PM2 Node service at `127.0.0.1:8787`, source `/data/claude_project/ai-product-reliability-kit`, production `/data/prod/ai-product-reliability-kit`.

## Research Findings

- Initial Git status is clean on `main...origin/main`; there were no pre-existing user modifications or planning files at goal start.
- Relevant prior deployment work established the same domain, paths, port, PM2/Nginx model, and need for a full Nginx configuration.
- The prior Windows environment could not execute real Bash or Nginx validation. This goal must use Linux CI or explicitly list those checks as unverified locally.
- Existing top-level entry points observed before deep discovery include `README.md`, root `package.json`, `automation/package.json`, `cli/package.json`, `apps/dashboard/package.json`, `sdks/node/package.json`, and Java SDK documentation.
- No repository-local `AGENTS.md` is tracked; the user-supplied AGENTS instructions govern the work.
- The repository is compact and currently has one SQL migration (`apps/dashboard/db/migrations/001_initial.sql`), one Node server entry point, native static Dashboard assets, Node/Python/Java SDKs, a Node CLI, and generated-operation automation.
- Root `README.md` currently claims a production-ready v1 and describes Docker Compose production, while the authoritative objective requires evidence-backed production V1 and preserves PM2 + Nginx. Documentation claims therefore require re-verification, not trust.
- Root `npm test` chains CLI, Node SDK, Python SDK, Dashboard, Automation, and a Java source/compile check; its individual suites must be inspected for genuine behavioral coverage before treating a pass as evidence.
- After planning initialization, Git shows only the three goal-created planning files as untracked; `deploy.sh` remains executable in Git.
- Baseline runtime versions are Node `v22.22.1`, npm `10.9.4`, and Python `3.13.12`. The PATH-configured Java 17 installation is broken, but targeted discovery found a valid JDK 21 at `D:\Software\Java\jdk-21.0.10`; real Java compilation can run locally by setting command-local `JAVA_HOME`/PATH.
- The root `npm test` chain completed through all existing suites, but current CLI and Automation "tests" are only successful command execution; the Java step reports "static checks" and does not prove compilation. The Dashboard `postgres-schema.test.mjs` also requires inspection before it can count as real Postgres evidence.
- The bundled `examples/node-nextjs` is explicitly placeholder-heavy: package scripts only echo placeholder text, `captureError`/`trackEvent` log placeholders, readiness hard-codes dependencies true, and the passport labels a core action test as manual placeholder. Its current full score is therefore a required regression target.
- The current standard says v1 tools should keep old contracts readable and add optional fields, but `telemetry-envelope.schema.json` pins `schema_version` to exactly `1.0`; a compatibility layer is not yet evidenced.
- A read-only top-level `E:\Projects` inventory using the documented 180-day/dirty activity heuristic found strong Node evidence across many active products, Python evidence in active `learn-claude-code`, and Java/Maven evidence in active `Gua`. All three existing server SDK languages therefore require production-grade behavior; none can be dismissed as an unsupported experimental language.
- The technology inventory only examined Git metadata and language manifests/source presence. It did not modify or inspect business data in any other project.
- The current runtime status path is materially untrustworthy: `statusModel()` defaults every product without explicit failing health to `operational`, and Postgres `latestHealthByProduct()` collapses all environments under one product key. This directly violates both `unknown` semantics and environment isolation.
- Product API keys can be looked up and `last_used_at` updated, but server routes only check a generic `ingest` scope; they do not enforce `principal.product_id` against telemetry or product writes. Cross-product writes are therefore currently possible.
- `readJsonBody()` lets `JSON.parse` errors escape as 500, `clientIp()` trusts `x-forwarded-for` unconditionally, and production configuration falls back to a known development session secret. These are explicit acceptance/security failures.
- Postgres migration logic reads and executes only `001_initial.sql` on every startup. There is no `schema_migrations` ledger, per-file transaction, or concurrency lock.
- The schema contains API key records, incidents, monitor runs, and alert deliveries, but lacks the full lifecycle/state/audit/retention structures required by the objective; API key creation/rotation/revocation endpoints are absent.
- The server currently combines API and scheduler worker startup in one process and closes the store immediately on `close`; no readiness endpoint, graceful signal drain, or single-scheduler database lease is evidenced.
- There is no root `.github` CI workflow. The only workflow is inside the placeholder example and runs placeholder scripts, so it cannot satisfy repository production verification.
- `deploy.sh` currently rsyncs directly into the live directory, runs a single migration, calls `pm2 delete`, starts in place, and checks `/api/status`; it has no release directories, atomic symlink, backup, rollback, retention, or readiness acceptance. It directly contradicts the target deployment contract.
- `scripts/check-java-sdk.mjs` is exactly a prohibited source-text matching test. It must be replaced by a real compile/behavior/contract path.
- Production `.env.example` contains replace-me values, but current config loading does not reject them or validate URLs/secrets. Docker Compose also health-checks public `/api/status` rather than platform liveness/readiness.
- Existing Dashboard HTTP/security/CLI integration tests do exercise real in-memory/JSON server behavior, but they cover only happy paths and simple auth/redaction. They do not cover environment isolation, unknown state, product-key ownership, malformed JSON, readiness, incident lifecycle, or public redaction.
- `apps/dashboard/test/postgres-schema.test.mjs` only searches SQL source text for table/index names, so it is explicitly invalid as PostgreSQL integration evidence under the objective.
- Scheduler tests currently expect one alert delivery on each failed monitor in a single run; there are no tests for consecutive thresholds, stable dedup keys, cooldown, acknowledgement, recovery, maintenance windows, historical baselines, or independent cadence.
- Node and Python SDK tests use real local HTTP servers for one successful batch, but do not cover timeout, retry+jitter, bounded queue/drop counts, failed-batch requeue, idempotency, shutdown flush, or fail-open behavior.
- CLI and Automation package tests are command smoke executions with no assertions in their package scripts. Root baseline success therefore overstates scanner and generator correctness.
- The baseline scanner gives the known placeholder `examples/node-nextjs` exactly `100/100 (A)` with zero missing controls. It treats document mentions, dependency declarations, placeholder source, and echo-only CI scripts as passes; this is direct evidence for the scanner trust regression requirement.
- Read-only failure probes reproduced the objective's critical runtime defects: no-data status is `operational`; a later Staging success masks Production failure; HTTP monitor 500 does not change product status; an alert declaring two consecutive failures notifies on the first failure and again on the second; malformed JSON returns 500; a product key can write another product; `/healthz` and `/readyz` return 404; and products without publication enabled appear on public status.
- Current Windows tooling includes a usable Git Bash at `D:\Software\Git\bin\bash.exe`, a valid JDK 21, and Maven 3.6.3 (which needs command-local `JAVA_HOME` override). Docker, local Postgres, Nginx, ShellCheck, and PM2 are absent, so those validations remain CI/report items.
- The scanner is a single dependency-free file with regex YAML extraction and broad whole-repository text matching. Its ignore list omits `.tmp`, templates, and several non-target example/generated paths, explaining false evidence.
- CLI `push` currently converts a local compliance scan into a synthetic operational event plus health envelope. This explicitly violates the requirement to store scan/compliance as an independent signal.
- All three SDKs have unbounded in-memory queues and one-shot flushes. Node requeues an HTTP failure but has no timeout/retry/jitter; Python clears only after success but blocks with a fixed 10s request and no retry; Java lacks timeout/retry/requeue guarantees and only serializes a limited map shape. None currently exposes drop counts, close/shutdown flush, or fail-open result semantics.
- The native Dashboard is currently a single fleet table plus four cumulative metrics, health list, events, and errors. It has no product onboarding, environment-aware product detail, incident operations, System Passport, time filters, publication control, loading skeleton, or explicit page-level error/empty workflows; its prominence of cumulative counts conflicts with the actionable-work-first requirement.
- Client-side status derivation repeats the same faulty default (`health missing => operational`) instead of consuming one server-derived state model.
- New pure runtime modules now define the shared four-state precedence and the bounded alert-rule/lifecycle semantics. They are intentionally not yet wired into the stores/server while the Phase 2 foundation agent owns those files.
- A pure incident lifecycle module now supplies the required state transitions, ownership, linked alerts, timeline, mandatory recovery note, and reopen behavior; persistence/API/state integration remains pending.
- A pure retention module now defines safe cutoff validation and daily environment-isolated rollups before raw deletion; Postgres transactional cleanup and scheduled execution remain pending.
- A pure System Passport builder now combines only registry, declared contract, compliance evidence, and runtime inputs with source, timestamp, and declared/detected/verified/unverified/stale labels; API/UI persistence integration remains pending.
- A public-status projection now filters on explicit publication and exposes only name/slug/state/time/public summary/components; private products and internal diagnostic data are structurally excluded.
- Phase 2's new behavioral test contract covers production fail-closed config, malformed JSON, telemetry/privacy validation, proxy/rate buckets, SSRF, readiness, full product-key lifecycle/scoping, independent compliance scans, and secret-free audit logs. These assertions are materially stronger than the original happy-path suite.
- Operations tests include real fake-boundary execution for backup/restore/drill and, on symlink-capable Linux, successful atomic switch plus failed-deploy/failed-rollback restoration. Windows skips the symlink cases by design; root Linux CI must execute them before they count as verified.
- The new shared Standard package now passes formal YAML + JSON Schema validation and compatibility fixtures for supported v1.x optional/deprecated behavior and explicit unknown-major rejection; its dependency audit reports zero vulnerabilities.
- The integrated Phase 3 runtime path now passes environment isolation, four-state status, monitor cadence/SSRF/maintenance, alert lifecycle/recovery, incident operations, graceful shutdown, and single-worker lease behavior; real PostgreSQL execution remains unavailable locally and is wired into the Linux service job.
- Node, Python, and Java SDKs now share the required v1.x contract and production queue/retry semantics. Java is a real Maven artifact compiled locally for Java 17; the prohibited source-text checker has been removed.
- The native Dashboard now uses one server-derived state model across action queue, product detail, passport, and public status. Five desktop/mobile Playwright workflows cover real login, onboarding, incident recovery, public redaction, deterministic state UI, and layout overflow.
- Production execution now has an explicit one-API/one-worker PM2 ecosystem. This closes the prior hidden failure where production defaulted to API role while no independent worker was managed.
- Deployment now validates the same strict production configuration before creating/switching a release; malformed password hashes, shared secrets, missing HMAC/trusted-proxy settings, and noncanonical host/port fail before mutation.
- The first completion snapshot was not sufficient: independent behavioral probes found that configured-but-unrun critical monitors, active alert instances, error/health retries, project-key fleet reads, nested product identity, and globally keyed configuration ownership could still produce false state or cross-scope mutation. These now have explicit failure-first regressions.
- A single environment-scoped ingest ledger is the canonical idempotency boundary for product/event/error/health/release items. PostgreSQL keeps the old event conflict target usable during the rollback window by storing an environment-qualified hash while preserving the original client key; legacy event triggers also populate the ledger and reject cross-type reuse.
- Database relationship ownership needs more than separate foreign keys. Composite monitor/alert ownership constraints plus compatibility triggers now bind runs, instances, and deliveries to the same product/environment, while alert dedup keys are ownership-prefixed and event identity is immutable.
- Public status slugs and product IDs share a route namespace. Memory and PostgreSQL reject cross-owner collisions in both creation orders; migration 004 archives ambiguous/duplicate legacy pages before adding guards.
- Real PostgreSQL is absent locally. The CI fixture now creates isolated fresh and 001/002 legacy schemas, proves concurrent migration, adversarial key upgrades, old SQL writes, first-contact deferred product claims, ownership conflicts, retention concurrency, and exact backup/restore sentinels.
- Final UI evidence is broader than horizontal overflow: 14 Playwright cases cover desktop and Pixel 7 onboarding, grouped errors/journey signals, persisted incident state/alert linking, passport/public redaction, loading/error states, long content, viewport bounds, and sibling overlap.
- The second completion audit confirmed additional P1s not covered by the first matrix: shutdown must coordinate with in-flight SDK flush/backoff in all three languages; periodic Worker errors must not become unhandled rejections; DNS validation and connection must share one pinned resolution; structured monitor/alert/incident inputs require typed bounds; manual scheduling must share the Worker lease; disabled monitors must not contribute historical failures. All six were remediated with failure-first regressions and the final root, E2E, operations, Java, packaging, and syntax matrix passed. PostgreSQL/Linux execution remains an explicit CI gate rather than a local claim.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Build a requirements-to-evidence verdict before implementation | Prevents scope drift and exposes already-complete versus missing behavior. |
| Sequence foundations before state/monitoring, then clients/UI, then operations | Later layers depend on stable schema, auth, protocol, and environment dimensions. |
| Record every test command and result in `progress.md` | The objective requires auditable baseline and final verification evidence. |
| Keep compliance scan signals separate from operational health | Explicit trust-model boundary in the objective. |
| Treat Node, Python, and Java as evidenced production SDK targets | Active local projects exist for all three under the agreed read-only activity heuristic. |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| Objective initially decoded incorrectly | Re-read as UTF-8 before using any requirement text. |
| Native goal already existed with only the wrapper wording | Treat the referenced objective file as the authoritative execution contract while retaining the active goal. |
| PATH Java commands fail before reading the configured JDK | Use the discovered JDK 21 with command-local environment variables; keep the broken JDK17 shim out of verification. |

## Resources

- Authoritative objective: `C:\Users\hongr\.codex\attachments\85f7b2bd-457a-4192-922f-25868e4d98ec\goal-objective.md`
- Prior deployment memory: `C:\Users\hongr\.codex\memories\rollout_summaries\2026-06-30T14-49-14-9TyC-pm2_nginx_production_deploy_config_for_ai_product_reliabilit.md`
- Planning workflow: `C:\Users\hongr\.codex\plugins\cache\planning-with-files\planning-with-files\3.4.0\skills\planning-with-files\SKILL.md`

## Visual/Browser Findings

- No browser or visual inspection has been performed yet.

---

Update this file after every two discovery/view operations and after material architectural findings.
