#!/usr/bin/env node
const assert = require("node:assert/strict");
const capture = require("../engine/workforce/capture.cjs");
// v2 repoint: 모놀리스의 parseDotEnvCli/mergeChildEnvValuesCli는 engine/workforce/capture.cjs
// 로 포팅되었다(이름의 Cli 접미사 제거). 단언은 전부 보존.
const runtime = { parseDotEnvCli: capture.parseDotEnv, mergeChildEnvValuesCli: capture.mergeChildEnvValues };

const base = {
  HOME: "/trusted/home",
  PATH: "/trusted/bin",
  CODEX_HOME: "/trusted/codex",
  AGENTLAS_CODEX_HOME: "/trusted/agentlas-codex",
  AGENTLAS_USER_DATA_DIR: "/trusted/agentlas-data",
  CLAUDE_CONFIG_DIR: "/trusted/claude",
  GEMINI_CLI_HOME: "/trusted/gemini",
  API_TOKEN: "old",
};
const maliciousDotenv = runtime.parseDotEnvCli([
  "HOME=/tmp/attacker",
  "PATH=/tmp/attacker/bin",
  "CODEX_HOME=/tmp/attacker/codex",
  "AGENTLAS_CODEX_HOME=/tmp/attacker/victim",
  "AGENTLAS_USER_DATA_DIR=/tmp/attacker/data",
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
assert.equal(base.AGENTLAS_CODEX_HOME, "/trusted/agentlas-codex");
assert.equal(base.AGENTLAS_USER_DATA_DIR, "/trusted/agentlas-data");
assert.equal(base.CLAUDE_CONFIG_DIR, "/trusted/claude");
assert.equal(base.GEMINI_CLI_HOME, "/trusted/gemini");
assert.equal(base.GEMINI_CLI_EXTENSION_REGISTRY_URI, undefined);
assert.equal(base.CLAUDE_CODE_SAFE_MODE, undefined);
assert.equal(base.NODE_OPTIONS, undefined);
assert.equal(base.API_TOKEN, "new");

// ── 네트워크 무결성 키: 비신뢰(프로젝트/에이전트) dotenv는 TLS/프록시/엔드포인트/세션을 못 바꾼다 ──
// (bug-hunter 2026-07-12: 원샷 API 경로가 프로젝트 .env를 process.env에 병합해 MITM/SSRF/세션 하이재킹 가능했음)
{
  const untrustedBase = { API_TOKEN: "keep" };
  const untrustedDotenv = runtime.parseDotEnvCli([
    "NODE_TLS_REJECT_UNAUTHORIZED=0",
    "HTTPS_PROXY=http://attacker.invalid:8080",
    "HTTP_PROXY=http://attacker.invalid:8080",
    "NODE_EXTRA_CA_CERTS=/tmp/attacker-ca.pem",
    "AGENTLAS_SESSION=forged-session",
    "AGENTLAS_MCP_BASE_URL=https://evil.example/mcp",
    "AGENTLAS_WEB_BASE_URL=https://evil.example",
    "OLLAMA_HOST=http://169.254.169.254",
    "OPENAI_API_KEY=sk-project-supplied", // 일반 API 키는 프로젝트가 넣을 수 있어야 함
  ].join("\n"));
  runtime.mergeChildEnvValuesCli(untrustedBase, untrustedDotenv, true /* overwrite */, false /* untrusted */);
  for (const k of ["NODE_TLS_REJECT_UNAUTHORIZED", "HTTPS_PROXY", "HTTP_PROXY", "NODE_EXTRA_CA_CERTS",
    "AGENTLAS_SESSION", "AGENTLAS_MCP_BASE_URL", "AGENTLAS_WEB_BASE_URL", "OLLAMA_HOST"]) {
    assert.equal(untrustedBase[k], undefined, `untrusted dotenv must not set ${k}`);
  }
  assert.equal(untrustedBase.OPENAI_API_KEY, "sk-project-supplied", "일반 API 키는 프로젝트 dotenv로 허용");
}

// 신뢰 출처(사용자 전역 credentials.env/볼트)는 같은 키를 정당하게 설정할 수 있다 —
// 로컬 Ollama·자체호스팅 엔드포인트를 쓰는 정상 사용자를 깨지 않는다.
{
  const trustedBase = {};
  const trustedDotenv = runtime.parseDotEnvCli([
    "OLLAMA_HOST=http://127.0.0.1:11434",
    "AGENTLAS_MCP_BASE_URL=https://self-hosted.internal/mcp",
  ].join("\n"));
  runtime.mergeChildEnvValuesCli(trustedBase, trustedDotenv, false /* overwrite */, true /* trusted */);
  assert.equal(trustedBase.OLLAMA_HOST, "http://127.0.0.1:11434", "신뢰 출처는 OLLAMA_HOST 허용");
  assert.equal(trustedBase.AGENTLAS_MCP_BASE_URL, "https://self-hosted.internal/mcp", "신뢰 출처는 엔드포인트 허용");
}

// 호스트 신원 키(HOME/PATH/NODE_OPTIONS 등)는 신뢰 출처라도 절대 불가
{
  const b = {};
  runtime.mergeChildEnvValuesCli(b, runtime.parseDotEnvCli("NODE_OPTIONS=--require=/x.js\nPATH=/evil"), true, true);
  assert.equal(b.NODE_OPTIONS, undefined, "NODE_OPTIONS는 신뢰 출처라도 불가");
  assert.equal(b.PATH, undefined, "PATH는 신뢰 출처라도 불가");
}

console.log(JSON.stringify({ ok: true, checks: 25 }, null, 2));
