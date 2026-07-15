#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  claudeArgs,
  codexArgs,
  geminiArgs,
  prepareCodexRuntimeEnv,
} = require("../engine/agentlas-native-host.cjs");
const permissions = require("../engine/agentlas-permissions.cjs");
const {
  buildArgs: legacyBuildArgs,
  codexCaptureAgentText,
} = require("../engine/agentlas.cjs");

const mcpServers = [{
  id: "playwright",
  catalog_id: "playwright",
  name: "playwright",
  transport: "stdio",
  command: "playwright-mcp",
  args_json: "[]",
  enabled: 1,
}];

function hasPair(args, flag, value) {
  return args.some((item, index) => item === flag && args[index + 1] === value);
}

function includesExternalMcp(args) {
  if (args.some((arg) => String(arg).includes("mcp_servers"))) return true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--mcp-config") continue;
    const value = String(args[index + 1] || "");
    try {
      const parsed = JSON.parse(value);
      if (Object.keys(parsed.mcpServers || {}).length > 0) return true;
    } catch {
      return true; // a generated config file is the explicit full-access inventory
    }
  }
  return false;
}

function common(level) {
  return {
    prompt: "test",
    systemPrompt: "system",
    permission: level,
    session: {},
    cwd: process.cwd(),
    mcpServers,
  };
}

function testClaude() {
  const read = claudeArgs(common("read"));
  const write = claudeArgs(common("write"));
  const full = claudeArgs(common("full"));
  assert.ok(hasPair(read, "--permission-mode", "plan"));
  assert.ok(hasPair(write, "--permission-mode", "acceptEdits"));
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.ok(!write.includes("--dangerously-skip-permissions"), "write must never launch Claude unrestricted");
  for (const args of [read, write]) {
    assert.ok(args.includes("--strict-mcp-config"), "Claude read/write must ignore user/project MCP configuration");
    assert.equal(includesExternalMcp(args), false, "Claude read/write must receive an explicit empty MCP inventory");
  }
  assert.ok(full.includes("--strict-mcp-config"), "Claude full must use only the Agentlas-provided MCP inventory");
  assert.equal(includesExternalMcp(full), true);
}

function testCodex() {
  const read = codexArgs(common("read"));
  const write = codexArgs(common("write"));
  const full = codexArgs(common("full"));
  assert.ok(hasPair(read, "--sandbox", "read-only"));
  assert.ok(hasPair(write, "--sandbox", "workspace-write"));
  assert.ok(full.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!write.includes("--dangerously-bypass-approvals-and-sandbox"), "write must stay sandboxed");
  assert.equal(includesExternalMcp(read), false);
  assert.equal(includesExternalMcp(write), false, "write must not auto-inject Playwright or another external MCP");
  assert.equal(includesExternalMcp(full), true);
}

function testGemini() {
  const read = geminiArgs(common("read"));
  const write = geminiArgs(common("write"));
  const full = geminiArgs(common("full"));
  assert.ok(hasPair(read, "--approval-mode", "plan"));
  assert.ok(hasPair(write, "--approval-mode", "auto_edit"));
  assert.ok(hasPair(full, "--approval-mode", "yolo"));
  assert.equal(write.includes("--yolo"), false);
  for (const args of [read, write]) {
    const index = args.indexOf("--allowed-mcp-server-names");
    assert.ok(index >= 0 && /^__agentlas_no_mcp_[0-9a-f-]+__$/.test(String(args[index + 1])), "Gemini read/write must use an exclusive empty MCP allow-list");
  }
  const fullAllowlist = full.indexOf("--allowed-mcp-server-names");
  assert.ok(fullAllowlist >= 0, "Gemini full must use the same host-owned exact server-name boundary");
  assert.equal(full[fullAllowlist + 1], "playwright", "Gemini full must not inherit arbitrary user/global MCP definitions");
}

