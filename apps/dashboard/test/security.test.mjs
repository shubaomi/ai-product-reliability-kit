import assert from "node:assert/strict";
import { createDashboardServer } from "../server.mjs";

const config = {
  authRequired: true,
  masterApiKey: "master-test-key",
  ingestApiKey: "ingest-test-key",
  maxBodyBytes: 4096,
  maxBatchSize: 10,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100,
  corsOrigins: [],
  sessionSecret: "test-session-secret",
  workerEnabled: false
};
const server = await createDashboardServer({ memory: true, config });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  let response = await fetch(`${base}/api/summary`);
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "master-test-key" })
  });
  assert.equal(response.status, 200);
  const sessionCookie = response.headers.get("set-cookie");
  assert.match(sessionCookie, /apr_session=/);

  response = await fetch(`${base}/api/summary`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ingest-test-key" },
    body: JSON.stringify(envelope("event", {
      event: "secret_test",
      properties: { api_key: "should-not-survive", visible: "yes" }
    }))
  });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/events`, {
    headers: { authorization: "Bearer master-test-key" }
  });
  assert.equal(response.status, 200);
  const events = await response.json();
  assert.equal(events[0].payload.properties.api_key, "[REDACTED]");
  assert.equal(events[0].payload.properties.visible, "yes");

  response = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ingest-test-key" },
    body: JSON.stringify(envelope("health", { checks: { database: true } }))
  });
  assert.equal(response.status, 400);

  response = await fetch(`${base}/status`);
  assert.equal(response.status, 200);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Security tests OK");

function envelope(type, payload) {
  return {
    schema_version: "1.0",
    type,
    product_id: "secure-product",
    environment: "test",
    release: "test",
    occurred_at: new Date().toISOString(),
    payload
  };
}
