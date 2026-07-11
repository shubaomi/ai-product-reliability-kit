import assert from "node:assert/strict";
import { buildPublicStatusModel } from "../src/public-status.mjs";

const model = buildPublicStatusModel({
  products: [
    { product_id: "public-product", name: "Public Product", owner: "private-owner@example.com", public_status_enabled: true },
    { product_id: "private-product", name: "Private Product", public_status_enabled: false }
  ],
  statuses: [
    {
      product_id: "public-product",
      environment: "production",
      status: "degraded",
      updated_at: "2026-07-10T11:59:00.000Z",
      reasons: [{ message: "database password secret-value failed" }]
    },
    { product_id: "private-product", environment: "production", status: "outage" }
  ],
  statusPages: [{
    product_id: "public-product",
    public_slug: "public-product-status",
    public_summary: "Some requests are delayed.",
    components: [{ name: "API", status: "degraded" }],
    body: "internal stack trace and api_key=secret"
  }],
  now: new Date("2026-07-10T12:00:00.000Z")
});

assert.equal(model.status, "degraded");
assert.equal(model.products.length, 1);
assert.deepEqual(model.products[0], {
  name: "Public Product",
  slug: "public-product-status",
  status: "degraded",
  updated_at: "2026-07-10T11:59:00.000Z",
  summary: "Some requests are delayed.",
  components: [{ name: "API", status: "degraded" }]
});

const serialized = JSON.stringify(model);
for (const secret of ["private-product", "private-owner", "database password", "secret-value", "api_key", "stack trace"]) {
  assert.equal(serialized.includes(secret), false, `public status leaked ${secret}`);
}

console.log("Public status tests OK");
