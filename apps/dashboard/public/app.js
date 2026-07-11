const elements = {
  boot: document.getElementById("boot-screen"),
  loginPanel: document.getElementById("login-panel"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  dashboard: document.getElementById("dashboard-panel"),
  view: document.getElementById("view-root"),
  pageKicker: document.getElementById("page-kicker"),
  pageTitle: document.getElementById("page-title"),
  pageSubtitle: document.getElementById("page-subtitle"),
  refresh: document.getElementById("refresh"),
  register: document.getElementById("register-product"),
  banner: document.getElementById("global-banner"),
  modal: document.getElementById("modal-root"),
  toasts: document.getElementById("toast-region")
};

const PRODUCT_CONTRACT_TEMPLATE = `standard_version: "1.1"
product:
  id: my-ai-product
  name: My AI Product
  owner: owner@example.com
environments:
  - name: production
    url: https://product.example.com
critical_journeys:
  - id: core_action
    name: Core action
    success_event: core_action_completed
health:
  live_path: /healthz
  ready_path: /readyz
release:
  version_source: git_sha
  rollback: docs/rollback.md
public_status:
  enabled: false
`;

const app = {
  authenticated: false,
  loading: false,
  data: emptyFleetData(),
  route: parseRoute(),
  detail: null,
  passport: null,
  apiKeys: [],
  detailTab: "overview",
  signalRange: "24h",
  productQuery: "",
  onboarding: newOnboardingState()
};

elements.loginForm.addEventListener("submit", signIn);
elements.refresh.addEventListener("click", refreshCurrentView);
elements.register.addEventListener("click", () => navigate("/onboarding"));
elements.view.addEventListener("click", handleViewClick);
elements.view.addEventListener("submit", handleViewSubmit);
elements.view.addEventListener("input", handleViewInput);
elements.view.addEventListener("change", handleViewChange);
window.addEventListener("hashchange", async () => {
  app.route = parseRoute();
  await renderRoute();
});

bootstrap();

async function bootstrap() {
  try {
    await loadFleetData();
    showDashboard();
    await renderRoute();
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      showDashboard();
      renderError(error);
    }
  } finally {
    hideBoot();
  }
}

async function signIn(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const submit = elements.loginForm.querySelector("button[type='submit']");
  setButtonBusy(submit, true, "Checking credentials…");
  try {
    await apiJson("/api/session/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("login-email").value,
        password: document.getElementById("login-password").value
      })
    });
    await loadFleetData();
    showDashboard();
    await renderRoute();
  } catch (error) {
    elements.loginError.textContent = error.status === 401
      ? "Those credentials were not accepted."
      : "The operations desk could not be reached. Try again.";
  } finally {
    setButtonBusy(submit, false);
  }
}

async function loadFleetData() {
  const [products, operational, incidents, alerts, summary, publicStatus] = await Promise.all([
    apiJson("/api/products"),
    apiJson("/api/operational-status"),
    apiJson("/api/incidents"),
    apiJson("/api/alert-instances"),
    apiJson("/api/summary"),
    apiJson("/api/status")
  ]);
  app.data = {
    products,
    operational,
    incidents: incidents.items ?? [],
    alerts: alerts.items ?? [],
    summary,
    publicStatus
  };
  app.authenticated = true;
}

async function refreshCurrentView() {
  if (app.loading) return;
  app.loading = true;
  setButtonBusy(elements.refresh, true, "Refreshing…");
  showBanner("Refreshing telemetry, monitor results, alerts, and incidents…");
  try {
    await loadFleetData();
    if (app.route.name === "product") await loadProduct(app.route.productId, app.route.environment);
    await renderRoute({ preserveData: true });
    showToast("Operational state refreshed.");
  } catch (error) {
    if (error.status === 401) showLogin();
    else renderError(error);
  } finally {
    app.loading = false;
    setButtonBusy(elements.refresh, false);
    hideBanner();
  }
}

async function renderRoute(options = {}) {
  if (!app.authenticated) return;
  setActiveNavigation(app.route.name);
  elements.register.hidden = app.route.name === "onboarding";

  if (app.route.name === "onboarding") {
    renderOnboarding();
    return;
  }
  if (app.route.name === "product") {
    setHeader("Product / evidence and response", "Product detail", "Loading environment-isolated runtime evidence…");
    if (!options.preserveData || app.detail?.product?.product_id !== app.route.productId || app.detail?.environment !== app.route.environment) {
      renderLoading();
      try {
        await loadProduct(app.route.productId, app.route.environment);
      } catch (error) {
        renderError(error);
        return;
      }
    }
    renderProductDetail();
    return;
  }
  if (app.route.name === "products") {
    renderProductsView();
    return;
  }
  if (app.route.name === "incidents") {
    renderIncidentsView();
    return;
  }
  if (app.route.name === "public-status") {
    renderPublicStatusView();
    return;
  }
  renderOperationsDesk();
}

function renderOperationsDesk() {
  setHeader(
    "Fleet / right now",
    "Operations desk",
    `Last recomputed ${formatDate(app.data.operational.generated_at)}. Operational state is derived from health, monitors, freshness, and incidents.`
  );
  const items = app.data.operational.items ?? [];
  const fleetState = normalizeState(app.data.operational.status);
  const outages = items.filter((item) => item.status === "outage").length;
  const unknown = items.filter((item) => item.status === "unknown").length;
  const activeIncidents = app.data.incidents.filter(isActiveRecord);
  const activeAlerts = app.data.alerts.filter(isActiveRecord);
  const problems = buildActionQueue(items, activeIncidents, activeAlerts);

  elements.view.innerHTML = `
    <section class="state-strip" aria-label="Current fleet state">
      <div class="state-primary ${fleetState}" data-testid="fleet-state">
        <span class="state-lamp" aria-hidden="true"></span>
        <div><small>Fleet state</small><strong>${escapeHtml(fleetState)}</strong></div>
      </div>
      ${metricCell(problems.length, "Current actions")}
      ${metricCell(outages, "Outages")}
      ${metricCell(unknown, "Unknown states")}
    </section>
    <section class="content-grid">
      <article class="panel span-7">
        <header class="panel-head">
          <div><h2>Current action queue</h2><p>Open incidents, active alerts, and degraded or unavailable environments.</p></div>
          <span class="count-chip">${problems.length} open</span>
        </header>
        ${problems.length ? `<div class="action-list">${problems.map(actionMarkup).join("")}</div>` : emptyMarkup(
          "✓",
          "No active incidents or reliability regressions.",
          "Unknown products remain visible below until the first trustworthy signal arrives.",
          true
        )}
      </article>
      <article class="panel span-5">
        <header class="panel-head">
          <div><h2>Coverage gaps</h2><p>Unknown is explicit; it never becomes healthy by omission.</p></div>
          <span class="count-chip">${unknown}</span>
        </header>
        ${renderCoverageGaps(items)}
      </article>
      <article class="panel span-12">
        <header class="panel-head">
          <div><h2>Product environments</h2><p>Production is shown first. Staging cannot mask a production failure.</p></div>
          <a class="button quiet small" href="#/products">View all products</a>
        </header>
        ${renderProductGrid(app.data.products, items, 6)}
      </article>
    </section>`;
}

function renderProductsView() {
  setHeader(
    "Registry / ownership and runtime",
    "Products",
    `${app.data.products.length} registered products. Open one to inspect an environment without cross-product or cross-environment leakage.`
  );
  const query = app.productQuery.toLowerCase();
  const filtered = app.data.products.filter((product) => [product.name, product.product_id, product.owner]
    .some((value) => String(value ?? "").toLowerCase().includes(query)));
  elements.view.innerHTML = `
    <header class="view-heading">
      <div><h2>Product registry</h2><p>Declared ownership paired with the latest trustworthy operational evidence.</p></div>
      <label class="search-box"><span class="sr-only">Search products</span><input id="product-search" type="search" placeholder="Search name, ID, or owner" value="${escapeAttribute(app.productQuery)}"></label>
    </header>
    <section id="product-results">
      ${filtered.length ? renderProductGrid(filtered, app.data.operational.items) : emptyMarkup("⌕", "No products match that search.", "Clear the search or register a new product.")}
    </section>`;
}

function renderIncidentsView() {
  const incidents = [...app.data.incidents].sort(newestFirst);
  const active = incidents.filter(isActiveRecord).length;
  setHeader(
    "Response / ownership and recovery",
    "Incidents",
    `${active} active of ${incidents.length} recorded. Recovery requires an explicit note and remains on the timeline.`
  );
  elements.view.innerHTML = `
    <header class="view-heading">
      <div><h2>Incident ledger</h2><p>Ownership, acknowledgement, linked alerts, and recovery history in one durable record.</p></div>
      <span class="state-chip ${active ? "outage" : "operational"}">${active} active</span>
    </header>
    <section class="record-list" id="incident-list">
      ${incidents.length ? incidents.map((incident) => incidentMarkup(incident, app.data.alerts.filter((alert) => alert.product_id === incident.product_id && alert.environment === incident.environment))).join("") : emptyMarkup("○", "No incidents have been recorded.", "Open incidents from a product environment so ownership and status impact stay scoped.")}
    </section>`;
}

