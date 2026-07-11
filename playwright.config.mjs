import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 8787);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: ".tmp/playwright-report", open: "never" }]]
    : "line",
  outputDir: ".tmp/test-results/playwright",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "node scripts/start-e2e-dashboard.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      APR_AUTH_REQUIRED: "true",
      APR_ADMIN_EMAIL: "operator@reliability.local",
      APR_MASTER_API_KEY: "e2e-master-key-for-dashboard-login",
      APR_SESSION_SECRET: "e2e-session-secret-for-dashboard-tests",
      APR_MONITOR_HOST_ALLOWLIST: "example.com",
      APR_WORKER_ENABLED: "false",
      APR_DASHBOARD_STORE: path.resolve(".tmp/playwright-dashboard-store.json")
    }
  }
});
