#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-env-boundary-"));
const userData = path.join(root, "user-data");
const project = path.join(root, "project");
const agent = path.join(root, "agent");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(agent, { recursive: true });

const originalUserData = process.env.AGENTLAS_USER_DATA_DIR;
const originalProcessProvider = process.env.PROCESS_PROVIDER_TOKEN;
const originalProcessSentinel = process.env.PROCESS_UNRELATED_SECRET;
process.env.AGENTLAS_USER_DATA_DIR = userData;
process.env.PROCESS_PROVIDER_TOKEN = "process-provider-sentinel-value";
process.env.PROCESS_UNRELATED_SECRET = "process-unrelated-sentinel-value";

const host = require("../engine/agentlas-native-host.cjs");
const mcpEnv = require("../engine/agentlas-mcp-env.cjs");
const terminalMcp = require("../engine/mcp/probe.cjs");

const secretValues = [
  "process-provider-sentinel-value",
  "process-unrelated-sentinel-value",
  "global-alpha-sentinel-value",
  "global-unrelated-sentinel-value",
  "project-beta-sentinel-value",
  "project-unrelated-sentinel-value",
  "agent-alpha-sentinel-value",
  "agent-unrelated-sentinel-value",
];
const unrelatedNames = [
  "PROCESS_PROVIDER_TOKEN",
  "PROCESS_UNRELATED_SECRET",
  "GLOBAL_UNRELATED_SECRET",
  "PROJECT_UNRELATED_SECRET",
  "AGENT_UNRELATED_SECRET",
];

// v1의 buildChildEnvCli(모놀리스)가 만들던 "4소스 병합 provider env"를 픽스처로
// 재현한다: 프로세스 env + 전역 credentials.env + 프로젝트 .env + 에이전트 .env.
// v2에는 아직 provider env 빌더가 포팅되지 않았지만, 이 테스트의 계약(MCP 자식
// env 격리가 그 병합본에서 허용 키만 통과시킨다)은 병합 방식과 무관하게 동일하다.
function readDotEnvFixture(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) values[match[1]] = value;
  }
  return values;
}