function renderPublicStatusView() {
  const publicProducts = app.data.publicStatus.products ?? [];
  const unpublished = app.data.products.filter((product) => !product.public_status_enabled && product.contract?.public_status?.enabled !== true);
  setHeader(
    "Communication / deliberately public",
    "Public status",
    "Only explicitly published production state is exposed. Owners, raw reasons, internal evidence, and secrets stay private."
  );
  elements.view.innerHTML = `
    <section class="content-grid">
      <article class="panel span-7">
        <header class="panel-head"><div><h2>Published services</h2><p>The public page consumes the same four-state operational projection.</p></div><a class="button quiet small" href="/status" target="_blank" rel="noopener">Open fleet page</a></header>
        ${publicProducts.length ? `<div class="record-list">${publicProducts.map((product) => `
          <article class="record-card">
            <div class="record-card-header"><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.summary)}</p></div>${stateChip(product.status)}</div>
            <div class="record-meta"><span>/${escapeHtml(product.slug)}</span><span>${formatDate(product.updated_at)}</span><span>${product.components.length} components</span></div>
            <div class="card-actions"><a class="button quiet small" href="/status/${encodeURIComponent(product.slug)}" target="_blank" rel="noopener">View public page</a></div>
          </article>`).join("")}</div>` : emptyMarkup("◌", "Nothing is public.", "Publication is opt-in from each product. Unknown state is safe to publish; internal evidence is not.", true)}
      </article>
      <article class="panel span-5">
        <header class="panel-head"><div><h2>Private by default</h2><p>These products have no public projection.</p></div><span class="count-chip">${unpublished.length}</span></header>
        ${unpublished.length ? `<div class="record-list">${unpublished.slice(0, 8).map((product) => `
          <article class="record-card"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.product_id)}</p><div class="card-actions"><a class="button quiet small" href="#/products/${encodeURIComponent(product.product_id)}?environment=production&tab=configuration">Manage publication</a></div></article>`).join("")}</div>` : `<p class="meta-copy">Every registered product is explicitly published.</p>`}
      </article>
    </section>`;
}

async function loadProduct(productId, environment) {
  const encoded = encodeURIComponent(productId);
  const query = `environment=${encodeURIComponent(environment)}`;
  const [detail, passport, apiKeys] = await Promise.all([
    apiJson(`/api/products/${encoded}/detail?${query}`),
    apiJson(`/api/system-passports/${encoded}?${query}`),
    apiJson(`/api/products/${encoded}/api-keys`)
  ]);
  app.detail = detail;
  app.passport = passport;
  app.apiKeys = apiKeys.items ?? [];
  if (app.route.tab) app.detailTab = app.route.tab;
}

function renderProductDetail() {
  const detail = app.detail;
  const product = detail.product;
  const status = normalizeState(detail.status?.status);
  const environments = declaredEnvironments(product);
  const publicationEnabled = product.public_status_enabled === true || product.contract?.public_status?.enabled === true;
  setHeader(
    `${product.product_id} / ${detail.environment}`,
    product.name,
    `${product.owner} · Standard ${product.standard_version} · ${formatDate(detail.status?.updated_at)}`
  );
  elements.view.innerHTML = `
    <section class="page-hero ${status}">
      <div>
        <p class="kicker">Environment-isolated operational state</p>
        <h2>${escapeHtml(product.name)}</h2>
        <p>${escapeHtml(detail.status?.reasons?.[0]?.message ?? statusSummary(status))}</p>
        <div class="button-row" style="margin-top:16px">
          ${stateChip(status)}
          <button class="button quiet small" type="button" data-action="open-incident">Open incident</button>
          <button class="button quiet small" type="button" data-action="schedule-maintenance">Schedule maintenance</button>
          <button class="button quiet small" type="button" data-action="toggle-public" data-enabled="${publicationEnabled}">${publicationEnabled ? "Unpublish status" : "Publish status"}</button>
        </div>
      </div>
      <div class="environment-control">
        <label for="environment-select">Environment</label>
        <select id="environment-select" aria-label="Environment">
          ${environments.map((environment) => `<option value="${escapeAttribute(environment)}" ${environment === detail.environment ? "selected" : ""}>${escapeHtml(environment)}</option>`).join("")}
        </select>
      </div>
    </section>
    <div class="tab-list" role="tablist" aria-label="Product details">
      ${tabButton("overview", "Overview")}
      ${tabButton("signals", "Signals")}
      ${tabButton("incidents", "Incidents")}
      ${tabButton("passport", "System passport")}
      ${tabButton("configuration", "Configuration")}
    </div>
    <section class="tab-panel" role="tabpanel">${renderDetailTab()}</section>`;
}

function renderDetailTab() {
  if (app.detailTab === "signals") return renderSignalsTab();
  if (app.detailTab === "incidents") return renderIncidentsTab();
  if (app.detailTab === "passport") return renderPassportTab();
  if (app.detailTab === "configuration") return renderConfigurationTab();
  return renderOverviewTab();
}

function renderOverviewTab() {
  const detail = app.detail;
  const reasons = detail.status?.reasons ?? [];
  return `
    <div class="content-grid">
      <article class="panel span-7">
        <header class="panel-head"><div><h2>Why this state</h2><p>Only evidence from ${escapeHtml(detail.environment)} contributes here.</p></div></header>
        ${reasons.length ? `<ul class="reason-list">${reasons.map((reason) => `<li><strong>${escapeHtml(reason.code)}</strong><br>${escapeHtml(reason.message)}</li>`).join("")}</ul>` : `<div class="empty-state compact"><div><div class="empty-mark">✓</div><h3>No active reliability reason</h3><p>Fresh health and critical monitor evidence currently support operational state.</p></div></div>`}
      </article>
      <article class="panel span-5">
        <header class="panel-head"><div><h2>Latest release</h2><p>Environment-scoped deployment signal.</p></div></header>
        ${app.detail.latest_release ? `<dl class="key-value-list"><div><dt>Version</dt><dd>${escapeHtml(app.detail.latest_release.payload?.version ?? app.detail.latest_release.release)}</dd></div><div><dt>Received</dt><dd>${formatDate(app.detail.latest_release.occurred_at)}</dd></div></dl>` : emptyMarkup("—", "No release signal.", "Send a release envelope from the deployment pipeline.", true)}
      </article>
      <article class="panel span-7">
        <header class="panel-head"><div><h2>Monitors</h2><p>Cadence, timeout, severity, and the latest result remain visible.</p></div><span class="count-chip">${app.detail.monitors.length}</span></header>
        ${app.detail.monitors.length ? `<div class="record-list">${app.detail.monitors.map(monitorMarkup).join("")}</div>` : emptyMarkup("⌁", "No monitor configured.", "Register an HTTP or event-freshness monitor to add independent evidence.", true)}
      </article>
      <article class="panel span-5">
        <header class="panel-head"><div><h2>Critical journeys</h2><p>Declared outcomes paired with retained runtime signals.</p></div><span class="count-chip">${app.detail.journeys.length}</span></header>
        ${app.detail.journeys.length ? `<div class="record-list">${app.detail.journeys.map((journey) => journeySignalMarkup(journey, app.detail.events)).join("")}</div>` : emptyMarkup("◇", "No critical journey declared.", "Add a business outcome to the product contract.", true)}
      </article>
    </div>`;
}

