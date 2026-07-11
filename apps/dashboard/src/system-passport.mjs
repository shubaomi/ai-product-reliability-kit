const SECTION_DEFINITIONS = Object.freeze([
  ["product", "Product"],
  ["features", "Features"],
  ["architecture", "Architecture"],
  ["dependencies", "Dependencies"],
  ["journeys", "Critical Journeys"],
  ["deployment", "Deployment"],
  ["monitoring", "Monitoring"],
  ["troubleshooting", "Troubleshooting"]
]);

const FINDING_SECTIONS = Object.freeze({
  "product-contract": "product",
  "system-passport": "architecture",
  "health-check": "monitoring",
  "readiness-check": "monitoring",
  "error-tracking": "monitoring",
  "product-events": "journeys",
  "smoke-tests": "journeys",
  "release-tracking": "deployment",
  rollback: "deployment",
  "ci-quality-gate": "deployment",
  "security-maintenance": "monitoring"
});

const VERIFICATIONS = new Set(["declared", "detected", "verified", "unverified", "stale"]);

export function buildSystemPassport({
  product,
  environment,
  scan,
  runtime = {},
  now = new Date(),
  staleAfterMs = 15 * 60_000
}) {
  if (!product?.product_id) throw new Error("product_id is required to build a system passport");
  if (!environment) throw new Error("environment is required to build a system passport");

  const sections = new Map(SECTION_DEFINITIONS.map(([id, title]) => [id, { id, title, entries: [] }]));
  const productUpdatedAt = product.updated_at ?? null;
  const contract = product.contract ?? {};

  add(sections, "product", "Product ID", product.product_id, "product_registry", productUpdatedAt, "verified");
  add(sections, "product", "Name", product.name, "product_registry", productUpdatedAt, "verified");
  add(sections, "product", "Owner", product.owner, "product_registry", productUpdatedAt, "verified");
  add(sections, "product", "Description", contract.product?.description, "product_contract", productUpdatedAt, "declared");

  for (const feature of asArray(contract.features)) {
    add(sections, "features", "Feature", scalarValue(feature), "product_contract", productUpdatedAt, "declared");
  }
  addObjectEntries(sections, "architecture", contract.architecture, "product_contract", productUpdatedAt, "declared");
  for (const dependency of asArray(contract.dependencies ?? contract.health?.dependencies)) {
    add(sections, "dependencies", "Dependency", scalarValue(dependency), "product_contract", productUpdatedAt, "declared");
  }
  for (const journey of asArray(product.critical_journeys ?? contract.critical_journeys)) {
    const value = typeof journey === "string"
      ? journey
      : compactObject({ id: journey.id, success_event: journey.success_event, failure_event: journey.failure_event });
    add(sections, "journeys", journey.name ?? journey.id ?? "Journey", value, "product_contract", productUpdatedAt, "declared");
  }
  addObjectEntries(sections, "deployment", contract.deployment, "product_contract", productUpdatedAt, "declared");
  addObjectEntries(sections, "deployment", contract.release, "product_contract", productUpdatedAt, "declared");
  for (const item of asArray(contract.troubleshooting)) {
    add(sections, "troubleshooting", "Entry point", scalarValue(item), "product_contract", productUpdatedAt, "declared");
  }

  for (const finding of asArray(scan?.findings)) {
    const sectionId = FINDING_SECTIONS[finding.id] ?? "architecture";
    const evidence = asArray(finding.evidence);
    add(
      sections,
      sectionId,
      finding.title ?? finding.id ?? "Scan finding",
      evidence.length ? evidence.join(", ") : finding.status ?? "no evidence",
      "compliance_scan",
      scan.scanned_at ?? scan.generated_at ?? null,
      normalizeVerification(finding.evidence_level ?? finding.verification ?? "unverified")
    );
  }

  if (runtime.status) {
    add(sections, "monitoring", "Current status", runtime.status.status, "runtime_status", runtime.status.updated_at, runtimeVerification(runtime.status.updated_at, now, staleAfterMs));
  }
  for (const monitor of asArray(runtime.monitors)) {
    add(
      sections,
      "monitoring",
      monitor.name ?? monitor.id ?? "Monitor",
      monitor.status ?? (monitor.ok === true ? "passing" : monitor.ok === false ? "failing" : "unknown"),
      "runtime_monitor",
      monitor.checked_at ?? monitor.updated_at ?? null,
      runtimeVerification(monitor.checked_at ?? monitor.updated_at, now, staleAfterMs)
    );
  }
  if (runtime.latest_release) {
    add(
      sections,
      "deployment",
      "Latest release",
      runtime.latest_release.version ?? runtime.latest_release.release,
      "runtime_release",
      runtime.latest_release.occurred_at ?? runtime.latest_release.updated_at ?? null,
      runtimeVerification(runtime.latest_release.occurred_at ?? runtime.latest_release.updated_at, now, staleAfterMs)
    );
  }

  return {
    product_id: product.product_id,
    environment,
    generated_at: new Date(toMillis(now)).toISOString(),
    sections: [...sections.values()].map(finalizeSection)
  };
}

function addObjectEntries(sections, sectionId, value, source, updatedAt, verification) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [label, entryValue] of Object.entries(value)) {
    add(sections, sectionId, humanize(label), scalarValue(entryValue), source, updatedAt, verification);
  }
}

function add(sections, sectionId, label, value, source, updatedAt, verification) {
  if (value == null || value === "" || (typeof value === "object" && !Object.keys(value).length)) return;
  sections.get(sectionId).entries.push({
    label: String(label),
    value,
    source,
    updated_at: updatedAt ?? null,
    verification: normalizeVerification(verification)
  });
}

function finalizeSection(section) {
  const verifications = section.entries.map((entry) => entry.verification);
  const verification = verifications.includes("verified")
    ? "verified"
    : verifications.includes("stale")
      ? "stale"
      : verifications.includes("detected")
        ? "detected"
        : verifications.includes("declared")
          ? "declared"
          : "unverified";
  const timestamps = section.entries.map((entry) => toMillis(entry.updated_at)).filter(Number.isFinite).sort((a, b) => b - a);
  return {
    ...section,
    sources: [...new Set(section.entries.map((entry) => entry.source))],
    updated_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    verification
  };
}

function runtimeVerification(updatedAt, now, staleAfterMs) {
  const updatedMs = toMillis(updatedAt);
  const nowMs = toMillis(now);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return "unverified";
  return nowMs - updatedMs > staleAfterMs ? "stale" : "verified";
}

function normalizeVerification(value) {
  const normalized = String(value ?? "unverified").toLowerCase();
  return VERIFICATIONS.has(normalized) ? normalized : "unverified";
}

function scalarValue(value) {
  if (Array.isArray(value)) return value.map(scalarValue);
  if (value && typeof value === "object") return compactObject(value);
  return value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item != null && item !== ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function humanize(value) {
  const text = String(value).replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}
