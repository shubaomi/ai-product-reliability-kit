import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { normalizeTelemetryEnvelope } from "@ai-product-reliability/standard/protocol-compatibility";

const TELEMETRY_TYPES = new Set(["product", "event", "error", "health", "release"]);
const MONITOR_TYPES = new Set(["http", "collector", "event-freshness"]);
const RELIABILITY_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const API_KEY_SCOPES = new Set(["ingest", "read"]);
const SECRET_KEYS = /(password|token|secret|api[_-]?key|authorization|cookie|card|cvv)/i;
const USER_IDENTIFIER_KEYS = /^(user[_-]?id|userId|anonymous[_-]?id|anonymousId)$/;

export function validateIngestBody(body, config) {
  return validateIngestBatch(body, config).items;
}

export function validateIngestBatch(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "JSON body must be an object");
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  if (!rawItems.length) throw httpError(400, "No telemetry items provided");
  if (rawItems.length > config.maxBatchSize) throw httpError(413, `Batch too large; max ${config.maxBatchSize}`);
  const warnings = [];
  const migrationAdvice = [];
  const items = rawItems.map((item, itemIndex) => {
    let compatibility;
    try {
      compatibility = normalizeTelemetryEnvelope(item);
    } catch (error) {
      const wrapped = httpError(error.status ?? 400, error.message);
      wrapped.code = error.code ?? "invalid_envelope";
      wrapped.details = error.details ?? {};
      throw wrapped;
    }
    for (const warning of compatibility.warnings) warnings.push({ item_index: itemIndex, ...warning });
    migrationAdvice.push(...compatibility.migration_advice);
    return applyPrivacyTransforms(validateTelemetryEnvelope(compatibility.envelope, config), config);
  });
  return {
    items,
    warnings,
    migration_advice: [...new Set(migrationAdvice)]
  };
}

export function validateTelemetryEnvelope(item, config = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError(400, "Telemetry item must be an object");
  validateSchemaVersion(item.schema_version);
  if (!TELEMETRY_TYPES.has(item.type)) throw httpError(400, "Invalid telemetry type");
  validateString(item.product_id, "product_id", config.maxProductIdLength ?? 128);
  validateString(item.environment, "environment", 64);
  if (config.allowedEnvironments?.length && !config.allowedEnvironments.includes(item.environment)) {
    throw httpError(400, `Unsupported environment: ${item.environment}`);
  }
  validateString(item.release, "release", 256);
  validateOccurredAt(item.occurred_at, config);
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
    throw httpError(400, "payload must be an object");
  }
  for (const field of ["anonymous_id", "user_id", "request_id", "idempotency_key"]) {
    if (item[field] != null) validateString(item[field], field, 256);
  }
  validatePayloadByType(item, config);
  validateNestedValues(item.payload, config.maxStringLength ?? 4096);
  return structuredClone(item);
}

export function normalizeProduct(input, config = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Product body must be an object");
  const contract = input.contract ?? input;
  const product = contract.product ?? contract;
  const productId = product.id ?? input.product_id;
  const name = product.name ?? input.name ?? productId;
  const owner = product.owner ?? input.owner;
  const standardVersion = contract.standard_version ?? input.standard_version;
  validateString(productId, "product_id", config.maxProductIdLength ?? 128);
  validateString(name, "name", 256);
  validateString(owner, "owner", 320);
  validateString(standardVersion, "standard_version", 32);
  const environments = contract.environments ?? input.environments ?? [];
  const criticalJourneys = contract.critical_journeys ?? input.critical_journeys ?? [];
  if (!Array.isArray(environments)) throw httpError(400, "environments must be an array");
  if (!Array.isArray(criticalJourneys)) throw httpError(400, "critical_journeys must be an array");
  for (const environment of environments) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw httpError(400, "environment must be an object");
    validateString(environment.name, "environment.name", 64);
    if (config.allowedEnvironments?.length && !config.allowedEnvironments.includes(environment.name)) {
      throw httpError(400, `Unsupported environment: ${environment.name}`);
    }
    if (environment.url != null && environment.url !== "") validateHttpUrl(environment.url, "environment.url");
  }
  return {
    product_id: productId,
    name,
    owner,
    standard_version: standardVersion,
    environments,
    critical_journeys: criticalJourneys,
    contract,
    updated_at: new Date().toISOString()
  };
}

