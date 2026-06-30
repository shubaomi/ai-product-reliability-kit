const loginPanel = document.getElementById("login-panel");
const dashboardPanel = document.getElementById("dashboard-panel");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");

async function loadDashboard() {
  const [summary, products] = await Promise.all([
    apiJson("/api/summary"),
    apiJson("/api/products")
  ]);

  showDashboard();
  setText("product-count", summary.products);
  setText("event-count", summary.events);
  setText("error-count", summary.errors);
  setText("monitor-count", summary.monitors);

  const fleet = document.getElementById("fleet-status");
  fleet.textContent = summary.status === "degraded" ? "Degraded" : "Operational";
  fleet.className = `status-pill ${summary.status}`;

  renderProducts(products, summary);
  renderHealth(summary.latest_health);
  renderTimeline("events", summary.recent_events, "event");
  renderTimeline("errors", summary.recent_errors, "error");
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
  if (response.status === 401) {
    const error = new Error("Authentication required");
    error.status = 401;
    throw error;
  }
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function renderProducts(products, summary) {
  const target = document.getElementById("products");
  target.innerHTML = "";
  if (!products.length) {
    target.innerHTML = `<tr><td colspan="6">No products registered yet.</td></tr>`;
    return;
  }

  for (const product of products) {
    const health = summary.latest_health[product.product_id];
    const status = health?.payload?.ok === false ? "degraded" : "operational";
    target.insertAdjacentHTML("beforeend", `
      <tr>
        <td><strong>${escapeHtml(product.name)}</strong><div class="meta">${escapeHtml(product.product_id)}</div></td>
        <td>${escapeHtml(product.owner)}</td>
        <td>${escapeHtml(product.standard_version)}</td>
        <td><span class="tag">${status}</span></td>
        <td>${summary.errors_by_product[product.product_id] ?? 0}</td>
        <td>${summary.events_by_product[product.product_id] ?? 0}</td>
      </tr>
    `);
  }
}

function renderHealth(latestHealth) {
  const target = document.getElementById("health-list");
  const items = Object.values(latestHealth);
  target.innerHTML = "";
  if (!items.length) {
    target.innerHTML = `<div class="row-item">No health data yet.</div>`;
    return;
  }
  for (const item of items) {
    const ok = item.payload?.ok !== false;
    target.insertAdjacentHTML("beforeend", `
      <div class="row-item ${ok ? "good" : "bad"}">
        <strong>${escapeHtml(item.product_id)}</strong>
        <div class="meta">${ok ? "healthy" : "failing"} / ${escapeHtml(item.occurred_at)}</div>
      </div>
    `);
  }
}

function renderTimeline(id, items, type) {
  const target = document.getElementById(id);
  target.innerHTML = "";
  if (!items.length) {
    target.innerHTML = `<div class="row-item">No ${type}s yet.</div>`;
    return;
  }
  for (const item of items) {
    const title = type === "event" ? item.payload?.event : item.payload?.message;
    target.insertAdjacentHTML("beforeend", `
      <div class="row-item ${type === "error" ? "bad" : ""}">
        <strong>${escapeHtml(title ?? "unknown")}</strong>
        <div class="meta">${escapeHtml(item.product_id)} / ${escapeHtml(item.release)} / ${escapeHtml(item.occurred_at)}</div>
      </div>
    `);
  }
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboardPanel.hidden = false;
  loginError.textContent = "";
}

function showLogin() {
  loginPanel.hidden = false;
  dashboardPanel.hidden = true;
  document.getElementById("login-email").focus();
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value ?? 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

document.getElementById("refresh").addEventListener("click", () => {
  loadDashboard().catch(handleLoadError);
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const body = {
    email: document.getElementById("login-email").value,
    password: document.getElementById("login-password").value
  };
  try {
    await apiJson("/api/session/login", {
      method: "POST",
      body: JSON.stringify(body)
    });
    await loadDashboard();
  } catch (error) {
    loginError.textContent = error.status === 401 ? "Invalid email or password." : "Sign in failed.";
  }
});

function handleLoadError(error) {
  if (error.status === 401) {
    showLogin();
    return;
  }
  console.error(error);
  document.getElementById("fleet-status").textContent = "Error";
}

loadDashboard().catch(handleLoadError);