function renderSignalsTab() {
  const cutoff = rangeCutoff(app.signalRange);
  const errors = app.detail.errors.filter((item) => !cutoff || Date.parse(item.occurred_at) >= cutoff);
  const events = app.detail.events.filter((item) => !cutoff || Date.parse(item.occurred_at) >= cutoff);
  const runs = app.detail.monitor_runs.filter((item) => !cutoff || Date.parse(item.checked_at) >= cutoff);
  return `
    <div class="filter-row" style="justify-content:flex-end;margin-bottom:14px">
      <label class="range-filter">Time range
        <select id="signal-range" aria-label="Signal time range">
          ${[["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["all", "All retained"]].map(([value, label]) => `<option value="${value}" ${app.signalRange === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="content-grid">
      <article class="panel span-6"><header class="panel-head"><div><h2>Error summary</h2><p>Grouped by error name, message, and release; recent records remain available below.</p></div><span class="count-chip">${errors.length}</span></header>${errorSummaryMarkup(errors)}</article>
      <article class="panel span-6"><header class="panel-head"><div><h2>Product events</h2><p>Business signals in range.</p></div><span class="count-chip">${events.length}</span></header>${signalRecords(events, "event")}</article>
      <article class="panel span-12"><header class="panel-head"><div><h2>Monitor runs</h2><p>Independent checks with duration and threshold context.</p></div><span class="count-chip">${runs.length}</span></header>${runs.length ? `<div class="record-list">${runs.map(runMarkup).join("")}</div>` : emptyMarkup("⌁", "No monitor runs in this range.", "The worker records each due monitor execution.", true)}</article>
    </div>`;
}

function renderIncidentsTab() {
  const incidents = [...app.detail.incidents].sort(newestFirst);
  const alerts = [...app.detail.alerts].sort(newestFirst);
  return `
    <div class="content-grid">
      <article class="panel span-7"><header class="panel-head"><div><h2>Incidents</h2><p>Operate acknowledgement, alert linkage, ownership, and recovery here.</p></div><button class="button primary small" type="button" data-action="open-incident">Open incident</button></header>${incidents.length ? `<div class="record-list">${incidents.map((incident) => incidentMarkup(incident, alerts)).join("")}</div>` : emptyMarkup("○", "No incidents for this environment.", "Open one when coordinated response or customer communication is required.", true)}</article>
      <article class="panel span-5"><header class="panel-head"><div><h2>Alert instances</h2><p>Deduplicated rule lifecycle, separate from incidents.</p></div><span class="count-chip">${alerts.length}</span></header>${alerts.length ? `<div class="record-list">${alerts.map(alertMarkup).join("")}</div>` : emptyMarkup("✓", "No alert instances.", "Alerts open only when their structured thresholds are met.", true)}</article>
    </div>`;
}

function renderPassportTab() {
  const sections = app.passport?.sections ?? [];
  return `
    <header class="view-heading">
      <div><p class="kicker">Dynamic evidence map</p><h2>Evidence-sourced passport</h2><p>Every fact retains its source, time, and declared/detected/verified state. Missing evidence stays missing.</p></div>
      <span class="count-chip">Generated ${formatDate(app.passport?.generated_at)}</span>
    </header>
    <div class="passport-grid">
      ${sections.map((section) => `<article class="passport-section">
        <header class="passport-section-header"><h3>${escapeHtml(section.title)}</h3>${verificationChip(section.verification)}</header>
        ${section.entries.length ? section.entries.map((entry) => `<div class="passport-entry"><strong>${escapeHtml(entry.label)}</strong><pre>${escapeHtml(formatValue(entry.value))}</pre><div class="evidence-meta"><span>${escapeHtml(entry.source)}</span><span>${escapeHtml(entry.verification)}</span><span>${formatDate(entry.updated_at)}</span></div></div>`).join("") : `<p class="meta-copy">No evidence supplied for this section.</p>`}
      </article>`).join("")}
    </div>`;
}

function renderConfigurationTab() {
  const product = app.detail.product;
  const published = product.public_status_enabled === true || product.contract?.public_status?.enabled === true;
  return `
    <div class="content-grid">
      <article class="panel span-6">
        <header class="panel-head"><div><h2>Product registry</h2><p>Declared identity and ownership.</p></div></header>
        <dl class="key-value-list">
          <div><dt>Product ID</dt><dd>${escapeHtml(product.product_id)}</dd></div>
          <div><dt>Owner</dt><dd>${escapeHtml(product.owner)}</dd></div>
          <div><dt>Standard</dt><dd>${escapeHtml(product.standard_version)}</dd></div>
          <div><dt>Environment</dt><dd>${escapeHtml(app.detail.environment)}</dd></div>
        </dl>
      </article>
      <article class="panel span-6">
        <header class="panel-head"><div><h2>Public status</h2><p>Production only, explicit, and redacted.</p></div>${stateChip(published ? "operational" : "unknown", published ? "Published" : "Private")}</header>
        <p class="meta-copy">${published ? "This product is included in the public projection." : "No product data is public until an operator enables publication."}</p>
        <div class="card-actions"><button class="button ${published ? "danger" : "primary"} small" type="button" data-action="toggle-public" data-enabled="${published}">${published ? "Unpublish product" : "Publish production status"}</button>${published ? `<a class="button quiet small" href="/status/${encodeURIComponent(product.product_id)}" target="_blank" rel="noopener">Open public page</a>` : ""}</div>
      </article>
      <article class="panel span-12">
        <header class="panel-head"><div><h2>Product API keys</h2><p>Secrets are reveal-once; stored records contain hashes only.</p></div><button class="button primary small" type="button" data-action="create-key">Create key</button></header>
        ${app.apiKeys.length ? `<div class="record-list">${app.apiKeys.map(apiKeyMarkup).join("")}</div>` : emptyMarkup("⌘", "No product API keys.", "Create a scoped ingest or read key for server-side use.", true)}
      </article>
    </div>`;
}

function renderOnboarding() {
  setHeader(
    "Onboarding / product to first signal",
    "Register product",
    "Validate ownership and runtime boundaries, prove keyed telemetry, then attach the first independent monitor."
  );
  const step = app.onboarding.step;
  elements.view.innerHTML = `
    <section class="onboarding-shell">
      <div class="stepper" aria-label="Onboarding progress">
        ${stepMarkup(1, "Validated contract", step)}${stepMarkup(2, "Prove connection", step)}${stepMarkup(3, "First monitor", step)}
      </div>
      ${step === 1 ? onboardingProductForm() : step === 2 ? onboardingSecretStep() : onboardingMonitorForm()}
    </section>`;
}

function onboardingProductForm() {
  return `<article class="onboarding-card">
    <p class="kicker">Step 01 / contract gate</p><h2>Register a product</h2>
    <p>Import the product's durable contract, or use the complete contract builder. Registration stays blocked until the same JSON Schema and compatibility checks used by automation accept it.</p>
    <div class="onboarding-mode-switch" role="group" aria-label="Contract entry method">
      <button type="button" class="${app.onboarding.mode === "yaml" ? "active" : ""}" data-action="select-onboarding-mode" data-mode="yaml">Import product.yml</button>
      <button type="button" class="${app.onboarding.mode === "manual" ? "active" : ""}" data-action="select-onboarding-mode" data-mode="manual">Build complete contract</button>
    </div>
    ${app.onboarding.mode === "manual" ? onboardingManualForm() : onboardingYamlForm()}
  </article>`;
}

function onboardingYamlForm() {
  return `<form id="onboarding-contract-form">
      <label class="contract-file" for="product-yaml-file"><span><strong>Import product.yml</strong><small>YAML only · contents stay in this browser until validation</small></span><input id="product-yaml-file" type="file" accept=".yml,.yaml,text/yaml,application/yaml"></label>
      <label class="field full contract-editor">product.yml contents<textarea id="product-yaml" name="yaml" aria-label="product.yml contents" required spellcheck="false">${escapeHtml(app.onboarding.yaml)}</textarea><small>Publication is private unless <code>public_status.enabled</code> is explicitly true.</small></label>
      <div id="contract-validation-result">${contractValidationMarkup(app.onboarding.validation)}</div>
      <footer class="form-footer"><a class="button quiet" href="#/">Cancel</a><button class="button quiet" type="submit">Validate product.yml</button>${app.onboarding.validation?.ok ? `<button class="button primary" type="button" data-action="create-validated-product">Register validated contract</button>` : ""}</footer>
    </form>`;
}

function onboardingManualForm() {
  return `<form id="onboarding-manual-form">
      <div class="form-grid">
        <label class="field">Product ID<input id="product-id" name="product_id" required pattern="[a-z0-9][a-z0-9-]{1,127}" placeholder="invoice-ai"><small>Stable lowercase identifier used by every SDK envelope.</small></label>
        <label class="field">Product name<input id="product-name" name="name" required placeholder="Invoice AI"></label>
        <label class="field">Owner email<input id="product-owner" name="owner" type="email" required placeholder="owner@example.com"></label>
        <label class="field">Environment<select id="product-environment" name="environment"><option value="production">production</option><option value="staging">staging</option><option value="development">development</option></select></label>
        <label class="field full">Environment URL<input id="environment-url" name="environment_url" type="url" required placeholder="https://product.example.com"></label>
        <label class="field">Critical journey name<input name="journey_name" required placeholder="Checkout"></label>
        <label class="field">Journey success event<input name="success_event" required pattern="[a-z][a-z0-9_]*" placeholder="checkout_completed"></label>
        <label class="field">Liveness path<input name="live_path" required value="/healthz"></label>
        <label class="field">Readiness path<input name="ready_path" required value="/readyz"></label>
        <label class="field">Release version source<input name="version_source" required value="git_sha"></label>
        <label class="field">Rollback reference<input name="rollback" required value="docs/rollback.md"></label>
        <label class="checkbox-field full"><input name="publish" type="checkbox"><span>Publish a redacted production status after setup. This can be changed later.</span></label>
      </div>
      <p class="form-error" data-form-error role="alert"></p>
      <footer class="form-footer"><a class="button quiet" href="#/">Cancel</a><button class="button primary" type="submit">Validate and register contract</button></footer>
    </form>
  `;
}

function onboardingSecretStep() {
  const product = app.onboarding.product;
  const snippets = onboardingSdkSnippets(product);
  const confirmed = app.onboarding.connection?.status === "confirmed";
  return `<article class="onboarding-card">
    <p class="kicker">Step 02 / telemetry boundary</p><h2>Connect telemetry</h2>
    <p>The validated product registry exists. Store this least-privilege server key now, select the matching SDK, then prove both authenticated write and operator readback.</p>
    <div class="secret-box">
      <p>This secret is shown once.</p>
      <code data-testid="revealed-secret">${escapeHtml(app.onboarding.secret)}</code>
      <button class="button quiet small" type="button" data-action="copy-secret">Copy secret</button>
    </div>
    <dl class="key-value-list onboarding-key-facts"><div><dt>Product</dt><dd>${escapeHtml(product.name)} / ${escapeHtml(product.product_id)}</dd></div><div><dt>Scopes</dt><dd data-testid="key-scopes">ingest only</dd></div><div><dt>SDK endpoint</dt><dd>${escapeHtml(window.location.origin)}</dd></div></dl>
    <section class="snippet-section" aria-labelledby="sdk-snippets-title"><div class="section-heading"><div><p class="kicker">Server SDK examples</p><h3 id="sdk-snippets-title">Use the product-scoped key</h3></div><p>Keep <code>APR_PRODUCT_API_KEY</code> in the server-side secret manager. Never place it in browser or mobile code.</p></div><div class="snippet-grid">${Object.entries(snippets).map(([language, snippet]) => snippetMarkup(language, snippet)).join("")}</div></section>
    <section class="connectivity-check" aria-labelledby="connectivity-title"><div><p class="kicker">Authenticated round trip</p><h3 id="connectivity-title">Check connectivity</h3><p>The test uses the reveal-once ingest key to write one event, then uses this operator session—not the ingest key—to confirm it appears in the product detail.</p></div>${connectivityMarkup(app.onboarding.connection)}<button class="button quiet" type="button" data-action="send-onboarding-probe">${confirmed ? "Send another keyed test event" : "Send keyed test event"}</button></section>
    <footer class="form-footer"><a class="button quiet" href="#/products/${encodeURIComponent(product.product_id)}?environment=${encodeURIComponent(product.environments?.[0]?.name ?? "production")}">Exit setup</a><button class="button primary" type="button" data-action="onboarding-monitor" ${confirmed ? "" : "disabled"}>Continue to first monitor</button></footer>
  </article>`;
}

function onboardingMonitorForm() {
  const product = app.onboarding.product;
  const environment = product.environments?.[0]?.name ?? "production";
  const livePath = product.contract?.health?.live_path ?? "/healthz";
  const suggestedUrl = product.environments?.[0]?.url ? `${String(product.environments[0].url).replace(/\/$/, "")}${String(livePath).startsWith("/") ? livePath : `/${livePath}`}` : "";
  return `<article class="onboarding-card">
    <p class="kicker">Step 03 / independent evidence</p><h2>Add the first monitor</h2>
    <p>Use a public health or readiness URL. The server validates the target again immediately before every fetch to prevent SSRF rebinding.</p>
    <form id="onboarding-monitor-form">
      <div class="form-grid">
        <label class="field">Monitor name<input id="monitor-name" name="name" required value="Production readiness"></label>
        <label class="field">Environment<input name="environment" readonly value="${escapeAttribute(environment)}"></label>
        <label class="field full">Monitor URL<input id="monitor-url" name="url" type="url" required value="${escapeAttribute(suggestedUrl)}"></label>
        <label class="field">Interval (seconds)<input name="interval_seconds" type="number" min="15" value="60" required></label>
        <label class="field">Timeout (milliseconds)<input name="timeout_ms" type="number" min="100" value="2500" required></label>
      </div>
      <p class="form-error" data-form-error role="alert"></p>
      <footer class="form-footer"><button class="button quiet" type="button" data-action="onboarding-back-secret">Back</button><button class="button primary" type="submit">Save monitor and open product</button></footer>
    </form>
  </article>`;
}

async function handleViewSubmit(event) {
  if (event.target.id === "onboarding-contract-form") {
    event.preventDefault();
    await validateImportedContract(event.target);
  } else if (event.target.id === "onboarding-manual-form") {
    event.preventDefault();
    await submitManualProduct(event.target);
  } else if (event.target.id === "onboarding-monitor-form") {
    event.preventDefault();
    await submitOnboardingMonitor(event.target);
  }
}

async function validateImportedContract(form) {
  const yaml = String(new FormData(form).get("yaml") ?? "");
  app.onboarding.yaml = yaml;
  const submit = form.querySelector("button[type='submit']");
  setButtonBusy(submit, true, "Validating…");
  try {
    const result = await apiJson("/api/product-contracts/validate", { method: "POST", body: JSON.stringify({ yaml }) });
    app.onboarding.validation = { ok: true, ...result };
    renderOnboarding();
    showToast("Contract valid. Review compatibility guidance before registration.");
  } catch (error) {
    app.onboarding.validation = {
      ok: false,
      code: error.code ?? "invalid_contract",
      message: error.message,
      issues: error.details?.issues ?? []
    };
    renderOnboarding();
  } finally {
    setButtonBusy(submit, false);
  }
}

async function submitManualProduct(form) {
  const values = new FormData(form);
  const submit = form.querySelector("button[type='submit']");
  const errorTarget = form.querySelector("[data-form-error]");
  errorTarget.textContent = "";
  setButtonBusy(submit, true, "Validating contract…");
  const contract = {
    standard_version: "1.0",
    product: {
      id: String(values.get("product_id")).trim(),
      name: String(values.get("name")).trim(),
      owner: String(values.get("owner")).trim()
    },
    environments: [{ name: String(values.get("environment")), url: String(values.get("environment_url")).trim() }],
    critical_journeys: [{
      id: slugifyIdentifier(String(values.get("journey_name"))),
      name: String(values.get("journey_name")).trim(),
      success_event: String(values.get("success_event")).trim()
    }],
    health: { live_path: String(values.get("live_path")).trim(), ready_path: String(values.get("ready_path")).trim() },
    release: { version_source: String(values.get("version_source")).trim(), rollback: String(values.get("rollback")).trim() },
    public_status: { enabled: values.get("publish") === "on" }
  };
  try {
    const validated = await apiJson("/api/product-contracts/validate", {
      method: "POST",
      body: JSON.stringify({ yaml: JSON.stringify(contract) })
    });
    await createOnboardingProduct(validated.contract);
  } catch (error) {
    errorTarget.textContent = error.message;
  } finally {
    setButtonBusy(submit, false);
  }
}

async function createOnboardingProduct(contract, button) {
  if (!contract) return;
  setButtonBusy(button, true, "Registering…");
  const productId = contract.product.id;
  try {
    const created = await apiJson("/api/products", { method: "POST", body: JSON.stringify(contract) });
    const key = await apiJson(`/api/products/${encodeURIComponent(productId)}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name: "Initial server ingest", scopes: ["ingest"] })
    });
    app.onboarding = {
      ...app.onboarding,
      step: 2,
      product: created.product,
      secret: key.secret,
      connection: { status: "idle" }
    };
    await loadFleetData();
    renderOnboarding();
    showToast("Validated product registered. Store the reveal-once ingest key now.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function sendOnboardingProbe(button) {
  const product = app.onboarding.product;
  const environment = product.environments?.[0]?.name ?? "production";
  const idempotencyKey = `onboarding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  setButtonBusy(button, true, "Sending and reading back…");
  app.onboarding.connection = { status: "checking" };
  try {
    const result = await apiJson("/api/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${app.onboarding.secret}` },
      body: JSON.stringify({ items: [{
        schema_version: "1.1",
        type: "event",
        product_id: product.product_id,
        environment,
        release: "onboarding-connectivity-check",
        occurred_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
        payload: { event: "apr_onboarding_connected", properties: { source: "dashboard" } }
      }] })
    });
    const detail = await apiJson(`/api/products/${encodeURIComponent(product.product_id)}/detail?environment=${encodeURIComponent(environment)}`);
    const observed = detail.events?.some((item) => item.idempotency_key === idempotencyKey);
    if (result.accepted !== 1 || !observed) throw new Error("The collector accepted no new event or the operator readback could not find it.");
    app.onboarding.connection = { status: "confirmed", accepted: result.accepted, checkedAt: new Date().toISOString() };
    renderOnboarding();
    showToast("Keyed telemetry accepted and confirmed through product detail.");
  } catch (error) {
    app.onboarding.connection = { status: "error", message: error.message };
    renderOnboarding();
  } finally {
    setButtonBusy(button, false);
  }
}

