# Progress Log

## Session: 2026-07-10

### Phase 1: Repository discovery, requirements verdict, and baseline

- **Status:** complete
- **Started:** 2026-07-10
- Actions taken:
  - Read the attached goal objective explicitly as UTF-8 and captured its scope and constraints.
  - Confirmed the native `/goal` is active for this task.
  - Loaded the `planning-with-files` workflow and its three templates.
  - Confirmed the initial Git worktree is clean on `main...origin/main`.
  - Reviewed the relevant prior PM2/Nginx deployment summary and preserved its canonical topology constraints.
  - Created durable task plan, findings, and progress records.
  - Inventoried all tracked files, read the root README/package scripts, checked recent Git history, and confirmed no repository-local `AGENTS.md` exists.
  - Ran the complete repository baseline `npm test` chain under Node 22/Python 3.13; all existing scripted stages completed.
  - Confirmed the configured local Java runtime is broken before startup, so existing "Java SDK static checks OK" is not compilation evidence.
  - Read the current standards, reusable skill/reference material, templates, example contract, placeholder example scripts, and example operational docs.
  - Performed a read-only active-repository technology inventory under `E:\Projects`; confirmed real Node, Python, and Java usage without changing other repositories.
  - Read the Dashboard server, configuration/security/validation flow, stores, scheduler/alert/incident modules, and initial schema sufficiently to identify direct acceptance failures in status isolation, product-key authorization, JSON handling, configuration safety, and migrations.
  - Audited production env, Docker, migration runner, root CI presence, Java check, and `deploy.sh`; confirmed missing root CI and non-atomic/destructive deployment behavior.
  - Read every existing Dashboard and SDK test plus CLI/Automation test entry points; classified which are behavioral and which are smoke/source-text checks.
  - Captured the baseline CLI report showing the placeholder example incorrectly scores 100/100.
  - Reproduced critical acceptance failures with read-only probes across status, environment isolation, monitor impact, alert threshold/dedup, malformed JSON, product-key ownership, platform health endpoints, and public-status publication control.
  - Confirmed Git Bash can parse the current deploy script while Docker/Postgres/Nginx/ShellCheck/PM2 remain unavailable locally.
  - Found a valid JDK 21 and Maven installation outside the broken PATH JDK17 shim, enabling real local Java compile/contract verification with command-local environment overrides.
  - Reviewed the emerging Phase 2 and operations failure-first test contracts to ensure they assert behavior, and required the Linux CI path to execute Windows-skipped symlink rollback cases rather than relying on text checks.
  - Read the complete CLI scanner/push flow and all three SDK implementations; identified regex parsing, false-evidence scoring, operational-health contamination, and missing production queue/retry semantics.
  - Read all native Dashboard HTML/JS/CSS and mapped the missing onboarding, product-detail, incident, passport, public-control, and resilient UI states.
  - Consolidated three parallel read-only audits into `docs/requirements-verdict.md`, including required, conditional, not-in-scope, and failure-first acceptance matrices.
- Files created/modified:
  - `task_plan.md` (created)
  - `findings.md` (created)
  - `progress.md` (created)
  - `docs/requirements-verdict.md` (created)

### Phase 2: Data, protocol, security, and API foundations

- **Status:** complete
- Actions taken:
  - Phase opened after the requirements verdict froze scope and implementation order.
  - Added failure-first Phase 2 server/security/store tests (initially 0/9) and migration tests (initially 0/2).
  - Implemented strict production config, validation/privacy, trusted-proxy and bucketed rate limiting, SSRF registration controls, product API Key lifecycle/scoping, audit logs, independent compliance scans, health/readiness, and versioned/checksummed/advisory-locked migrations.
  - Independently reran the complete Dashboard suite: 23 pass, 0 fail, 1 real-Postgres skip.
  - Independently reran the Postgres entry suite: 2 pass, 0 fail, 1 skip because `APR_TEST_DATABASE_URL` is unavailable locally; root Linux CI owns the real service execution.
- Files created/modified:
  - None.

### Phase 3: Runtime state, monitoring, alerts, incidents, and retention

