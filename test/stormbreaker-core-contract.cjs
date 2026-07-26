#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HARNESS_ID,
  HARNESS_MODE,
  HARNESS_SCHEMA_VERSION,
  CONTEXT_MAP_MIN_CORE_VERSION,
  loadCoreStormbreakerHarness,
  readCoreRuntimeVersion,
  resolveCoreRuntimeRoot,
  resolveCoreRuntimeRootFromCandidates,
  validateCoreStormbreakerHarness,
} = require("../engine/agentlas-core-harness.cjs");

async function main() {
  const requestedRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
  assert.ok(requestedRoot, "HEPHAESTUS_RUNTIME_ROOT must point to an Agentlas-OS checkout or installed runtime");
  const root = resolveCoreRuntimeRoot(requestedRoot);
  assert.equal(path.resolve(root), path.resolve(requestedRoot));
  assert.ok(readCoreRuntimeVersion(root), "Core runtime must publish bounded version metadata");

  const compatibilityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-core-compat-"));
  const staleRoot = path.join(compatibilityRoot, "stale");
  const currentRoot = path.join(compatibilityRoot, "current");
  for (const [candidate, version] of [[staleRoot, "1.1.65"], [currentRoot, CONTEXT_MAP_MIN_CORE_VERSION]]) {
    fs.mkdirSync(path.join(candidate, "agentlas_cloud"), { recursive: true });
    fs.mkdirSync(path.join(candidate, "schemas"), { recursive: true });
    fs.writeFileSync(path.join(candidate, "agentlas_cloud", "__main__.py"), "", "utf8");
    fs.writeFileSync(path.join(candidate, "agentlas_cloud", "context_map.py"), "", "utf8");
    fs.writeFileSync(path.join(candidate, "schemas", "workforce-work-order.schema.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(candidate, "schemas", "workforce-selection.schema.json"), "{}\n", "utf8");
    const manifestDir = candidate === staleRoot ? path.join(candidate, "host_adapters") : candidate;
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), `${JSON.stringify({ version })}\n`, "utf8");
  }
  assert.equal(readCoreRuntimeVersion(staleRoot), "1.1.65", "legacy host-adapter version metadata must remain readable");
  assert.equal(
    resolveCoreRuntimeRootFromCandidates(
      [staleRoot],
      [["agentlas_cloud", "context_map.py"]],
      { minVersion: CONTEXT_MAP_MIN_CORE_VERSION },
    ),
    null,
    "capability routing must fail closed when every installed Core runtime is incompatible",
  );
  assert.equal(
    resolveCoreRuntimeRootFromCandidates(
      [staleRoot, currentRoot],
      [["agentlas_cloud", "context_map.py"]],
      { minVersion: CONTEXT_MAP_MIN_CORE_VERSION },
    ),
    currentRoot,
    "capability routing must skip an earlier but incompatible Core runtime",
  );
  fs.rmSync(compatibilityRoot, { recursive: true, force: true });

  const harness = await loadCoreStormbreakerHarness(process.cwd(), root);
  assert.equal(harness.schema_version, HARNESS_SCHEMA_VERSION);
  assert.equal(harness.harness_id, HARNESS_ID);
  assert.equal(harness.mode, HARNESS_MODE);
  assert.equal(harness.system_prompt.split("GOAL MODE:").length - 1, 1);
  assert.equal(harness.system_prompt.split("ULTRACODE MODE:").length - 1, 1);
  assert.equal(
    crypto.createHash("sha256").update(harness.system_prompt, "utf8").digest("hex"),
    harness.prompt_sha256,
  );

  assert.throws(
    () => validateCoreStormbreakerHarness({ ...harness, system_prompt: `${harness.system_prompt}\ntampered` }),
    /SHA-256 integrity check/,
  );

  const proof = {
    schema: "agentlas.terminal.cross-platform-harness-proof.v1",
    platform: os.platform(),
    architecture: os.arch(),
    node: process.version,
    harness_id: harness.harness_id,
    mode: harness.mode,
    prompt_sha256: harness.prompt_sha256,
    system_prompt_utf8_base64: Buffer.from(harness.system_prompt, "utf8").toString("base64"),
  };
  if (process.env.AGENTLAS_HARNESS_PROOF_PATH) {
    const proofPath = path.resolve(process.env.AGENTLAS_HARNESS_PROOF_PATH);
    fs.mkdirSync(path.dirname(proofPath), { recursive: true });
    fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
