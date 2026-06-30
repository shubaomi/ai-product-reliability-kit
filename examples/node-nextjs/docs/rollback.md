# Rollback Guide

## Rollback Steps

1. Identify the last known good Git SHA.
2. Roll back the deployment in the hosting provider.
3. Confirm `/healthz`.
4. Run the smoke test.
5. Watch release-specific errors and core journey events.

## Data Migration Notes

This example does not include a database migration.