- **Status:** complete (real PostgreSQL execution is CI-gated on this host)
- Actions taken:
  - Added desired-behavior tests for environment-isolated four-state derivation, fleet aggregation, structured alert rules, cadence, maintenance suppression, deduplication, acknowledgement, cooldown, and recovery.
  - Ran both tests before implementation; each failed with `ERR_MODULE_NOT_FOUND`, proving the required model/rule modules did not exist.
  - Implemented pure `status-model.mjs` and `alert-rules.mjs`; both focused behavior suites pass.
  - Added a failure-first incident lifecycle suite, confirmed the module was absent, then implemented immutable open/acknowledge/assign/link/resolve/reopen behavior with timeline and mandatory recovery notes; the focused suite passes.
  - Added failure-first retention coverage, then implemented non-mutating raw telemetry rollup/pruning with environment-isolated daily aggregates; focused tests pass.
  - Integrated environment-aware operational queries and the shared four-state model across memory, JSON, and PostgreSQL stores plus the server API.
  - Integrated per-monitor cadence/timeout/environment, pre-fetch SSRF revalidation, maintenance suppression, four structured alert types, stable lifecycle/deduplication, acknowledgement, resolution, and one recovery delivery.
  - Added persisted incident ownership/timeline/linked-alert/recovery flows, transactional PostgreSQL rollup and pruning, daily aggregates, API/worker separation, graceful in-flight draining, and advisory scheduler leasing.
  - Added migration `003_runtime_operations.sql` and behavioral server/store/scheduler/worker tests; the full Dashboard suite reports 34 pass, 0 fail, and one explicit real-PostgreSQL skip.

### Phase 4: Scanner, CLI, protocol contracts, and production SDKs

- **Status:** complete
- Actions taken:
  - Replaced regex-only configuration parsing with a shared YAML parser and JSON Schema validation, version compatibility guidance, and reusable protocol contract cases.
  - Implemented declared/detected/verified evidence, generated/template exclusions, honest placeholder scoring, and allowlisted safe verification with success/failure/timeout/skipped/unverified outcomes.
  - Kept compliance scan uploads independent from operational telemetry.
  - Confirmed through read-only inventory that active Node, Python, and Java projects require production SDK support.
  - Implemented publishable Node, Python, and Java packages with bounded queues, drop counters, stable idempotency, exact-batch retry, timeout, exponential backoff with jitter, failed-batch requeue, fail-open results, and shutdown flush.
  - Replaced the Java source-text assertion with a real Maven artifact and behavior/contract suite; JDK 21 compiled to Java 17 and all Maven tests passed.
  - Ran the root component regression: Standard 4/4, CLI 4/4, Node 4/4, Python 5/5, Dashboard 34 pass plus one explicit PostgreSQL skip, and Automation 2/2.

### Phase 5: Actionable Dashboard and public status

- **Status:** complete
- Actions taken:
  - Added a failure-first dynamic System Passport suite and confirmed the module was absent.
  - Implemented a source-labelled passport model combining only product registry, declared contract, scan evidence, and runtime signals; fresh/stale/unverified provenance is explicit and no missing fact is inferred.
  - Added failure-first public-status privacy coverage, then implemented an explicit-publication allowlist model that consumes shared production state and never exposes owner, raw reasons, internal body, keys, or private products.
  - Replaced the cumulative-count-first fleet page with an action-first operations desk driven by the shared environment-aware state, active incidents, and deduplicated alerts; unknown remains explicit.
  - Added authenticated three-step onboarding for the product registry, reveal-once scoped ingest key, and SSRF-validated first monitor.
  - Added product detail tabs for state reasons, release, monitors, journeys, ranged errors/events/runs, incident and alert operations, evidence-sourced passport, API key lifecycle, maintenance, and publication control.
  - Added incident open/acknowledge/assign/resolve flows with immediate UI feedback and mandatory recovery notes.
  - Added an explicit public-status management view and retained the server-side allowlist/redaction projection.
  - Implemented deterministic boot/loading/empty/error/long-content states plus an industrial control-room visual system with responsive mobile navigation and wrapped evidence content.
  - Added deterministic E2E store startup and ran five Playwright workflows on desktop Chromium and Pixel 7 profiles: 10/10 passed with horizontal-overflow and mobile stacking assertions.
  - Captured and visually inspected desktop/mobile product-detail screenshots; adjusted mobile tabs and toast stacking after inspection.