function runWrappedProbe(descriptor, inheritedEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "../engine/agentlas-mcp-wrapper.cjs"), mcpEnv.encodeLaunchDescriptor(descriptor)], {
      cwd: project,
      env: inheritedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      reject(new Error("wrapped MCP fixture timed out"));
    }, 2_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        }
        if (message.id === 2) child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`wrapped MCP fixture exited ${code}`));
      try {
        assert.match(stdout, /"id":2/);
        assert.equal(stderr, "", "wrapper must not emit inherited environment or descriptor data");
        for (const secret of secretValues) assert.equal(stdout.includes(secret) || stderr.includes(secret), false);
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "env-test", version: "1" } },
    })}\n`);
  });
}

(async () => {
  try {
    fs.writeFileSync(path.join(userData, "credentials.env"), [
      "GLOBAL_ALPHA_TOKEN=global-alpha-sentinel-value",
      "GLOBAL_UNRELATED_SECRET=global-unrelated-sentinel-value",
    ].join("\n") + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(project, ".env"), [
      "PROJECT_BETA_TOKEN=project-beta-sentinel-value",
      "PROJECT_UNRELATED_SECRET=project-unrelated-sentinel-value",
    ].join("\n") + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(agent, ".env"), [
      "AGENT_ALPHA_TOKEN=agent-alpha-sentinel-value",
      "AGENT_UNRELATED_SECRET=agent-unrelated-sentinel-value",
    ].join("\n") + "\n", { mode: 0o600 });
    const mergedProviderEnv = {
      ...process.env,
      ...readDotEnvFixture(path.join(userData, "credentials.env")),
      ...readDotEnvFixture(path.join(project, ".env")),
      ...readDotEnvFixture(path.join(agent, ".env")),
    };
    for (const key of [
      "PROCESS_PROVIDER_TOKEN", "PROCESS_UNRELATED_SECRET", "GLOBAL_ALPHA_TOKEN", "GLOBAL_UNRELATED_SECRET",
      "PROJECT_BETA_TOKEN", "PROJECT_UNRELATED_SECRET", "AGENT_ALPHA_TOKEN", "AGENT_UNRELATED_SECRET",
    ]) assert.ok(mergedProviderEnv[key], `provider fixture must contain ${key} before MCP isolation`);

    const alphaHome = mcpEnv.mcpRuntimeHome(userData, "alpha");
    const betaHome = mcpEnv.mcpRuntimeHome(userData, "beta");
    const alphaKeys = ["GLOBAL_ALPHA_TOKEN", "AGENT_ALPHA_TOKEN"];
    const betaKeys = ["PROJECT_BETA_TOKEN"];
    const alphaEnv = mcpEnv.buildMcpChildEnv(mergedProviderEnv, alphaKeys, { runtimeHome: alphaHome });
    const betaEnv = mcpEnv.buildMcpChildEnv(mergedProviderEnv, betaKeys, { runtimeHome: betaHome });
    assert.deepEqual(alphaKeys.map((key) => alphaEnv[key]), ["global-alpha-sentinel-value", "agent-alpha-sentinel-value"]);
    assert.equal(betaEnv.PROJECT_BETA_TOKEN, "project-beta-sentinel-value");
    for (const key of [...unrelatedNames, "PROJECT_BETA_TOKEN"]) assert.equal(alphaEnv[key], undefined, `alpha must not inherit ${key}`);
    for (const key of [...unrelatedNames, "GLOBAL_ALPHA_TOKEN", "AGENT_ALPHA_TOKEN"]) assert.equal(betaEnv[key], undefined, `beta must not inherit ${key}`);
    assert.equal(alphaEnv.HOME, alphaHome);
    assert.equal(betaEnv.HOME, betaHome);
    assert.notEqual(alphaEnv.HOME, process.env.HOME);
    assert.equal(alphaEnv.TMPDIR, path.join(alphaHome, "tmp"));
    assert.notEqual(alphaEnv.TMPDIR, process.env.TMPDIR);
    assert.equal(alphaEnv.NODE_OPTIONS, undefined);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(alphaHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(betaHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(alphaEnv.TMPDIR).mode & 0o777, 0o700);
      assert.equal(fs.statSync(betaEnv.TMPDIR).mode & 0o777, 0o700);
    }

    const fixtureServer = path.join(__dirname, "fixtures", "mcp-env-fixture-server.cjs");
    const allSecretNames = [
      "PROCESS_PROVIDER_TOKEN", "PROCESS_UNRELATED_SECRET", "GLOBAL_ALPHA_TOKEN", "GLOBAL_UNRELATED_SECRET",
      "PROJECT_BETA_TOKEN", "PROJECT_UNRELATED_SECRET", "AGENT_ALPHA_TOKEN", "AGENT_UNRELATED_SECRET",
    ];
    const alphaForbidden = allSecretNames.filter((name) => !alphaKeys.includes(name));
    const betaForbidden = allSecretNames.filter((name) => !betaKeys.includes(name));
    await Promise.all([
      runWrappedProbe({
        schema: mcpEnv.MCP_LAUNCH_SCHEMA,
        command: process.execPath,
        args: [fixtureServer, "GLOBAL_ALPHA_TOKEN", alphaHome, ...alphaForbidden],
        credentialKeyNames: alphaKeys,
        runtimeHome: alphaHome,
      }, mergedProviderEnv),
      runWrappedProbe({
        schema: mcpEnv.MCP_LAUNCH_SCHEMA,
        command: process.execPath,
        args: [fixtureServer, "PROJECT_BETA_TOKEN", betaHome, ...betaForbidden],
        credentialKeyNames: betaKeys,
        runtimeHome: betaHome,
      }, mergedProviderEnv),
    ]);

    const probeServer = {
      id: "alpha-probe",
      catalog_id: "alpha-probe",
      command: process.execPath,
      args_json: JSON.stringify([fixtureServer, "GLOBAL_ALPHA_TOKEN", alphaHome, ...alphaForbidden]),
    };
    Object.defineProperty(probeServer, "credentialKeyNames", { value: alphaKeys });
    Object.defineProperty(probeServer, "mcpRuntimeHome", { value: alphaHome });
    assert.deepEqual(await terminalMcp.probeSystemMcpServerConnection(probeServer, {
      cwd: project,
      env: mergedProviderEnv,
      userDataDir: userData,
      timeoutMs: 1_000,
    }), { connected: true, reason: "connected" }, "preflight probe must use the same credential allowlist");

    const alphaServer = { id: "alpha", catalog_id: "alpha", name: "alpha", transport: "stdio", command: "alpha-mcp", args_json: "[]", enabled: 1 };
    const betaServer = { id: "beta", catalog_id: "beta", name: "beta", transport: "stdio", command: "beta-mcp", args_json: "[]", enabled: 1 };
    Object.defineProperty(alphaServer, "credentialKeyNames", { value: alphaKeys });
    Object.defineProperty(alphaServer, "mcpRuntimeHome", { value: alphaHome });
    Object.defineProperty(betaServer, "credentialKeyNames", { value: betaKeys });
    Object.defineProperty(betaServer, "mcpRuntimeHome", { value: betaHome });
    const configPath = host.cliMcpConfigPath([alphaServer, betaServer], { exactAllowlist: true, env: mergedProviderEnv }).file;
    const codexArgs = JSON.stringify(host.codexMcpArgs([alphaServer, betaServer], { exactAllowlist: true, env: mergedProviderEnv }));
    const configText = fs.readFileSync(configPath, "utf8");
    if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    for (const secret of secretValues) {
      assert.equal(configText.includes(secret), false, "generated Claude config must contain no secret values");
      assert.equal(codexArgs.includes(secret), false, "generated Codex config must contain no secret values");
    }

    const noSystemSettings = path.join(root, "missing-gemini-system-settings.json");
    const geminiEnv = host.prepareGeminiRuntimeEnv({
      ...mergedProviderEnv,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: noSystemSettings,
    }, { mcpServers: [alphaServer, betaServer], mcpAllowlistMode: "exact" });
    const geminiConfig = fs.readFileSync(geminiEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8");
    if (process.platform !== "win32") assert.equal(fs.statSync(geminiEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH).mode & 0o777, 0o600);
    for (const secret of secretValues) assert.equal(geminiConfig.includes(secret), false, "generated Gemini config must contain no secret values");
    const externalSystemSettings = path.join(root, "organization-gemini-settings.json");
    fs.writeFileSync(externalSystemSettings, "{}\n", { mode: 0o600 });
    assert.equal(host.geminiMcpIsolationReadiness({ ...mergedProviderEnv, GEMINI_CLI_SYSTEM_SETTINGS_PATH: externalSystemSettings }).ready, false);

    assert.throws(() => mcpEnv.normalizeCredentialKeyNames(["NODE_OPTIONS"]), /protected host variable/);
    assert.throws(() => mcpEnv.encodeLaunchDescriptor({
      schema: mcpEnv.MCP_LAUNCH_SCHEMA,
      command: "bad-mcp",
      args: ["--access-token", "credential-value"],
      credentialKeyNames: [],
      runtimeHome: alphaHome,
    }), /credential-like value/);

    console.log(JSON.stringify({ ok: true, checks: 52, servers: 2, credentialSources: 4 }, null, 2));
  } finally {
    if (originalUserData == null) delete process.env.AGENTLAS_USER_DATA_DIR; else process.env.AGENTLAS_USER_DATA_DIR = originalUserData;
    if (originalProcessProvider == null) delete process.env.PROCESS_PROVIDER_TOKEN; else process.env.PROCESS_PROVIDER_TOKEN = originalProcessProvider;
    if (originalProcessSentinel == null) delete process.env.PROCESS_UNRELATED_SECRET; else process.env.PROCESS_UNRELATED_SECRET = originalProcessSentinel;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
