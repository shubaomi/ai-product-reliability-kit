import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

const source = await fs.readFile("sdks/java/src/main/java/com/aiproductreliability/ReliabilityClient.java", "utf8");

for (const snippet of [
  "public final class ReliabilityClient",
  "public String event(",
  "public String error(",
  "public String health(",
  "public String flush()",
  "\\\"schema_version\\\":\\\"1.0\\\"",
  "/api/ingest"
]) {
  assert.match(source, new RegExp(escapeRegExp(snippet)));
}

console.log("Java SDK static checks OK");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
