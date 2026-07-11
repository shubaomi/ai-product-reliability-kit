import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_EXECUTABLES = new Set([
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "pytest",
  "uv",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew"
]);
const PLACEHOLDER_SCRIPT = /\bplaceholder\b|\bnot[ -]?implemented\b|\bTODO\b|^\s*(echo|printf)\b/i;

export async function runVerification(context, options = {}) {
  const requested = options.requested === true;
  const commands = buildVerificationCommands(context);
  if (!requested) {
    return {
      requested: false,
      status: "unverified",
      commands: commands.map((command) => ({ ...publicCommand(command), status: "unverified" }))
    };
  }

  const results = [];
  for (const command of commands) {
    results.push(await executeCommand(command, context.root, options.defaultTimeoutMs ?? 30_000));
  }

  return {
    requested: true,
    status: aggregateStatus(results),
    commands: results
  };
}

export function buildVerificationCommands(context) {
  const explicit = (context.contractResult?.contract?.verification?.commands ?? []).map((item) => ({
    id: item.id,
    command: item.command,
    controls: item.controls ?? [],
    timeout_ms: item.timeout_ms,
    source: "product.yml",
    placeholder: false
  }));
  const scripts = context.packageJson?.scripts ?? {};
  const builtins = [];
  for (const [name, controls] of [
    ["test", ["smoke-tests"]],
    ["lint", ["ci-quality-gate"]],
    ["typecheck", ["ci-quality-gate"]],
    ["build", ["ci-quality-gate"]],
    ["audit", ["security-maintenance"]],
    ["security", ["security-maintenance"]]
  ]) {
    if (typeof scripts[name] !== "string") continue;
    builtins.push({
      id: `builtin-${name}`,
      command: name === "test" ? ["npm", "test"] : ["npm", "run", name],
      controls,
      source: "built-in",
      placeholder: PLACEHOLDER_SCRIPT.test(scripts[name])
    });
  }
  return [...explicit, ...builtins];
}

async function executeCommand(command, cwd, defaultTimeoutMs) {
  const result = publicCommand(command);
  const executable = normalizeExecutable(command.command[0]);
  if (!SAFE_EXECUTABLES.has(executable)) {
    return { ...result, status: "skipped", reason: `executable_not_allowed:${executable}` };
  }
  if (command.placeholder) {
    return { ...result, status: "skipped", reason: "placeholder_script" };
  }

  const timeout = command.timeout_ms ?? defaultTimeoutMs;
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(resolveExecutable(command.command[0]), command.command.slice(1), {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: false
    });
    return {
      ...result,
      status: "success",
      exit_code: 0,
      duration_ms: Date.now() - started,
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr)
    };
  } catch (error) {
    const timedOut = error.killed === true || error.code === "ETIMEDOUT";
    return {
      ...result,
      status: "failure",
      exit_code: Number.isInteger(error.code) ? error.code : null,
      timed_out: timedOut,
      reason: timedOut ? "timeout" : "command_failed",
      duration_ms: Date.now() - started,
      stdout: trimOutput(error.stdout),
      stderr: trimOutput(error.stderr ?? error.message)
    };
  }
}

function publicCommand(command) {
  return {
    id: command.id,
    command: [...command.command],
    controls: [...command.controls],
    source: command.source,
    timeout_ms: command.timeout_ms
  };
}

function aggregateStatus(results) {
  if (!results.length) return "unverified";
  if (results.some((item) => item.status === "failure")) return "failure";
  if (results.every((item) => item.status === "success")) return "success";
  if (results.every((item) => item.status === "skipped")) return "skipped";
  return "mixed";
}

function normalizeExecutable(value) {
  return path.basename(String(value)).toLowerCase().replace(/\.(cmd|exe|bat)$/i, "");
}

function resolveExecutable(value) {
  if (process.platform !== "win32" || path.extname(value)) return value;
  const executable = normalizeExecutable(value);
  if (["npm", "npx", "mvn", "mvnw", "gradle", "gradlew"].includes(executable)) return `${value}.cmd`;
  return value;
}

function trimOutput(value) {
  return String(value ?? "").trim().slice(0, 4000);
}
