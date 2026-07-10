#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const terminal = require(path.join(root, "engine", "agentlas.cjs"));
const tools = require(path.join(root, "engine", "agentlas-tools.cjs"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-credential-env-"));

try {
  const shellCwd = path.join(temp, "project");
  fs.mkdirSync(shellCwd, { recursive: true });
  assert.equal(
    terminal.resolveCredentialSourcePath("keys/service.json", shellCwd),
    path.join(shellCwd, "keys", "service.json"),
    "relative credential source must resolve from the caller cwd",
  );

  const credentials = path.join(temp, "credentials.env");
  terminal.upsertEnvLine(credentials, "SERVICE_TOKEN", "first");
  terminal.upsertEnvLine(credentials, "SERVICE_TOKEN", "second");
  assert.equal(fs.readFileSync(credentials, "utf8"), "SERVICE_TOKEN=second\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600, "credential env must be owner-only");
  }

  const before = process.env.AGENTLAS_SCOPE_TEST;
  const result = tools.runTool(
    "bash",
    { command: 'printf %s "$AGENTLAS_SCOPE_TEST"' },
    {
      cwd: shellCwd,
      permission: "full",
      env: { ...process.env, AGENTLAS_SCOPE_TEST: "turn-only" },
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.content, /turn-only/);
  assert.equal(process.env.AGENTLAS_SCOPE_TEST, before, "turn env must not leak into the host process");

  const replSource = fs.readFileSync(path.join(root, "engine", "agentlas-repl.cjs"), "utf8");
  assert.equal(replSource.includes("Object.assign(process.env"), false);
  assert.match(replSource, /ctx:\s*\{ \.\.\.ctx, env: runEnv \}/);

  console.log(JSON.stringify({ ok: true, checks: 8 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
