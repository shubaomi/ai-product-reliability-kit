# Release and Compatibility Standard v1

Every runtime and deployment signal should expose a Git SHA, package version, image tag, or release ID. The same value should appear in error/event/health evidence and the System Passport so operators can correlate a regression without guessing.

## Contract and API Compatibility

- Add optional fields before deprecating old fields.
- Keep compatible v1.x readers tolerant of unknown optional fields.
- Emit deprecation warnings and migration advice; reject only an unknown major or invalid contract.
- Preserve API response fields across the retained application release window.
- Support old mobile/browser clients according to the product's measured usage and sunset policy; this kit does not store secrets in those clients.

## Expand/Contract Database Changes

1. Add new nullable/defaulted structures without removing the old shape.
2. Deploy code that can operate across the release window; dual-read/write only where evidence requires it.
3. Backfill and verify separately when needed.
4. Deploy code that depends on the new shape.
5. Remove old structures only after retained releases and clients no longer need them.

The kit's migration runner is forward-only, transactional per migration, checksummed, recorded, and advisory-locked. Application rollback never implies a down migration. The current integrity upgrade keeps older application writes usable while introducing environment-scoped ingest deduplication, archives duplicate legacy status-page rows before adding uniqueness, and backfills structured alert-instance types.

Legacy free-form alert conditions are not trustworthy structured rules. During upgrade they are preserved for inspection, mapped only for compatibility, disabled, and given migration advice. Recreate the intended rule with an explicit product, environment, and one of the four supported rule types; do not blindly enable the migrated legacy row.

## Rollback Readiness

Document the current and previous release, exact rollback command, migration/data limitations, owner, verification endpoints, and notification path. Before switching releases, create and verify a database backup. After switching, accept both liveness and readiness; a public status 200 alone is insufficient.

Feature flags may be an application-specific mitigation if that product already owns a safe flag system. This standard does not require or provide a feature-flag service.
