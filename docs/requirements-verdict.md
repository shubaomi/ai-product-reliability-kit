# Production V1 Requirements Verdict

## Authority and Scope Lock

This document resolves the implementation scope for the production V1 goal. The authoritative source is:

`C:\Users\hongr\.codex\attachments\85f7b2bd-457a-4192-922f-25868e4d98ec\goal-objective.md`

The repository must become an evidence-backed, long-lived production V1 while retaining the existing Node.js, native Dashboard, Postgres, PM2, and Nginx architecture. This is not permission to deploy, commit, push, modify another project, or operate an external service.

Verdict labels:

- **Required**: implement and verify in this goal.
- **Conditional**: keep a bounded extension point or existing evidenced integration; do not expand without the named trigger.
- **Not in scope**: explicitly excluded from implementation.

## Confirmed Baseline

| Area | Current evidence | Verdict |
| --- | --- | --- |
| Existing test chain | Root `npm test` completes under Node 22 and Python 3.13 | Baseline only; it includes command smoke checks and prohibited source-text checks. |
| Runtime state | No data is operational; Staging can mask Production; monitor failures and open incidents do not reliably affect state | P0; replace with one environment-isolated four-state model. |
| Authorization | Product key can write another product and ingest-only access can read fleet data | P0; enforce product and scope boundaries on every route/store operation. |
| Request safety | Malformed JSON returns 500; forwarded IP is trusted without a configured proxy boundary; monitor URLs accept loopback/private targets | P0; implement explicit 400 handling, trusted-proxy policy, separate rate limits, and SSRF validation. |
| Monitoring/alerts | Declared consecutive thresholds, cadence, environment, maintenance windows, deduplication, cooldown, and recovery are not enforced | P0; implement the four bounded rule types and real lifecycle semantics. |
| Scanner | Placeholder example scores 100/100; YAML is regex parsed; source/doc text is full-credit evidence; `--verify` does not exist | P0; implement schema-backed contracts and honest declared/detected/verified evidence. |
| Protocol | Collector accepts exactly `1.0`; `1.1` and `1.9` fail like unknown major versions | P0 compatibility failure; support v1.x and distinguish unknown major. |
| SDKs | Node/Python/Java queues are unbounded and lack the required resilience contract; Node loses a batch on network rejection | P0; all three languages have active-project evidence and require production clients. |
| Data | Startup replays one `001_initial.sql`; Postgres test searches SQL text | P0; implement versioned locked migrations and require real Postgres validation before production. |
| Dashboard | Single fleet table and cumulative metrics; no onboarding, environment detail, incident operations, passport, or publication controls | Required product work, not documentation-only. |
| Deployment | Direct rsync into live path plus `pm2 delete`; no backup, atomic switch, automatic rollback, or release retention | P0 production-readiness gap. |
| Validation/tooling | No root workflow/lockfile/Playwright; Java and Postgres checks match source text | Require lockfiles, Playwright, and reproducible manual Linux/Postgres checks before production. Git Bash is locally usable; Docker/Postgres/Nginx/ShellCheck/PM2 and a working JDK are not currently local. |

## Required Implementation

### 1. Work Discipline and Evidence

| Requirement | Resolution | Required evidence |
| --- | --- | --- |
| Read all repository surfaces and preserve unrelated work | Required; initial worktree was clean, and all goal changes remain uncommitted | `progress.md`, Git status, baseline command log |
| Maintain a phased plan and test after each phase | Required | `task_plan.md`, `progress.md` |
| Keep architecture and avoid unrelated rewrites | Required | Focused diff; no framework replacement |
| Prevent scope drift | Required | This verdict document |
| Do not finish with known P0s or only old tests passing | Required | Final readiness report and acceptance matrix |

### 2. Trustworthy State

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Isolate by `product_id + environment` | Required in storage, queries, summaries, status, monitors, alerts, incidents, and UI | Production failure is never overwritten by Staging success |
| Four states: unknown/operational/degraded/outage | Required as one shared derivation module | No data/stale = unknown; fresh passing critical signals = operational; noncritical failure = degraded; consecutive critical failure or critical incident = outage |
| Combine health, monitors, telemetry freshness, and unresolved incidents | Required | Monitor 500 and open critical incident affect current status |
| Keep compliance scans out of operational health | Required | CLI push writes a compliance scan record and leaves latest health unchanged |
| Platform `/healthz` and `/readyz` | Required | Liveness 200; readiness verifies DB connectivity, migrations, and required dependencies, returning 503 when not ready |

