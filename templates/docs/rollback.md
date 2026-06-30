# Rollback Guide

## Last Known Good Version

- Version:
- Deployment time:
- Notes:

## Rollback Steps

1. Announce maintenance or degraded mode if users are affected.
2. Disable risky feature flags when available.
3. Roll back application deployment to the last known good version.
4. Confirm `/healthz` and `/readyz`.
5. Confirm critical journey smoke tests.
6. Monitor release-specific errors and conversion events.

## Data Migration Notes

- Was a database migration included?
- Is it backward compatible?
- Does rollback require data restore?

## Verification

- Health check:
- Core journey:
- Error rate:
- User-facing announcement:

