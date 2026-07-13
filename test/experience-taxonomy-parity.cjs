#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const exchange = require("../engine/agentlas-experience-exchange.cjs");

const taxonomyPath = path.join(__dirname, "../engine/experience-taxonomy-v1.json");
const fixturePath = path.join(__dirname, "fixtures/experience-taxonomy-v1-cross-surface.json");
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
let checks = 0;
const check = (action) => { action(); checks += 1; };

check(() => assert.equal(exchange.canonicalHash(taxonomy), exchange.EXPERIENCE_TAXONOMY_CHECKSUM));
check(() => assert.equal(exchange.EXPERIENCE_TAXONOMY_CHECKSUM, "sha256:413833472e423352518f9591cd0e051c5bc0a7971e53ab3dc7b5aaf7d50c37ab"));
check(() => assert.equal(fixture.taxonomyChecksum, exchange.EXPERIENCE_TAXONOMY_CHECKSUM));
check(() => assert.deepEqual(exchange.loadExperienceTaxonomyContract(), exchange.EXPERIENCE_TAXONOMY_V1));
check(() => assert.equal(exchange.CANONICAL_TASK_IDS.length, 23));
check(() => assert.equal(exchange.CANONICAL_TASK_IDS.includes("agentlas.task.v1/general"), false));
check(() => assert.equal(exchange.canonicalSourceTaskId("agentlas.task.v1/research"), "agentlas.task.v1/research"));
check(() => assert.equal(exchange.canonicalSourceTaskId(" research "), null, "portable source must require a canonical ID"));
check(() => assert.equal(exchange.canonicalTaskId(" Research "), "agentlas.task.v1/research"));
check(() => assert.equal(exchange.canonicalTaskId("general"), null));

for (const value of [
  "agentlas.env.v1/os/macos",
  "agentlas.env.v1/os/windows",
  "agentlas.env.v1/os/linux",
  "agentlas.env.v1/os/ios",
  "agentlas.env.v1/os/android",
  "agentlas.env.v1/os/unknown",
  "agentlas.env.v1/arch/arm64",
  "agentlas.env.v1/arch/x64",
  "agentlas.env.v1/arch/unknown",
  "agentlas.env.v1/runtime/go",
  "agentlas.env.v1/runtime/terminal",
]) check(() => assert.equal(exchange.isCanonicalEnvironmentTag(value), true, `${value} should be canonical`));

for (const value of [
  "agentlas.env.v1/os/freebsd",
  "agentlas.env.v1/arch/riscv64",
  "agentlas.env.v1/runtime/x",
  "agentlas.env.v1/runtime/unknown runtime",
  "macos-arm64",
]) check(() => assert.equal(exchange.isCanonicalEnvironmentTag(value), false, `${value} must fail closed`));

check(() => assert.deepEqual(exchange.defaultEnvironmentTags({ platform: "freebsd", arch: "riscv64", runtime: "x" }), [
  "agentlas.env.v1/os/unknown",
  "agentlas.env.v1/arch/unknown",
  "agentlas.env.v1/runtime/unknown",
]));
check(() => assert.deepEqual(exchange.defaultEnvironmentTags({ platform: "darwin", arch: "aarch64", runtime: "terminal" }), [
  "agentlas.env.v1/os/macos",
  "agentlas.env.v1/arch/arm64",
  "agentlas.env.v1/runtime/terminal",
]));
check(() => assert.equal(exchange.environmentConstraintsMatch([
  "agentlas.env.v1/os/macos",
  "agentlas.env.v1/arch/arm64",
  "agentlas.env.v1/runtime/codex",
], { os: "macos", arch: "arm64", runtime: "codex" }), true));
check(() => assert.equal(exchange.environmentConstraintsMatch(["agentlas.env.v1/os/freebsd"], {
  os: "unknown", arch: "arm64", runtime: "codex",
}), false));
check(() => assert.equal(exchange.environmentConstraintsMatch([], { os: "freebsd", arch: "arm64", runtime: "codex" }), false));
check(() => assert.equal(exchange.environmentConstraintsMatch([], { os: "macos", arch: "arm64", runtime: "x" }), false));
check(() => assert.equal(exchange.environmentConstraintsMatch(["agentlas.env.v1/os/unknown"], {
  os: "unknown", arch: "arm64", runtime: "codex",
}), false, "unknown values are portable but never runtime-eligible"));
check(() => assert.deepEqual(exchange.deriveCanonicalTaskClasses("The runtime returned an error.").taskIds, [
  "agentlas.task.v1/debugging",
]));
check(() => assert.deepEqual(exchange.resolveRuntimeExperienceForAgent({
  requested: {},
  platform: "darwin",
  arch: "arm64",
  runtime: "x",
}).observableReason, "runtime-environment-unknown"));

const byId = new Map(fixture.items.map((item) => [item.experienceItemId, item]));
for (const testCase of fixture.cases) {
  check(() => assert.deepEqual(exchange.selectApplicablePortableItems({
    items: testCase.itemIds.map((id) => byId.get(id)),
    taskClass: testCase.taskClass,
    capabilityTags: testCase.capabilityTags,
    environment: testCase.environment,
  }), testCase.expectedSelectedItemIds, testCase.id));
}

const drifted = JSON.parse(JSON.stringify(taxonomy));
drifted.taskSlugs.push("general");
check(() => assert.throws(() => exchange.validateExperienceTaxonomyContract(drifted), /task catalog drifted|checksum drifted/));
const runtimeDrift = JSON.parse(JSON.stringify(taxonomy));
runtimeDrift.environment.runtimePattern = "^[a-z0-9]$";
check(() => assert.throws(() => exchange.validateExperienceTaxonomyContract(runtimeDrift), /environment contract drifted|checksum drifted/));

console.log(JSON.stringify({ ok: true, checks, checksum: exchange.EXPERIENCE_TAXONOMY_CHECKSUM }, null, 2));
