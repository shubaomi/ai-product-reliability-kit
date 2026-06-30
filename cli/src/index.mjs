#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode"
]);

const RULES = [
  {
    id: "product-contract",
    title: "Product contract",
    weight: 12,
    severity: "high",
    check: (ctx) => Boolean(ctx.productContractPath),
    evidence: (ctx) => ctx.productContractPath ? [rel(ctx.root, ctx.productContractPath)] : [],
    recommendation: "Add product.yml and declare product ID, owner, environments, critical journeys, health, release, and capabilities."
  },
  {
    id: "health-check",
    title: "Health check endpoint",
    weight: 10,
    severity: "high",
    check: (ctx) => hasPath(ctx, /healthz/i) || hasPattern(ctx, [/\/healthz\b/i, /\bhealthz\b/i]),
    evidence: (ctx) => pathEvidence(ctx, /healthz/i, [/\/healthz\b/i, /\bhealthz\b/i]),
    recommendation: "Expose a shallow /healthz endpoint with product_id, environment, release, ok, and timestamp."
  },
  {
    id: "readiness-check",
    title: "Readiness check endpoint",
    weight: 6,
    severity: "medium",
    check: (ctx) => hasPath(ctx, /readyz/i) || hasPattern(ctx, [/\/readyz\b/i, /\breadyz\b/i]),
    evidence: (ctx) => pathEvidence(ctx, /readyz/i, [/\/readyz\b/i, /\breadyz\b/i]),
    recommendation: "Add /readyz for required dependencies such as database, storage, payment provider, or AI API."
  },
  {
    id: "system-passport",
    title: "System passport",
    weight: 9,
    severity: "high",
    check: (ctx) => hasFile(ctx, ["docs/system-passport.md", "docs/SYSTEM_PASSPORT.md"]),
    evidence: (ctx) => existingFiles(ctx, ["docs/system-passport.md", "docs/SYSTEM_PASSPORT.md"]),
    recommendation: "Create docs/system-passport.md with features, architecture, dependencies, release, observability, and troubleshooting notes."
  },
  {
    id: "runbook",
    title: "Incident runbook",
    weight: 7,
    severity: "medium",
    check: (ctx) => hasFile(ctx, ["docs/runbook.md", "docs/RUNBOOK.md"]),
    evidence: (ctx) => existingFiles(ctx, ["docs/runbook.md", "docs/RUNBOOK.md"]),
    recommendation: "Create docs/runbook.md with first response, triage, common checks, and escalation details."
  },
  {
    id: "rollback",
    title: "Rollback guide",
    weight: 8,
    severity: "high",
    check: (ctx) => hasFile(ctx, ["docs/rollback.md", "docs/ROLLBACK.md"]),
    evidence: (ctx) => existingFiles(ctx, ["docs/rollback.md", "docs/ROLLBACK.md"]),
    recommendation: "Create docs/rollback.md and keep deployment rollback steps current."
  },
  {
    id: "ci-quality-gate",
    title: "CI quality gate",
    weight: 8,
    severity: "medium",
    check: (ctx) => ctx.files.some((file) => file.relative.startsWith(".github/workflows/") && /\.ya?ml$/i.test(file.relative)),
    evidence: (ctx) => ctx.files.filter((file) => file.relative.startsWith(".github/workflows/")).map((file) => file.relative),
    recommendation: "Add CI that runs lint, typecheck, tests, build, and security checks where supported."
  },
  {
    id: "smoke-tests",
    title: "Smoke or E2E tests",
    weight: 10,
    severity: "high",
    check: (ctx) => ctx.files.some((file) => /(\.spec|\.test)\.(t|j)sx?$/i.test(file.relative) || /playwright/i.test(file.relative)),
    evidence: (ctx) => ctx.files.filter((file) => /(\.spec|\.test)\.(t|j)sx?$/i.test(file.relative) || /playwright/i.test(file.relative)).map((file) => file.relative),
    recommendation: "Add at least one smoke/E2E test for health and one critical user journey."
  },
  {
    id: "error-tracking",
    title: "Error tracking",
    weight: 10,
    severity: "high",
    check: (ctx) => hasPattern(ctx, [/Sentry/i, /captureException/i, /capture_error/i, /error_tracking/i]),
    evidence: (ctx) => grepEvidence(ctx, [/Sentry/i, /captureException/i, /capture_error/i, /error_tracking/i]),
    recommendation: "Connect Sentry or an equivalent error tracker with product_id, environment, release, and safe user/session context."
  },
  {
    id: "product-events",
    title: "Core product events",
    weight: 8,
    severity: "medium",
    check: (ctx) => hasPattern(ctx, [/success_event/i, /trackEvent/i, /posthog/i, /analytics\.track/i, /capture\(/i]),
    evidence: (ctx) => grepEvidence(ctx, [/success_event/i, /trackEvent/i, /posthog/i, /analytics\.track/i, /capture\(/i]),
    recommendation: "Emit stable success/failure events for declared critical journeys."
  },
  {
    id: "release-tracking",
    title: "Release tracking",
    weight: 7,
    severity: "medium",
    check: (ctx) => hasPattern(ctx, [/version_source/i, /GIT_SHA/i, /COMMIT_SHA/i, /RELEASE_VERSION/i, /\brelease\b/i]),
    evidence: (ctx) => grepEvidence(ctx, [/version_source/i, /GIT_SHA/i, /COMMIT_SHA/i, /RELEASE_VERSION/i, /\brelease\b/i]),
    recommendation: "Attach Git SHA, package version, or deployment ID to health checks, events, logs, and errors."
  },
  {
    id: "security-maintenance",
    title: "Security maintenance",
    weight: 5,
    severity: "medium",
    check: (ctx) => hasFile(ctx, [".github/dependabot.yml", ".github/dependabot.yaml"]) || hasPattern(ctx, [/codeql/i, /secret scanning/i, /npm audit/i]),
    evidence: (ctx) => [
      ...existingFiles(ctx, [".github/dependabot.yml", ".github/dependabot.yaml"]),
      ...grepEvidence(ctx, [/codeql/i, /secret scanning/i, /npm audit/i])
    ],
    recommendation: "Enable dependency update alerts and basic static/security scanning in CI."
  }
];

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
      registerDashboard: options.registerDashboard
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "push") {
    const options = parsePushArgs(args);
    const target = path.resolve(process.cwd(), options.target);
    const result = await pushToDashboard(target, options.dashboardUrl);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command !== "scan") {
    fail(`Unknown command: ${command}`);
  }

  const options = parseScanArgs(args);
  const target = path.resolve(process.cwd(), options.target ?? ".");
  const report = await scanProject(target);

  if (options.writePassport) {
    const outPath = path.join(target, "docs", "system-passport.generated.md");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, report.passportDraft, "utf8");
    report.generatedFiles.push(rel(target, outPath));
  }

  const output = options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);

  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, output, "utf8");
  } else {
    process.stdout.write(`${output}\n`);
  }

  if (report.summary.score < 40) {
    process.exitCode = 2;
  }
}

