# AI Product Reliability Kit

Reusable standards, templates, a Codex skill, and a lightweight CLI for making AI-built products easier to understand, monitor, debug, and safely evolve.

This repository is the stage 1 MVP. It focuses on project audit, product contract, documentation, and safe adoption. Runtime SDKs and a central dashboard are planned later.

## What Is Included

- `standard/` - Core reliability standard, product contract schema, event, health, and release compatibility guidance.
- `cli/` - Dependency-light Node.js CLI that scans a project and reports missing reliability controls.
- `skill/ai-product-reliability/` - Codex skill for auditing or improving projects with this standard.
- `templates/` - Product contract, documentation, CI, and smoke test templates.
- `examples/node-nextjs/` - Minimal example project that follows the MVP standard.
- `docs/` - Architecture and roadmap for later SDK/dashboard phases.

## Quick Start

```bash
cd E:/Projects/ai-product-reliability-kit
node cli/src/index.mjs scan examples/node-nextjs
```

Write a system passport draft into a target project:

```bash
node cli/src/index.mjs scan E:/Projects/my-product --write-passport
```

Create JSON output:

```bash
node cli/src/index.mjs scan E:/Projects/my-product --json --out report.json
```

## Use the Skill

The reusable Codex skill lives at:

```text
skill/ai-product-reliability
```

Copy or symlink that folder into your Codex skills directory when you want it auto-discovered. The skill tells an AI agent to audit a project with the same standard, use the CLI when available, generate a minimal adoption plan, and verify changes by rerunning the scan.

## MVP Success Criteria

A scanned project should produce:

- Product contract coverage.
- Missing reliability controls.
- Risk grade and weighted score.
- Prioritized adoption plan.
- System passport draft.

## Adoption Model

Existing projects should start with the CLI and templates. Do not rewrite the product first. Add the smallest missing controls in this order:

1. Product contract.
2. Health checks.
3. Error tracking and release version.
4. Core journey events.
5. CI checks and smoke tests.
6. Runbooks and rollback notes.

New projects should copy `templates/product.yml` and the docs/CI/test templates before feature work begins.