export async function validateMonitorInput(monitor, config, options = {}) {
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) throw httpError(400, "Monitor must be an object");
  validateString(monitor.id, "monitor.id", 256);
  validateString(monitor.product_id, "monitor.product_id", config.maxProductIdLength ?? 128);
  validateString(monitor.name, "monitor.name", 256);
  if (!MONITOR_TYPES.has(monitor.type)) throw httpError(400, "Invalid monitor type");
  if (monitor.environment != null) {
    validateString(monitor.environment, "monitor.environment", 64);
    if (config.allowedEnvironments?.length && !config.allowedEnvironments.includes(monitor.environment)) {
      throw httpError(400, `Unsupported environment: ${monitor.environment}`);
    }
  }
  if (monitor.enabled != null && typeof monitor.enabled !== "boolean") throw httpError(400, "monitor.enabled must be a boolean");
  if (monitor.severity != null && !RELIABILITY_SEVERITIES.has(String(monitor.severity).toLowerCase())) {
    throw httpError(400, "monitor.severity must be low, medium, high, or critical");
  }
  validateOptionalInteger(monitor.interval_seconds, "interval_seconds", 1, 86_400);
  validateOptionalInteger(monitor.failure_threshold, "failure_threshold", 1, 100);
  validateOptionalInteger(monitor.consecutive_failures, "consecutive_failures", 1, 100);
  if (["http", "collector"].includes(monitor.type)) {
    await validateSafeMonitorUrl(monitor.url, config, options);
    validateOptionalInteger(monitor.expected_status, "expected_status", 100, 599);
    validateOptionalInteger(monitor.timeout_ms, "timeout_ms", 100, 120_000);
    validateOptionalNumber(monitor.timeout_seconds, "timeout_seconds", 0.1, 120);
  } else {
    validateString(monitor.event, "monitor.event", 128);
    validateOptionalInteger(monitor.window_minutes, "window_minutes", 1, 10_080);
    validateOptionalInteger(monitor.min_count, "min_count", 1, 1_000_000);
  }
  return structuredClone(monitor);
}

export function validateComplianceScan(input, config) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Compliance scan must be an object");
  validateString(input.product_id, "product_id", config.maxProductIdLength ?? 128);
  if (input.environment !== "local") throw httpError(400, "Compliance scan environment must be local");
  validateOccurredAt(input.scanned_at, config, "scanned_at");
  validateString(input.tool_version, "tool_version", 64);
  validateString(input.standard_version, "standard_version", 32);
  validateString(input.grade, "grade", 16);
  if (!Number.isFinite(input.score) || !Number.isFinite(input.max_score) || input.max_score <= 0 || input.score < 0 || input.score > input.max_score) {
    throw httpError(400, "Invalid compliance score");
  }
  if (!Array.isArray(input.findings)) throw httpError(400, "findings must be an array");
  if (!input.verification || typeof input.verification !== "object" || Array.isArray(input.verification)) {
    throw httpError(400, "verification must be an object");
  }
  validateNestedValues(input.findings, config.maxStringLength ?? 4096);
  validateNestedValues(input.verification, config.maxStringLength ?? 4096);
  return redactSensitive({
    product_id: input.product_id,
    environment: input.environment,
    scanned_at: new Date(Date.parse(input.scanned_at)).toISOString(),
    tool_version: input.tool_version,
    standard_version: input.standard_version,
    score: input.score,
    max_score: input.max_score,
    grade: input.grade,
    findings: structuredClone(input.findings),
    verification: structuredClone(input.verification)
  }, config);
}

export function validateApiKeyRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "API key body must be an object");
  validateString(input.name, "name", 128);
  const scopes = input.scopes ?? ["ingest"];
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !API_KEY_SCOPES.has(scope))) {
    throw httpError(400, "API key scopes must contain only ingest or read");
  }
  let expiresAt = null;
  if (input.expires_at != null) {
    const timestamp = Date.parse(input.expires_at);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw httpError(400, "expires_at must be a future date-time");
    expiresAt = new Date(timestamp).toISOString();
  }
  return { name: input.name, scopes: [...new Set(scopes)], expires_at: expiresAt };
}

export function redactSensitive(value, config = {}) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, config));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
      if (SECRET_KEYS.test(key)) return [key, "[REDACTED]"];
      if (USER_IDENTIFIER_KEYS.test(key) && typeof inner === "string") return [key, hashIdentifier(inner, config.userIdHmacSecret)];
      return [key, redactSensitive(inner, config)];
    }));
  }
  return value;
}

export function hashIdentifier(value, secret) {
  if (String(value).startsWith("hmac_sha256:")) return String(value);
  if (!secret) throw new Error("A user identifier HMAC secret is required");
  return `hmac_sha256:${crypto.createHmac("sha256", secret).update(String(value)).digest("hex")}`;
}

export async function validateSafeMonitorUrl(value, config, options = {}) {
  return (await resolveSafeMonitorTarget(value, config, options, { allowUnresolvedAllowlistedHost: true })).url;
}

