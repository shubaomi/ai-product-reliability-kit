# Architecture

The kit is a monorepo with standards, SDKs, a CLI, a production dashboard, automation generators, templates, examples, and a Codex skill.

```mermaid
flowchart TD
  P["Product repositories"] --> C["CLI scanner"]
  C --> R["Reliability report"]
  C --> S["System passport draft"]
  K["Codex skill"] --> C
  K --> T["Templates"]
  STD["Core standard and schemas"] --> C
  STD --> SDK["Node/Python/Java SDKs"]
  SDK --> API["Collector API"]
  API --> DB["Postgres"]
  DB --> D["Dashboard UI"]
  DB --> SP["Public status pages"]
  DB --> IP["AI incident packages"]
  W["Scheduler worker"] --> M["Monitors"]
  M --> DB
  W --> A["Alert delivery hooks"]
  A --> DB
  G["product.yml"] --> AUTO["Automation generator"]
  AUTO --> M
  AUTO --> SP
```

## Components

| Component | Responsibility |
| --- | --- |
| Standard | Defines the contract, ingestion protocol, compatibility rules, and operational documents. |
| CLI | Scans projects, reports gaps, registers products, and pushes scan telemetry to the dashboard. |
| SDKs | Send product, event, error, health, and release envelopes to the collector API with optional API key auth. |
| Dashboard | Provides authenticated product inventory, health, event, error, release, monitor, alert, and incident views. |
| Postgres store | Persists products, telemetry, monitors, monitor runs, alerts, status pages, and incident packages. |
| Scheduler | Executes HTTP, collector, and event freshness monitors, then records monitor runs and alert deliveries. |
| Automation | Generates monitor definitions, alert rules, status page drafts, and AI incident package templates from `product.yml`. |
| Skill | Guides AI agents to audit and improve projects consistently. |
| Templates | Provide reusable docs, CI, product contract, and smoke test templates. |

## Runtime Data Flow

```mermaid
sequenceDiagram
  participant App as Product App
  participant SDK as SDK
  participant API as Collector API
  participant DB as Postgres
  participant Worker as Scheduler
  participant Operator as Operator

  App->>SDK: event/error/health/release
  SDK->>API: POST /api/ingest with API key
  API->>DB: validate, redact, persist
  Worker->>DB: load monitors and alerts
  Worker->>App: check health/readiness endpoints
  Worker->>DB: record monitor runs and alert deliveries
  Operator->>API: request incident package
  API->>DB: read recent context
  API-->>Operator: Markdown/JSON incident package
```

Local development can use JSON storage. Production should use Docker Compose with Postgres, auth enabled, and worker enabled.
