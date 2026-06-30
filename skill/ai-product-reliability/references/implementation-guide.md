# Implementation Guide

Apply the smallest safe change first.

## Existing Project Order

1. Add `product.yml`.
2. Add `/healthz`.
3. Add `docs/system-passport.md`, `docs/runbook.md`, and `docs/rollback.md`.
4. Add release identity from Git SHA, package version, or deployment ID.
5. Connect error tracking.
6. Add core journey events.
7. Add smoke tests.
8. Add CI checks.
9. Add readiness checks and dependency checks.
10. Add SDK telemetry if the product has runtime traffic.
11. Register the project with the dashboard using `node cli/src/index.mjs push <project>`.
12. Generate operations artifacts using `node cli/src/index.mjs automate <project> --out <dir>`.

## New Project Order

Start from templates:

- `templates/product.yml`
- `templates/docs/system-passport.md`
- `templates/docs/runbook.md`
- `templates/docs/rollback.md`
- `templates/docs/incident-report.md`
- `templates/ci/github-actions.yml`
- `templates/tests/playwright-smoke.spec.ts`

## Health Check Pattern

Return fast JSON with:

- `ok`
- `product_id`
- `environment`
- `release`
- `time`

Do not expose secrets, connection strings, stack traces, tokens, raw prompts, or private data.

## Event Pattern

Name completed outcomes in lowercase snake case:

- `user_signed_up`
- `checkout_succeeded`
- `ai_generation_succeeded`

For high-risk journeys, also emit failure events.

## Verification

After changes:

1. Run the project test/build commands.
2. Run the kit CLI scan again.
3. Confirm score increased or missing high-risk items decreased.
4. If docs were generated, skim for inaccurate assumptions.
5. If SDK telemetry was added, send a test event to the dashboard and confirm `/api/summary` changes.
6. If automation artifacts were generated, confirm monitors, alerts, status page, and incident package exist.
