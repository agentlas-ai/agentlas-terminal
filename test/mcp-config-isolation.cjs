#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-config-"));
process.env.AGENTLAS_USER_DATA_DIR = temp;
const host = require("../engine/agentlas-native-host.cjs");
const mcpEnv = require("../engine/agentlas-mcp-env.cjs");

try {
  const alpha = host.cliMcpConfigPath([
    { id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 },
  ]);
  const beta = host.cliMcpConfigPath([
    { id: "beta", name: "beta", transport: "stdio", command: "beta-mcp", args_json: '["--b"]', enabled: 1 },
  ]);
  assert.notEqual(alpha.file, beta.file, "different MCP sets must not race on one filename");
  const alphaConfig = JSON.parse(fs.readFileSync(alpha.file, "utf8"));
  const betaConfig = JSON.parse(fs.readFileSync(beta.file, "utf8"));
  assert.equal(alphaConfig.mcpServers.alpha.command, process.execPath, "provider config must launch the Agentlas-owned wrapper");
  assert.equal(betaConfig.mcpServers.beta.command, process.execPath, "every actual MCP must cross the wrapper boundary");
  const alphaLaunch = mcpEnv.decodeLaunchDescriptor(alphaConfig.mcpServers.alpha.args[1]);
  const betaLaunch = mcpEnv.decodeLaunchDescriptor(betaConfig.mcpServers.beta.args[1]);
  assert.equal(alphaLaunch.command, "alpha-mcp");
  assert.deepEqual(alphaLaunch.args, ["--a"]);
  assert.equal(betaLaunch.command, "beta-mcp");
  assert.deepEqual(betaLaunch.args, ["--b"]);
  assert.equal(host.cliMcpConfigPath([{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 }]).file, alpha.file);
  const exactEmpty = host.cliMcpConfigPath([], { exactAllowlist: true });
  const exactAlpha = host.cliMcpConfigPath([
    { id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 },
  ], { exactAllowlist: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(exactEmpty.file, "utf8")), { mcpServers: {} }, "zero Build approval must create an exact empty MCP config");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(exactAlpha.file, "utf8")).mcpServers), ["alpha"], "exact Build config must not seed Playwright");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(alpha.file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(alpha.file).mode & 0o777, 0o600);
  }
  const codex = host.codexMcpArgs([{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 }]);
  assert.ok(codex.some((value) => value.includes("mcp_servers.alpha.command")));
  assert.deepEqual(host.codexMcpArgs([], { exactAllowlist: true }), []);
  const exactCodex = host.codexMcpArgs([{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '[]', enabled: 1 }], { exactAllowlist: true });
  assert.ok(exactCodex.some((value) => value.includes("mcp_servers.alpha.command")));
  assert.equal(exactCodex.some((value) => String(value).includes("mcp_servers.playwright")), false);
  const exactClaudeArgs = host.claudeArgs({
    prompt: "build", systemPrompt: "system", permission: "full", session: {},
    mcpServers: [], mcpAllowlistMode: "exact",
  });
  const exactClaudeConfig = exactClaudeArgs[exactClaudeArgs.indexOf("--mcp-config") + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(exactClaudeConfig, "utf8")), { mcpServers: {} });
  assert.equal(exactClaudeArgs.includes("--allowedTools"), false);
  const exactGemini = host.geminiArgs({ prompt: "build", systemPrompt: "system", permission: "full", mcpServers: [], mcpAllowlistMode: "exact" });
  assert.match(String(exactGemini[exactGemini.indexOf("--allowed-mcp-server-names") + 1]), /^__agentlas_no_mcp_/);
  const mainSource = fs.readFileSync(path.join(__dirname, "../engine/agentlas.cjs"), "utf8");
  assert.match(mainSource, /readConsentedSystemMcpServers/, "ordinary full turns must resolve exact consent receipts");
  assert.match(mainSource, /const mcp = native\.claudeMcpIsolationArgs\(\)/, "unstructured capture must remain exact-empty");
  assert.doesNotMatch(mainSource, /mcp__playwright|@playwright\/mcp@latest/);
  assert.equal(mainSource.includes('path.join(dir, "agentlas-cli-mcp.json")'), false);
  console.log(JSON.stringify({ ok: true, checks: 27 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
