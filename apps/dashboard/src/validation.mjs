const TELEMETRY_TYPES = new Set(["product", "event", "error", "health", "release"]);
const SECRET_KEYS = /(password|token|secret|api[_-]?key|authorization|cookie|card|cvv)/i;

export function validateIngestBody(body, config) {
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  if (!rawItems.length) throw httpError(400, "No telemetry items provided");
  if (rawItems.length > config.maxBatchSize) throw httpError(413, `Batch too large; max ${config.maxBatchSize}`);
  const items = rawItems.map(validateTelemetryEnvelope);
  return items.map(redactSensitive);
}

export function validateTelemetryEnvelope(item) {
  if (!item || typeof item !== "object") throw httpError(400, "Telemetry item must be an object");
  if (item.schema_version !== "1.0") throw httpError(400, "Unsupported schema_version");
  if (!TELEMETRY_TYPES.has(item.type)) throw httpError(400, "Invalid telemetry type");
  for (const field of ["product_id", "environment", "release", "occurred_at", "payload"]) {
    if (item[field] == null || item[field] === "") throw httpError(400, `Missing ${field}`);
  }
  if (Number.isNaN(Date.parse(item.occurred_at))) throw httpError(400, "Invalid occurred_at");
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
    throw httpError(400, "payload must be an object");
  }
  validatePayloadByType(item);
  return item;
}

function validatePayloadByType(item) {
  if (item.type === "event" && typeof item.payload.event !== "string") {
    throw httpError(400, "event payload requires event");
  }
  if (item.type === "error" && (typeof item.payload.name !== "string" || typeof item.payload.message !== "string")) {
    throw httpError(400, "error payload requires name and message");
  }
  if (item.type === "health" && typeof item.payload.ok !== "boolean") {
    throw httpError(400, "health payload requires boolean ok");
  }
  if (item.type === "release" && typeof item.payload.version !== "string") {
    throw httpError(400, "release payload requires version");
  }
}

export function normalizeProduct(input) {
  const contract = input?.contract ?? input;
  const product = contract?.product ?? contract;
  return {
    product_id: product?.id ?? input?.product_id ?? "unknown-product",
    name: product?.name ?? input?.name ?? product?.id ?? "Unknown Product",
    owner: product?.owner ?? input?.owner ?? "unknown",
    standard_version: contract?.standard_version ?? input?.standard_version ?? "unknown",
    environments: contract?.environments ?? input?.environments ?? [],
    critical_journeys: contract?.critical_journeys ?? input?.critical_journeys ?? [],
    contract,
    updated_at: new Date().toISOString()
  };
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) ? "[REDACTED]" : redactSensitive(inner)])
    );
  }
  return value;
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
