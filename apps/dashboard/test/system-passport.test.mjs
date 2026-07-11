import assert from "node:assert/strict";
import { buildSystemPassport } from "../src/system-passport.mjs";

const passport = buildSystemPassport({
  product: {
    product_id: "product-a",
    name: "Checkout AI",
    owner: "owner@example.com",
    updated_at: "2026-07-10T11:58:00.000Z",
    critical_journeys: [{ id: "checkout", name: "Checkout", success_event: "checkout_succeeded" }],
    contract: {
      product: { description: "Assists users during checkout." },
      features: ["Checkout assistance"],
      architecture: { runtime: "Node.js" },
      dependencies: ["Postgres"],
      release: { version_source: "git_sha", rollback: "docs/rollback.md" },
      troubleshooting: ["docs/runbook.md"]
    }
  },
  environment: "production",
  scan: {
    scanned_at: "2026-07-10T11:57:00.000Z",
    findings: [{
      id: "error-tracking",
      title: "Error tracking",
      evidence_level: "verified",
      evidence: ["tests/error-tracking.test.mjs"]
    }]
  },
  runtime: {
    status: { status: "operational", updated_at: "2026-07-10T11:59:00.000Z", reasons: [] },
    latest_release: { version: "git:abc123", occurred_at: "2026-07-10T11:00:00.000Z" },
    monitors: [{ id: "healthz", name: "Health", ok: true, checked_at: "2026-07-10T11:59:00.000Z" }]
  },
  now: new Date("2026-07-10T12:00:00.000Z"),
  staleAfterMs: 5 * 60_000
});

assert.equal(passport.product_id, "product-a");
assert.equal(passport.environment, "production");

const features = passport.sections.find((section) => section.id === "features");
assert.equal(features.entries[0].value, "Checkout assistance");
assert.equal(features.entries[0].verification, "declared");
assert.equal(features.entries[0].source, "product_contract");

const monitoring = passport.sections.find((section) => section.id === "monitoring");
assert.ok(monitoring.entries.some((entry) => entry.value === "operational" && entry.verification === "verified"));
assert.ok(monitoring.entries.some((entry) => entry.label === "Error tracking" && entry.verification === "verified"));

const deployment = passport.sections.find((section) => section.id === "deployment");
assert.ok(deployment.entries.some((entry) => entry.value === "git:abc123" && entry.verification === "stale"));

for (const section of passport.sections) {
  assert.ok(["declared", "detected", "verified", "unverified", "stale"].includes(section.verification));
  assert.ok(Object.hasOwn(section, "updated_at"));
  assert.ok(Array.isArray(section.sources));
}

assert.equal(JSON.stringify(passport).includes("guessed"), false, "passport must not invent unavailable facts");

console.log("System passport tests OK");