function contractValidationMarkup(validation) {
  if (!validation) {
    return `<section class="contract-validation neutral" data-testid="contract-validation"><span class="validation-mark">?</span><div><h3>Awaiting validation</h3><p>Schema errors, deprecated fields, and version migration advice will appear here.</p></div></section>`;
  }
  if (!validation.ok) {
    const issues = validation.issues?.length ? `<ul>${validation.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : "";
    return `<section class="contract-validation invalid" data-testid="contract-validation" role="alert"><span class="validation-mark">!</span><div><h3>Contract needs attention</h3><p><code>${escapeHtml(validation.code)}</code> · ${escapeHtml(validation.message)}</p>${issues}</div></section>`;
  }
  const warnings = validation.warnings ?? [];
  const advice = validation.migration_advice ?? [];
  return `<section class="contract-validation valid" data-testid="contract-validation"><span class="validation-mark">✓</span><div><h3>Contract valid</h3><p>${escapeHtml(validation.contract.product.name)} / ${escapeHtml(validation.contract.product.id)} can be registered.</p>${warnings.length ? `<div class="guidance-block warning"><strong>Compatibility warnings</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning.message ?? warning.code)}</li>`).join("")}</ul></div>` : `<p class="validation-note">No deprecated fields or newer-minor warnings.</p>`}${advice.length ? `<div class="guidance-block advice"><strong>Migration advice</strong><ul>${advice.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : `<p class="validation-note">Contract is current with collector 1.1.</p>`}</div></section>`;
}

function onboardingSdkSnippets(product) {
  const environment = product.environments?.[0]?.name ?? "production";
  const endpoint = window.location.origin;
  const productId = product.product_id;
  return {
    Node: `import { createReliabilityClient } from "@ai-product-reliability/sdk-node";\n\nconst client = createReliabilityClient({\n  productId: "${productId}",\n  environment: "${environment}",\n  release: process.env.GIT_SHA,\n  endpoint: "${endpoint}",\n  apiKey: process.env.APR_PRODUCT_API_KEY\n});`,
    Python: `import os\nfrom ai_product_reliability import ReliabilityClient\n\nclient = ReliabilityClient(\n    product_id="${productId}",\n    environment="${environment}",\n    release=os.environ["GIT_SHA"],\n    endpoint="${endpoint}",\n    api_key=os.environ["APR_PRODUCT_API_KEY"],\n)`,
    Java: `ReliabilityClient client = new ReliabilityClient(\n    "${productId}",\n    "${environment}",\n    System.getenv("GIT_SHA"),\n    "${endpoint}",\n    System.getenv("APR_PRODUCT_API_KEY"),\n    new ReliabilityClient.Options()\n);`
  };
}

function snippetMarkup(language, snippet) {
  return `<article class="snippet-card"><header><strong>${escapeHtml(language)}</strong><button class="button quiet small" type="button" data-action="copy-sdk-snippet" data-language="${escapeAttribute(language)}" aria-label="Copy ${escapeAttribute(language)} snippet">Copy</button></header><pre><code>${escapeHtml(snippet)}</code></pre></article>`;
}

function connectivityMarkup(connection) {
  if (connection?.status === "confirmed") {
    return `<div class="connectivity-result confirmed" data-testid="connectivity-confirmed"><span>✓</span><div><strong>Connection confirmed</strong><p>Accepted by ingest and confirmed through the operator readback · ${formatDate(connection.checkedAt)}</p></div></div>`;
  }
  if (connection?.status === "error") {
    return `<div class="connectivity-result failed" role="alert"><span>!</span><div><strong>Connection not confirmed</strong><p>${escapeHtml(connection.message)}</p></div></div>`;
  }
  if (connection?.status === "checking") {
    return `<div class="connectivity-result checking" role="status"><span>…</span><div><strong>Checking both boundaries</strong><p>Writing with the product key, then reading with the operator session.</p></div></div>`;
  }
  return `<div class="connectivity-result idle"><span>→</span><div><strong>Round trip not run</strong><p>No monitor setup is unlocked until the keyed event is visible in product detail.</p></div></div>`;
}

function slugifyIdentifier(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "core_action";
}

function newOnboardingState() {
  return {
    step: 1,
    mode: "yaml",
    yaml: PRODUCT_CONTRACT_TEMPLATE,
    validation: null,
    product: null,
    secret: null,
    connection: null
  };
}

async function submitOnboardingMonitor(form) {
  const values = new FormData(form);
  const product = app.onboarding.product;
  const submit = form.querySelector("button[type='submit']");
  const errorTarget = form.querySelector("[data-form-error]");
  errorTarget.textContent = "";
  setButtonBusy(submit, true, "Saving monitor…");
  try {
    await apiJson("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        id: `${product.product_id}-first-readiness`,
        product_id: product.product_id,
        environment: String(values.get("environment")),
        name: String(values.get("name")).trim(),
        type: "http",
        url: String(values.get("url")).trim(),
        interval_seconds: Number(values.get("interval_seconds")),
        timeout_ms: Number(values.get("timeout_ms")),
        severity: "critical",
        failure_threshold: 2
      })
    });
    const environment = String(values.get("environment"));
    const productId = product.product_id;
    app.onboarding = newOnboardingState();
    await loadFleetData();
    showToast("First monitor saved. State remains unknown until evidence arrives.");
    navigate(`/products/${encodeURIComponent(productId)}?environment=${encodeURIComponent(environment)}`);
  } catch (error) {
    errorTarget.textContent = error.message;
  } finally {
    setButtonBusy(submit, false);
  }
}

async function handleViewClick(event) {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  if (action === "retry") return refreshCurrentView();
  if (action === "copy-secret") return copySecret();
  if (action === "select-onboarding-mode") {
    app.onboarding.mode = control.dataset.mode === "manual" ? "manual" : "yaml";
    renderOnboarding();
    return;
  }
  if (action === "create-validated-product") return createOnboardingProduct(app.onboarding.validation?.contract, control);
  if (action === "send-onboarding-probe") return sendOnboardingProbe(control);
  if (action === "copy-sdk-snippet") {
    const snippet = onboardingSdkSnippets(app.onboarding.product)[control.dataset.language];
    if (snippet) await writeClipboard(snippet);
    showToast(`${control.dataset.language} snippet copied.`);
    return;
  }
  if (action === "onboarding-monitor") { app.onboarding.step = 3; renderOnboarding(); return; }
  if (action === "onboarding-back-secret") { app.onboarding.step = 2; renderOnboarding(); return; }
  if (action === "open-onboarded-product") {
    const product = app.onboarding.product;
    navigate(`/products/${encodeURIComponent(product.product_id)}?environment=${encodeURIComponent(product.environments?.[0]?.name ?? "production")}`);
    return;
  }
  if (action === "select-tab") {
    app.detailTab = control.dataset.tab;
    updateRouteTab(app.detailTab);
    renderProductDetail();
    return;
  }
  if (action === "open-incident") return openIncidentModal();
  if (action === "incident-acknowledge") return acknowledgeIncidentAction(control.dataset.id);
  if (action === "incident-resolve") return openResolveModal(control.dataset.id);
  if (action === "incident-assign") return openAssignModal(control.dataset.id);
  if (action === "incident-link-alerts") return openLinkAlertsModal(control.dataset.id);
  if (action === "alert-acknowledge") return acknowledgeAlertAction(control.dataset.id);
  if (action === "schedule-maintenance") return openMaintenanceModal();
  if (action === "toggle-public") return updatePublication(control.dataset.enabled !== "true");
  if (action === "create-key") return openCreateKeyModal();
  if (action === "rotate-key") return rotateApiKey(control.dataset.id);
  if (action === "revoke-key") return openRevokeKeyModal(control.dataset.id);
}

function handleViewInput(event) {
  if (event.target.id === "product-yaml") {
    app.onboarding.yaml = event.target.value;
    if (app.onboarding.validation) {
      app.onboarding.validation = null;
      const target = document.getElementById("contract-validation-result");
      if (target) target.innerHTML = contractValidationMarkup(null);
      document.querySelector("[data-action='create-validated-product']")?.remove();
    }
    return;
  }
  if (event.target.id !== "product-search") return;
  app.productQuery = event.target.value;
  const query = app.productQuery.toLowerCase();
  const filtered = app.data.products.filter((product) => [product.name, product.product_id, product.owner]
    .some((value) => String(value ?? "").toLowerCase().includes(query)));
  const target = document.getElementById("product-results");
  if (target) target.innerHTML = filtered.length
    ? renderProductGrid(filtered, app.data.operational.items)
    : emptyMarkup("⌕", "No products match that search.", "Clear the search or register a new product.");
}

function handleViewChange(event) {
  if (event.target.id === "product-yaml-file") {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then((yaml) => {
      app.onboarding.yaml = yaml;
      app.onboarding.validation = null;
      renderOnboarding();
      showToast(`${file.name} loaded. Validate before registration.`);
    }).catch(() => showToast("The selected contract file could not be read.", true));
    return;
  }
  if (event.target.id === "environment-select") {
    navigate(`/products/${encodeURIComponent(app.detail.product.product_id)}?environment=${encodeURIComponent(event.target.value)}`);
  }
  if (event.target.id === "signal-range") {
    app.signalRange = event.target.value;
    renderProductDetail();
  }
}

function openIncidentModal() {
  if (!app.detail) return;
  openFormModal({
    kicker: `${app.detail.product.product_id} / ${app.detail.environment}`,
    title: "Open incident",
    submitLabel: "Create incident",
    body: `
      <label class="field">Incident title<input name="title" required></label>
      <label class="field">Severity<select name="severity" aria-label="Severity"><option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label>
      <label class="field">Incident owner<input name="owner" type="email" required value="${escapeAttribute(app.detail.product.owner)}"></label>`,
    onSubmit: async (form) => {
      const values = new FormData(form);
      await apiJson("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          product_id: app.detail.product.product_id,
          environment: app.detail.environment,
          title: String(values.get("title")).trim(),
          severity: String(values.get("severity")),
          owner: String(values.get("owner")).trim()
        })
      });
      app.detailTab = "incidents";
      updateRouteTab("incidents");
      await reloadDetailAndFleet();
      showToast("Incident opened and added to operational state.");
    }
  });
}

async function acknowledgeIncidentAction(id) {
  await runRecordAction(async () => {
    await apiJson(`/api/incidents/${encodeURIComponent(id)}/acknowledge`, { method: "POST", body: "{}" });
  }, "Incident acknowledged.");
}

function openResolveModal(id) {
  openFormModal({
    kicker: "Recovery / evidence required",
    title: "Resolve incident",
    submitLabel: "Confirm recovery",
    body: `<label class="field">Recovery note<textarea name="recovery_note" required minlength="8" placeholder="What changed, and how was recovery verified?"></textarea></label>`,
    onSubmit: async (form) => {
      const values = new FormData(form);
      await apiJson(`/api/incidents/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ recovery_note: String(values.get("recovery_note")).trim() })
      });
      await reloadDetailAndFleet();
      showToast("Incident resolved with a durable recovery note.");
    }
  });
}