function parseScanArgs(args) {
  const options = {
    target: undefined,
    json: false,
    out: undefined,
    writePassport: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-passport") {
      options.writePassport = true;
    } else if (arg === "--out") {
      i += 1;
      if (!args[i]) fail("--out requires a file path");
      options.out = args[i];
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else if (!options.target) {
      options.target = arg;
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function parseAutomationArgs(args) {
  const options = {
    target: undefined,
    out: undefined,
    dashboardUrl: "http://127.0.0.1:8787",
    registerDashboard: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") {
      i += 1;
      if (!args[i]) fail("--out requires a directory");
      options.out = args[i];
    } else if (arg === "--dashboard-url") {
      i += 1;
      if (!args[i]) fail("--dashboard-url requires a URL");
      options.dashboardUrl = args[i];
    } else if (arg === "--register-dashboard") {
      options.registerDashboard = true;
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else if (!options.target) {
      options.target = arg;
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.target) fail("automate requires a project path");
  return options;
}

function parsePushArgs(args) {
  const options = {
    target: undefined,
    dashboardUrl: "http://127.0.0.1:8787"
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dashboard-url") {
      i += 1;
      if (!args[i]) fail("--dashboard-url requires a URL");
      options.dashboardUrl = args[i];
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else if (!options.target) {
      options.target = arg;
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.target) fail("push requires a project path");
  return options;
}

async function scanProject(root) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    fail(`Target is not a directory: ${root}`);
  }

  const files = await walk(root);
  const textFiles = await readTextFiles(files);
  const productContractPath = findFirstFile(files, [
    "product.yml",
    "product.yaml",
    "reliability/product.yml",
    "config/product.yml"
  ])?.path;
  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  const ctx = { root, files, textFiles, productContractPath, packageJson };

  const findings = RULES.map((rule) => {
    const passed = Boolean(rule.check(ctx));
    return {
      id: rule.id,
      title: rule.title,
      status: passed ? "pass" : "missing",
      severity: rule.severity,
      weight: rule.weight,
      evidence: passed ? unique(rule.evidence(ctx)).slice(0, 6) : [],
      recommendation: passed ? "" : rule.recommendation
    };
  });

  const maxScore = RULES.reduce((sum, rule) => sum + rule.weight, 0);
  const score = findings
    .filter((finding) => finding.status === "pass")
    .reduce((sum, finding) => sum + finding.weight, 0);
  const missing = findings.filter((finding) => finding.status !== "pass");
  const summary = {
    target: root,
    standard_version: extractStandardVersion(ctx) ?? "unknown",
    score,
    max_score: maxScore,
    grade: grade(score),
    missing_count: missing.length,
    passed_count: findings.length - missing.length
  };
  const adoptionPlan = buildAdoptionPlan(missing);

  return {
    tool: "ai-product-reliability-cli",
    tool_version: "0.4.0",
    generated_at: new Date().toISOString(),
    summary,
    findings,
    adoption_plan: adoptionPlan,
    passportDraft: generatePassportDraft(ctx, findings, summary, adoptionPlan),
    generatedFiles: []
  };
}

async function walk(root) {
  const results = [];

  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = rel(root, fullPath);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        results.push({ path: fullPath, relative });
      }
    }
  }

  await visit(root);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function readTextFiles(files) {
  const textFiles = [];
  const textExt = /\.(md|mdx|txt|ya?ml|json|js|jsx|ts|tsx|mjs|cjs|py|java|go|rb|php|cs|rs|html|css|env|toml|ini)$/i;

  for (const file of files) {
    if (!textExt.test(file.relative)) continue;
    const stat = await fs.stat(file.path);
    if (stat.size > 256 * 1024) continue;
    const text = await fs.readFile(file.path, "utf8").catch(() => "");
    textFiles.push({ ...file, text });
  }

  return textFiles;
}

function hasFile(ctx, candidates) {
  return existingFiles(ctx, candidates).length > 0;
}

function existingFiles(ctx, candidates) {
  const candidateSet = new Set(candidates.map(normalize));
  return ctx.files
    .filter((file) => candidateSet.has(normalize(file.relative)))
    .map((file) => file.relative);
}

function hasPattern(ctx, patterns) {
  return ctx.textFiles.some((file) => patterns.some((pattern) => pattern.test(file.text)));
}

function hasPath(ctx, pattern) {
  return ctx.files.some((file) => pattern.test(file.relative));
}

function pathEvidence(ctx, pathPattern, contentPatterns) {
  const direct = ctx.files
    .filter((file) => pathPattern.test(file.relative))
    .map((file) => file.relative);
  return direct.length ? direct : grepEvidence(ctx, contentPatterns);
}

function grepEvidence(ctx, patterns) {
  const matches = [];
  for (const file of ctx.textFiles) {
    if (patterns.some((pattern) => pattern.test(file.text))) {
      matches.push(file.relative);
    }
  }
  return unique(matches);
}

function findFirstFile(files, candidates) {
  const candidateSet = new Set(candidates.map(normalize));
  return files.find((file) => candidateSet.has(normalize(file.relative)));
}

async function readJsonIfExists(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractStandardVersion(ctx) {
  const contract = productContractText(ctx);
  return contract?.match(/standard_version:\s*["']?([^"'\n]+)["']?/i)?.[1]?.trim();
}

function buildAdoptionPlan(missing) {
  const order = [
    "product-contract",
    "health-check",
    "system-passport",
    "rollback",
    "error-tracking",
    "release-tracking",
    "product-events",
    "smoke-tests",
    "ci-quality-gate",
    "readiness-check",
    "runbook",
    "security-maintenance"
  ];

  return order
    .map((id) => missing.find((finding) => finding.id === id))
    .filter(Boolean)
    .map((finding, index) => ({
      step: index + 1,
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      action: finding.recommendation
    }));
}

function generatePassportDraft(ctx, findings, summary, adoptionPlan) {
  const contract = productContractText(ctx) ?? "";
  const productName = extractYamlValue(contract, "name") ?? ctx.packageJson?.name ?? path.basename(ctx.root);
  const productId = extractYamlValue(contract, "id") ?? ctx.packageJson?.name ?? path.basename(ctx.root);
  const owner = extractYamlValue(contract, "owner") ?? "unknown";
  const passed = findings.filter((finding) => finding.status === "pass");
  const missing = findings.filter((finding) => finding.status !== "pass");

  return `# System Passport Draft

Generated by AI Product Reliability CLI on ${new Date().toISOString()}.

## Product

- Product ID: ${productId}
- Product name: ${productName}
- Owner: ${owner}
- Source path: ${ctx.root}
- Standard version: ${summary.standard_version}
- Reliability score: ${summary.score}/${summary.max_score} (${summary.grade})

## Detected Controls

${passed.length ? passed.map((finding) => `- ${finding.title}: ${finding.evidence.join(", ") || "detected"}`).join("\n") : "- None detected yet."}

## Missing Controls

${missing.length ? missing.map((finding) => `- ${finding.title}: ${finding.recommendation}`).join("\n") : "- No missing MVP controls detected."}

## Suggested Adoption Plan

${adoptionPlan.length ? adoptionPlan.map((item) => `${item.step}. ${item.title} - ${item.action}`).join("\n") : "No immediate adoption steps required."}

## Architecture Notes

- Fill in frontend, backend, database, storage, external services, background jobs, and deployment target.
- Add a Mermaid diagram once the runtime shape is known.

## Troubleshooting Notes

- Start with current release, error tracking, health checks, and critical journey events.
- Capture request ID, user/session ID, release, environment, and timestamp before asking AI to debug.
`;
}

function renderMarkdown(report) {
  const missing = report.findings.filter((finding) => finding.status !== "pass");
  const passed = report.findings.filter((finding) => finding.status === "pass");

  return `# AI Product Reliability Report

- Target: ${report.summary.target}
- Generated: ${report.generated_at}
- Score: ${report.summary.score}/${report.summary.max_score}
- Grade: ${report.summary.grade}
- Passed: ${report.summary.passed_count}
- Missing: ${report.summary.missing_count}

## Passed Controls

${passed.length ? passed.map((finding) => `- ${finding.title}${finding.evidence.length ? ` (${finding.evidence.join(", ")})` : ""}`).join("\n") : "- None"}

## Missing Controls

${missing.length ? missing.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.recommendation}`).join("\n") : "- None"}

## Adoption Plan

${report.adoption_plan.length ? report.adoption_plan.map((item) => `${item.step}. ${item.title}: ${item.action}`).join("\n") : "No immediate adoption steps required."}

## System Passport Draft

${report.passportDraft}
`;
}

async function pushToDashboard(target, dashboardUrl) {
  const report = await scanProject(target);
  const { parseProductContract } = await import("../../automation/src/generate.mjs");
  const contractText = await fs.readFile(path.join(target, "product.yml"), "utf8");
  const contract = parseProductContract(contractText);
  const endpoint = dashboardUrl.replace(/\/$/, "");
  const productResponse = await postJson(`${endpoint}/api/products`, {
    standard_version: contract.standard_version,
    product: contract.product,
    environments: contract.environments,
    critical_journeys: contract.critical_journeys
  });
  const ingestResponse = await postJson(`${endpoint}/api/ingest`, {
    items: [
      {
        schema_version: "1.0",
        type: "event",
        product_id: contract.product.id,
        environment: "local",
        release: "cli-scan",
        occurred_at: new Date().toISOString(),
        payload: {
          event: "reliability_scan_completed",
          properties: {
            score: report.summary.score,
            grade: report.summary.grade,
            missing_count: report.summary.missing_count
          }
        }
      },
      {
        schema_version: "1.0",
        type: "health",
        product_id: contract.product.id,
        environment: "local",
        release: "cli-scan",
        occurred_at: new Date().toISOString(),
        payload: {
          ok: report.summary.missing_count === 0,
          checks: {
            reliability_scan: report.summary.missing_count === 0
          }
        }
      }
    ]
  });

  return {
    product_id: contract.product.id,
    dashboard_url: endpoint,
    score: report.summary.score,
    product_response: productResponse,
    ingest_response: ingestResponse
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status}`);
  }
  return response.json().catch(() => ({ ok: true }));
}

function productContractText(ctx) {
  if (!ctx.productContractPath) return null;
  return ctx.textFiles.find((file) => file.path === ctx.productContractPath)?.text ?? null;
}

function grade(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function extractYamlValue(text, key) {
  if (!text) return null;
  const match = text.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n]+)["']?`, "im"));
  return match?.[1]?.trim() ?? null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalize(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function rel(root, fullPath) {
  return normalize(path.relative(root, fullPath));
}

function printHelp() {
  process.stdout.write(`AI Product Reliability CLI

Usage:
  node cli/src/index.mjs scan <project-path> [--json] [--out <file>] [--write-passport]
  node cli/src/index.mjs automate <project-path> [--out <dir>] [--dashboard-url <url>] [--register-dashboard]
  node cli/src/index.mjs push <project-path> [--dashboard-url <url>]

Commands:
  scan              Scan a project for MVP reliability controls.
  automate          Generate monitors, alerts, status page, and AI incident package.
  push              Register a project and scan result with the dashboard.

Options:
  --json            Output JSON instead of Markdown.
  --out <file>      Write output to a file.
  --write-passport  Write docs/system-passport.generated.md into the scanned project.
`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