### Phase 6: Production operations, backup/restore, atomic release, rollback, and CI

- **Status:** complete (host-gated Linux checks remain explicit CI evidence)
- Actions taken:
  - Added restricted custom-format `pg_dump` backup, checksum/archive verification, guarded destructive restore, disposable restore drill, backup pruning, release pruning, and a pending-manual cron template.
  - Reworked deployment into immutable release directories with atomic `current`/`previous` links, pre-deploy backup, compatible migration, readiness acceptance, automatic prior-release restoration, and no `pm2 delete`.
  - Added independent rollback with pre-rollback backup, target containment checks, acceptance, and original-release restoration on rollback failure.
  - Added one API plus one Worker PM2 ecosystem; normal releases reload both, initial/transition releases start missing processes, and retained legacy releases use a safe single-process compatibility path.
  - Added strict pre-switch production configuration validation, including a real PBKDF2 password-hash format, distinct secrets, HMAC secret, trusted proxy boundary, canonical host/port, and PostgreSQL URL.
  - Added provider-neutral external liveness/readiness definitions that remain explicitly `PENDING MANUAL ENABLEMENT`.
  - Added root Linux CI jobs for all Node lockfiles/tests, independent SDK pack/install, Python, Java Maven, real Postgres migrations/retention/backup restore, desktop/mobile Playwright, dependency audits, Bash/ShellCheck, deployment simulations, and Nginx validation.
  - Locally ran operations tests: five passed and four Linux symlink cases skipped by platform; backup/restore command boundaries and retention executed. Git Bash syntax, PM2 config behavior, YAML parsing, Node pack, and Python wheel build passed.

### Phase 7: Full-system verification, documentation, readiness report, and local handoff