### 3. Monitoring and Alerts

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Only four structured rules | Required: `availability_failure`, `telemetry_stale`, `error_spike`, `journey_drop` | Validation rejects arbitrary DSL/rule types |
| Real per-monitor interval, timeout, and environment | Required | Independent cadence test and environment-specific monitor runs |
| Thresholds, samples, windows, baselines, maintenance | Required | Deterministic behavioral tests with injected clock/fetch |
| Alert lifecycle and stable dedup | Required: open/acknowledged/resolved, cooldown, recovery, recovery notification | Same fault does not notify every minute; recovery resolves and emits once |
| Notification providers | Generic webhook required; retain only already-evidenced adapters | No new provider list |

### 4. Security and Privacy

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Product API key lifecycle | Required: create, reveal once, hash, product/scope, expiry, rotate, revoke, last-used | API/integration tests never persist plaintext |
| Product and admin boundaries | Required on read and write paths | Cross-product access/write returns 403 |
| Production startup validation | Required for secrets, URLs, DB/store, auth, proxy, and unsafe defaults | Invalid production configurations fail with specific messages |
| Proxy/rate-limit boundary | Required with configured trusted proxies and separate login/ingest buckets | Forged XFF cannot bypass; login and ingest limits are independent |
| Request and telemetry validation | Required for JSON, body/batch/field limits, types, timestamp skew, URLs | Malformed JSON = 400; invalid envelopes never persist |
| Privacy policy | Required configurable allowlist, recursive redaction, and HMAC user identifiers | Sensitive values absent from stored payloads |
| Audit and SSRF | Required for sensitive operations and monitor targets | Audit records exist; loopback/private/link-local/dangerous protocols rejected |

### 5. Trustworthy Scanner and Compatibility

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Formal YAML and JSON Schema | Required and shared by CLI/Automation | Invalid YAML/schema returns actionable validation errors |
| Exclusions | Required for `.tmp`, generated output, templates, dependencies, and non-target examples while allowing a target that itself is an example | Fixture tests |
| Evidence levels | Required: declared/detected/verified with scoring caps | Docs/dependencies/placeholders never become verified or full score |
| Safe `--verify` | Required with built-in and user-configured allowlist, timeout, and success/failure/skipped/unverified results | A non-allowlisted command is never executed |
| Honest placeholder/security scoring | Required | Current placeholder example is below 100; an `npm audit` string is insufficient |
| v1.x compatibility | Required in shared fixtures and collector | v1.0 and compatible v1.x accepted; optional fields ignored; deprecated fields warn; unknown major returns explicit compatibility error |
| Migration advice | Required, non-breaking by default | Old projects continue to scan with structured suggestions |

### 6. Data Reliability

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Versioned migrations | Required: ordered files, `schema_migrations`, transaction, advisory lock, checksum/identity | Concurrent migration and upgrade tests on real Postgres |
| Retention and aggregates | Required configurable raw retention, cleanup task, and only the aggregates needed by state/alerts/UI | Retention integration test |
| Partitioning | Not required without data-scale evidence | No speculative partition subsystem |
| Backup/restore | Required `pg_dump`, restore, verification, drill, retention, cron example, and runbook | Linux/Postgres manual smoke plus documented full drill |
| Real Postgres integration | Required before production for migrations, constraints, transactions, queries, retention, backup/restore, and concurrency | No SQL-source matching accepted as substitute |

### 7. Actionable Dashboard

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Action-first home | Required | Current issues precede cumulative counts |
| Product onboarding | Required: create/import/validate/key/snippet/test/connectivity/first monitors | Desktop/mobile E2E flow |
| Product detail | Required with environment state, releases, monitors, errors, journeys, alerts, filters, and actions | Behavioral API and E2E tests |
| Incident closure loop | Required with owner, timeline, linked alerts, recovery note, state impact | Incident transitions reflected in status |
| Dynamic System Passport | Required from contract + scan + runtime, with source/time/verified state | No inferred claim rendered as fact |
| Public Status | Required to use shared state, explicit publication, and redaction | Non-public products absent; no internal details leak |
| Resilient responsive UI | Required login/onboarding/detail/incidents plus empty/loading/error/long text and no overlap | Playwright desktop/mobile |

### 8. SDK and Ingestion Boundary

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Language-neutral protocol and contracts | Required | Shared versioned fixture suite |
| Language classification | Node, Python, and Java are all production targets because active local projects evidence them | Inventory recorded in `findings.md` |
| Production resilience | Required in all three: configurable timeout, exponential backoff+jitter, bounded queue, idempotency, failed-batch requeue, shutdown flush, fail-open, drop counts | Cross-language behavior tests |
| Unsupported languages | Conditional thin adapters may be experimental only if added later | No unsupported production-ready claim |
| Browser/mobile SDKs | Not in scope | Document server-only/API-key boundary and backend proxy contract only |

