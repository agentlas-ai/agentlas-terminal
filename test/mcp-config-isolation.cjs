#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-config-"));
process.env.AGENTLAS_USER_DATA_DIR = temp;
const host = require("../engine/agentlas-native-host.cjs");

try {
  const alpha = host.cliMcpConfigPath([
    { id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 },
  ]);
  const beta = host.cliMcpConfigPath([
    { id: "beta", name: "beta", transport: "stdio", command: "beta-mcp", args_json: '["--b"]', enabled: 1 },
  ]);
  assert.notEqual(alpha.file, beta.file, "different MCP sets must not race on one filename");
  assert.equal(JSON.parse(fs.readFileSync(alpha.file, "utf8")).mcpServers.alpha.command, "alpha-mcp");
  assert.equal(JSON.parse(fs.readFileSync(beta.file, "utf8")).mcpServers.beta.command, "beta-mcp");
  assert.equal(host.cliMcpConfigPath([{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 }]).file, alpha.file);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(alpha.file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(alpha.file).mode & 0o777, 0o600);
  }
  const codex = host.codexMcpArgs([{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 }]);
  assert.ok(codex.some((value) => value.includes("mcp_servers.alpha.command")));
  const mainSource = fs.readFileSync(path.join(__dirname, "../engine/agentlas.cjs"), "utf8");
  assert.match(mainSource, /agentlas-native-host\.cjs"\)\.cliMcpConfigPath/);
  assert.equal(mainSource.includes('path.join(dir, "agentlas-cli-mcp.json")'), false);
  console.log(JSON.stringify({ ok: true, checks: 9 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
