import assert from "node:assert/strict";
import { MemoryStore } from "../src/stores/memory-store.mjs";
import { buildIncidentPackage } from "../src/incident.mjs";

const store = new MemoryStore();
await store.ready();
await store.upsertProduct({
  product_id: "incident-product",
  name: "Incident Product",
  owner: "owner@example.com",
  standard_version: "1.0"
});
await store.appendIngestItems([
  envelope("error", { name: "TypeError", message: "Cannot read property" }),
  envelope("health", { ok: false, checks: { database: false } }),
  envelope("release", { version: "git:abc123", properties: {} })
]);

const incident = await buildIncidentPackage(store, "incident-product");
assert.match(incident.package_markdown, /TypeError/);
assert.match(incident.package_markdown, /database/);
assert.match(incident.package_markdown, /git:abc123/);

console.log("Incident package tests OK");

function envelope(type, payload) {
  return {
    schema_version: "1.0",
    type,
    product_id: "incident-product",
    environment: "test",
    release: "test-release",
    occurred_at: new Date().toISOString(),
    payload
  };
}

