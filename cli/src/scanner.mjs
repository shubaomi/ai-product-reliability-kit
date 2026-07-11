import { promises as fs } from "node:fs";
import path from "node:path";
import { loadProductContract } from "@ai-product-reliability/standard/product-contract";
import { runVerification } from "./verify.mjs";

const IGNORE_DIRS = new Set([
  ".git",
  ".tmp",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "templates",
  "template",
  "examples",
  "example"
]);

const LEVEL_SCORE = { missing: 0, declared: 0.3, detected: 0.6, verified: 1 };
const LEVEL_ORDER = ["missing", "declared", "detected", "verified"];
const PLACEHOLDER_TEXT = /\bplaceholder\b|replace with .* in production|\bnot[ -]?implemented\b|\bTODO\b/i;

const RULES = [
  rule("product-contract", "Product contract", 12, "high", (ctx) => ctx.contractResult
    ? [evidence(rel(ctx.root, ctx.contractResult.path), "verified", "schema_validated")]
    : [], "Add a schema-valid product.yml contract."),
  rule("health-check", "Health check endpoint", 10, "high", (ctx) => [
    ...pathOrCodeEvidence(ctx, /healthz/i, [/\/healthz\b/i, /\bhealthz\b/i]),
    ...capabilityEvidence(ctx, "health_check")
  ], "Expose a shallow /healthz endpoint and verify its behavior."),
  rule("readiness-check", "Readiness check endpoint", 6, "medium", (ctx) => pathOrCodeEvidence(ctx, /readyz/i, [/\/readyz\b/i, /\breadyz\b/i]), "Add /readyz with real dependency checks."),
  rule("system-passport", "System passport", 9, "high", (ctx) => fileEvidence(ctx, ["docs/system-passport.md", "docs/SYSTEM_PASSPORT.md"], "declared", "documentation"), "Create docs/system-passport.md."),
  rule("runbook", "Incident runbook", 7, "medium", (ctx) => fileEvidence(ctx, ["docs/runbook.md", "docs/RUNBOOK.md"], "declared", "documentation"), "Create an incident runbook."),
  rule("rollback", "Rollback guide", 8, "high", (ctx) => [
    ...fileEvidence(ctx, ["docs/rollback.md", "docs/ROLLBACK.md"], "declared", "documentation"),
    ...capabilityEvidence(ctx, "rollback_runbook")
  ], "Create and exercise rollback guidance."),
  rule("ci-quality-gate", "CI quality gate", 8, "medium", (ctx) => [
    ...ctx.files.filter((file) => file.relative.startsWith(".github/workflows/") && /\.ya?ml$/i.test(file.relative)).map((file) => evidence(file.relative, "detected", "ci_workflow")),
    ...capabilityEvidence(ctx, "ci_quality_gate")
  ], "Add CI with real lint, typecheck, test, build, and security commands."),
  rule("smoke-tests", "Smoke or E2E tests", 10, "high", (ctx) => [
    ...ctx.textFiles.filter((file) => isTestFile(file.relative)).map((file) => evidence(file.relative, isPlaceholder(file.text) ? "declared" : "detected", "test_file")),
    ...capabilityEvidence(ctx, "smoke_tests")
  ], "Add executable smoke/E2E coverage for health and a critical journey."),
  rule("error-tracking", "Error tracking", 10, "high", (ctx) => [
    ...codeEvidence(ctx, [/Sentry\.captureException\s*\(/i, /captureException\s*\(/i, /capture_error\s*\(/i]),
    ...dependencyEvidence(ctx, [/sentry/i]),
    ...capabilityEvidence(ctx, "error_tracking")
  ], "Connect a real error tracker and verify delivery."),
  rule("product-events", "Core product events", 8, "medium", (ctx) => [
    ...codeEvidence(ctx, [/trackEvent\s*\(/i, /analytics\.track\s*\(/i, /posthog\.capture\s*\(/i]),
    ...dependencyEvidence(ctx, [/posthog/i]),
    ...capabilityEvidence(ctx, "product_events")
  ], "Emit and verify stable critical-journey events."),
  rule("release-tracking", "Release tracking", 7, "medium", (ctx) => [
    ...codeEvidence(ctx, [/GIT_SHA/i, /COMMIT_SHA/i, /RELEASE_VERSION/i]),
    ...capabilityEvidence(ctx, "release_tracking")
  ], "Attach release identity to runtime signals."),
  rule("security-maintenance", "Security maintenance", 5, "medium", (ctx) => [
    ...fileEvidence(ctx, [".github/dependabot.yml", ".github/dependabot.yaml"], "detected", "dependency_updates"),
    ...workflowCommandEvidence(ctx, /(?:run:\s*|[- ]run\s+).*\b(?:npm audit|codeql|secret scanning)\b/i)
  ], "Run real dependency and security checks in CI.")
];

export async function scanProject(root, options = {}) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Target is not a directory: ${root}`);

  const files = await walk(root);
  const textFiles = await readTextFiles(files);
  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  const contractResult = await loadProductContract(root);
  const ctx = { root, files, textFiles, packageJson, contractResult };
  const verification = await runVerification(ctx, { requested: options.verify === true, defaultTimeoutMs: options.verifyTimeoutMs });

  const findings = RULES.map((item) => buildFinding(item, ctx, verification));
  const maxScore = RULES.reduce((sum, item) => sum + item.weight, 0);
  const score = round(findings.reduce((sum, item) => sum + item.score, 0));
  const missing = findings.filter((item) => item.evidence_level === "missing");
  const summary = {
    target: root,
    standard_version: contractResult?.contract.standard_version ?? "unknown",
    score,
    max_score: maxScore,
    grade: grade(score, maxScore),
    missing_count: missing.length,
    passed_count: findings.length - missing.length,
    declared_count: findings.filter((item) => item.evidence_level === "declared").length,
    detected_count: findings.filter((item) => item.evidence_level === "detected").length,
    verified_count: findings.filter((item) => item.evidence_level === "verified").length
  };
  const adoptionPlan = buildAdoptionPlan(findings.filter((item) => item.evidence_level !== "verified"));

  return {
    tool: "ai-product-reliability-cli",
    tool_version: "1.0.0",
    generated_at: new Date().toISOString(),
    summary,
    compatibility: contractResult?.compatibility ?? null,
    warnings: contractResult?.warnings ?? [],
    migration_advice: contractResult?.migration_advice ?? [],
    verification,
    findings,
    adoption_plan: adoptionPlan,
    passportDraft: generatePassportDraft(ctx, findings, summary, adoptionPlan),
    generatedFiles: []
  };
}

export function renderMarkdown(report) {
  const rows = report.findings.map((item) => `- [${item.evidence_level}] ${item.title}: ${item.score}/${item.weight}${item.evidence.length ? ` (${item.evidence.join(", ")})` : ""}`);
  return `# AI Product Reliability Report

- Target: ${report.summary.target}
- Generated: ${report.generated_at}
- Score: ${report.summary.score}/${report.summary.max_score}
- Grade: ${report.summary.grade}
- Verified: ${report.summary.verified_count}
- Detected: ${report.summary.detected_count}
- Declared: ${report.summary.declared_count}
- Missing: ${report.summary.missing_count}
- Verification: ${report.verification.status}

## Controls

${rows.join("\n")}

## Migration Advice

${report.migration_advice.length ? report.migration_advice.map((item) => `- ${item}`).join("\n") : "- None"}

## Adoption Plan

${report.adoption_plan.length ? report.adoption_plan.map((item) => `${item.step}. ${item.title}: ${item.action}`).join("\n") : "No immediate adoption steps required."}
`;
}

function buildFinding(item, ctx, verification) {
  const items = uniqueEvidence(item.collect(ctx));
  const matchingCommands = verification.commands.filter((command) => command.controls.includes(item.id));
  for (const command of matchingCommands.filter((entry) => entry.status === "success")) {
    items.push(evidence(`verification:${command.id}`, "verified", "command_success"));
  }
  const level = highestLevel(items);
  const verificationStatus = commandStatus(matchingCommands);
  return {
    id: item.id,
    title: item.title,
    status: level,
    evidence_level: level,
    severity: item.severity,
    weight: item.weight,
    score: round(item.weight * LEVEL_SCORE[level]),
    evidence: unique(items.map((entry) => entry.path)),
    evidence_items: uniqueEvidence(items),
    verification_status: verificationStatus,
    recommendation: level === "verified" ? "" : item.recommendation
  };
}

function rule(id, title, weight, severity, collect, recommendation) {
  return { id, title, weight, severity, collect, recommendation };
}

function evidence(pathValue, level, kind) {
  return { path: pathValue, level, kind };
}

function pathOrCodeEvidence(ctx, pathPattern, contentPatterns) {
  const direct = ctx.textFiles.filter((file) => pathPattern.test(file.relative) && !isPlaceholder(file.text));
  if (direct.length) return direct.map((file) => evidence(file.relative, "detected", "source_path"));
  return codeEvidence(ctx, contentPatterns);
}

function codeEvidence(ctx, patterns) {
  return ctx.textFiles
    .filter((file) => isCodeFile(file.relative) && !isTestFile(file.relative) && !isPlaceholder(file.text))
    .filter((file) => patterns.some((pattern) => pattern.test(stripComments(file.text))))
    .map((file) => evidence(file.relative, "detected", "source_code"));
}

function dependencyEvidence(ctx, patterns) {
  const dependencies = { ...(ctx.packageJson?.dependencies ?? {}), ...(ctx.packageJson?.optionalDependencies ?? {}) };
  return Object.keys(dependencies)
    .filter((name) => patterns.some((pattern) => pattern.test(name)))
    .map((name) => evidence(`package.json#${name}`, "detected", "dependency_declaration"));
}

function workflowCommandEvidence(ctx, pattern) {
  return ctx.textFiles
    .filter((file) => file.relative.startsWith(".github/workflows/") && pattern.test(file.text) && !isPlaceholder(file.text))
    .map((file) => evidence(file.relative, "detected", "ci_command"));
}

function capabilityEvidence(ctx, capability) {
  return ctx.contractResult?.contract.capabilities?.[capability] === true
    ? [evidence(`product.yml#capabilities.${capability}`, "declared", "contract_declaration")]
    : [];
}

function fileEvidence(ctx, candidates, level, kind) {
  const normalized = new Set(candidates.map(normalize));
  return ctx.files.filter((file) => normalized.has(normalize(file.relative))).map((file) => evidence(file.relative, level, kind));
}

async function walk(root) {
  const results = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORE_DIRS.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = rel(root, fullPath);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) results.push({ path: fullPath, relative });
    }
  }
  await visit(root);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function readTextFiles(files) {
  const result = [];
  const textExt = /\.(md|mdx|txt|ya?ml|json|js|jsx|ts|tsx|mjs|cjs|py|java|go|rb|php|cs|rs|html|css|env|toml|ini)$/i;
  for (const file of files) {
    if (!textExt.test(file.relative)) continue;
    const stat = await fs.stat(file.path);
    if (stat.size > 256 * 1024) continue;
    result.push({ ...file, text: await fs.readFile(file.path, "utf8").catch(() => "") });
  }
  return result;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function generatePassportDraft(ctx, findings, summary, adoptionPlan) {
  const product = ctx.contractResult?.contract.product ?? {};
  return `# System Passport Draft

Generated by AI Product Reliability CLI on ${new Date().toISOString()}.

## Product

- Product ID: ${product.id ?? ctx.packageJson?.name ?? path.basename(ctx.root)}
- Product name: ${product.name ?? ctx.packageJson?.name ?? path.basename(ctx.root)}
- Owner: ${product.owner ?? "unknown"}
- Standard version: ${summary.standard_version}
- Reliability score: ${summary.score}/${summary.max_score} (${summary.grade})

## Evidence

${findings.map((item) => `- ${item.title}: ${item.evidence_level}${item.evidence.length ? ` (${item.evidence.join(", ")})` : ""}`).join("\n")}

## Suggested Adoption Plan

${adoptionPlan.length ? adoptionPlan.map((item) => `${item.step}. ${item.title} - ${item.action}`).join("\n") : "No immediate adoption steps required."}
`;
}

function buildAdoptionPlan(findings) {
  return findings
    .sort((a, b) => LEVEL_ORDER.indexOf(a.evidence_level) - LEVEL_ORDER.indexOf(b.evidence_level) || b.weight - a.weight)
    .map((item, index) => ({ step: index + 1, id: item.id, title: item.title, severity: item.severity, action: item.recommendation }));
}

function highestLevel(items) {
  return items.reduce((level, item) => LEVEL_ORDER.indexOf(item.level) > LEVEL_ORDER.indexOf(level) ? item.level : level, "missing");
}

function commandStatus(commands) {
  if (!commands.length) return "unverified";
  if (commands.some((item) => item.status === "success")) return "success";
  if (commands.some((item) => item.status === "failure")) return "failure";
  if (commands.every((item) => item.status === "skipped")) return "skipped";
  return "unverified";
}

function uniqueEvidence(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.path}:${item.level}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function isPlaceholder(text) {
  return PLACEHOLDER_TEXT.test(text);
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
}

function isCodeFile(filePath) {
  return /\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rb|php|cs|rs)$/i.test(filePath);
}

function isTestFile(filePath) {
  return /(\.spec|\.test)\.(t|j)sx?$/i.test(filePath) || /(^|\/)tests?\//i.test(filePath) || /playwright/i.test(filePath);
}

function grade(score, maxScore) {
  const percent = maxScore ? (score / maxScore) * 100 : 0;
  if (percent >= 85) return "A";
  if (percent >= 70) return "B";
  if (percent >= 55) return "C";
  if (percent >= 40) return "D";
  return "F";
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function normalize(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function rel(root, fullPath) {
  return normalize(path.relative(root, fullPath));
}
