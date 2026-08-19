"use strict";
/*
 * runtimes/kinds — 런타임 종류(RuntimeKind)의 단일 정본 (2026-08-18).
 *
 * 배경: 같은 어휘가 8곳(detect·capture·resolve·acp-driver·capabilities·onboard·
 * palette·input)에 손 목록으로 흩어져 있었다 — 새 kind 를 추가하면 한두 곳이
 * 반드시 빠진다. 여기 한 벌만 두고, 다른 표면은 이 상수를 **가져다 쓴다**.
 * 좁은 목록(캡처 4종 등)도 정본에서 파생해야 새 kind 가 모든 표면에 보인다.
 *
 * 순서가 곧 계약이다:
 *  - detect.listAvailableCliRuntimes 는 이 순서로 PATH 를 훑고, resolve 의
 *    "detected" 폴백은 그 첫 항목을 쓴다.
 *  - 온보딩 위저드 선택지·팔레트/입력 완성 후보도 이 순서로 표시된다.
 */

const RUNTIME_KIND_SPECS = [
  { kind: "claude-code", bin: "claude", driver: "native", capture: true },
  { kind: "codex", bin: "codex", driver: "native", capture: true },
  // Antigravity CLI — gemini 후속. 공식 gemini CLI가 계정 티어로 죽어도(IneligibleTierError,
  // 실측 2026-08-06) 이쪽은 산다. 데스크탑 gemini 러너의 agy 경로와 같은 실물.
  { kind: "agy", bin: "agy", driver: "native", capture: true },
  { kind: "gemini", bin: "gemini", driver: "native", capture: true },
  // kimi/grok/cursor 는 ACP 드라이버(runtimes/acp-driver.cjs → 벤더 코어의 공용
  // ACP 러너)로 돈다 (PRD 2026-08-15 T-2). 캡처(buildArgs/텍스트 추출) 계약은 없다.
  { kind: "kimi", bin: "kimi", driver: "acp" },
  { kind: "grok", bin: "grok", driver: "acp" },
  { kind: "cursor", bin: "cursor-agent", driver: "acp" },
];

/** kind → 실행 파일 이름. CLI 런타임 전체(네이티브 + ACP). */
const RUNTIME_BIN = Object.fromEntries(RUNTIME_KIND_SPECS.map((s) => [s.kind, s.bin]));

/**
 * 데스크탑이 **같은 DB 에 적어 둔 이름** → 이 저장소의 이름.
 *
 * ★터미널과 데스크탑은 하나의 SQLite 를 공유하는데 같은 런타임을 다르게 부른다:
 *   데스크탑 `shared/runtime-kinds.ts` 는 `antigravity`, 여기는 `agy` 다. 그 차이는
 *   주석에만 적혀 있었고 **읽는 자리에서 번역되지 않았다**.
 *
 *   결과(실측 2026-08-19): 사용자가 오케스트레이터를 Antigravity 로 골라 두면
 *   `model_roles.kind = "antigravity"` 가 저장되는데, 터미널의 실행 가능 집합에는
 *   그 이름이 없어 **"이 컴퓨터에서 실행 불가"로 걸러지고** 풀 3순위(codex)가 대신 돌았다.
 *   `agentlas roles` 는 antigravity 라고 보여 주면서 그래프 빌더는 codex 로 지었다 —
 *   고른 대로 안 도는데 화면은 고른 대로 보였다.
 *
 *   저장된 이름은 못 바꾼다(데스크탑이 계속 그렇게 쓴다). 그러니 **읽는 쪽이 번역한다**.
 */
const STORED_KIND_ALIASES = { antigravity: "agy" };

/** 저장소에서 읽은 kind 를 이 저장소의 정본 이름으로. 모르는 값은 그대로 돌려준다. */
function canonicalRuntimeKind(kind) {
  const text = typeof kind === "string" ? kind.trim() : "";
  if (!text) return text;
  return STORED_KIND_ALIASES[text] ?? text;
}

