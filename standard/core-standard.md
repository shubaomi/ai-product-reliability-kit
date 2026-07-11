# AI Product Reliability Core Standard v1

This standard defines the minimum evidence needed to understand, monitor, test, and recover an AI-built product used by real users or revenue workflows. It does not force a framework, cloud, or observability vendor.

## Required Core Controls

1. **Product contract** — a valid `product.yml` naming stable product ID, owner, environments, critical journeys, dependencies, health paths, release source, rollback path, and supported standard version.
2. **Liveness and readiness** — shallow `/healthz`; dependency-aware `/readyz` when normal service depends on external systems.
3. **Release identity** — every error, event, health/release signal, and deployment identifies a version or Git SHA.
4. **Safe error evidence** — errors include product, environment, release, and safe request/user context without credentials or private payloads.
5. **Critical-journey evidence** — each important user outcome has a stable success event and, where practical, a paired failure event.
6. **Behavioral smoke/E2E tests** — critical paths execute real behavior, not source-text assertions or placeholder commands.
7. **CI quality gate** — deterministic install plus applicable lint/type/test/build/security/contract checks before release.
8. **Evidence-sourced System Passport** — concise product, feature, architecture, data/dependency, deployment, monitoring, and troubleshooting entries with source, time, and verification state.
9. **Runbook, backup, and rollback** — human-operable incident and recovery steps, including data/migration limitations.

## Product Contract and Publication

`product.yml` is parsed as formal YAML and validated against `product-contract.schema.json`; a regular-expression extraction or a plausible-looking document is not a valid contract. Compatible v1.x readers preserve older contracts and return warnings/migration advice.

`public_status` is optional and, when present, must contain a boolean `enabled`. Omission means private. Registration, health, or monitor data never makes a product public implicitly; only an explicit `public_status.enabled: true` decision allows the redacted Production projection.

The optional `verification.commands` entries are argument arrays, not shell strings. The CLI executes them with no shell through its bounded executable allowlist, applies the declared/default timeout, and distinguishes `success`, `failure`, `skipped`, and `unverified`. Generated placeholders, echo-only scripts, and non-allowlisted executables are skipped rather than promoted to verified evidence.

## Evidence Levels

Scanner and passport claims must distinguish:

| Level | Meaning |
| --- | --- |
| `declared` | A formal contract says the control should exist. |
| `detected` | Relevant implementation/configuration evidence exists. |
| `verified` | A safe command or runtime result proved the behavior. |
| `unverified` | Evidence is absent, ambiguous, placeholder-only, or could not safely run. |
| `stale` | Runtime evidence exists but is older than its freshness contract. |

A README mention, dependency name, generated template, echo-only script, or manual placeholder must not receive verified credit.

## Capability Levels

| Level | Meaning |
| --- | --- |
| L0 | Product boundary and owner are unknown. |
| L1 | Valid contract, owner, environments, health/release identity, and recovery docs exist. |
| L2 | Error/journey evidence, behavioral smoke tests, and CI gates are detected or verified. |
| L3 | Environment-scoped monitors, structured alerts, incidents, public-status decision, backup, and rollback exercise exist. |
| L4 | Central state/incident operations, evidence-sourced passport, restore exercises, and recurring reliability review operate. |

Partial adoption stays visible. A score is an evidence summary, not a substitute for operational state or production approval.

## Operational State Boundary

Runtime state is always scoped by `product_id + environment` and uses four values:

- `unknown` — missing/stale evidence or a configured critical monitor with no run; never silently healthy.
- `operational` — fresh successful evidence and no active reason.
- `degraded` — current noncritical failure, active noncritical structured alert, or active incident.
- `outage` — critical unresolved incident/alert or repeated critical health/monitor failure.

Compliance scans are a separate plane and cannot change these states. A successful Staging signal cannot mask Production.

Telemetry replay protection uses `product_id + environment + idempotency_key`. The same caller key in Staging and Production identifies two independent signals; replaying it in the same product/environment is accepted as a duplicate without storing a second record.

## Standard Versioning

Projects declare a major/minor version such as `1.0`. Compatible `1.x` minors add optional fields or deprecations only. Readers must keep old v1 contracts usable, emit warnings and migration advice, ignore unknown optional fields, and reject unknown majors explicitly. Required-field or semantic breaks require a new major.

## Minimum Production-V1 Evidence

A project is not production-ready merely because files exist. At minimum, the relevant controls above must be detected and the critical runtime/deployment behaviors must be verified in CI or the target environment. Any environment-gated or manual control must be labelled as such in its readiness record.

## Non-Goals

This standard does not require rewriting the product, building custom APM/logging/replay/BI, providing a general alert DSL or feature-flag service, adopting the central Dashboard before core controls exist, or replacing specialized vendors. Use the smallest verified control that closes the real operational risk.