- **Status:** complete for locally available verification; authorized production/CI gates remain pending by design.

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Initial worktree check | `git status --short --branch` | Clean branch before goal changes | `## main...origin/main` | PASS |
| Root baseline suite | `npm test` | Existing repository suite completes | CLI scan, Node SDK, Python (2), Dashboard, Automation, Java static-check stages completed | PASS (baseline only) |
| Java PATH baseline | `java -version`; `javac -version` | Valid runtime/compiler version | Both fail opening `D:\Software\Java\jdk17.0.11\lib\jvm.cfg` | FAIL (broken PATH shim) |
| Targeted Java toolchain | `D:\Software\Java\jdk-21.0.10\bin\java.exe -version`; matching `javac.exe -version` | Valid runtime/compiler | Java/Javac 21.0.10, exit 0 | PASS |
| Placeholder scanner baseline | `node cli/src/index.mjs scan examples/node-nextjs --json --out .tmp/example-report.json` | Capture current faulty score | Placeholder example scored `100/100 (A)` with 0 missing controls | EXPECTED FAILING BEHAVIOR |
| Deployment shell syntax baseline | `D:\Software\Git\bin\bash.exe -n deploy.sh` | Current shell script parses | Exit 0 | PASS (syntax only) |
| Dashboard baseline suites | `npm --prefix apps/dashboard test` | Capture current server/store behavior | All 7 scripted groups completed | PASS (baseline only) |
| Compatible v1 minor probe | Collector envelope versions `1.1` and `1.9` | v1.x remains compatible | Both returned 400 | EXPECTED FAILING BEHAVIOR |
| Unknown major probe | Collector envelope version `2.0` | Explicit compatibility error | Generic 400 | EXPECTED FAILING BEHAVIOR |
| CLI verify baseline | `node cli/src/index.mjs scan examples/node-nextjs --verify` | Verify mode available | Exit 1, unknown option | EXPECTED FAILING BEHAVIOR |
| Node SDK network failure probe | Flush with rejecting fetch | Batch remains queued and fail-open result | Queue length became 0 | EXPECTED FAILING BEHAVIOR |
| Status model failure-first | `node apps/dashboard/test/status-model.test.mjs` | Desired state behavior available | Exit 1, missing `src/status-model.mjs` | EXPECTED FAIL BEFORE IMPLEMENTATION |
| Alert rules failure-first | `node apps/dashboard/test/alert-rules.test.mjs` | Desired rule/lifecycle behavior available | Exit 1, missing `src/alert-rules.mjs` | EXPECTED FAIL BEFORE IMPLEMENTATION |
| Status model focused suite | `node apps/dashboard/test/status-model.test.mjs` | Environment isolation and four-state cases pass | `Status model tests OK` | PASS |
| Alert rules focused suite | `node apps/dashboard/test/alert-rules.test.mjs` | Bounded rules, cadence, maintenance, lifecycle, dedup, recovery pass | `Alert rule tests OK` | PASS |
| Incident lifecycle failure-first | `node apps/dashboard/test/incident-lifecycle.test.mjs` before implementation | Incident workflow available | Exit 1, missing module | EXPECTED FAIL BEFORE IMPLEMENTATION |
| Incident lifecycle focused suite | `node apps/dashboard/test/incident-lifecycle.test.mjs` | Open/ack/owner/alerts/resolve/recovery/reopen pass | `Incident lifecycle tests OK` | PASS |
| Retention failure-first | `node apps/dashboard/test/retention.test.mjs` before implementation | Retention module available | Exit 1, missing module | EXPECTED FAIL BEFORE IMPLEMENTATION |
| Retention focused suite | `node apps/dashboard/test/retention.test.mjs` | Old raw data rolls up and prunes without mutation | `Retention tests OK` | PASS |
| System Passport failure-first | `node apps/dashboard/test/system-passport.test.mjs` before implementation | Dynamic passport available | Exit 1, missing module | EXPECTED FAIL BEFORE IMPLEMENTATION |
| System Passport focused suite | `node apps/dashboard/test/system-passport.test.mjs` | Source/time/verification labels and stale runtime behavior pass | `System passport tests OK` | PASS |
| Public status failure-first | `node apps/dashboard/test/public-status.test.mjs` before implementation | Safe publication model available | Exit 1, missing module | EXPECTED FAIL BEFORE IMPLEMENTATION |
| Public status focused suite | `node apps/dashboard/test/public-status.test.mjs` | Explicit publication, shared state, and redaction pass | `Public status tests OK` | PASS |
| Standard contract suite | `npm --prefix standard test` | Formal YAML/schema and v1.x compatibility behavior pass | 4/4 tests passed | PASS |
| Standard dependency audit | `npm --prefix standard audit --audit-level=high` | No high-severity dependency findings | 0 vulnerabilities | PASS |
| Phase 2 Dashboard regression | `npm --prefix apps/dashboard test` | Foundation and existing behavior pass | 23 pass, 0 fail, 1 Postgres skip | PASS |
| Phase 2 Postgres entry | `npm --prefix apps/dashboard run test:postgres` | Local tests pass; real PG runs when configured | 2 pass, 0 fail, 1 `APR_TEST_DATABASE_URL` skip | PASS with documented local gap |
| Continuation component matrix | Standard / CLI / Automation / Node SDK | Current component suites pass | 4/4, 4/4, 2/2, 4/4 | PASS |
| Python SDK continuation matrix | `python -m unittest discover -s sdks/python/tests -v` | Five resilience/contract tests pass | 4 pass, 1 error: closed enqueue consumes exhausted id factory | FAIL; targeted fix pending |
| Phase 3 integration red tests | `npm --prefix apps/dashboard test` | New incident/maintenance/status APIs integrated | First two Phase 3 API cases return 405 | EXPECTED FAIL; integration incomplete |
| Phase 3 store/status red suite | `node --test --test-timeout=5000 apps/dashboard/test/phase3-store-status.test.mjs` | Environment-isolated queries/status projection | 0 pass, 3 fail: missing store methods/API | EXPECTED FAIL BEFORE INTEGRATION |
| Phase 3 scheduler red suite | `node --test --test-timeout=5000 apps/dashboard/test/phase3-scheduler-integration.test.mjs` | Cadence, SSRF, alert lifecycle, maintenance | 0 pass, 4 fail | EXPECTED FAIL BEFORE INTEGRATION |
| Worker red suite | `node --test --test-timeout=5000 apps/dashboard/test/worker.test.mjs` | Independent leased worker | Missing `worker.mjs` | EXPECTED FAIL BEFORE INTEGRATION |
| Python SDK targeted fix | `python -m unittest discover -s sdks/python/tests -v` | Closed enqueue is fail-open without ID generation | 5/5 pass | PASS |
| Phase 3 full Dashboard regression | `npm --prefix apps/dashboard test` | Runtime/store/API/scheduler/worker integrations pass | 34 pass, 0 fail, 1 real-PostgreSQL skip | PASS with documented local gap |
| Java SDK Maven contract | JDK 21 + `mvn -f sdks/java/pom.xml test` | Compile for Java 17 and run resilience/shared-contract behavior | Maven wrapper and all behavior checks passed | PASS |
| Root post-Phase-4 regression | `npm test` | All non-Java local component suites pass | Standard 4, CLI 4, Node 4, Python 5, Dashboard 34+1 skip, Automation 2 | PASS |
| Dashboard Playwright acceptance | `npx playwright test` | Login, onboarding, incidents, passport/public redaction, loading/error, desktop/mobile layout | 10/10 passed | PASS |
| Dashboard visual review | Desktop and Pixel 7 onboarding/detail captures | Coherent hierarchy, safe wrapping, no document overflow | Reviewed; mobile tab visibility and toast stacking refined | PASS |
| Production password-hash failure-first | Targeted Phase 2 production config test | Malformed PBKDF2 hash fails closed | Initially missing rejection; implementation now passes | PASS |
| Operations behavior suite | `npm run test:ops` | Backup/restore boundaries, retention, PM2 topology, CI contract pass | 5 pass, 0 fail, 4 Linux symlink skips | PASS with documented host gaps |
| Bash syntax | Git Bash `bash -n deploy.sh rollback.sh scripts/ops/*.sh` | All scripts parse | Exit 0 | PASS |
| CI/config YAML parse | Shared YAML parser over workflow, Dependabot, Compose, external monitor | All formal YAML parses | Four files parsed | PASS |
| Node SDK package gate | SDK-local `npm ci`, tests, `npm pack --dry-run` | Independent package with no repository dependency | 4 tests and two-file tarball manifest passed | PASS |
| Python SDK wheel gate | `python -m pip wheel --no-deps ...` | Build installable 1.0.0 wheel | Wheel built successfully | PASS |

