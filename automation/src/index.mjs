#!/usr/bin/env node
import process from "node:process";
import { generateAutomation } from "./generate.mjs";

async function main() {
  const [command, target, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return;
  }
  if (command !== "generate") {
    fail(`Unknown command: ${command}`);
  }
  if (!target) {
    fail("generate requires a project path");
  }

  const options = parseArgs(args);
  const result = await generateAutomation(target, options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") {
      i += 1;
      if (!args[i]) fail("--out requires a directory");
      options.outDir = args[i];
    } else if (arg === "--dashboard-url") {
      i += 1;
      if (!args[i]) fail("--dashboard-url requires a URL");
      options.dashboardUrl = args[i];
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`AI Product Reliability Automation

Usage:
  node automation/src/index.mjs generate <project-path> [--out <dir>] [--dashboard-url <url>]

Generates:
  monitors.json
  alerts.json
  status-page.md
  ai-incident-package.md
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

