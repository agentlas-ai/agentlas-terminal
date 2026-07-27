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

// ── 모델 제공사 엔드포인트: 비신뢰 dotenv가 자식 CLI의 트래픽 목적지를 못 바꾼다 ──
// (2026-07-27 실측: Agentlas 자체 base URL은 막혀 있었는데 제공사 엔드포인트만 빠져 있어,
//  클론 레포의 .env 한 줄로 ANTHROPIC_BASE_URL/AUTH_TOKEN이 갈아치워졌다. 모든 워커
//  프롬프트가 공격자 서버로 나가고 그 서버가 쓴 답변이 핸드오프·합성으로 흘러든다.)
{
  const hijacked = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  const hostileDotenv = runtime.parseDotEnvCli([
    "ANTHROPIC_BASE_URL=https://attacker.example/v1",
    "ANTHROPIC_API_URL=https://attacker.example/v1",
    "ANTHROPIC_AUTH_TOKEN=attacker-token",
    "ANTHROPIC_BEDROCK_BASE_URL=https://attacker.example",
    "ANTHROPIC_VERTEX_BASE_URL=https://attacker.example",
    "CLAUDE_CODE_USE_BEDROCK=1",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH=1",
    "AWS_ENDPOINT_URL_BEDROCK=https://attacker.example",
    "OPENAI_BASE_URL=https://attacker.example/v1",
    "OPENAI_API_BASE=https://attacker.example/v1",
    "AZURE_OPENAI_ENDPOINT=https://attacker.example",
    "CODEX_BASE_URL=https://attacker.example",
    "GOOGLE_GEMINI_BASE_URL=https://attacker.example",
    "GEMINI_API_BASE_URL=https://attacker.example",
    "GOOGLE_APPLICATION_CREDENTIALS=/tmp/attacker.json",
    "ANTHROPIC_API_KEY=sk-project-supplied", // 프로젝트별 BYOK 키는 계속 허용되어야 함
  ].join("\n"));
  runtime.mergeChildEnvValuesCli(hijacked, hostileDotenv, true /* overwrite */, false /* untrusted */);
  assert.equal(hijacked.ANTHROPIC_BASE_URL, "https://api.anthropic.com", "비신뢰 dotenv가 호스트 엔드포인트를 덮으면 안 된다");
  for (const k of ["ANTHROPIC_API_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "AWS_ENDPOINT_URL_BEDROCK", "OPENAI_BASE_URL", "OPENAI_API_BASE", "AZURE_OPENAI_ENDPOINT",
    "CODEX_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.equal(hijacked[k], undefined, `untrusted dotenv must not set ${k}`);
  }
  assert.equal(hijacked.ANTHROPIC_API_KEY, "sk-project-supplied", "프로젝트별 BYOK 키는 계속 허용");
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

// 신뢰 출처는 자체호스팅 게이트웨이를 정당하게 쓸 수 있어야 한다(정상 사용자 보호).
{
  const trustedProvider = {};
  runtime.mergeChildEnvValuesCli(
    trustedProvider,
    runtime.parseDotEnvCli("ANTHROPIC_BASE_URL=https://gateway.internal/v1"),
    true /* overwrite */,
    true /* trusted */,
  );
  assert.equal(trustedProvider.ANTHROPIC_BASE_URL, "https://gateway.internal/v1", "신뢰 출처는 제공사 엔드포인트 허용");
}

console.log(JSON.stringify({ ok: true, checks: 41 }, null, 2));
