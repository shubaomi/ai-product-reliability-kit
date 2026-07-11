import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDashboardServer } from "../server.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-dashboard-"));
const storePath = path.join(tempDir, "store.json");
const server = await createDashboardServer({ storePath });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  await post("/api/products", {
    standard_version: "1.0",
    product: { id: "dashboard-test", name: "Dashboard Test", owner: "owner@example.com" },
    environments: [{ name: "production", url: "https://example.com" }],
    critical_journeys: []
  });

  await post("/api/ingest", {
    items: [
      envelope("event", { event: "user_signed_up", properties: {} }),
      envelope("error", { name: "Error", message: "boom" }),
      envelope("health", { ok: true, checks: { database: true } })
    ]
  });

  const summary = await get("/api/summary");
  assert.equal(summary.products, 1);
  assert.equal(summary.events, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.status, "operational");

  const html = await fetch(base).then((response) => response.text());
  assert.match(html, /Product Fleet/);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("Dashboard tests OK");

async function post(url, payload) {
  const response = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function get(url) {
  const response = await fetch(`${base}${url}`);
  assert.equal(response.ok, true);
  return response.json();
}

function envelope(type, payload) {
  return {
    schema_version: "1.0",
    type,
    product_id: "dashboard-test",
    environment: "production",
    release: "test-sha",
    occurred_at: new Date().toISOString(),
    payload
  };
}
