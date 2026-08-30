"use strict";
/*
 * runtimes/resolve — 이번 실행에 쓸 런타임 확정.
 * 사다리: 명시(--runtime) > prefs.runtime(실행 파일 존재 시) > 공유 DB active_runtime >
 *         PATH에서 처음 발견된 CLI.
 * 아무것도 없으면 no_runtime "정직 정지" — 키워드/저품질 폴백 금지(오너 결정).
 */
const { RUNTIME_BIN, whichSync, listAvailableCliRuntimes, activeRuntimeRow } = require("./detect.cjs");
const KINDS = require("./kinds.cjs");
const path = require("node:path");

// Session이 실제 드라이버를 갖춘 런타임만 실행 대상으로 삼는다.
// CLI는 native-host, Ollama는 로컬 API loop를 쓴다. 다른 드라이버가 포팅되면
// 해당 집합에 추가한다(조용한 오폭 방지).
//
// kimi/grok/cursor 는 ACP 드라이버(runtimes/acp-driver.cjs → 벤더 코어의 공용 ACP 러너)로 돈다
// (PRD 2026-08-15 T-2). 벤더 코어가 그 러너를 갖고 있을 때만 실행 대상에 든다 — 옛 코어면
// 종전과 같은 "드라이버 없음" 정직 거부.
// 집합의 원소는 정본(runtimes/kinds.cjs)에서 파생한다 — 여기서 다시 적지 않는다.
const NATIVE_CLI_KINDS = new Set(KINDS.NATIVE_CLI_KINDS);
const ACP_CLI_KINDS = new Set(KINDS.ACP_CLI_KINDS);
const API_EXECUTABLE_KINDS = new Set(KINDS.API_EXECUTABLE_KINDS);

function acpKindsAvailable() {
  try {
    const { acpDriverAvailability } = require("./acp-driver.cjs");
    return acpDriverAvailability().ok ? ACP_CLI_KINDS : new Set();
  } catch {
    return new Set();
  }
}

// 라이브 집합: 네이티브 4종 + (코어가 ACP 러너를 갖고 있으면) ACP 3종.
const CLI_EXECUTABLE_KINDS = new Proxy(NATIVE_CLI_KINDS, {
  get(target, prop) {
    const live = new Set([...target, ...acpKindsAvailable()]);
    const value = live[prop];
    return typeof value === "function" ? value.bind(live) : value;
  },
});
const EXECUTABLE_KINDS = new Proxy(NATIVE_CLI_KINDS, {
  get(target, prop) {
    const live = new Set([...target, ...acpKindsAvailable(), ...API_EXECUTABLE_KINDS]);
    const value = live[prop];
    return typeof value === "function" ? value.bind(live) : value;
  },
});

function apiRuntime(kind, model, source) {
  if (!API_EXECUTABLE_KINDS.has(kind)) return null;
  return {
    kind,
    backend: kind,
    ...(model ? { model } : {}),
    source,
  };
}

function sharedRuntimeKind(row) {
  if (!row) return null;
  // Desktop historically stored Antigravity as kind=gemini with the actual
  // selected executable in source. Preserve the selected product surface;
  // never discard `agy` and silently fall through to Gemini or another CLI.
  const selectedBin = path.posix.basename(path.win32.basename(String(row.source || ""))).toLowerCase();
  if (row.kind === "gemini" && /^agy(?:\.exe|\.cmd)?$/i.test(selectedBin)) return "agy";
  return KINDS.canonicalRuntimeKind(row.kind);
}

class NoRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.code = "no_runtime";
  }
}

/**
 * @returns {{kind, bin, model?, source}} source ∈ explicit|prefs|active|detected
 * @throws NoRuntimeError
 */
function resolveRuntime({ db, prefs, explicit }) {
  if (explicit) {
    const explicitKind = KINDS.canonicalRuntimeKind(explicit);
    const api = apiRuntime(explicitKind, null, "explicit");
    if (api) return api;
    const bin = RUNTIME_BIN[explicitKind];
    if (!bin) throw new NoRuntimeError(`unknown runtime: ${explicit}`);
    if (!CLI_EXECUTABLE_KINDS.has(explicitKind)) {
      const acpHint = ACP_CLI_KINDS.has(explicitKind)
        ? ` — its ACP driver needs the desktop core with electron/runtime/acp.js (npm run vendor:core / agentlas doctor)`
        : "";
      throw new NoRuntimeError(`runtime '${explicit}' has no v2 streaming driver yet (available: ${[...EXECUTABLE_KINDS].join(", ")})${acpHint}`);
    }
    const p = whichSync(bin);
    if (!p) throw new NoRuntimeError(`runtime '${explicit}' requested but '${bin}' is not on PATH`);
    return { kind: explicitKind, bin: p, source: "explicit" };
  }
  const pref = KINDS.canonicalRuntimeKind(prefs && prefs.runtime);
  if (pref && API_EXECUTABLE_KINDS.has(pref)) {
    return apiRuntime(pref, null, "prefs");
  }
  if (pref && CLI_EXECUTABLE_KINDS.has(pref)) {
    const p = whichSync(RUNTIME_BIN[pref]);
    if (p) return { kind: pref, bin: p, source: "prefs" };
  }
  if (db) {
    const active = activeRuntimeRow(db);
    const activeKind = sharedRuntimeKind(active);
    if (active && API_EXECUTABLE_KINDS.has(activeKind)) {
      return apiRuntime(activeKind, active.model || undefined, "active");
    }
    if (active && CLI_EXECUTABLE_KINDS.has(activeKind)) {
      const p = whichSync(RUNTIME_BIN[activeKind]);
      if (p) return {
        kind: activeKind,
        bin: p,
        model: active.model || undefined,
        source: "active",
        runtimeSource: active.source || undefined,
      };
    }
  }
  const found = listAvailableCliRuntimes().filter((r) => CLI_EXECUTABLE_KINDS.has(r.kind));
  if (found.length) return { kind: found[0].kind, bin: found[0].path, source: "detected" };
  // 신규 사용자의 최빈 막다른 길: "설치하라"만 있고 방법이 없으면 여기서 이탈한다.
  // 실제 설치 명령을 그대로 준다(데스크탑 온보딩의 "Claude Code 무료로 설치하기"와 동형).
  throw new NoRuntimeError([
    "no_runtime: no agent CLI is connected — Agentlas runs your agents on a CLI you already subscribe to.",
    "",
    "Connect or install one, then rerun:",
    "  agy                                      # Antigravity CLI (preferred)",
    "  npm i -g @anthropic-ai/claude-code    # Claude Code",
    "  npm i -g @openai/codex                # Codex CLI",
    "  npm i -g @google/gemini-cli           # Gemini CLI (legacy)",
    "",
    "Already installed? Make sure its binary is on PATH (agentlas doctor shows what was detected).",
  ].join("\n"));
}

module.exports = {
  resolveRuntime,
  NoRuntimeError,
  EXECUTABLE_KINDS,
  CLI_EXECUTABLE_KINDS,
  NATIVE_CLI_KINDS,
  ACP_CLI_KINDS,
  API_EXECUTABLE_KINDS,
  sharedRuntimeKind,
};