## Error Log

| Date | Error | Attempt | Resolution |
|------|-------|---------|------------|
| 2026-07-10 | Goal objective rendered as mojibake with default PowerShell decoding | 1 | Re-read using explicit UTF-8 decoding. |
| 2026-07-10 | `create_goal` rejected a duplicate because `/goal` had already created an active goal | 1 | Queried `get_goal`, confirmed the active wrapper objective, and continued under it. |
| 2026-07-10 | PATH `java` and `javac` cannot open the configured JDK `jvm.cfg` | 1 | Found working JDK 21 and Maven; use command-local `JAVA_HOME` and PATH without changing global configuration. |
| 2026-07-10 | Status and alert behavior tests could not import not-yet-implemented modules | 1 | Expected failure-first result; implement the narrowly scoped pure modules next. |
| 2026-07-10 | Alert error-spike fixture omitted product/environment and was correctly filtered out | 1 | Added the required dimensions to the test fixture; production telemetry always carries them. |
| 2026-07-10 | Manual Standard review requested two guessed test filenames that do not exist | 1 | Stopped guessing names; use `rg --files standard/test` or the package test glob, and asked the owner to list exact files. |
| 2026-07-10 | Python SDK enqueue after close invokes `id_factory` before checking closed state | 1 | Treat as implementation ordering bug; add closed guard before envelope/id creation. |
| 2026-07-10 | Phase 3 integration tests return 405 for incident and maintenance APIs | 1 | Expected red-test evidence from interrupted worker; implement the declared routes and store integration. |
| 2026-07-10 | Combined Phase 3 test run hung after a shutdown-path failure; unified exec backend could not send interrupt | 1 | Terminated only the exact test process trees and switched to bounded per-file runs with `--test-timeout=5000`. |
| 2026-07-10 | Onboarding E2E product heading locator matched both the page title and detail hero | 1 | Scoped the assertion to heading level 1; the complete onboarding behavior had already succeeded. |
| 2026-07-10 | Incident E2E created a record but the Overview tab did not expose it | 1 | Route to the product Incidents tab immediately after creation, preserving the successful API write and making follow-up actions visible. |
| 2026-07-10 | Node SDK package-lock generation exposed an accidental `file:../..` runtime dependency | 1 | Removed the circular repository dependency and made independent packaging part of CI verification. |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 7: full verification, documentation, readiness report, and local handoff. |
| Where am I going? | Align every required document, prove the objective item by item, clean the worktree, and leave a verified local Dashboard running. |
| What's the goal? | Deliver the attached production V1 contract without external mutation or false verification claims. |
| What have I learned? | See `findings.md`. |
| What have I done? | Read the objective, verified initial state, loaded the planning workflow, and created durable records. |