function openAssignModal(id) {
  openFormModal({
    kicker: "Incident ownership",
    title: "Assign incident",
    submitLabel: "Assign owner",
    body: `<label class="field">Incident owner<input name="owner" type="email" required></label>`,
    onSubmit: async (form) => {
      await apiJson(`/api/incidents/${encodeURIComponent(id)}/assign`, {
        method: "POST",
        body: JSON.stringify({ owner: String(new FormData(form).get("owner")).trim() })
      });
      await reloadDetailAndFleet();
      showToast("Incident owner updated.");
    }
  });
}

function openLinkAlertsModal(id) {
  const incident = app.detail?.incidents?.find((item) => item.id === id)
    ?? app.data.incidents.find((item) => item.id === id);
  if (!incident) {
    showToast("Incident not found in the current operational view.", true);
    return;
  }
  const availableAlerts = (app.detail?.product?.product_id === incident.product_id ? app.detail.alerts : app.data.alerts)
    .filter((alert) => alert.product_id === incident.product_id
      && alert.environment === incident.environment
      && isActiveRecord(alert)
      && !(incident.alert_ids ?? []).includes(alert.id));
  if (!availableAlerts.length) {
    showToast("No unlinked active alerts are available for this product environment.");
    return;
  }
  openFormModal({
    kicker: `${incident.product_id} / ${incident.environment}`,
    title: "Link active alerts",
    submitLabel: "Link selected alerts",
    body: `<fieldset class="alert-picker"><legend>Select active alert evidence</legend>${availableAlerts.map((alert) => `<label class="alert-choice"><input type="checkbox" name="alert_ids" value="${escapeAttribute(alert.id)}"><span><strong>${escapeHtml(alert.name ?? alert.rule_type ?? "Active alert")}</strong><small>${escapeHtml(alert.severity ?? "medium")} · ${escapeHtml(alert.status)} · ${formatDate(alert.updated_at ?? alert.opened_at)}</small></span></label>`).join("")}</fieldset>`,
    onSubmit: async (form) => {
      const alertIds = new FormData(form).getAll("alert_ids").map(String);
      if (!alertIds.length) throw new Error("Select at least one active alert to link.");
      await apiJson(`/api/incidents/${encodeURIComponent(id)}/link-alerts`, {
        method: "POST",
        body: JSON.stringify({ alert_ids: alertIds })
      });
      await reloadDetailAndFleet();
      showToast(`${alertIds.length} active alert${alertIds.length === 1 ? "" : "s"} linked to the incident.`);
    }
  });
}

