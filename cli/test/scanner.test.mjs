import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pushToDashboard, scanProject } from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

test("placeholder example receives honest sub-100 evidence scoring", async () => {
  const report = await scanProject(path.join(repoRoot, "examples", "node-nextjs"));
  assert.ok(report.summary.score < report.summary.max_score, JSON.stringify(report.summary));
  assert.notEqual(finding(report, "error-tracking").evidence_level, "verified");
  assert.notEqual(finding(report, "security-maintenance").evidence_level, "verified");
});

test("scanner excludes generated and non-target evidence while scanning a target located under examples", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-scanner-"));
  try {
    const root = path.join(tempDir, "project");
    await writeProject(root);
    await write(path.join(root, ".tmp", "fake-healthz.js"), "Sentry.captureException(); npm audit; /healthz");
    await write(path.join(root, "generated", "fake.test.js"), "trackEvent('completed')");
    await write(path.join(root, "templates", "docs", "system-passport.md"), "template only");
    await write(path.join(root, "examples", "other", "readyz.ts"), "/readyz");

    const report = await scanProject(root);
    assert.equal(finding(report, "health-check").evidence_level, "missing");
    assert.equal(finding(report, "error-tracking").evidence_level, "missing");
    assert.equal(finding(report, "security-maintenance").evidence_level, "missing");

    const exampleTarget = path.join(tempDir, "examples", "actual-target");
    await writeProject(exampleTarget);
    await write(path.join(exampleTarget, "src", "healthz.ts"), "export const healthz = true;");
    const exampleReport = await scanProject(exampleTarget);
    assert.equal(finding(exampleReport, "health-check").evidence_level, "detected");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("safe verify distinguishes success, failure, timeout, skipped, and unverified without executing unsafe commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-verify-"));
  try {
    const marker = path.join(tempDir, "unsafe-marker.txt");
    await writeProject(tempDir, `verification:
  commands:
    - id: verify-health
      command: [node, -e, "process.exit(0)"]
      controls: [health-check]
      timeout_ms: 1000
    - id: verify-failure
      command: [node, -e, "process.exit(7)"]
      controls: [smoke-tests]
      timeout_ms: 1000
    - id: verify-timeout
      command: [node, -e, "setTimeout(() => {}, 500)"]
      controls: [readiness-check]
      timeout_ms: 25
    - id: unsafe-shell
      command: [powershell, -Command, "Set-Content -LiteralPath '${marker.replaceAll("\\", "\\\\")}' -Value unsafe"]
      controls: [security-maintenance]
      timeout_ms: 1000
`);
    await write(path.join(tempDir, "src", "healthz.ts"), "/healthz");
    await write(path.join(tempDir, "src", "readyz.ts"), "/readyz");
    await write(path.join(tempDir, "tests", "smoke.test.js"), "throw new Error('real test fixture');");

    const unverified = await scanProject(tempDir);
    assert.equal(unverified.verification.status, "unverified");

    const report = await scanProject(tempDir, { verify: true });
    assert.equal(command(report, "verify-health").status, "success");
    assert.equal(command(report, "verify-failure").status, "failure");
    assert.equal(command(report, "verify-timeout").status, "failure");
    assert.equal(command(report, "verify-timeout").timed_out, true);
    assert.equal(command(report, "unsafe-shell").status, "skipped");
    assert.equal(await exists(marker), false);
    assert.equal(finding(report, "health-check").evidence_level, "verified");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI push sends an independent compliance scan and never operational telemetry", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apr-compliance-push-"));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, id: "scan-1" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeProject(tempDir);
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await pushToDashboard(tempDir, base, "test-key");
    assert.deepEqual(requests.map((item) => item.path), ["/api/products", "/api/compliance-scans"]);
    assert.equal(requests.some((item) => item.path === "/api/ingest"), false);
    assert.equal(requests[1].body.product_id, "fixture-product");
    assert.equal(result.compliance_response.id, "scan-1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function finding(report, id) {
  return report.findings.find((item) => item.id === id);
}

function command(report, id) {
  return report.verification.commands.find((item) => item.id === id);
}

async function writeProject(root, suffix = "") {
  await write(path.join(root, "product.yml"), `${validContract()}${suffix}`);
  await write(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-product",
    version: "1.0.0",
    scripts: {
      test: "echo test placeholder",
      audit: "echo npm audit placeholder"
    }
  }, null, 2));
}

function validContract() {
  return `standard_version: "1.0"
product:
  id: fixture-product
  name: Fixture Product
  owner: owner@example.com
environments:
  - name: production
    url: https://example.com
critical_journeys:
  - id: core_action
    name: Core action
    success_event: core_action_completed
health:
  live_path: /healthz
release:
  version_source: git_sha
  rollback: docs/rollback.md
`;
}

async function write(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
