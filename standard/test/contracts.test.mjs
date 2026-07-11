import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ProductContractError,
  parseProductContractText
} from "../src/product-contract.mjs";
import {
  CompatibilityError,
  normalizeTelemetryEnvelope
} from "../src/protocol-compatibility.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "protocol");

test("formal YAML parsing validates the product schema and returns migration advice", () => {
  const result = parseProductContractText(validContract("1.0"), "fixture.yml");
  assert.equal(result.contract.product.id, "fixture-product");
  assert.equal(result.compatibility.accepted, true);
  assert.match(result.migration_advice.join("\n"), /1\.1/);
});

test("invalid YAML and schema violations return actionable typed errors", () => {
  assert.throws(
    () => parseProductContractText("standard_version: '1.0'\nproduct:\n  id: [\n", "broken.yml"),
    (error) => error instanceof ProductContractError && error.code === "invalid_yaml" && /broken\.yml/.test(error.message)
  );
  assert.throws(
    () => parseProductContractText("standard_version: '1.0'\nproduct: {}\n", "missing.yml"),
    (error) => error instanceof ProductContractError && error.code === "invalid_contract" && error.issues.length > 0
  );
});

test("deprecated product fields remain readable and emit warnings", () => {
  const text = validContract("1.1").replace(
    "  repo: https://example.com/repo\n",
    "  repository: https://example.com/legacy-repo\n"
  );
  const result = parseProductContractText(text, "legacy.yml");
  assert.equal(result.contract.product.repo, "https://example.com/legacy-repo");
  assert.ok(result.warnings.some((warning) => warning.code === "deprecated_field"));
});

test("public status publication is a formal boolean contract field and defaults to private", () => {
  const privateContract = parseProductContractText(validContract("1.1"), "private.yml");
  assert.equal(privateContract.contract.public_status, undefined);

  const publicContract = parseProductContractText(
    `${validContract("1.1")}public_status:\n  enabled: true\n`,
    "public.yml"
  );
  assert.equal(publicContract.contract.public_status.enabled, true);

  assert.throws(
    () => parseProductContractText(
      `${validContract("1.1")}public_status:\n  enabled: yes-please\n`,
      "unsafe-publication.yml"
    ),
    (error) => error instanceof ProductContractError
      && error.code === "invalid_contract"
      && error.issues.some((issue) => issue.includes("/public_status/enabled"))
  );
});

test("shared protocol fixtures accept v1.x, tolerate optional fields, warn on deprecated fields, and reject unknown majors", async () => {
  for (const name of ["telemetry-v1.0.json", "telemetry-v1.1-optional.json"]) {
    const envelope = await readJson(name);
    const result = normalizeTelemetryEnvelope(envelope);
    assert.equal(result.compatibility.accepted, true);
    assert.equal(result.envelope.schema_version, envelope.schema_version);
  }

  const deprecated = normalizeTelemetryEnvelope(await readJson("telemetry-v1.0-deprecated.json"));
  assert.equal(deprecated.envelope.occurred_at, "2026-07-10T12:00:00.000Z");
  assert.ok(deprecated.warnings.some((warning) => warning.field === "timestamp"));

  assert.throws(
    () => normalizeTelemetryEnvelope(awaitValue("telemetry-v2.0-unsupported.json")),
    (error) => error instanceof CompatibilityError && error.code === "unsupported_major"
  );
});

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, name), "utf8"));
}

function awaitValue(name) {
  return JSON.parse(fsSyncRead(path.join(fixtureDir, name)));
}

function fsSyncRead(filePath) {
  return globalThis.process.getBuiltinModule("node:fs").readFileSync(filePath, "utf8");
}

function validContract(version) {
  return `standard_version: "${version}"
product:
  id: fixture-product
  name: Fixture Product
  owner: owner@example.com
  repo: https://example.com/repo
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
