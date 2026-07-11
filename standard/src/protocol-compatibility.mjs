import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const CURRENT_PROTOCOL_VERSION = "1.1";
export const SUPPORTED_PROTOCOL_MAJOR = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(await fs.readFile(path.resolve(__dirname, "../telemetry-envelope.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateEnvelope = ajv.compile(schema);

export class CompatibilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CompatibilityError";
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

export function negotiateProtocolVersion(version, options = {}) {
  const currentVersion = options.currentVersion ?? CURRENT_PROTOCOL_VERSION;
  const supportedMajor = options.supportedMajor ?? SUPPORTED_PROTOCOL_MAJOR;
  const requested = parseVersion(version, "schema_version");
  const current = parseVersion(currentVersion, "current protocol version");

  if (requested.major !== supportedMajor) {
    throw new CompatibilityError(
      "unsupported_major",
      `Unsupported schema major version ${requested.major}; this collector supports v${supportedMajor}.x`,
      { requested: version, supported_major: supportedMajor, current: currentVersion }
    );
  }

  const warnings = [];
  const migrationAdvice = [];
  let status = "current";
  if (requested.minor < current.minor) {
    status = "older_minor";
    migrationAdvice.push(`Client schema ${version} remains supported; migrate to ${currentVersion} when convenient.`);
  } else if (requested.minor > current.minor) {
    status = "newer_minor";
    warnings.push({
      code: "newer_minor",
      message: `Schema ${version} is newer than collector ${currentVersion}; unknown optional fields will be ignored.`
    });
  }

  return {
    accepted: true,
    requested: version,
    current: currentVersion,
    major: requested.major,
    minor: requested.minor,
    status,
    warnings,
    migration_advice: migrationAdvice
  };
}

export function normalizeTelemetryEnvelope(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CompatibilityError("invalid_envelope", "Telemetry envelope must be an object");
  }

  const envelope = { ...input };
  const compatibility = negotiateProtocolVersion(envelope.schema_version, options);
  const warnings = [...compatibility.warnings];

  if (Object.hasOwn(envelope, "timestamp")) {
    warnings.push({
      code: "deprecated_field",
      field: "timestamp",
      replacement: "occurred_at",
      message: "timestamp is deprecated; use occurred_at"
    });
    if (!envelope.occurred_at) envelope.occurred_at = envelope.timestamp;
    delete envelope.timestamp;
  }

  if (!validateEnvelope(envelope)) {
    const issues = formatAjvErrors(validateEnvelope.errors);
    throw new CompatibilityError(
      "invalid_envelope",
      `Telemetry envelope validation failed: ${issues.join("; ")}`,
      { issues }
    );
  }

  return {
    envelope,
    compatibility,
    warnings,
    migration_advice: compatibility.migration_advice
  };
}

function parseVersion(value, label) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)$/);
  if (!match) {
    throw new CompatibilityError(
      "invalid_version",
      `${label} must use major.minor format`,
      { requested: value }
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`.trim());
}
