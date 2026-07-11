#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadProductContract } from "@ai-product-reliability/standard/product-contract";
import { renderMarkdown, scanProject } from "./scanner.mjs";

export { scanProject } from "./scanner.mjs";

export async function pushToDashboard(target, dashboardUrl, apiKey) {
  const report = await scanProject(target);
  const contractResult = await loadProductContract(target);
  if (!contractResult) throw new Error(`No product.yml found in ${target}`);
  const contract = contractResult.contract;
  const endpoint = dashboardUrl.replace(/\/$/, "");
  const productResponse = await postJson(`${endpoint}/api/products`, {
    standard_version: contract.standard_version,
    product: contract.product,
    environments: contract.environments,
    critical_journeys: contract.critical_journeys,
    contract
  }, apiKey);
  const complianceResponse = await postJson(`${endpoint}/api/compliance-scans`, {
    product_id: contract.product.id,
    environment: "local",
    scanned_at: report.generated_at,
    tool: report.tool,
    tool_version: report.tool_version,
    standard_version: report.summary.standard_version,
    score: report.summary.score,
    max_score: report.summary.max_score,
    grade: report.summary.grade,
    findings: report.findings,
    verification: report.verification,
    warnings: report.warnings,
    migration_advice: report.migration_advice
  }, apiKey);
  return {
    product_id: contract.product.id,
    dashboard_url: endpoint,
    score: report.summary.score,
    product_response: productResponse,
    compliance_response: complianceResponse
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "automate") {
    const options = parseAutomationArgs(args);
    const { generateAutomation } = await import("../../automation/src/generate.mjs");
    const result = await generateAutomation(path.resolve(process.cwd(), options.target), {
      outDir: options.out,
      dashboardUrl: options.dashboardUrl,
      registerDashboard: options.registerDashboard,
      dashboardApiKey: options.apiKey
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "push") {
    const options = parsePushArgs(args);
    const result = await pushToDashboard(path.resolve(process.cwd(), options.target), options.dashboardUrl, options.apiKey);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command !== "scan") fail(`Unknown command: ${command}`);

  const options = parseScanArgs(args);
  const target = path.resolve(process.cwd(), options.target ?? ".");
  const report = await scanProject(target, { verify: options.verify, verifyTimeoutMs: options.verifyTimeoutMs });
  if (options.writePassport) {
    const outPath = path.join(target, "docs", "system-passport.generated.md");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, report.passportDraft, "utf8");
    report.generatedFiles.push(path.relative(target, outPath).replace(/\\/g, "/"));
  }
  const output = options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, output, "utf8");
  } else {
    process.stdout.write(`${output}\n`);
  }
  if (report.summary.score < 40) process.exitCode = 2;
}

function parseScanArgs(args) {
  const options = { target: undefined, json: false, out: undefined, writePassport: false, verify: false, verifyTimeoutMs: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--write-passport") options.writePassport = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--verify-timeout-ms") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 10 || value > 300000) fail("--verify-timeout-ms must be an integer from 10 to 300000");
      options.verifyTimeoutMs = value;
    } else if (arg === "--out") {
      if (!args[++i]) fail("--out requires a file path");
      options.out = args[i];
    } else if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
    else if (!options.target) options.target = arg;
    else fail(`Unexpected argument: ${arg}`);
  }
  return options;
}

function parseAutomationArgs(args) {
  const options = { target: undefined, out: undefined, dashboardUrl: "http://127.0.0.1:8787", registerDashboard: false, apiKey: process.env.APR_API_KEY ?? process.env.APR_MASTER_API_KEY };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") options.out = requiredValue(args, ++i, "--out requires a directory");
    else if (arg === "--dashboard-url") options.dashboardUrl = requiredValue(args, ++i, "--dashboard-url requires a URL");
    else if (arg === "--api-key" || arg === "--dashboard-api-key") options.apiKey = requiredValue(args, ++i, `${arg} requires a value`);
    else if (arg === "--register-dashboard") options.registerDashboard = true;
    else if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
    else if (!options.target) options.target = arg;
    else fail(`Unexpected argument: ${arg}`);
  }
  if (!options.target) fail("automate requires a project path");
  return options;
}

function parsePushArgs(args) {
  const options = { target: undefined, dashboardUrl: "http://127.0.0.1:8787", apiKey: process.env.APR_API_KEY ?? process.env.APR_MASTER_API_KEY };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dashboard-url") options.dashboardUrl = requiredValue(args, ++i, "--dashboard-url requires a URL");
    else if (arg === "--api-key" || arg === "--dashboard-api-key") options.apiKey = requiredValue(args, ++i, `${arg} requires a value`);
    else if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
    else if (!options.target) options.target = arg;
    else fail(`Unexpected argument: ${arg}`);
  }
  if (!options.target) fail("push requires a project path");
  return options;
}

async function postJson(url, payload, apiKey) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`POST ${url} failed: ${response.status}${text ? ` ${text}` : ""}`);
  }
  return response.json().catch(() => ({ ok: true }));
}

function requiredValue(args, index, message) {
  if (!args[index]) fail(message);
  return args[index];
}

function printHelp() {
  process.stdout.write(`AI Product Reliability CLI

Usage:
  node cli/src/index.mjs scan <project-path> [--json] [--out <file>] [--write-passport] [--verify]
  node cli/src/index.mjs automate <project-path> [--out <dir>] [--dashboard-url <url>] [--api-key <key>] [--register-dashboard]
  node cli/src/index.mjs push <project-path> [--dashboard-url <url>] [--api-key <key>]

Options:
  --json                    Output JSON instead of Markdown.
  --out <file>              Write output to a file.
  --verify                  Run only built-in or product.yml allowlisted verification commands.
  --verify-timeout-ms <ms>  Default verification timeout, from 10 to 300000 ms.
  --write-passport          Write docs/system-passport.generated.md into the target.
`);
}

function fail(message) {
  const error = new Error(message);
  error.isCliUsageError = true;
  throw error;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exit(1);
  });
}
