# Runbook

## First Response

1. Confirm whether the issue affects production users.
2. Check the latest release and recent configuration changes.
3. Check error tracking, logs, uptime checks, and core journey events.
4. Decide whether to roll back, disable a feature flag, or apply a hotfix.

## Triage Checklist

- Product:
- Environment:
- First seen:
- Affected users:
- Affected journey:
- Release:
- Error IDs:
- Related deployment:

## Common Checks

- `/healthz`
- `/readyz`
- Error tracking issues for current release.
- Failed core journey events.
- Payment/provider dashboards.
- Queue or background job status.

## Escalation

- Owner:
- Backup owner:
- User communication channel:

