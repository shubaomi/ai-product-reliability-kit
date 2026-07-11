import { expect, test } from "@playwright/test";

const ADMIN_EMAIL = "operator@reliability.local";
const ADMIN_PASSWORD = "e2e-master-key-for-dashboard-login";

test("operator signs in and sees an action-first empty operations desk", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Operations desk" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current action queue" })).toBeVisible();
  await expect(page.getByText("No active incidents or reliability regressions.")).toBeVisible();
  await expect(page.getByTestId("fleet-state")).toContainText(/unknown|operational|degraded|outage/i);
  await expectBoundedLayout(page);
});

test("onboarding validates product.yml, proves keyed connectivity, and registers the first monitor", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "onboard");
  const productId = `checkout-${suffix}`;
  const productName = `Checkout Reliability ${suffix}`;

  await page.getByRole("button", { name: "Register product" }).click();
  await expect(page.getByRole("heading", { name: "Register a product" })).toBeVisible();
  await page.getByLabel("product.yml contents").fill("standard_version: '1.0'\nproduct:\n  id: [");
  await page.getByRole("button", { name: "Validate product.yml" }).click();
  await expect(page.getByTestId("contract-validation")).toContainText(/invalid YAML|contains invalid YAML/i);

  await page.getByLabel("product.yml contents").fill(productContractYaml({ productId, productName }));
  await page.getByRole("button", { name: "Validate product.yml" }).click();
  const validation = page.getByTestId("contract-validation");
  await expect(validation.getByRole("heading", { name: "Contract valid" })).toBeVisible();
  await expect(validation).toContainText("product.repository is deprecated");
  await expect(validation).toContainText("remains supported; migrate to 1.1");
  await page.getByRole("button", { name: "Register validated contract" }).click();

  await expect(page.getByRole("heading", { name: "Connect telemetry" })).toBeVisible();
  await expect(page.getByTestId("revealed-secret")).toContainText("apr_pk_");
  await expect(page.getByText("This secret is shown once.")).toBeVisible();
  await expect(page.getByTestId("key-scopes")).toHaveText("ingest only");
  await expect(page.locator(".snippet-card code").filter({ hasText: "APR_PRODUCT_API_KEY" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Copy Node snippet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Python snippet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Java snippet" })).toBeVisible();
  await page.getByRole("button", { name: "Send keyed test event" }).click();
  await expect(page.getByTestId("connectivity-confirmed")).toContainText("Accepted by ingest and confirmed through the operator readback");
  await page.getByRole("button", { name: "Continue to first monitor" }).click();

  await page.getByLabel("Monitor name").fill("Public readiness");
  await page.getByLabel("Monitor URL").fill("https://example.com");
  await page.getByRole("button", { name: "Save monitor and open product" }).click();

  await expect(page.getByRole("heading", { name: productName, level: 1 })).toBeVisible();
  await expect(page.getByText("Public readiness")).toBeVisible();
  await expect(page.getByLabel("Environment")).toHaveValue("production");
  await expectBoundedLayout(page);
  if (process.env.APR_CAPTURE_UI) {
    await page.screenshot({ path: `.tmp/dashboard-${testInfo.project.name}.png`, fullPage: true });
  }
});

test("manual onboarding builds and validates a complete contract", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "manual");
  const productId = `manual-${suffix}`;

  await page.getByRole("button", { name: "Register product" }).click();
  await page.getByRole("button", { name: "Build complete contract" }).click();
  await page.getByLabel("Product ID").fill(productId);
  await page.getByLabel("Product name").fill(`Manual Contract ${suffix}`);
  await page.getByLabel("Owner email").fill("manual-owner@example.com");
  await page.getByLabel("Environment URL").fill("https://example.com");
  await page.getByLabel("Critical journey name").fill("Generate report");
  await page.getByLabel("Journey success event").fill("report_generated");

  const productRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/products");
  await page.getByRole("button", { name: "Validate and register contract" }).click();
  const contract = (await productRequest).postDataJSON();
  expect(contract.critical_journeys).toEqual([{ id: "generate_report", name: "Generate report", success_event: "report_generated" }]);
  expect(contract.health).toEqual({ live_path: "/healthz", ready_path: "/readyz" });
  expect(contract.release).toEqual({ version_source: "git_sha", rollback: "docs/rollback.md" });
  expect(contract.public_status).toEqual({ enabled: false });
  await expect(page.getByRole("heading", { name: "Connect telemetry" })).toBeVisible();
  await expect(page.getByTestId("key-scopes")).toHaveText("ingest only");
  await expectBoundedLayout(page);
});

test("product detail groups errors and shows current critical-journey signals", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "signals");
  const productId = `signals-${suffix}`;
  await createProduct(page, { productId, name: `Signal Evidence ${suffix}`, owner: "signals-owner@example.com" });
  const now = Date.now();
  await post(page, "/api/ingest", {
    items: [
      eventEnvelope(productId, "checkout_completed", "journey-success-1", now - 5_000),
      eventEnvelope(productId, "checkout_completed", "journey-success-2", now - 4_000),
      eventEnvelope(productId, "checkout_failed", "journey-failure-1", now - 3_000),
      errorEnvelope(productId, "ModelTimeout", "Model response exceeded 2 seconds", "error-timeout-1", now - 2_000),
      errorEnvelope(productId, "ModelTimeout", "Model response exceeded 2 seconds", "error-timeout-2", now - 1_000),
      errorEnvelope(productId, "ValidationError", "Invoice was missing a total", "error-validation-1", now)
    ]
  });

  await page.goto(`/#/products/${productId}?environment=production`);
  const journey = page.getByTestId("journey-signal").filter({ hasText: "Checkout" });
  await expect(journey).toContainText("2 success signals");
  await expect(journey).toContainText("1 failure signal");
  await expect(journey).toContainText("Latest: checkout_failed");

  await page.getByRole("tab", { name: "Signals" }).click();
  const timeoutGroup = page.getByTestId("error-group").filter({ hasText: "ModelTimeout" });
  await expect(timeoutGroup).toContainText("2 occurrences");
  await expect(timeoutGroup).toContainText("Model response exceeded 2 seconds");
  await expect(timeoutGroup).toContainText("r1");
  await expect(page.getByTestId("error-group")).toHaveCount(2);
  await expect(page.getByTestId("recent-error-record")).toHaveCount(3);
  await expectBoundedLayout(page);
});