async function acknowledgeAlertAction(id) {
  await runRecordAction(async () => {
    await apiJson(`/api/alert-instances/${encodeURIComponent(id)}/acknowledge`, { method: "POST", body: "{}" });
  }, "Alert acknowledged; deduplication remains active.");
}

function openMaintenanceModal() {
  if (!app.detail) return;
  const starts = toLocalDateTime(new Date(Date.now() + 5 * 60_000));
  const ends = toLocalDateTime(new Date(Date.now() + 65 * 60_000));
  openFormModal({
    kicker: `${app.detail.product.product_id} / ${app.detail.environment}`,
    title: "Schedule maintenance",
    submitLabel: "Create window",
    body: `<label class="field">Window name<input name="name" required value="Planned deployment"></label><label class="field">Starts at<input name="starts_at" type="datetime-local" required value="${starts}"></label><label class="field">Ends at<input name="ends_at" type="datetime-local" required value="${ends}"></label>`,
    onSubmit: async (form) => {
      const values = new FormData(form);
      await apiJson("/api/maintenance-windows", {
        method: "POST",
        body: JSON.stringify({
          product_id: app.detail.product.product_id,
          environment: app.detail.environment,
          name: String(values.get("name")).trim(),
          starts_at: new Date(String(values.get("starts_at"))).toISOString(),
          ends_at: new Date(String(values.get("ends_at"))).toISOString()
        })
      });
      showToast("Maintenance window scheduled. Due checks will be suppressed during it.");
    }
  });
}

async function updatePublication(enabled) {
  if (!app.detail) return;
  const product = app.detail.product;
  const contract = structuredClone(product.contract ?? {});
  const payload = {
    ...contract,
    standard_version: product.standard_version,
    product: { ...(contract.product ?? {}), id: product.product_id, name: product.name, owner: product.owner },
    environments: product.environments ?? contract.environments ?? [],
    critical_journeys: product.critical_journeys ?? contract.critical_journeys ?? [],
    public_status: { ...(contract.public_status ?? {}), enabled }
  };
  try {
    await apiJson("/api/products", { method: "POST", body: JSON.stringify(payload) });
    if (enabled) {
      await apiJson("/api/status-pages", {
        method: "POST",
        body: JSON.stringify({
          product_id: product.product_id,
          public_slug: product.product_id,
          public_summary: "Current production availability from the reliability operations model.",
          components: []
        })
      });
    }
    await reloadDetailAndFleet();
    showToast(enabled ? "Production status is now public." : "Product removed from public status.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function openCreateKeyModal() {
  openFormModal({
    kicker: "Reveal once / server-side only",
    title: "Create product key",
    submitLabel: "Create key",
    body: `<label class="field">Key name<input name="name" required value="Server ingest"></label><label class="checkbox-field"><input name="read" type="checkbox"><span>Also allow product-scoped read access.</span></label>`,
    onSubmit: async (form) => {
      const values = new FormData(form);
      const result = await apiJson(`/api/products/${encodeURIComponent(app.detail.product.product_id)}/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name: String(values.get("name")).trim(), scopes: values.get("read") === "on" ? ["ingest", "read"] : ["ingest"] })
      });
      await reloadDetailAndFleet();
      showSecretModal(result.secret, "New product key");
    }
  });
}

async function rotateApiKey(id) {
  try {
    const result = await apiJson(`/api/products/${encodeURIComponent(app.detail.product.product_id)}/api-keys/${encodeURIComponent(id)}/rotate`, { method: "POST", body: "{}" });
    await reloadDetailAndFleet();
    showSecretModal(result.secret, "Rotated product key");
  } catch (error) {
    showToast(error.message, true);
  }
}

function openRevokeKeyModal(id) {
  openFormModal({
    kicker: "Immediate credential change",
    title: "Revoke product key",
    submitLabel: "Revoke key",
    body: `<p>This key will stop authenticating immediately. Existing secret material cannot be recovered.</p>`,
    onSubmit: async () => {
      await apiJson(`/api/products/${encodeURIComponent(app.detail.product.product_id)}/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      await reloadDetailAndFleet();
      showToast("Product key revoked.");
    }
  });
}

async function runRecordAction(action, successMessage) {
  try {
    await action();
    await reloadDetailAndFleet();
    showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function reloadDetailAndFleet() {
  const productId = app.detail?.product?.product_id;
  const environment = app.detail?.environment;
  await loadFleetData();
  if (productId && environment) {
    await loadProduct(productId, environment);
    renderProductDetail();
  } else {
    await renderRoute({ preserveData: true });
  }
}

function openFormModal({ kicker, title, body, submitLabel, onSubmit }) {
  elements.modal.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-head"><div><p class="kicker">${escapeHtml(kicker)}</p><h2 id="modal-title">${escapeHtml(title)}</h2></div><button class="modal-close" type="button" aria-label="Close dialog">×</button></header><form class="modal-form">${body}<p class="form-error" data-modal-error role="alert"></p><footer class="form-footer"><button class="button quiet" type="button" data-modal-cancel>Cancel</button><button class="button primary" type="submit">${escapeHtml(submitLabel)}</button></footer></form></section></div>`;
  const backdrop = elements.modal.querySelector(".modal-backdrop");
  const form = elements.modal.querySelector("form");
  const close = () => { elements.modal.innerHTML = ""; document.removeEventListener("keydown", onKeyDown); };
  const onKeyDown = (event) => { if (event.key === "Escape") close(); };
  elements.modal.querySelector(".modal-close").addEventListener("click", close);
  elements.modal.querySelector("[data-modal-cancel]").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  document.addEventListener("keydown", onKeyDown);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type='submit']");
    const errorTarget = form.querySelector("[data-modal-error]");
    setButtonBusy(submit, true, "Saving…");
    errorTarget.textContent = "";
    try {
      await onSubmit(form);
      close();
    } catch (error) {
      errorTarget.textContent = error.message;
    } finally {
      setButtonBusy(submit, false);
    }
  });
  requestAnimationFrame(() => elements.modal.querySelector("input, select, textarea, button")?.focus());
}

function showSecretModal(secret, title) {
  elements.modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><header class="modal-head"><div><p class="kicker">Reveal once</p><h2>${escapeHtml(title)}</h2></div><button class="modal-close" type="button" aria-label="Close dialog">×</button></header><div class="secret-box"><p>This secret is shown once.</p><code data-secret-value>${escapeHtml(secret)}</code><button class="button quiet small" type="button" data-copy-modal>Copy secret</button></div></section></div>`;
  const close = () => { elements.modal.innerHTML = ""; };
  elements.modal.querySelector(".modal-close").addEventListener("click", close);
  elements.modal.querySelector(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  elements.modal.querySelector("[data-copy-modal]").addEventListener("click", async () => {
    await writeClipboard(secret);
    showToast("Secret copied.");
  });
}

async function copySecret() {
  await writeClipboard(app.onboarding.secret);
  showToast("Secret copied. Store it in the product's server-side secret manager.");
}

async function writeClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function buildActionQueue(statuses, incidents, alerts) {
  const actions = [];
  for (const incident of incidents) actions.push({
    kind: "incident",
    status: incident.severity === "critical" ? "outage" : "degraded",
    title: incident.title,
    detail: `${incident.product_id} / ${incident.environment} · owner ${incident.owner ?? "unassigned"}`,
    href: `#/products/${encodeURIComponent(incident.product_id)}?environment=${encodeURIComponent(incident.environment)}&tab=incidents`
  });
  for (const alert of alerts) actions.push({
    kind: "alert",
    status: alert.severity === "critical" ? "outage" : "degraded",
    title: alert.name ?? alert.rule_type ?? "Active alert",
    detail: `${alert.product_id} / ${alert.environment} · ${alert.status}`,
    href: `#/products/${encodeURIComponent(alert.product_id)}?environment=${encodeURIComponent(alert.environment)}&tab=incidents`
  });
  for (const item of statuses.filter((status) => ["outage", "degraded"].includes(status.status))) {
    if (actions.some((action) => action.detail.startsWith(`${item.product_id} / ${item.environment}`))) continue;
    actions.push({
      kind: "state",
      status: item.status,
      title: `${item.product_name} is ${item.status}`,
      detail: `${item.product_id} / ${item.environment} · ${item.reasons?.[0]?.message ?? "Investigate current evidence"}`,
      href: `#/products/${encodeURIComponent(item.product_id)}?environment=${encodeURIComponent(item.environment)}`
    });
  }
  return actions.slice(0, 20);
}

