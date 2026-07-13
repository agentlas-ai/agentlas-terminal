#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const coreRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
if (!coreRoot || !fs.existsSync(path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py"))) {
  console.log("project-bootstrap-contract: SKIP (new Agentlas Core runtime not supplied)");
  process.exit(0);
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-terminal-project-bootstrap-"));
fs.writeFileSync(path.join(project, "main.js"), "function terminalFirstContact() { return true; }\n");

try {
  const terminal = require("../engine/agentlas.cjs");
  assert.equal(terminal.ensureCoreProjectCli(project), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "project-soul-memory.md")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "code-map", "project-map.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "ontology-runtime.sqlite")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "career-graph.sqlite")), true);
  const ignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  assert.match(ignore, /agentlas local project state/);
  console.log("project-bootstrap-contract: PASS");
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
