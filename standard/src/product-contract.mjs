import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { negotiateProtocolVersion } from "./protocol-compatibility.mjs";

export const PRODUCT_CONTRACT_CANDIDATES = [
  "product.yml",
  "product.yaml",
  "reliability/product.yml",
  "config/product.yml"
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(await fs.readFile(path.resolve(__dirname, "../product-contract.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateContract = ajv.compile(schema);

export class ProductContractError extends Error {
  constructor(code, message, issues = []) {
    super(message);
    this.name = "ProductContractError";
    this.code = code;
    this.status = 400;
    this.issues = issues;
  }
}

export function parseProductContractText(text, source = "product.yml") {
  const document = YAML.parseDocument(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true
  });
  if (document.errors.length) {
    const issues = document.errors.map((error) => error.message);
    throw new ProductContractError(
      "invalid_yaml",
      `${source} contains invalid YAML: ${issues.join("; ")}`,
      issues
    );
  }

  const value = document.toJS({ maxAliasCount: 100 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductContractError("invalid_contract", `${source} must contain a YAML object`, ["/ must be an object"]);
  }

  const contract = structuredClone(value);
  const warnings = [];
  if (contract.product?.repository) {
    warnings.push({
      code: "deprecated_field",
      field: "product.repository",
      replacement: "product.repo",
      message: "product.repository is deprecated; use product.repo"
    });
    if (!contract.product.repo) contract.product.repo = contract.product.repository;
    delete contract.product.repository;
  }

  if (!validateContract(contract)) {
    const issues = formatAjvErrors(validateContract.errors);
    throw new ProductContractError(
      "invalid_contract",
      `${source} does not match product-contract.schema.json: ${issues.join("; ")}`,
      issues
    );
  }

  let compatibility;
  try {
    compatibility = negotiateProtocolVersion(contract.standard_version, { currentVersion: "1.1" });
  } catch (error) {
    throw new ProductContractError(error.code ?? "incompatible_contract", `${source}: ${error.message}`, [error.message]);
  }
  warnings.push(...compatibility.warnings);

  return {
    contract,
    source,
    compatibility,
    warnings,
    migration_advice: compatibility.migration_advice
  };
}

export async function findProductContract(root, candidates = PRODUCT_CONTRACT_CANDIDATES) {
  for (const candidate of candidates) {
    const filePath = path.join(root, candidate);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return filePath;
    } catch {
      // Continue to the next supported location.
    }
  }
  return null;
}

export async function loadProductContract(root, candidates = PRODUCT_CONTRACT_CANDIDATES) {
  const filePath = await findProductContract(root, candidates);
  if (!filePath) return null;
  const text = await fs.readFile(filePath, "utf8");
  return { ...parseProductContractText(text, filePath), path: filePath, text };
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`.trim());
}