function actionMarkup(action) {
  return `<div class="action-item ${escapeAttribute(action.status)}"><span class="action-icon">!</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.detail)}</p></div><a class="button quiet small" href="${escapeAttribute(action.href)}">Investigate</a></div>`;
}

function renderCoverageGaps(items) {
  const gaps = items.filter((item) => item.status === "unknown");
  if (!gaps.length) return `<div class="empty-state compact"><div><div class="empty-mark">✓</div><h3>All declared environments have evidence.</h3><p>Freshness rules still apply continuously.</p></div></div>`;
  return `<div class="record-list">${gaps.slice(0, 7).map((item) => `<article class="record-card"><div class="record-card-header"><h3>${escapeHtml(item.product_name)}</h3>${stateChip("unknown")}</div><p>${escapeHtml(item.reasons?.[0]?.message ?? "No trustworthy state")}</p><div class="record-meta"><span>${escapeHtml(item.environment)}</span><span>${formatDate(item.updated_at)}</span></div></article>`).join("")}</div>`;
}

function renderProductGrid(products, statuses, limit = Number.POSITIVE_INFINITY) {
  if (!products.length) return emptyMarkup("+", "No products registered yet.", "Register the first product to establish ownership and telemetry boundaries.");
  return `<div class="product-grid">${products.slice(0, limit).map((product) => {
    const productStatuses = statuses.filter((item) => item.product_id === product.product_id);
    const production = productStatuses.find((item) => item.environment === "production") ?? productStatuses[0];
    const status = normalizeState(production?.status);
    const environment = production?.environment ?? declaredEnvironments(product)[0];
    return `<a class="product-card ${status}" href="#/products/${encodeURIComponent(product.product_id)}?environment=${encodeURIComponent(environment)}"><span class="product-state-bar"></span><div class="product-card-body"><div class="product-card-top"><h3>${escapeHtml(product.name)}</h3>${stateChip(status)}</div><p>${escapeHtml(product.product_id)}</p><dl><div><dt>Environment</dt><dd>${escapeHtml(environment)}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(product.owner)}</dd></div></dl></div></a>`;
  }).join("")}</div>`;
}

function incidentMarkup(incident, alerts = []) {
  const active = isActiveRecord(incident);
  const linkedIds = incident.alert_ids ?? [];
  const linkedAlerts = linkedIds.map((id) => alerts.find((alert) => alert.id === id) ?? { id, name: id });
  const linkCandidates = alerts.filter((alert) => isActiveRecord(alert) && !linkedIds.includes(alert.id));
  return `<article class="record-card" data-testid="incident-card" data-incident-id="${escapeAttribute(incident.id)}">
    <div class="record-card-header"><div><h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.product_id)} / ${escapeHtml(incident.environment)}</p></div><div class="button-row">${severityChip(incident.severity)}${stateChip(active ? "degraded" : "operational", incident.status)}</div></div>
    <div class="record-meta"><span>Owner: ${escapeHtml(incident.owner ?? "unassigned")}</span><span>${formatDate(incident.updated_at ?? incident.created_at)}</span><span>${linkedIds.length} linked alert${linkedIds.length === 1 ? "" : "s"}</span></div>
    ${linkedAlerts.length ? `<div class="linked-alerts" aria-label="Linked alert evidence">${linkedAlerts.map((alert) => `<span title="${escapeAttribute(alert.id)}">${escapeHtml(alert.name ?? alert.rule_type ?? alert.id)}</span>`).join("")}</div>` : ""}
    ${incident.recovery_note ? `<p><strong>Recovery:</strong> ${escapeHtml(incident.recovery_note)}</p>` : ""}
    ${incident.timeline?.length ? `<div class="timeline" style="margin-top:12px">${incident.timeline.slice(-4).map((entry) => `<div class="timeline-item"><strong>${escapeHtml(entry.action ?? entry.type ?? "updated")}</strong><p>${escapeHtml(entry.actor ?? "system")} · ${formatDate(entry.at ?? entry.created_at)}</p></div>`).join("")}</div>` : ""}
    ${active ? `<div class="card-actions">${incident.status === "open" ? `<button class="button quiet small" type="button" data-action="incident-acknowledge" data-id="${escapeAttribute(incident.id)}">Acknowledge</button>` : ""}${linkCandidates.length ? `<button class="button quiet small" type="button" data-action="incident-link-alerts" data-id="${escapeAttribute(incident.id)}">Link alerts (${linkCandidates.length})</button>` : ""}<button class="button quiet small" type="button" data-action="incident-assign" data-id="${escapeAttribute(incident.id)}">Assign</button><button class="button primary small" type="button" data-action="incident-resolve" data-id="${escapeAttribute(incident.id)}">Resolve</button></div>` : ""}
  </article>`;
}

function alertMarkup(alert) {
  const active = isActiveRecord(alert);
  return `<article class="record-card"><div class="record-card-header"><div><h3>${escapeHtml(alert.name ?? alert.rule_type ?? "Alert")}</h3><p>${escapeHtml(alert.dedup_key ?? alert.id)}</p></div>${stateChip(active ? "degraded" : "operational", alert.status)}</div><div class="record-meta"><span>${escapeHtml(alert.severity ?? "medium")}</span><span>${formatDate(alert.updated_at ?? alert.opened_at)}</span><span>${alert.occurrences ?? 1} occurrences</span></div>${active && alert.status === "open" ? `<div class="card-actions"><button class="button quiet small" type="button" data-action="alert-acknowledge" data-id="${escapeAttribute(alert.id)}">Acknowledge</button></div>` : ""}</article>`;
}

function monitorMarkup(monitor) {
  const latest = app.detail.monitor_runs.find((run) => run.monitor_id === monitor.id);
  const status = latest?.ok === true ? "operational" : latest?.ok === false ? "degraded" : "unknown";
  return `<article class="record-card"><div class="record-card-header"><div><h3>${escapeHtml(monitor.name)}</h3><p>${escapeHtml(monitor.url ?? monitor.event ?? monitor.type)}</p></div>${stateChip(status, latest?.ok === true ? "passing" : latest?.ok === false ? "failing" : "not run")}</div><div class="record-meta"><span>every ${escapeHtml(monitor.interval_seconds ?? 60)}s</span><span>${escapeHtml(monitor.timeout_ms ?? 2000)}ms timeout</span><span>${escapeHtml(monitor.severity ?? "medium")}</span><span>${formatDate(latest?.checked_at)}</span></div></article>`;
}

function runMarkup(run) {
  return `<article class="record-card"><div class="record-card-header"><div><h3>${escapeHtml(run.monitor_id ?? run.id)}</h3><p>${escapeHtml(run.error ?? `HTTP ${run.status ?? "result recorded"}`)}</p></div>${stateChip(run.ok === true ? "operational" : "degraded", run.ok === true ? "pass" : "fail")}</div><div class="record-meta"><span>${formatDate(run.checked_at)}</span><span>${escapeHtml(run.duration_ms ?? "—")}ms</span><span>threshold ${escapeHtml(run.failure_threshold ?? "—")}</span></div></article>`;
}

function journeySignalMarkup(journey, events) {
  const successEvent = journey.success_event;
  const failureEvent = journey.failure_event;
  const successSignals = events.filter((item) => eventSignalName(item) === successEvent);
  const failureSignals = failureEvent ? events.filter((item) => eventSignalName(item) === failureEvent) : [];
  const signals = [...successSignals, ...failureSignals].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
  const latest = signals[0];
  const latestName = latest ? eventSignalName(latest) : null;
  const latestFailed = Boolean(failureEvent && latestName === failureEvent);
  return `<article class="record-card journey-signal ${latest ? (latestFailed ? "failed" : "passing") : "missing"}" data-testid="journey-signal">
    <div class="record-card-header"><div><h3>${escapeHtml(journey.name ?? journey.id ?? "Critical journey")}</h3><p>Success: ${escapeHtml(successEvent ?? "not declared")}${failureEvent ? ` · Failure: ${escapeHtml(failureEvent)}` : ""}</p></div>${stateChip(latest ? (latestFailed ? "degraded" : "operational") : "unknown", latest ? (latestFailed ? "latest failed" : "latest passed") : "no signal")}</div>
    ${latest ? `<div class="journey-tally"><span><strong>${successSignals.length}</strong> ${escapeHtml(pluralSignal(successSignals.length, "success signal"))}</span>${failureEvent ? `<span><strong>${failureSignals.length}</strong> ${escapeHtml(pluralSignal(failureSignals.length, "failure signal"))}</span>` : ""}</div><div class="record-meta"><span>Latest: ${escapeHtml(latestName)}</span><span>${formatDate(latest.occurred_at)}</span><span>${escapeHtml(latest.release ?? "release unknown")}</span></div>` : `<div class="journey-no-signal"><strong>No retained journey signal</strong><p>The contract is declared, but neither its success nor failure event is present for this environment.</p></div>`}
  </article>`;
}

