#!/usr/bin/env node
import process from "node:process";
import { hashPassword } from "../src/security.mjs";

const password = process.argv[2] ?? process.env.APR_ADMIN_PASSWORD;

if (!password) {
  process.stderr.write("Usage: node scripts/hash-password.mjs <password>\n");
  process.exit(1);
}

process.stdout.write(`${hashPassword(password)}\n`);