test("operator opens, acknowledges, and resolves an incident with a recovery note", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "incident");
  const productId = `incident-${suffix}`;
  await createProduct(page, {
    productId,
    name: `Incident Control ${suffix}`,
    owner: "incident-owner@example.com"
  });
  await post(page, "/api/alerts", {
    id: `${productId}-telemetry-stale`,
    product_id: productId,
    environment: "production",
    name: "Telemetry missing",
    type: "telemetry_stale",
    severity: "medium",
    stale_after_seconds: 1
  });
  await post(page, "/api/scheduler/run-once", {});

  await page.goto(`/#/products/${encodeURIComponent(productId)}?environment=production`);
  await expect(page.getByRole("heading", { name: `Incident Control ${suffix}`, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open incident" }).click();
  await page.getByLabel("Incident title").fill("Checkout unavailable in production");
  await page.getByLabel("Severity").selectOption("critical");
  await page.getByLabel("Incident owner").fill("incident-owner@example.com");
  await page.getByRole("button", { name: "Create incident" }).click();

  const incident = page.getByTestId("incident-card").filter({ hasText: "Checkout unavailable in production" });
  await expect(incident).toContainText("open");
  let operational = await getJson(page, `/api/operational-status?product_id=${productId}&environment=production`);
  expect(operational.items[0].status).toBe("outage");
  await expect(page.locator(".page-hero")).toHaveClass(/outage/);

  await incident.getByRole("button", { name: /Link alerts/ }).click();
  await page.getByLabel("Telemetry missing").check();
  await page.getByRole("button", { name: "Link selected alerts" }).click();
  await expect(incident).toContainText("1 linked alert");
  await expect(incident).toContainText("alerts_linked");
  await incident.getByRole("button", { name: "Acknowledge" }).click();
  await expect(incident).toContainText("acknowledged");
  await incident.getByRole("button", { name: "Resolve" }).click();
  await page.getByLabel("Recovery note").fill("Rolled back release r2 and verified checkout from two regions. The deliberately detailed recovery record preserves operator context, validation evidence, follow-up ownership, and the exact production boundary without overflowing a narrow mobile incident card.");
  await page.getByRole("button", { name: "Confirm recovery" }).click();
  await expect(incident).toContainText("resolved");
  await expect(incident).toContainText("Rolled back release r2");
  operational = await getJson(page, `/api/operational-status?product_id=${productId}&environment=production`);
  expect(operational.items[0].status).toBe("degraded");
  await expect(page.locator(".page-hero")).toHaveClass(/degraded/);
  await expectBoundedLayout(page);

  await post(page, "/api/ingest", { items: [eventEnvelope(productId, "telemetry_recovered", `alert-recovery-${suffix}`, Date.now())] });
  await post(page, "/api/scheduler/run-once", {});
  const alertInstances = await getJson(page, `/api/alert-instances?product_id=${productId}&environment=production`);
  expect(alertInstances.items.find((item) => item.name === "Telemetry missing")?.status).toBe("resolved");
});

test("passport shows evidence provenance and public status stays redacted", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "public");
  const productId = `public-${suffix}`;
  const productName = `Public Checkout ${suffix}`;
  await createProduct(page, {
    productId,
    name: productName,
    owner: "private-owner@example.com",
    publicStatus: true,
    features: ["Invoice extraction with a deliberately long descriptive label that must wrap safely on mobile"]
  });
  await post(page, "/api/ingest", {
    items: [{
      schema_version: "1.0",
      type: "health",
      product_id: productId,
      environment: "production",
      release: "r1",
      occurred_at: new Date().toISOString(),
      idempotency_key: `health-${suffix}`,
      payload: { ok: true, checks: { database: true } }
    }]
  });
  await post(page, "/api/status-pages", {
    product_id: productId,
    public_slug: productId,
    public_summary: "Checkout is operating normally.",
    components: [{ name: "Checkout API", status: "operational" }],
    body: "PRIVATE RUNBOOK MUST NEVER APPEAR"
  });

  await page.goto(`/#/products/${encodeURIComponent(productId)}?environment=production`);
  await page.getByRole("tab", { name: "System passport" }).click();
  await expect(page.getByRole("heading", { name: "Evidence-sourced passport" })).toBeVisible();
  await expect(page.getByText("product_registry").first()).toBeVisible();
  await expect(page.getByText(/verified|declared/).first()).toBeVisible();
  await expectBoundedLayout(page);

  await page.goto(`/status/${encodeURIComponent(productId)}`);
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
  await expect(page.getByText("Checkout is operating normally.")).toBeVisible();
  await expect(page.getByText("PRIVATE RUNBOOK MUST NEVER APPEAR")).toHaveCount(0);
  await expect(page.getByText("private-owner@example.com")).toHaveCount(0);
  await expectBoundedLayout(page);
});

