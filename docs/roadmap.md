# Roadmap

## Stage 1: MVP Audit Kit

- Core standard and product contract.
- CLI scanner and report generator.
- System passport draft generator.
- Codex skill.
- Templates and example project.

## Stage 2: Runtime SDKs

- Define HTTP ingestion protocol. Done.
- Add Node.js/TypeScript SDK. Done.
- Add Python SDK. Done.
- Add Java standard-library client. Done.
- Provide framework adapters after the core SDKs are stable.

## Stage 3: Central Reliability Dashboard

- Product inventory from `product.yml`. Done.
- Error, event, release, and health aggregation. Done.
- Multi-product operational dashboard. Done.
- Postgres production store. Done.
- Authenticated dashboard and API keys. Done.
- Status page and alert routing hooks. Done.
- Provider-specific alert adapters. Next.

## Stage 4: AI-Assisted Operations

- One-command incident package. Done.
- Provider-neutral monitor and alert generation. Done.
- Status page draft generation. Done.
- Scheduler worker and alert delivery records. Done.
- Release regression analysis. Next.
- Codex plugin integration for dashboard-aware debugging. Next.

## Production v1

- Docker Compose deployment with Postgres. Done.
- Migration runner and password hash tooling. Done.
- Public status page and machine-readable status API. Done.
- Authenticated CLI push and automation registration. Done.
- Cross-language SDK API key support. Done.

## Upgrade Policy

- Keep v1 contracts readable.
- Add optional fields in minor versions.
- Reserve breaking changes for major versions.
- Provide CLI migration advice before requiring project changes.
