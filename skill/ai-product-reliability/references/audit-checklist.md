# Audit Checklist

Use this checklist to audit a project against the AI Product Reliability Standard v1.

## Required Evidence

- `product.yml` declares product ID, owner, environments, critical journeys, health, release, and capabilities.
- `/healthz` exists and returns product ID, environment, release, timestamp, and ok status.
- `/readyz` exists when dependencies can block traffic.
- Error tracking is connected or intentionally documented.
- Critical journeys have success events and high-risk journeys have failure events.
- Release version or Git SHA is attached to health, errors, logs, and events.
- Smoke/E2E tests cover health and at least one critical user journey.
- CI runs meaningful checks for the stack.
- `docs/system-passport.md` explains features, architecture, data, dependencies, deployment, observability, and troubleshooting.
- `docs/runbook.md` explains first response and triage.
- `docs/rollback.md` explains rollback steps and migration limits.

## Risk Ordering

1. No product contract.
2. No health check.
3. No rollback guide.
4. No error tracking.
5. No release identity.
6. No core journey events.
7. No smoke tests.
8. No CI quality gate.
9. No runbook.
10. No security maintenance.

## Capability Levels

- L0: Unknown product; no contract or docs.
- L1: Contract, health, release identity, and docs exist.
- L2: Error tracking, core events, CI, and smoke tests exist.
- L3: SLOs, alerts, status page, feature flags, and rollback exercises exist.
- L4: Central dashboard, incident package, and regular reliability review exist.

