#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const terminal = require("../engine/agentlas-experience-mcp.cjs");
const host = require("../engine/agentlas-native-host.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-consent-"));
const rows = [{
  id: "server-alpha",
  catalog_id: "alpha",
  name: "Alpha",
  name_en: "Alpha",
  transport: "stdio",
  command: "alpha-mcp",
  args_json: '["--stdio"]',
  env_keys_json: "[]",
  enabled: 1,
}];

const db = {
  prepare(sql) {
    if (/WHERE id=\? LIMIT 1/.test(sql)) {
      return { get: (id) => rows.find((row) => row.id === id) || null };
    }
    return { all: () => rows };
  },
};

try {
  assert.deepEqual(terminal.readConsentedSystemMcpServers(db, { userDataDir: temp }), [], "enabled alone must not authorize an ordinary turn");
  assert.deepEqual(host.codexMcpArgs([], {}), [], "legacy Playwright must not be seeded into an empty allowlist");

  const approved = terminal.materializeTrustedSystemMcpServer(rows[0], { userDataDir: temp, createRuntimeHome: false });
  assert.ok(approved && approved.consentFingerprint, "trusted row must produce an exact non-secret fingerprint");
  assert.equal(terminal.persistMcpConsentReceipts(temp, [approved]), true);

  const consented = terminal.readConsentedSystemMcpServers(db, { userDataDir: temp, createRuntimeHome: false });
  assert.deepEqual(consented.map((server) => server.catalog_id), ["alpha"]);
  const stateText = fs.readFileSync(terminal.mcpConsentStatePath(temp), "utf8");
  assert.doesNotMatch(stateText, /alpha-mcp|--stdio|credential|token|command|args_json/i, "consent state must contain only identity and fingerprints");
  if (process.platform !== "win32") assert.equal(fs.statSync(terminal.mcpConsentStatePath(temp)).mode & 0o777, 0o600);

  rows[0].command = "alpha-mcp-changed";
  assert.deepEqual(terminal.readConsentedSystemMcpServers(db, { userDataDir: temp }), [], "runtime definition drift must invalidate consent");
  rows[0].command = "alpha-mcp";
  rows[0].enabled = 0;
  assert.deepEqual(terminal.readConsentedSystemMcpServers(db, { userDataDir: temp }), [], "disabled registry rows must stay detached");
  fs.writeFileSync(terminal.mcpConsentStatePath(temp), '{"schemaVersion":"corrupt"}\n', "utf8");
  assert.deepEqual(terminal.readConsentedSystemMcpServers(db, { userDataDir: temp }), [], "malformed consent state must fail closed");

  console.log(JSON.stringify({ ok: true, checks: 11 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
