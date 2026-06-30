import assert from "node:assert/strict";
import http from "node:http";
import { createReliabilityClient, healthPayload } from "../src/index.mjs";

const received = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/api/ingest") {
    response.writeHead(404);
    response.end();
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  received.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ accepted: JSON.parse(body).items.length }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

try {
  const client = createReliabilityClient({
    productId: "sdk-node-test",
    environment: "test",
    release: "test-sha",
    endpoint: `http://127.0.0.1:${port}`
  });

  client.event("user_signed_up", { plan: "free" }, { anonymousId: "anon-1" });
  client.error(new Error("boom"), { requestId: "req-1" });
  client.health({ database: true, ai_api: true });

  assert.equal(client.queued().length, 3);
  const result = await client.flush();
  assert.equal(result.accepted, 3);
  assert.equal(client.queued().length, 0);
  assert.equal(received[0].items[0].schema_version, "1.0");
  assert.equal(received[0].items[0].product_id, "sdk-node-test");
  assert.deepEqual(healthPayload({ database: true, cache: false }), {
    ok: false,
    checks: { database: true, cache: false }
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Node SDK tests OK");

