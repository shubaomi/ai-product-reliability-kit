import assert from "node:assert/strict";
import { aggregateFleetStatus, deriveEnvironmentStatus } from "../src/status-model.mjs";

const NOW = new Date("2026-07-10T12:00:00.000Z");

assert.equal(derive({}).status, "unknown", "no signals must be unknown");

const production = derive({
  environment: "production",
  healthChecks: [
    health(false, "production", 2),
    health(false, "production", 1),
    health(true, "staging", 0)
  ]
});
assert.equal(production.status, "outage", "staging success must not mask consecutive production failures");

const staging = derive({
  environment: "staging",
  healthChecks: [
    health(false, "production", 1),
    health(true, "staging", 0)
  ]
});
assert.equal(staging.status, "operational");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  monitorRuns: [monitor(true, "critical-api", "critical", 1)]
}).status, "operational");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  monitorRuns: [monitor(false, "optional-search", "medium", 1)]
}).status, "degraded", "non-critical failures must degrade");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  monitorRuns: [
    monitor(false, "critical-api", "critical", 2),
    monitor(false, "critical-api", "critical", 1)
  ]
}).status, "outage", "consecutive critical monitor failures must cause outage");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  incidents: [{
    product_id: "product-a",
    environment: "production",
    severity: "critical",
    status: "open",
    updated_at: ago(0)
  }]
}).status, "outage", "critical open incidents must cause outage");

assert.equal(derive({
  healthChecks: [health(true, "production", 30)]
}).status, "unknown", "stale health must be unknown");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  configuredMonitors: [{ id: "critical-unrun", product_id: "product-a", environment: "production", severity: "critical", enabled: true }]
}).status, "unknown", "an enabled critical monitor must run before status can be operational");

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  configuredMonitors: [{ id: "retired-critical", product_id: "product-a", environment: "production", severity: "critical", enabled: false }],
  monitorRuns: [monitor(false, "retired-critical", "critical", 1)]
}).status, "operational", "historical failures from a disabled monitor must not keep the product in outage");

for (const ruleType of ["telemetry_stale", "error_spike", "journey_drop"]) {
  assert.equal(derive({
    healthChecks: [health(true, "production", 1)],
    activeAlerts: [activeAlert(ruleType, "high")]
  }).status, "degraded", `${ruleType} must affect operational status`);
}

assert.equal(derive({
  healthChecks: [health(true, "production", 1)],
  activeAlerts: [activeAlert("availability_failure", "critical")]
}).status, "outage", "a critical active availability alert must cause outage");

assert.equal(aggregateFleetStatus([
  { status: "operational" },
  { status: "unknown" },
  { status: "degraded" },
  { status: "outage" }
]), "outage");

console.log("Status model tests OK");

function derive(overrides) {
  return deriveEnvironmentStatus({
    productId: "product-a",
    environment: "production",
    healthChecks: [],
    monitorRuns: [],
    incidents: [],
    now: NOW,
    staleAfterMs: 5 * 60_000,
    criticalFailureThreshold: 2,
    ...overrides
  });
}

function health(ok, environment, minutesAgo) {
  return {
    product_id: "product-a",
    environment,
    occurred_at: ago(minutesAgo),
    payload: { ok, checks: {} }
  };
}

function monitor(ok, monitorId, severity, minutesAgo) {
  return {
    product_id: "product-a",
    environment: "production",
    monitor_id: monitorId,
    severity,
    ok,
    checked_at: ago(minutesAgo),
    failure_threshold: 2
  };
}

function activeAlert(ruleType, severity) {
  return {
    id: `${ruleType}-instance`,
    rule_type: ruleType,
    product_id: "product-a",
    environment: "production",
    severity,
    status: "open",
    updated_at: ago(0)
  };
}

function ago(minutes) {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}
