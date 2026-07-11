import { randomUUID } from "node:crypto";

const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

export function createIncidentRecord(input, { actor = "system", now = new Date() } = {}) {
  const timestamp = iso(now);
  const productId = required(input?.product_id, "product_id");
  const environment = required(input?.environment, "environment");
  const title = required(input?.title, "title");
  const severity = String(input?.severity ?? "medium").toLowerCase();
  if (!SEVERITIES.has(severity)) throw incidentError(400, `Invalid incident severity: ${severity}`);

  return {
    id: input.id ?? randomUUID(),
    product_id: productId,
    environment,
    title,
    severity,
    status: "open",
    owner: input.owner ?? null,
    alert_ids: uniqueStrings(input.alert_ids),
    recovery_note: null,
    opened_at: timestamp,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    timeline: [timelineEvent("opened", actor, timestamp, { title, severity })]
  };
}

export function acknowledgeIncident(incident, { actor, now = new Date() } = {}) {
  requireStatus(incident, ["open", "acknowledged"], "acknowledged");
  if (incident.status === "acknowledged") return { ...incident, timeline: [...incident.timeline] };
  const timestamp = iso(now);
  const acknowledgedBy = required(actor, "actor");
  return update(incident, timestamp, {
    status: "acknowledged",
    acknowledged_at: timestamp,
    acknowledged_by: acknowledgedBy,
    timeline: [...incident.timeline, timelineEvent("acknowledged", acknowledgedBy, timestamp)]
  });
}

export function assignIncident(incident, owner, { actor = "system", now = new Date() } = {}) {
  requireStatus(incident, ["open", "acknowledged"], "assigned");
  const timestamp = iso(now);
  const nextOwner = required(owner, "owner");
  return update(incident, timestamp, {
    owner: nextOwner,
    timeline: [...incident.timeline, timelineEvent("assigned", actor, timestamp, { owner: nextOwner })]
  });
}

export function linkIncidentAlerts(incident, alertIds, { actor = "system", now = new Date() } = {}) {
  requireStatus(incident, ["open", "acknowledged"], "linked");
  const timestamp = iso(now);
  const nextIds = uniqueStrings([...(incident.alert_ids ?? []), ...(alertIds ?? [])]);
  return update(incident, timestamp, {
    alert_ids: nextIds,
    timeline: [...incident.timeline, timelineEvent("alerts_linked", actor, timestamp, { alert_ids: nextIds })]
  });
}

export function resolveIncident(incident, { recovery_note: recoveryNote, actor, now = new Date() } = {}) {
  requireStatus(incident, ["open", "acknowledged"], "resolved");
  const note = required(recoveryNote, "recovery note");
  const resolvedBy = required(actor, "actor");
  const timestamp = iso(now);
  return update(incident, timestamp, {
    status: "resolved",
    recovery_note: note,
    resolved_at: timestamp,
    timeline: [...incident.timeline, timelineEvent("resolved", resolvedBy, timestamp, { recovery_note: note })]
  });
}

export function reopenIncident(incident, { reason, actor = "system", now = new Date() } = {}) {
  requireStatus(incident, ["resolved"], "reopened");
  const reopenReason = required(reason, "reason");
  const timestamp = iso(now);
  return update(incident, timestamp, {
    status: "open",
    recovery_note: null,
    resolved_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    opened_at: timestamp,
    timeline: [...incident.timeline, timelineEvent("reopened", actor, timestamp, { reason: reopenReason })]
  });
}

function requireStatus(incident, allowed, action) {
  if (!incident || !allowed.includes(incident.status)) {
    throw incidentError(409, `Incident cannot be ${action} from status ${incident?.status ?? "missing"}`);
  }
}

function update(incident, timestamp, changes) {
  return { ...incident, ...changes, updated_at: timestamp };
}

function timelineEvent(type, actor, at, details = {}) {
  return { id: randomUUID(), type, actor: actor ?? "system", at, details };
}

function uniqueStrings(values = []) {
  if (!Array.isArray(values)) throw incidentError(400, "alert_ids must be an array");
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw incidentError(400, `${label} is required`);
  return text;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw incidentError(400, "Invalid incident timestamp");
  return date.toISOString();
}

function incidentError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
