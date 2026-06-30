# Release and Compatibility Standard v1

Small teams need release practices that reduce breakage without requiring a large platform team.

## Release Identity

Every runtime should expose a release value from one of:

- Git SHA.
- Package version.
- Container image tag.
- Deployment platform release ID.

The value should appear in:

- Error tracking.
- Logs.
- Product events.
- Health checks.
- System passport.

## Compatibility Rules

- Add fields before removing fields.
- Keep API responses backward compatible across one release window.
- For mobile apps and mini programs, support old clients until usage is low enough to sunset.
- Use database expand-contract migrations for breaking schema changes.
- Use feature flags for risky user-facing changes.
- Keep rollback instructions current for each deployment target.

## Expand-Contract Database Migration

1. Expand: add nullable/new fields and keep old fields.
2. Dual read/write if needed.
3. Backfill data.
4. Deploy code that only needs the new shape.
5. Contract: remove old fields after old code and clients are gone.

## Rollback Readiness

Each product should document:

- Last known good deployment.
- Rollback command or platform steps.
- Data migration rollback limitations.
- Feature flags or kill switches.
- Owner and notification channel.

## Deprecation Policy

When a standard or product contract changes:

- Keep old versions readable.
- Emit upgrade warnings, not hard failures.
- Provide automated migration advice.
- Require manual review only for breaking data or API changes.

