export async function buildIncidentPackage(store, productId, options = {}) {
  const context = await store.recentContext(productId, options.limit ?? 20);
  const product = context.product ?? { product_id: productId, name: productId, owner: "unknown" };
  const now = new Date().toISOString();
  const title = `${product.name ?? product.product_id} incident package`;

  const markdown = `# AI Incident Package

Generated: ${now}

## Product

- Product ID: ${product.product_id}
- Name: ${product.name ?? product.product_id}
- Owner: ${product.owner ?? "unknown"}
- Standard version: ${product.standard_version ?? "unknown"}

## Current Signals

- Recent errors: ${context.errors.length}
- Recent events: ${context.events.length}
- Recent health checks: ${context.health.length}
- Recent releases: ${context.releases.length}
- Recent monitor runs: ${context.monitorRuns.length}
- Recent alert deliveries: ${context.alertDeliveries.length}

## Latest Errors

${formatItems(context.errors, (item) => `- ${time(item)} ${item.release ?? ""} ${item.payload?.name ?? item.error_name ?? "Error"}: ${item.payload?.message ?? item.message ?? ""} ${details(item.payload?.properties)}`)}

## Latest Health

${formatItems(context.health, (item) => `- ${time(item)} ok=${item.payload?.ok ?? item.ok} release=${item.release ?? ""} checks=${details(item.payload?.checks)}`)}

## Latest Releases

${formatItems(context.releases, (item) => `- ${time(item)} ${item.payload?.version ?? item.version ?? item.release}`)}

## Latest Events

${formatItems(context.events, (item) => `- ${time(item)} ${item.payload?.event ?? item.event_name ?? "event"} release=${item.release ?? ""} ${details(item.payload?.properties)}`)}

## Suggested AI Prompt

Use this incident package with the latest code diff and deployment logs. Identify likely root cause, blast radius, safest mitigation, rollback risk, verification steps, and follow-up prevention work. Prefer evidence from errors, health checks, releases, and critical journey events over speculation.
`;

  return {
    product_id: product.product_id,
    title,
    severity: options.severity ?? "medium",
    status: "open",
    package_markdown: markdown
  };
}

function formatItems(items, formatter) {
  if (!items.length) return "- None";
  return items.slice(0, 10).map(formatter).join("\n");
}

function time(item) {
  return item.occurred_at ?? item.checked_at ?? item.delivered_at ?? item.received_at ?? item.created_at ?? "";
}

function details(value) {
  if (!value || (typeof value === "object" && !Object.keys(value).length)) return "";
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