function testCodexIsolatedHome() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-home-"));
  const source = path.join(fixture, "source");
  const data = path.join(fixture, "agentlas-data");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "auth.json"), '{"token":"fixture"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(source, "config.toml"), '[mcp_servers.victim]\nurl="https://victim.invalid"\n', "utf8");
  try {
    const isolated = prepareCodexRuntimeEnv({ CODEX_HOME: source, AGENTLAS_USER_DATA_DIR: data });
    assert.notEqual(isolated.CODEX_HOME, source);
    assert.equal(fs.readFileSync(path.join(isolated.CODEX_HOME, "auth.json"), "utf8"), '{"token":"fixture"}\n');
    assert.doesNotMatch(fs.readFileSync(path.join(isolated.CODEX_HOME, "config.toml"), "utf8"), /mcp_servers/);
    assert.match(fs.readFileSync(path.join(source, "config.toml"), "utf8"), /victim/);
    assert.throws(
      () => prepareCodexRuntimeEnv({ CODEX_HOME: source, AGENTLAS_USER_DATA_DIR: data, AGENTLAS_CODEX_HOME: source }),
      /must be isolated/,
    );
    assert.match(fs.readFileSync(path.join(source, "config.toml"), "utf8"), /victim/, "isolation failure overwrote the user's Codex config");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function testFailClosedAndCopy() {
  assert.equal(permissions.normalize("corrupt-value"), "read");
  const invalidCodex = codexArgs(common("corrupt-value"));
  assert.ok(hasPair(invalidCodex, "--sandbox", "read-only"));
  assert.equal(permissions.copy("write", "en").label, "workspace write");
  assert.match(permissions.copy("full", "ko").description, /승인과 샌드박스를 우회/);
  assert.deepEqual(permissions.LEVELS, ["read", "write", "full"]);
}

function testShiftTabFullConfirmation() {
  let clock = 1_000;
  const cycle = permissions.createCycleController({ now: () => clock, armMs: 5_000 });
  assert.deepEqual(cycle.step("read"), { level: "write", armed: false, enteredFull: false });
  assert.deepEqual(cycle.step("write"), { level: "write", armed: true, enteredFull: false });
  assert.equal(cycle.armed(), true);
  cycle.cancel();
  assert.equal(cycle.armed(), false, "any non-Shift-Tab key must disarm full escalation");
  assert.deepEqual(cycle.step("write"), { level: "write", armed: true, enteredFull: false });
  assert.deepEqual(cycle.step("write"), { level: "full", armed: false, enteredFull: true });
  assert.deepEqual(cycle.step("full"), { level: "read", armed: false, enteredFull: false });
  cycle.step("write");
  clock += 5_001;
  assert.deepEqual(cycle.step("write"), { level: "write", armed: true, enteredFull: false }, "expired arm must require a fresh double press");
}

function testBackgroundAndSwarmCapturePath() {
  for (const kind of ["claude-code", "codex", "gemini"]) {
    const read = legacyBuildArgs(kind, "system", "prompt", "read");
    const write = legacyBuildArgs(kind, "system", "prompt", "write");
    const full = legacyBuildArgs(kind, "system", "prompt", "full");
    assert.equal(includesExternalMcp(read), false, `${kind} read capture must not inject MCP`);
    assert.equal(includesExternalMcp(write), false, `${kind} write capture must not inject MCP`);
    assert.equal(includesExternalMcp(full), false, `${kind} full capture must not seed an unapproved Playwright server`);
  }

  const claudeWrite = legacyBuildArgs("claude-code", "system", "prompt", "write");
  const claudeFull = legacyBuildArgs("claude-code", "system", "prompt", "full");
  assert.ok(hasPair(claudeWrite, "--permission-mode", "acceptEdits"));
  assert.ok(claudeFull.includes("--dangerously-skip-permissions"));

  const codexWrite = legacyBuildArgs("codex", "system", "prompt", "write");
  const codexFull = legacyBuildArgs("codex", "system", "prompt", "full");
  assert.ok(hasPair(codexWrite, "--sandbox", "workspace-write"));
  assert.ok(!codexWrite.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(codexFull.includes("--dangerously-bypass-approvals-and-sandbox"));

  const geminiWrite = legacyBuildArgs("gemini", "system", "prompt", "write");
  const geminiFull = legacyBuildArgs("gemini", "system", "prompt", "full");
  assert.ok(hasPair(geminiWrite, "--approval-mode", "auto_edit"));
  assert.ok(hasPair(geminiFull, "--approval-mode", "yolo"));
  assert.equal(geminiWrite.includes("--yolo"), false);

  const invalid = legacyBuildArgs("codex", "system", "prompt", "corrupt-value");
  assert.ok(hasPair(invalid, "--sandbox", "read-only"), "capture path must also fail closed");
}

function testWorkforceNoAuthorityCapturePath() {
  const claude = legacyBuildArgs("claude-code", "system", "prompt", "full", {
    authorityMode: "no-authority",
  });
  assert.ok(hasPair(claude, "--permission-mode", "plan"));
  assert.ok(hasPair(claude, "--tools", ""), "Claude workforce isolation must expose an exact empty built-in tool set");
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.equal(claude.includes("--dangerously-skip-permissions"), false);

  const codex = legacyBuildArgs("codex", "system", "prompt", "full", {
    model: "gpt-5.6-terra",
    authorityMode: "no-authority",
  });
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--json"]) {
    assert.ok(codex.includes(flag), `Codex workforce isolation is missing ${flag}`);
  }
  for (const capability of [
    "shell_tool", "unified_exec", "apps", "browser_use", "computer_use",
    "image_generation", "workspace_dependencies", "goals", "memories",
    "plugins", "hooks", "multi_agent", "tool_suggest",
  ]) {
    assert.ok(hasPair(codex, "--disable", capability), `Codex workforce isolation is missing --disable ${capability}`);
  }
  assert.ok(hasPair(codex, "--sandbox", "read-only"));
  assert.equal(codex.includes("--dangerously-bypass-approvals-and-sandbox"), false);

  const captured = codexCaptureAgentText([
    JSON.stringify({ type: "thread.started", thread_id: "thread:fixture" }),
    JSON.stringify({ type: "item.updated", item: { id: "item:1", type: "agent_message", text: "partial" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item:1", type: "agent_message", text: '{"schemaVersion":"fixture.v1"}' } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n"));
  assert.equal(captured, '{"schemaVersion":"fixture.v1"}', "no-authority Codex JSONL must yield only the final agent message to the workforce parser");
}

testClaude();
testCodex();
testGemini();
testCodexIsolatedHome();
testFailClosedAndCopy();
testShiftTabFullConfirmation();
testBackgroundAndSwarmCapturePath();
testWorkforceNoAuthorityCapturePath();
console.log("permission-mapping: PASS");