### 9. Production Deployment and Self-Monitoring

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Fixed topology | Required: `reliability.hihongrun.com`, `127.0.0.1:8787`, canonical source/prod dirs, PM2 + Nginx | Config/docs/script assertions plus Linux validation |
| Atomic releases | Required version directories + `current`, install, backup, compatible migration, switch, PM2 reload, acceptance, automatic rollback | Failure simulation proves previous release restored; no `pm2 delete` |
| Independent rollback and retention | Required | Script behavior tests and runbook |
| Graceful shutdown | Required for SIGTERM/SIGINT and in-flight requests | Server integration test |
| API/worker separation and single scheduler | Required; worker uses Postgres advisory lock/lease when enabled | Two-worker integration test permits one scheduler pass |
| Complete Nginx/runbook/checklist | Required | Full copy-paste config and validation commands |
| External monitoring | Required provider-neutral config plus manual enablement steps | Clearly marked `PENDING MANUAL ENABLEMENT` until externally configured |

### 10. Testing, Manual Validation, Documentation, and Handoff

| Requirement | Resolution | Acceptance evidence |
| --- | --- | --- |
| Continuous CI | Not required: the user deploys by pulling a reviewed commit on the server. Run deterministic installs/lockfiles, Node, Python, Java, Postgres, Playwright, dependency/security, Bash/ShellCheck, and Nginx checks manually on Linux before production. | Deployment acceptance checklist and recorded results |
| Failure-first behavior tests | Required for every new behavior | Each implementation batch begins from a reproduced failing assertion |
| Explicit acceptance list | Required without substitutions | Final matrix in readiness report |
| Full suites and honest environment gaps | Required | Exact command/result ledger; local gaps are not labelled verified |
| Documentation alignment | Required for README, architecture, dashboard, SDK, standard, production, runbook, rollback, roadmap, changelog | Final doc audit |
| Readiness report | Required | `docs/production-readiness-report.md` |
| Local Dashboard handoff | Required | Running local address and final smoke check |

## Conditional Requirements

| Item | Trigger and verdict |
| --- | --- |
| Provider-specific alert adapters | Retain only repository-evidenced Generic Webhook and existing Feishu boundary. Do not add vendors. |
| Complex database partitioning | Trigger only with measured data-scale evidence. No current trigger; do not implement. |
| Additional language SDKs | Trigger only when a real active project uses the language. Current evidence requires Node/Python/Java only. |
| Multiple scheduler workers | Architecture must be safe if enabled; Postgres advisory lock is required. Do not add distributed orchestration beyond that. |
| External uptime service | Generate neutral config and manual steps only. Actual external activation remains unauthorized. |
| Local-only unavailable tools | Use a Linux or production-like validation environment where executable; otherwise list as a manual production-readiness action. Never claim local verification. |

## Explicitly Not in Scope

- A custom full logging platform, APM, or session replay system.
- Full BI, funnel, retention, or analytics product functionality.
- A general alert DSL.
- SaaS multi-tenancy, billing, or metering product work.
- A feature-flag service.
- Cross-business-system automated rollback.
- A broad notification/provider plugin marketplace.
- Multi-model consensus as a replacement for executable tests.
- Browser, mini-program, or mobile public SDKs.
- Speculative database partitioning without evidence.
- Production deployment, external-monitor activation, commits, pushes, or external-service mutation.
- Claims that the system will never require maintenance.

## Failure-First Acceptance Matrix

| Acceptance | Baseline | Required regression |
| --- | --- | --- |
| No data | Incorrectly operational | `unknown` |
| Production fail + Staging success | Production masked | Separate environment states |
| HTTP monitor 500 | Product remains operational | Degraded/outage per severity and threshold |
| Product key cross-product write | 200 | 403 |
| Malformed JSON | 500 | 400 |
| Consecutive alert threshold | Fires on first failure | Opens only at threshold |
| Repeated fault | Re-notifies each run | Stable dedup + cooldown |
| Recovery | No lifecycle | Resolves and notifies once |
| Per-monitor cadence | Global loop only | Independent due scheduling |
| Placeholder example | 100/100 | Honest sub-100 evidence result |
| Compatible v1 minor | 400 | Accepted with compatibility metadata |
| Unknown major | Generic 400 | Explicit compatibility error |
| CLI scan push | Writes health=true | Separate compliance signal |
| Backup/restore | No scripts/test | Restores and verifies |
| Deploy failure | Leaves switched/broken state | Automatic previous-release rollback |

This verdict is frozen for the goal. New functionality must map to a row above or receive explicit user authorization.
