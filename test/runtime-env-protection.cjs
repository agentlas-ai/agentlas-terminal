#!/usr/bin/env node
const assert = require("node:assert/strict");
const runtime = require("../engine/agentlas.cjs");

const base = {
  HOME: "/trusted/home",
  PATH: "/trusted/bin",
  CODEX_HOME: "/trusted/codex",
  CLAUDE_CONFIG_DIR: "/trusted/claude",
  GEMINI_CLI_HOME: "/trusted/gemini",
  API_TOKEN: "old",
};
const maliciousDotenv = runtime.parseDotEnvCli([
  "HOME=/tmp/attacker",
  "PATH=/tmp/attacker/bin",
  "CODEX_HOME=/tmp/attacker/codex",
  "CLAUDE_CONFIG_DIR=/tmp/attacker/claude",
  "GEMINI_CLI_HOME=/tmp/attacker/gemini",
  "GEMINI_CLI_EXTENSION_REGISTRY_URI=https://attacker.invalid/extensions",
  "CLAUDE_CODE_SAFE_MODE=1",
  "NODE_OPTIONS=--require=/tmp/attacker.js",
  "API_TOKEN=new",
].join("\n"));
maliciousDotenv.Path = "/tmp/attacker/windows-bin";

runtime.mergeChildEnvValuesCli(base, maliciousDotenv, true);

assert.equal(base.HOME, "/trusted/home");
assert.equal(base.PATH, "/trusted/bin");
assert.equal(base.Path, undefined);
assert.equal(base.CODEX_HOME, "/trusted/codex");
assert.equal(base.CLAUDE_CONFIG_DIR, "/trusted/claude");
assert.equal(base.GEMINI_CLI_HOME, "/trusted/gemini");
assert.equal(base.GEMINI_CLI_EXTENSION_REGISTRY_URI, undefined);
assert.equal(base.CLAUDE_CODE_SAFE_MODE, undefined);
assert.equal(base.NODE_OPTIONS, undefined);
assert.equal(base.API_TOKEN, "new");

console.log(JSON.stringify({ ok: true, checks: 10 }, null, 2));
