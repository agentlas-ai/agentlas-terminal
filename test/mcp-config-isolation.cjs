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
  // v1에서는 모놀리스(engine/agentlas.cjs) 소스 스캔으로 검증하던 두 계약이,
  // v2에서는 담당 모듈이 갈라졌다(동의 해소 → engine/mcp/consent.cjs, 턴 인자
  // 생성 → agentlas-native-host.cjs). 동일 계약을 소스 문자열 매칭 대신 실제
  // 동작으로 검증한다 — 단언 내용은 그대로, 검증 강도는 더 높다.
  const consent = require("../engine/mcp/consent.cjs");
  const enabledOnlyDb = {
    prepare: () => ({
      get: () => ({ id: "srv", catalog_id: "srv", name: "srv", name_en: "srv", transport: "stdio", command: "srv-mcp", args_json: "[]", env_keys_json: "[]", enabled: 1 }),
      all: () => [],
    }),
  };
  // 계약 1: ordinary full turn은 정확한 동의 영수증 해소를 거친다 — enabled
  // 레지스트리 행만으로는 아무것도 attach되지 않고, 동의 없는 해소 결과(빈
  // 목록)로 만든 full-turn 인자도 exact-empty MCP 구성이어야 한다.
  const consentResolved = consent.readConsentedSystemMcpServers(enabledOnlyDb, { userDataDir: temp });
  assert.deepEqual(consentResolved, [], "ordinary full turns must resolve exact consent receipts");
  const fullTurnArgs = host.claudeArgs({ prompt: "turn", systemPrompt: "system", permission: "full", session: {}, mcpServers: consentResolved });
  const fullTurnConfig = JSON.parse(fs.readFileSync(fullTurnArgs[fullTurnArgs.indexOf("--mcp-config") + 1], "utf8"));
  assert.deepEqual(fullTurnConfig, { mcpServers: {} }, "a full turn must never fall back to every enabled registry row");
  assert.equal(fullTurnArgs.includes("--allowedTools"), false);
  // 계약 2: 비-full(캡처/배경) 경로는 서버 목록이 주어져도 exact-empty를 유지한다.
  const captureArgs = host.claudeArgs({
    prompt: "capture", systemPrompt: "system", permission: "read", session: {},
    mcpServers: [{ id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: '["--a"]', enabled: 1 }],
  });
  assert.ok(captureArgs.includes("--strict-mcp-config"));
  assert.equal(captureArgs[captureArgs.indexOf("--mcp-config") + 1], '{"mcpServers":{}}', "unstructured capture must remain exact-empty");
  // 계약 3/4: v2 턴 실행 경로 + MCP 모듈 전체에서 레거시 Playwright 시드와
  // 공유 파일명 레이스(agentlas-cli-mcp.json 단일 파일)가 부활하지 않아야 한다.
  const turnPathSources = [
    "../engine/agentlas.cjs",
    "../engine/sessions/session.cjs",
    "../engine/agentlas-native-host.cjs",
    "../engine/mcp/index.cjs",
    "../engine/mcp/contract.cjs",
    "../engine/mcp/inventory.cjs",
    "../engine/mcp/plan.cjs",
    "../engine/mcp/consent.cjs",
    "../engine/mcp/probe.cjs",
  ].map((source) => fs.readFileSync(path.join(__dirname, source), "utf8")).join("\n");
  assert.doesNotMatch(turnPathSources, /mcp__playwright|@playwright\/mcp@latest/);
  assert.equal(turnPathSources.includes('path.join(dir, "agentlas-cli-mcp.json")'), false);
  console.log(JSON.stringify({ ok: true, checks: 30 }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
