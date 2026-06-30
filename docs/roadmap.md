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
- Status page and alert routing integrations. Provider adapters next.

## Stage 4: AI-Assisted Operations

- One-command incident package. Done.
- Provider-neutral monitor and alert generation. Done.
- Status page draft generation. Done.
- Release regression analysis. Next.
- Codex plugin integration for dashboard-aware debugging. Next.

## Upgrade Policy

- Keep v1 contracts readable.
- Add optional fields in minor versions.
- Reserve breaking changes for major versions.
- Provide CLI migration advice before requiring project changes.