/** 역방향 — 공유 DB 에 적을 이름. 어긋남은 **양쪽으로** 난다:
 *  `agentlas roles set orchestrator agy` 가 `agy` 를 그대로 적으면, 이번에는
 *  데스크탑이 그 이름을 모른다(shared/runtime-kinds.ts 에 `agy` 가 없다).
 *  저장 어휘는 스키마 주인인 데스크탑 쪽으로 통일하고, 읽을 때 위에서 되돌린다. */
const CANONICAL_TO_STORED = Object.fromEntries(
  Object.entries(STORED_KIND_ALIASES).map(([stored, canonical]) => [canonical, stored]),
);
function storedRuntimeKind(kind) {
  const text = typeof kind === "string" ? kind.trim() : "";
  if (!text) return text;
  return CANONICAL_TO_STORED[text] ?? text;
}

/** CLI 런타임 kind 전체(탐지 순서). */
const CLI_KINDS = RUNTIME_KIND_SPECS.map((s) => s.kind);

/** native-host 드라이버(스폰 러너)를 갖춘 CLI 4종. */
const NATIVE_CLI_KINDS = RUNTIME_KIND_SPECS.filter((s) => s.driver === "native").map((s) => s.kind);

/** 벤더 코어의 공용 ACP 러너로 도는 3종. */
const ACP_CLI_KINDS = RUNTIME_KIND_SPECS.filter((s) => s.driver === "acp").map((s) => s.kind);

/** 캡처(no-authority headless) 드라이버가 검증된 kind — buildArgs/텍스트 추출 계약 보유. */
const CAPTURE_CLI_KINDS = RUNTIME_KIND_SPECS.filter((s) => s.capture).map((s) => s.kind);

/** kind → bin, 캡처 검증본만. workforce/capture 가 쓴다. */
const CAPTURE_RUNTIME_BIN = Object.fromEntries(
  RUNTIME_KIND_SPECS.filter((s) => s.capture).map((s) => [s.kind, s.bin]),
);

/** CLI 가 아니라 로컬 API loop 로 실행되는 kind. */
const API_EXECUTABLE_KINDS = ["ollama"];

/** BYOK/API 백엔드 spec 문자열(/runtime 완성 후보의 API 절반). */
const API_BACKEND_SPECS = ["anthropic", "openai", "google", "ollama", "upstage"];

/** /runtime 이 받는 spec 전체: 네이티브 CLI kind + API 백엔드. */
const RUNTIME_SPECS = [...NATIVE_CLI_KINDS, ...API_BACKEND_SPECS];

/**
 * 저장 계약(automation 등)이 허용하는 kind 전체 — CLI + 로컬/BYOK 실행 kind.
 * 데스크탑 shared/runtime-kinds.ts 와 동형(터미널 표기: antigravity→agy, acp 미지원).
 */
const CONTRACT_RUNTIME_KINDS = [...CLI_KINDS, "byok", "ollama", "lmstudio", "mlx"];

/** 저장 계약이 허용하는 LLM 백엔드 — 데스크탑 shared/runtime-backends.ts 와 동일 15종. */
const CONTRACT_RUNTIME_BACKENDS = [
  "anthropic", "openai", "google", "ollama", "lmstudio", "mlx", "upstage", "custom", "glm",
  "kimi", "deepseek", "minimax", "xai", "openrouter", "cursor",
];

module.exports = {
  RUNTIME_KIND_SPECS,
  RUNTIME_BIN,
  STORED_KIND_ALIASES,
  canonicalRuntimeKind,
  storedRuntimeKind,
  CLI_KINDS,
  NATIVE_CLI_KINDS,
  ACP_CLI_KINDS,
  CAPTURE_CLI_KINDS,
  CAPTURE_RUNTIME_BIN,
  API_EXECUTABLE_KINDS,
  API_BACKEND_SPECS,
  RUNTIME_SPECS,
  CONTRACT_RUNTIME_KINDS,
  CONTRACT_RUNTIME_BACKENDS,
};