export async function resolveSafeMonitorTarget(value, config, options = {}, { allowUnresolvedAllowlistedHost = false } = {}) {
  const url = validateHttpUrl(value, "monitor.url");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowlisted = (config.allowedMonitorHosts ?? []).includes(hostname);
  if (!allowlisted && (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname))) {
    throw httpError(400, "Monitor URL targets a private or unsafe address");
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    return pinnedMonitorTarget(url, hostname, hostname, literalFamily);
  }
  let addresses;
  try {
    addresses = await (options.dnsLookup ?? dns.lookup)(hostname, { all: true, verbatim: true });
  } catch {
    if (allowlisted && allowUnresolvedAllowlistedHost) return { url, hostname, address: null, family: 0, lookup: null };
    throw httpError(400, "Monitor URL hostname could not be resolved");
  }
  const list = (Array.isArray(addresses) ? addresses : [addresses])
    .filter((entry) => entry && typeof entry.address === "string" && net.isIP(entry.address));
  if (!list.length || (!allowlisted && list.some((entry) => isPrivateAddress(entry.address)))) {
    throw httpError(400, "Monitor URL resolves to a private or unsafe address");
  }
  const selected = list[0];
  return pinnedMonitorTarget(url, hostname, selected.address, selected.family ?? net.isIP(selected.address));
}

function pinnedMonitorTarget(url, hostname, address, family) {
  return {
    url,
    hostname,
    address,
    family,
    lookup(_requestedHostname, _options, callback) {
      callback(null, address, family);
    }
  };
}

export function isPrivateAddress(value) {
  const address = String(value ?? "").toLowerCase().split("%")[0];
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (family === 6) {
    return address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd") ||
      /^fe[89ab]/.test(address) || address.startsWith("ff");
  }
  return false;
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function applyPrivacyTransforms(item, config) {
  return redactSensitive(item, config);
}

function validateSchemaVersion(value) {
  if (typeof value !== "string") throw httpError(400, "schema_version must be a string");
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) throw httpError(400, "Invalid schema_version");
  if (Number(match[1]) !== 1) throw httpError(400, `Unsupported schema major version: ${match[1]}`);
}

function validatePayloadByType(item, config) {
  if (item.type === "product") {
    const contract = item.payload?.contract ?? item.payload;
    const contractProductId = contract?.product?.id ?? contract?.product_id;
    if (contractProductId && contractProductId !== item.product_id) {
      throw httpError(400, "Product envelope product_id must match payload contract product.id");
    }
  }
  if (item.type === "event") validateString(item.payload.event, "payload.event", 128);
  if (item.type === "error") {
    validateString(item.payload.name, "payload.name", 256);
    validateString(item.payload.message, "payload.message", config.maxStringLength ?? 4096);
  }
  if (item.type === "health" && typeof item.payload.ok !== "boolean") {
    throw httpError(400, "health payload requires boolean ok");
  }
  if (item.type === "release") validateString(item.payload.version, "payload.version", 256);
}

function validateOccurredAt(value, config, field = "occurred_at") {
  if (typeof value !== "string") throw httpError(400, `${field} must be a date-time string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw httpError(400, `Invalid ${field}`);
  const now = Date.now();
  if (timestamp - now > (config.maxClockSkewMs ?? 5 * 60 * 1000)) throw httpError(400, `${field} is too far in the future`);
  if (now - timestamp > (config.maxPastEventAgeMs ?? 7 * 24 * 60 * 60 * 1000)) throw httpError(400, `${field} is too old`);
}

function validateString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} must be a non-empty string`);
  if (value.length > maxLength) throw httpError(400, `${field} exceeds maximum length ${maxLength}`);
}

function validateNestedValues(value, maxStringLength, depth = 0) {
  if (depth > 20) throw httpError(400, "Payload nesting is too deep");
  if (typeof value === "string" && value.length > maxStringLength) throw httpError(400, `Payload string exceeds maximum length ${maxStringLength}`);
  if (Array.isArray(value)) {
    for (const item of value) validateNestedValues(item, maxStringLength, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key.length > 128) throw httpError(400, "Payload field name exceeds maximum length 128");
      validateNestedValues(inner, maxStringLength, depth + 1);
    }
  }
}

function validateHttpUrl(value, field) {
  if (typeof value !== "string" || value.length > 2048) throw httpError(400, `${field} must be a valid URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw httpError(400, `${field} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw httpError(400, `${field} must use http or https without embedded credentials`);
  }
  return parsed;
}

function validateOptionalInteger(value, field, min, max) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw httpError(400, `${field} must be an integer between ${min} and ${max}`);
  }
}

function validateOptionalNumber(value, field, min, max) {
  if (value == null) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw httpError(400, `${field} must be a number between ${min} and ${max}`);
  }
}