test("product detail exposes deterministic loading and API error states", async ({ page }, testInfo) => {
  await signIn(page);
  const suffix = uniqueSuffix(testInfo, "states");
  const productId = `states-${suffix}`;
  const productName = `State Handling ${suffix}`;
  await createProduct(page, { productId, name: productName, owner: "states-owner@example.com" });

  await page.route(`**/api/products/${productId}/detail**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.goto(`/#/products/${productId}?environment=production`);
  await expect(page.getByTestId("view-loading")).toBeVisible();
  await expectBoundedLayout(page);
  await expect(page.getByRole("heading", { name: productName, level: 1 })).toBeVisible();

  await page.route("**/api/operational-status", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Operational projection temporarily unavailable" })
  }));
  await page.getByRole("button", { name: "Refresh operational data" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load operations");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expectBoundedLayout(page);
});

async function signIn(page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operator sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Enter operations desk" }).click();
  await expect(page.getByRole("heading", { name: "Operations desk" })).toBeVisible();
}

async function createProduct(page, { productId, name, owner, publicStatus = false, features = [] }) {
  await post(page, "/api/products", {
    standard_version: "1.0",
    product: { id: productId, name, owner },
    environments: [{ name: "production", url: "https://example.com" }],
    critical_journeys: [{ id: "checkout", name: "Checkout", success_event: "checkout_completed", failure_event: "checkout_failed" }],
    features,
    public_status: { enabled: publicStatus }
  });
}

function eventEnvelope(productId, event, idempotencyKey, occurredAt) {
  return {
    schema_version: "1.1",
    type: "event",
    product_id: productId,
    environment: "production",
    release: "r1",
    occurred_at: new Date(occurredAt).toISOString(),
    idempotency_key: idempotencyKey,
    payload: { event, properties: {} }
  };
}

function errorEnvelope(productId, name, message, idempotencyKey, occurredAt) {
  return {
    schema_version: "1.1",
    type: "error",
    product_id: productId,
    environment: "production",
    release: "r1",
    occurred_at: new Date(occurredAt).toISOString(),
    idempotency_key: idempotencyKey,
    payload: { name, message, properties: {} }
  };
}

async function post(page, pathname, data) {
  const response = await page.request.post(pathname, { data });
  expect(response.ok(), `${pathname}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function getJson(page, pathname) {
  const response = await page.request.get(pathname);
  expect(response.ok(), `${pathname}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

function uniqueSuffix(testInfo, label) {
  return `${label}-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
}

function productContractYaml({ productId, productName }) {
  return `standard_version: "1.0"
product:
  id: ${productId}
  name: ${productName}
  owner: checkout-owner@example.com
  repository: https://example.com/source
environments:
  - name: production
    url: https://example.com
critical_journeys:
  - id: checkout
    name: Checkout
    success_event: checkout_completed
health:
  live_path: /healthz
  ready_path: /readyz
release:
  version_source: git_sha
  rollback: docs/rollback.md
public_status:
  enabled: false
`;
}

async function expectBoundedLayout(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    mobileChromeOverlap: (() => {
      const rail = document.querySelector(".rail")?.getBoundingClientRect();
      const command = document.querySelector(".command-bar")?.getBoundingClientRect();
      if (!rail || !command || document.documentElement.clientWidth > 760) return false;
      return Math.min(rail.right, command.right) - Math.max(rail.left, command.left) > 1
        && Math.min(rail.bottom, command.bottom) - Math.max(rail.top, command.top) > 1;
    })(),
    outOfBounds: [...document.querySelectorAll(".panel, .record-card, .passport-section, .error-state, .skeleton, .onboarding-card, .snippet-card")]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({ selector: element.className, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > document.documentElement.clientWidth + 1 || rect.width < 0),
    overlaps: [...document.querySelectorAll(".content-grid, .record-list, .passport-grid, .skeleton-grid, .snippet-grid")]
      .flatMap((container) => {
        const children = [...container.children].filter((child) => child.getClientRects().length);
        const collisions = [];
        for (let left = 0; left < children.length; left += 1) {
          const a = children[left].getBoundingClientRect();
          for (let right = left + 1; right < children.length; right += 1) {
            const b = children[right].getBoundingClientRect();
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 1 && overlapY > 1) collisions.push({ container: container.className, left, right, overlapX, overlapY });
          }
        }
        return collisions;
      })
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.outOfBounds).toEqual([]);
  expect(dimensions.overlaps).toEqual([]);
  expect(dimensions.mobileChromeOverlap).toBe(false);
}
