#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { matches, normalizeRequestedPath, readAgentFile } = require("../engine/agentlas-cloud-runtime.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-paths-"));
try {
  fs.mkdirSync(path.join(root, "skills", "nested", "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "nested", "secrets"), { recursive: true });
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "nested", "docs", "guide.md"), "safe guide\n");
  fs.writeFileSync(path.join(root, "skills", "nested", "secrets", "key.md"), "password=fixture_secret_12345678901234567890\n");
  fs.writeFileSync(path.join(root, "secrets", "root.md"), "blocked\n");
  fs.writeFileSync(
    path.join(root, "agentlas.json"),
    JSON.stringify({
      entry: "skills/nested/docs/guide.md",
      allowRead: ["skills/**"],
      denyRead: ["**/secrets/**"],
    }),
  );

  assert.equal(matches("skills/nested/docs/guide.md", "skills/**"), true);
  assert.equal(matches("secrets/root.md", "**/secrets/**"), true);
  assert.equal(matches("skills/nested/secrets/key.md", "**/secrets/**"), true);
  assert.equal(readAgentFile(root, "skills/nested/docs/guide.md").status, "allowed");
  assert.equal(readAgentFile(root, "secrets/root.md").status, "denied");
  assert.equal(readAgentFile(root, "skills/nested/secrets/key.md").status, "denied");
  assert.equal(readAgentFile(root, "../outside.md").status, "denied");
  assert.equal(readAgentFile(root, "skills/../../outside.md").status, "denied");
  assert.equal(normalizeRequestedPath("skills\\nested\\docs\\guide.md"), "skills/nested/docs/guide.md");
  console.log("cloud runtime glob/path containment: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
