# Architecture

The kit is a monorepo with standards, SDKs, a local dashboard, automation generators, templates, examples, and a Codex skill.

```mermaid
flowchart TD
  P["Any product repository"] --> C["CLI scanner"]
  C --> R["Reliability report"]
  C --> S["System passport draft"]
  K["Codex skill"] --> C
  K --> T["Templates"]
  T --> P
  STD["Core standard and schemas"] --> C
  STD --> K
  SDK["Node/Python/Java SDKs"] --> API["Dashboard collector API"]
  P --> SDK
  API --> D["Local dashboard"]
  A["Automation generator"] --> M["Monitors, alerts, status page, incident package"]
  C --> A
```

## Components

| Component | Responsibility |
| --- | --- |
| Standard | Defines the contract and compatibility rules. |
| CLI | Scans projects, reports gaps, and generates passport drafts. |
| SDKs | Send product, event, error, health, and release envelopes to collectors. |
| Dashboard | Provides local product inventory, health, event, error, release, monitor, and alert views. |
| Automation | Generates provider-neutral operations artifacts from `product.yml`. |
| Skill | Guides AI agents to audit and improve projects consistently. |
| Templates | Provide reusable docs, CI, product contract, and smoke tests. |
| Examples | Prove the MVP can scan a representative project. |

## Data Flow

```mermaid
flowchart LR
  A["Product SDK/Adapter"] --> B["Collector API"]
  B --> C["Local JSON storage"]
  C --> D["Central Dashboard"]
  G["product.yml"] --> H["Automation generator"]
  H --> E["Alerts"]
  H --> F["AI Incident Package"]
```
