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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-push-"));
const storePath = path.join(tempDir, "store.json");
const apiKey = "cli-push-master-key";
const server = await createDashboardServer({
  storePath,
  config: {
    authRequired: true,
    masterApiKey: apiKey,
    sessionSecret: "cli-push-session-secret",
    workerEnabled: false
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(repoRoot, "cli", "src", "index.mjs"),
    "push",
    path.join(repoRoot, "examples", "node-nextjs"),
    "--dashboard-url",
    base,
    "--api-key",
    apiKey
  ], { cwd: repoRoot });
  const pushed = JSON.parse(stdout);
  assert.equal(pushed.product_id, "reliable-nextjs-example");

  const summary = await fetch(`${base}/api/summary`, {
    headers: { authorization: `Bearer ${apiKey}` }
  }).then((response) => response.json());
  assert.equal(summary.products, 1);
  assert.equal(summary.events, 0);
  assert.equal(summary.latest_health["reliable-nextjs-example"], undefined);

  const scans = await fetch(`${base}/api/compliance-scans?product_id=reliable-nextjs-example`, {
    headers: { authorization: `Bearer ${apiKey}` }
  }).then((response) => response.json());
  assert.equal(scans.items.length, 1);
  assert.equal(scans.items[0].environment, "local");
  assert.equal(scans.items[0].product_id, "reliable-nextjs-example");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("CLI push dashboard test OK");
