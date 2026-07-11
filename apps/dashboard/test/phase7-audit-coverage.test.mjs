import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

test("sensitive mutations emit secret-free audit records", async () => {
  const store = new MemoryStore();
  const server = await createDashboardServer({
    store,
    config: { authRequired: false, workerEnabled: false, allowedMonitorHosts: ["example.com"] }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const secret = "never-copy-this-secret";

  try {
    await expectStatus(base, "/api/products", 200, {
      product_id: "audit-product",
      name: "Audit product",
      owner: "owner@example.com",
      standard_version: "1.1",
      environments: [{ name: "production", url: "https://example.com" }],
      critical_journeys: []
    });
    await expectStatus(base, "/api/compliance-scans", 201, {
      product_id: "audit-product",
      environment: "local",
      scanned_at: new Date().toISOString(),
      tool_version: "1.0.0",
      standard_version: "1.1",
      score: 100,
      max_score: 100,
      grade: "A",
      findings: [{ token: secret }],
      verification: { passed: 1 }
    });
    await expectStatus(base, "/api/alerts", 200, {
      id: "audit-product-stale",
      product_id: "audit-product",
      environment: "production",
      name: "Telemetry stale",
      type: "telemetry_stale",
      enabled: false,
      notify: [{ url: `https://example.com/hooks?token=${secret}` }]
    });
    await expectStatus(base, "/api/status-pages", 200, {
      product_id: "audit-product",
      public_slug: "audit-product",
      title: "Audit status",
      body: secret,
      generated_at: new Date().toISOString()
    });
    const incident = await expectStatus(base, "/api/incidents", 201, {
      product_id: "audit-product",
      environment: "production",
      title: `Incident ${secret}`,
      severity: "high"
    });
    await expectStatus(base, `/api/incidents/${incident.incident.id}/acknowledge`, 200, { actor: "operator" });
    await expectStatus(base, "/api/maintenance-windows", 201, {
      product_id: "audit-product",
      environment: "production",
      name: "Maintenance",
      starts_at: new Date(Date.now() + 60_000).toISOString(),
      ends_at: new Date(Date.now() + 120_000).toISOString()
    });
    await expectStatus(base, "/api/scheduler/run-once", 200, {});
    await expectStatus(base, "/api/retention/run", 200, {});

    const alert = await store.upsertAlertInstance({
      rule_id: "audit-product-stale",
      rule_type: "telemetry_stale",
      product_id: "audit-product",
      environment: "production",
      dedup_key: "audit-product:production:telemetry_stale:telemetry",
      name: "Telemetry stale",
      severity: "high",
      status: "open",
      opened_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    });
    await expectStatus(base, `/api/alert-instances/${alert.id}/acknowledge`, 200, { actor: "operator" });

    const logs = await store.listAuditLogs({ productId: "audit-product", limit: 100 });
    const actions = new Set(logs.map((entry) => entry.action));
    for (const action of [
      "product.upserted",
      "compliance_scan.created",
      "alert_rule.upserted",
      "status_page.published",
      "incident.created",
      "incident.acknowledge",
      "maintenance_window.created",
      "alert_instance.acknowledged"
    ]) assert.ok(actions.has(action), `missing audit action ${action}`);
    const fleetLogs = await store.listAuditLogs({ limit: 100 });
    assert.ok(fleetLogs.some((entry) => entry.action === "scheduler.run_once"));
    assert.ok(fleetLogs.some((entry) => entry.action === "retention.run"));
    assert.doesNotMatch(JSON.stringify(fleetLogs), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(fleetLogs), /api_key|authorization|cookie/i);
  } finally {
    await server.shutdown();
  }
});

async function expectStatus(base, pathname, status, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return payload;
}
