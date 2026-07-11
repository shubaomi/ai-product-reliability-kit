import { aggregateFleetStatus, OPERATIONAL_STATES } from "./status-model.mjs";

const PUBLIC_SUMMARIES = Object.freeze({
  unknown: "Status is not yet available.",
  operational: "All monitored services are operating normally.",
  degraded: "Some requests may be delayed or unavailable.",
  outage: "The service is currently unavailable. Recovery work is in progress."
});

export function buildPublicStatusModel({ products = [], statuses = [], statusPages = [], now = new Date() }) {
  const publicProducts = products.filter(isPublic);
  const resultProducts = publicProducts.map((product) => {
    const status = statuses
      .filter((item) => item.product_id === product.product_id && item.environment === "production")
      .sort((left, right) => toMillis(right.updated_at) - toMillis(left.updated_at))[0];
    const page = statusPages.find((item) => item.product_id === product.product_id);
    const state = OPERATIONAL_STATES.includes(status?.status) ? status.status : "unknown";
    return {
      name: safeText(product.public_name ?? product.name, 120),
      slug: safeSlug(page?.public_slug ?? product.public_slug ?? product.product_id),
      status: state,
      updated_at: validIso(status?.updated_at),
      summary: safeText(page?.public_summary, 500) || PUBLIC_SUMMARIES[state],
      components: sanitizeComponents(page?.components)
    };
  });

  return {
    status: aggregateFleetStatus(resultProducts),
    generated_at: new Date(toMillis(now)).toISOString(),
    products: resultProducts
  };
}

function isPublic(product) {
  return product.public_status_enabled === true || product.contract?.public_status?.enabled === true;
}

function sanitizeComponents(components) {
  if (!Array.isArray(components)) return [];
  return components.slice(0, 50).map((component) => ({
    name: safeText(component?.name, 120),
    status: OPERATIONAL_STATES.includes(component?.status) ? component.status : "unknown"
  })).filter((component) => component.name);
}

function safeText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function safeSlug(value) {
  const slug = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 100) || "status";
}

function validIso(value) {
  const timestamp = toMillis(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}
