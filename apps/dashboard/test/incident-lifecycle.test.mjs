import assert from "node:assert/strict";
import {
  acknowledgeIncident,
  assignIncident,
  createIncidentRecord,
  linkIncidentAlerts,
  reopenIncident,
  resolveIncident
} from "../src/incident-lifecycle.mjs";

const created = createIncidentRecord({
  id: "incident-1",
  product_id: "product-a",
  environment: "production",
  title: "Checkout unavailable",
  severity: "critical",
  alert_ids: ["alert-1"]
}, { actor: "system", now: date(0) });

assert.equal(created.status, "open");
assert.equal(created.timeline.length, 1);
assert.equal(created.timeline[0].type, "opened");

const assigned = assignIncident(created, "owner@example.com", { actor: "operator@example.com", now: date(1) });
assert.equal(assigned.owner, "owner@example.com");
assert.equal(assigned.timeline.at(-1).type, "assigned");

const acknowledged = acknowledgeIncident(assigned, { actor: "owner@example.com", now: date(2) });
assert.equal(acknowledged.status, "acknowledged");
assert.equal(acknowledged.acknowledged_by, "owner@example.com");

const linked = linkIncidentAlerts(acknowledged, ["alert-1", "alert-2"], { actor: "owner@example.com", now: date(3) });
assert.deepEqual(linked.alert_ids, ["alert-1", "alert-2"]);

assert.throws(() => resolveIncident(linked, { recovery_note: "", actor: "owner@example.com", now: date(4) }), /recovery note/i);

const resolved = resolveIncident(linked, {
  recovery_note: "Rolled back the failing release and confirmed checkout recovery.",
  actor: "owner@example.com",
  now: date(5)
});
assert.equal(resolved.status, "resolved");
assert.match(resolved.recovery_note, /Rolled back/);
assert.equal(resolved.timeline.at(-1).type, "resolved");

const reopened = reopenIncident(resolved, { reason: "Checkout failed again", actor: "monitor", now: date(6) });
assert.equal(reopened.status, "open");
assert.equal(reopened.recovery_note, null);
assert.equal(reopened.timeline.at(-1).type, "reopened");

console.log("Incident lifecycle tests OK");

function date(minutes) {
  return new Date(Date.parse("2026-07-10T12:00:00.000Z") + minutes * 60_000);
}
