import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";

async function withServer(callback) {
  const server = await createDashboardServer({ memory: true, config: { authRequired: false, workerEnabled: false } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(base);
  } finally {
    await server.shutdown();
  }
}

test("onboarding validates imported product YAML and returns compatibility guidance", async () => {
  await withServer(async (base) => {
    let response = await fetch(`${base}/api/product-contracts/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml: validContract().replace("repo:", "repository:") })
    });
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.contract.product.id, "onboarding-contract");
    assert.ok(body.warnings.some((warning) => warning.field === "product.repository"));
    assert.ok(body.migration_advice.some((advice) => /1\.1/.test(advice)));

    response = await fetch(`${base}/api/product-contracts/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml: "standard_version: '1.0'\nproduct:\n  id: [" })
    });
    assert.equal(response.status, 400);
    body = await response.json();
    assert.equal(body.code, "invalid_yaml");
    assert.ok(body.details.issues.length > 0);
  });
});

function validContract() {
  return `standard_version: "1.0"
product:
  id: onboarding-contract
  name: Onboarding Contract
  owner: owner@example.com
  repo: https://example.com/repo
environments:
  - name: production
    url: https://example.com
critical_journeys:
  - id: checkout
    name: Checkout
    success_event: checkout_completed
health:
  live_path: /healthz
  ready_path: /readyz
release:
  version_source: git_sha
  rollback: docs/rollback.md
`;
}
