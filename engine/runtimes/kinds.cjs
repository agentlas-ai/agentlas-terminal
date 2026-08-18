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
