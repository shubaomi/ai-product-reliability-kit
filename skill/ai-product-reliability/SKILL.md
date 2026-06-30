---
name: ai-product-reliability
description: Audit and improve AI-built products against the AI Product Reliability Standard. Use when reviewing or upgrading a website, app, mini program, SaaS, internal tool, or AI-generated codebase for production readiness, observability, health checks, product contracts, CI gates, smoke tests, rollback docs, incident runbooks, release compatibility, or system passport documentation.
---

# AI Product Reliability

## Overview

Use this skill to make a project safer to operate without rewriting it first. Prefer small, verifiable changes: product contract, health checks, release identity, SDK telemetry, error tracking, core events, smoke tests, CI, dashboard registration, automation artifacts, system passport, runbook, and rollback guide.

## Workflow

1. Inspect the repository before proposing changes.
2. If the kit CLI is available, run `node <kit>/cli/src/index.mjs scan <project>` and use the report as evidence.
3. Read `references/audit-checklist.md` before auditing.
4. For implementation work, read `references/implementation-guide.md`.
5. For existing projects or standard version changes, read `references/migration-guide.md`.
6. Make the smallest changes that move the project to the next capability level.
7. For runtime integration, use the SDK docs in `docs/sdk.md` and the ingestion protocol in `standard/ingestion-protocol.md`.
8. For dashboard work, use `docs/dashboard.md` and prefer the local collector before external providers.
9. For automation, run `node cli/src/index.mjs automate <project> --out <dir>`.
10. Verify with the project test/build commands and rerun the kit scan.

## Decision Rules

- Do not require a dashboard or SDK before basic reliability controls exist.
- Do not force a framework change.
- Do not add business-specific events without naming the critical journey they prove.
- Treat missing rollback guidance as a production risk.
- Prefer compatibility warnings over breaking old projects.
- For existing production systems, avoid invasive refactors unless the current architecture blocks observability or rollback.
- Prefer provider-neutral monitor and alert definitions before hard-coding an external service.

## Output Shape

When auditing, report:

1. Current capability level.
2. Missing controls ordered by risk.
3. Minimal implementation plan.
4. Verification commands.
5. Generated or updated docs.

When implementing, include a concise summary of changed files and verification evidence.
