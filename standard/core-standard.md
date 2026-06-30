# AI Product Reliability Core Standard v1

This standard defines the minimum reliability contract for AI-built products that are already used by real users or may become revenue-generating systems.

The goal is not to force every project into the same architecture. The goal is to make every project understandable, observable, testable, and recoverable.

## Required Core Controls

Every product should provide:

1. **Product contract** - A `product.yml` file that identifies the product, owner, environments, critical journeys, dependencies, and supported standard version.
2. **Health checks** - A lightweight `/healthz` endpoint and, when dependencies matter, a `/readyz` endpoint.
3. **Release identity** - Every error, event, and deployment should carry a release version or Git SHA.
4. **Error tracking** - Production errors should be captured with product ID, environment, release, and user/session context when safe.
5. **Core journey events** - Each critical user journey should emit a success event and, when practical, a failure event.
6. **Smoke tests** - Critical paths should have at least one automated smoke or E2E test.
7. **CI quality gate** - Lint/typecheck/test/build/security checks should run before release where the stack supports them.
8. **System passport** - A concise document that explains features, architecture, data, dependencies, deployment, and troubleshooting.
9. **Runbook and rollback** - A human-readable guide for incident response and version rollback.

## Capability Levels

Use capability levels instead of all-or-nothing compliance.

| Level | Meaning |
| --- | --- |
| L0 | Unknown product; no product contract or operational docs. |
| L1 | Product contract, basic docs, health check, and release identity exist. |
| L2 | Error tracking, core journey events, CI gate, and smoke tests exist. |
| L3 | SLOs, alerts, status page, feature flags, and rollback exercises exist. |
| L4 | Central dashboard integration, automated incident package, and regular reliability review exist. |

The MVP CLI focuses on L0-L2 because those deliver the fastest safety improvement with low migration risk.

## Standard Versioning

Projects declare a standard version:

```yaml
standard_version: "1.0"
```

Rules:

- `1.x` may add optional fields only.
- Breaking changes require `2.0`.
- Central tools must keep reading old contracts and report upgrade advice instead of failing old projects.
- Projects declare capabilities so partial adoption is visible and safe.

## Minimal Compliance Definition

A project is minimally compliant with v1 when it has:

- `product.yml`
- `/healthz`
- release version source
- error tracking plan or implementation
- at least one critical journey with a success event
- system passport draft
- rollback guide

## Non-Goals

This standard does not require:

- A specific programming language.
- A specific cloud provider.
- Rewriting existing systems.
- Building a custom observability platform before using existing tools.
- Full line-by-line human review of AI-generated code.

