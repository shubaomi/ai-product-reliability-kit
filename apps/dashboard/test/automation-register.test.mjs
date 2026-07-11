import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../server.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-automation-register-"));
const storePath = path.join(tempDir, "store.json");
const outDir = path.join(tempDir, "generated");
const apiKey = "automation-register-master-key";
const server = await createDashboardServer({
  storePath,
  config: {
    authRequired: true,
    masterApiKey: apiKey,
    sessionSecret: "automation-register-session-secret",
    allowedMonitorHosts: ["127.0.0.1", "example.com"],
    workerEnabled: false
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  const { stdout } = await execFileAsync(process.execPath, [
    "cli/src/index.mjs",
    "automate",
    "examples/node-nextjs",
    "--out",
    outDir,
    "--dashboard-url",
    base,
    "--api-key",
    apiKey,
    "--register-dashboard"
  ], { cwd: repoRoot });

  const result = JSON.parse(stdout);
  assert.equal(result.dashboardRegistrations.product.product.product_id, result.product_id);
  assert.equal(result.dashboardRegistrations.monitors.accepted, 5);
  assert.equal(result.dashboardRegistrations.alerts.accepted, result.alerts.length);
  assert.ok(result.alerts.length >= 4);
  assert.equal(result.dashboardRegistrations.status_page.accepted, 1);

  const summary = await fetch(`${base}/api/summary`, {
    headers: { authorization: `Bearer ${apiKey}` }
  }).then((response) => response.json());
  assert.equal(summary.monitors, 5);
  assert.equal(summary.alerts, result.alerts.length);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("Automation dashboard registration test OK");