---

Update after every phase, test run, and material error.

## Session: 2026-07-11 — Independent Final Audit Remediation

- **Status:** complete for the local matrix
- Reopened completion after independent audits found behavior not covered by the first green matrix.
- Added failure-first integrity coverage and fixed:
  - enabled critical monitors with no run and active structured alerts in the shared four-state projection;
  - all-type `product_id + environment + idempotency_key` deduplication, cross-type collision rejection, batch atomicity, and product-envelope identity checks;
  - product-key fleet filtering, monitor/alert/status namespace ownership, cross-table ownership, and product-ID/public-slug collision guards;
  - LF/CRLF-stable migration checksums, migration 004, legacy environment backfills, disabled free-form alert advice, old-write compatibility triggers, deferred product claims, UTC retention buckets, and retention locking;
  - restore target selection, shared deploy/rollback locking, explicit post-switch rollback, worker stability acceptance, protected env copying, cron ownership, restore sentinels, and quiesced production restore;
  - complete YAML/manual onboarding, ingest-only product key, Node/Python/Java snippets, keyed write/session readback, first monitor, grouped errors, runtime journey signals, alert linking, and general desktop/mobile bounds;
  - bounded secret-free audit records for product, compliance, alert/status, incident, maintenance, scheduler, retention, and acknowledgement mutations;
  - Node/Python permanent HTTP retry classification and the first Node close/drain race.
- Independent PostgreSQL re-audit now reports no remaining confirmed blocker in its seven-finding slice. Real execution remains Linux-CI gated.
- A second completion audit found six additional P1s (cross-language shutdown races, periodic Worker rejection handling, DNS rebinding, structured config/incident validation, manual scheduler lease bypass, and disabled-monitor history). They are fixed and covered by targeted regressions plus the final matrix:
  - Node aborts retry backoff on the close deadline; Python and Java serialize flush/close, drain queued races, and bound joins to active flushes.
  - Periodic Worker failures are caught and reported without suppressing later ticks.
  - URL monitor execution pins the vetted DNS answer through the connection lookup, preventing a second DNS resolution from changing the target.
  - Monitor/alert/status-page/incident inputs return structured 4xx responses; automation registers its product before dependent artifacts.
  - Manual scheduler execution acquires the same lease as the Worker; disabled monitor history no longer affects four-state status; PostgreSQL upserts preserve `enabled=false`.
  - The final `npm test`, `npm run test:e2e`, Java clean verify, operations suite, SDK package/wheel checks, scanner, syntax, and diff checks passed with only named host gates skipped.
  - Local handoff Dashboard is running at `http://127.0.0.1:8787` against a temporary JSON store; `/healthz` and `/readyz` returned `{ ok: true }` and `/` returned HTTP 200.
