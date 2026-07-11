import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAlerts, generateAutomation, parseProductContract } from "../src/generate.mjs";

test("automation uses the shared formal contract parser", async () => {
  assert.throws(
    () => parseProductContract("standard_version: '1.0'\nproduct:\n  id: [\n", "broken.yml"),
    (error) => error.code === "invalid_yaml"
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-automation-contract-"));
  try {
    await fs.writeFile(path.join(tempDir, "product.yml"), validContract(), "utf8");
    const result = await generateAutomation(tempDir, { outDir: path.join(tempDir, "output") });
    assert.equal(result.product_id, "automation-fixture");
    assert.ok(result.migration_advice.some((item) => /1\.1/.test(item)));
    assert.equal(result.files.length, 4);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("automation emits only the four structured alert rule types", () => {
  const contract = parseProductContract(validContract().replace('standard_version: "1.0"', 'standard_version: "1.1"'));
  const monitors = [
    { id: "automation-fixture-healthz", type: "http", environment: "production", severity: "critical" },
    { id: "automation-fixture-dashboard-ingest", type: "collector", environment: "production", severity: "high" }
  ];
  const alerts = buildAlerts(contract, monitors);
  assert.ok(alerts.some((item) => item.type === "availability_failure" && item.monitor_id === "automation-fixture-healthz"));
  assert.ok(alerts.some((item) => item.type === "telemetry_stale"));
  assert.ok(alerts.some((item) => item.type === "error_spike" && item.min_samples > 0));
  assert.ok(alerts.some((item) => item.type === "journey_drop" && item.journey_id === "core_action"));
  assert.equal(alerts.every((item) => item.environment === "production"), true);
  assert.equal(alerts.every((item) => !Object.hasOwn(item, "condition")), true);
});

function validContract() {
  return `standard_version: "1.0"
product:
  id: automation-fixture
  name: Automation Fixture
  owner: owner@example.com
environments:
  - name: production
    url: https://example.com
critical_journeys:
  - id: core_action
    name: Core action
    success_event: core_action_completed
health:
  live_path: /healthz
release:
  version_source: git_sha
  rollback: docs/rollback.md
`;
}
