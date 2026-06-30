# Migration Guide

Use versioned contracts so old projects do not break when the standard evolves.

## Contract Versioning

Projects declare:

```yaml
standard_version: "1.0"
capabilities:
  health_check: true
  error_tracking: false
```

Rules:

- Minor versions may add optional fields.
- Major versions may introduce breaking changes.
- Tools should read old versions and report upgrade advice.
- Do not force old production systems to upgrade during unrelated feature work.

## Migration Strategy

1. Scan current state.
2. Identify missing high-risk controls.
3. Add optional fields first.
4. Keep old field names readable until all tools support the new version.
5. Update templates after tools support the new contract.
6. Mark old fields deprecated before removing them.

## Existing Production Systems

- Avoid architecture rewrites during reliability adoption.
- Prefer wrappers, adapters, and docs.
- Add release and event metadata at boundaries before changing business logic.
- Treat database and API compatibility as separate migration plans.