function errorSummaryMarkup(errors) {
  if (!errors.length) return emptyMarkup("✓", "No errors in this range.", "No redacted error envelopes match the filter.", true);
  const groups = groupErrorSignals(errors);
  const recent = [...errors].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at)).slice(0, 8);
  return `<div class="error-summary-list">${groups.map((group) => `<article class="error-group" data-testid="error-group"><div class="record-card-header"><div><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(group.message)}</p></div><strong class="error-occurrences">${group.count} occurrence${group.count === 1 ? "" : "s"}</strong></div><div class="record-meta"><span>Release ${escapeHtml(group.release)}</span><span>Latest ${formatDate(group.latest_at)}</span></div></article>`).join("")}</div><section class="recent-errors"><header><div><p class="kicker">Actionable records</p><h3>Recent errors</h3></div><span class="count-chip">${recent.length}</span></header><div class="record-list">${recent.map(errorRecordMarkup).join("")}</div></section>`;
}

function groupErrorSignals(errors) {
  const groups = new Map();
  for (const item of errors) {
    const name = item.payload?.name ?? item.name ?? "Error";
    const message = item.payload?.message ?? item.message ?? "No message recorded";
    const release = item.release ?? "release unknown";
    const key = JSON.stringify([name, message, release]);
    const current = groups.get(key) ?? { name, message, release, count: 0, latest_at: item.occurred_at };
    current.count += 1;
    if (Date.parse(item.occurred_at) > Date.parse(current.latest_at)) current.latest_at = item.occurred_at;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || Date.parse(right.latest_at) - Date.parse(left.latest_at));
}

function errorRecordMarkup(item) {
  const name = item.payload?.name ?? item.name ?? "Error";
  const message = item.payload?.message ?? item.message ?? "No message recorded";
  return `<article class="record-card recent-error-record" data-testid="recent-error-record"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(message)}</p><div class="record-meta"><span>${escapeHtml(item.release ?? "release unknown")}</span><span>${formatDate(item.occurred_at)}</span><span>${escapeHtml(item.request_id ?? "no request ID")}</span></div></article>`;
}

function eventSignalName(item) {
  return item.payload?.event ?? item.event_name ?? item.event;
}

function pluralSignal(count, singular) {
  return `${singular}${count === 1 ? "" : "s"}`;
}

function signalRecords(items, type) {
  if (!items.length) return emptyMarkup(type === "error" ? "✓" : "·", `No ${type}s in this range.`, type === "error" ? "No redacted error envelopes match the filter." : "No product events match the filter.", true);
  return `<div class="record-list">${items.slice(0, 50).map((item) => {
    const title = type === "error" ? item.payload?.message ?? item.message : item.payload?.event ?? item.event_name;
    return `<article class="record-card"><h3>${escapeHtml(title ?? "Unknown signal")}</h3><div class="record-meta"><span>${escapeHtml(item.release)}</span><span>${formatDate(item.occurred_at)}</span><span>${escapeHtml(item.request_id ?? "no request ID")}</span></div></article>`;
  }).join("")}</div>`;
}

function apiKeyMarkup(key) {
  const revoked = Boolean(key.revoked_at);
  return `<article class="record-card"><div class="record-card-header"><div><h3>${escapeHtml(key.name)}</h3><p>${escapeHtml((key.scopes ?? []).join(", "))}</p></div>${stateChip(revoked ? "unknown" : "operational", revoked ? "revoked" : "active")}</div><div class="record-meta"><span>Created ${formatDate(key.created_at)}</span><span>Last used ${formatDate(key.last_used_at)}</span><span>Expires ${formatDate(key.expires_at)}</span></div>${revoked ? "" : `<div class="card-actions"><button class="button quiet small" type="button" data-action="rotate-key" data-id="${escapeAttribute(key.id)}">Rotate</button><button class="button danger small" type="button" data-action="revoke-key" data-id="${escapeAttribute(key.id)}">Revoke</button></div>`}</article>`;
}

function tabButton(id, label) {
  const selected = app.detailTab === id;
  return `<button type="button" role="tab" aria-selected="${selected}" data-action="select-tab" data-tab="${id}">${escapeHtml(label)}</button>`;
}

function stepMarkup(number, label, current) {
  const className = number === current ? "active" : number < current ? "complete" : "";
  return `<div class="${className}">${String(number).padStart(2, "0")} / ${escapeHtml(label)}</div>`;
}

function metricCell(value, label) {
  return `<div class="metric-cell"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div>`;
}

function emptyMarkup(mark, title, body, compact = false) {
  return `<div class="empty-state ${compact ? "compact" : ""}"><div><div class="empty-mark">${escapeHtml(mark)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div></div>`;
}

function stateChip(state, label = state) {
  const normalized = normalizeState(state);
  return `<span class="state-chip ${normalized}">${escapeHtml(label)}</span>`;
}

function severityChip(severity) {
  const normalized = ["critical", "high", "medium", "low"].includes(severity) ? severity : "medium";
  return `<span class="severity-chip ${normalized}">${escapeHtml(normalized)}</span>`;
}

function verificationChip(value) {
  const normalized = ["verified", "declared", "detected", "stale", "unverified"].includes(value) ? value : "unverified";
  return `<span class="verification-chip ${normalized}">${escapeHtml(normalized)}</span>`;
}

function renderLoading() {
  elements.view.innerHTML = `<div class="skeleton-grid" data-testid="view-loading" aria-label="Loading current operational evidence"><div class="skeleton wide"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
}

function renderError(error) {
  setHeader("Operations / unavailable", "Could not load operations", "The existing page remains safe; no state is inferred from a failed request.");
  elements.view.innerHTML = `<section class="error-state" role="alert"><div><div class="empty-mark">!</div><h2>Could not load operations</h2><p>${escapeHtml(error.message ?? "The Dashboard API did not return a usable response.")}</p><button class="button primary" type="button" data-action="retry">Retry</button></div></section>`;
}

function showDashboard() {
  app.authenticated = true;
  elements.loginPanel.hidden = true;
  elements.dashboard.hidden = false;
  elements.loginError.textContent = "";
  hideBoot();
}

function showLogin() {
  app.authenticated = false;
  elements.dashboard.hidden = true;
  elements.loginPanel.hidden = false;
  hideBoot();
  requestAnimationFrame(() => document.getElementById("login-email")?.focus());
}

function hideBoot() {
  elements.boot.hidden = true;
}

function setHeader(kicker, title, subtitle) {
  elements.pageKicker.textContent = kicker;
  elements.pageTitle.textContent = title;
  elements.pageSubtitle.textContent = subtitle;
  document.title = `${title} · AI Product Reliability`;
}

function setActiveNavigation(routeName) {
  const active = routeName === "product" || routeName === "onboarding" ? "products" : routeName;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function showBanner(message) {
  elements.banner.textContent = message;
  elements.banner.hidden = false;
}

function hideBanner() {
  elements.banner.hidden = true;
}

function showToast(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast ${isError ? "error" : ""}`;
  toast.textContent = message;
  elements.toasts.replaceChildren(toast);
  setTimeout(() => toast.remove(), 4_000);
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error ?? `${url} returned ${response.status}`);
    error.status = response.status;
    error.code = payload?.code;
    error.details = payload?.details;
    throw error;
  }
  return payload;
}

function setButtonBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel ?? button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function navigate(pathname) {
  window.location.hash = `#${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function updateRouteTab(tab) {
  if (app.route.name !== "product") return;
  const params = new URLSearchParams({ environment: app.detail.environment, tab });
  history.replaceState(null, "", `#/products/${encodeURIComponent(app.detail.product.product_id)}?${params}`);
  app.route = parseRoute();
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathname = "", query = ""] = raw.split("?");
  const parts = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === "onboarding") return { name: "onboarding" };
  if (parts[0] === "products" && parts[1]) return {
    name: "product",
    productId: decodeURIComponent(parts.slice(1).join("/")),
    environment: params.get("environment") ?? "production",
    tab: params.get("tab")
  };
  if (parts[0] === "products") return { name: "products" };
  if (parts[0] === "incidents") return { name: "incidents" };
  if (parts[0] === "public-status") return { name: "public-status" };
  return { name: "home" };
}

function declaredEnvironments(product) {
  const values = (product.environments ?? []).map((environment) => typeof environment === "string" ? environment : environment.name).filter(Boolean);
  return values.length ? [...new Set(values)] : ["production"];
}

function normalizeState(value) {
  return ["unknown", "operational", "degraded", "outage"].includes(value) ? value : "unknown";
}

function statusSummary(status) {
  return {
    unknown: "No trustworthy current state is available.",
    operational: "Current evidence supports normal operation.",
    degraded: "Some current evidence requires investigation.",
    outage: "Critical current evidence indicates unavailability."
  }[normalizeState(status)];
}

function isActiveRecord(item) {
  return ["open", "acknowledged"].includes(String(item?.status ?? "").toLowerCase());
}

function newestFirst(left, right) {
  return Date.parse(right.updated_at ?? right.created_at ?? right.opened_at ?? 0) - Date.parse(left.updated_at ?? left.created_at ?? left.opened_at ?? 0);
}

function rangeCutoff(range) {
  const durations = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
  return durations[range] ? Date.now() - durations[range] : null;
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "not yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function toLocalDateTime(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function emptyFleetData() {
  return {
    products: [],
    operational: { status: "unknown", generated_at: null, items: [] },
    incidents: [],
    alerts: [],
    summary: {},
    publicStatus: { status: "unknown", products: [] }
  };
}
