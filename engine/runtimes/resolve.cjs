"use strict";
/*
 * runtimes/resolve — 이번 실행에 쓸 런타임 확정.
 * 사다리: 명시(--runtime) > prefs.runtime(실행 파일 존재 시) > 공유 DB active_runtime >
 *         PATH에서 처음 발견된 CLI.
 * 아무것도 없으면 no_runtime "정직 정지" — 키워드/저품질 폴백 금지(오너 결정).
 */
const { RUNTIME_BIN, whichSync, listAvailableCliRuntimes, activeRuntimeRow } = require("./detect.cjs");

// Session이 실제 드라이버를 갖춘 런타임만 실행 대상으로 삼는다.
// CLI는 native-host, Ollama는 로컬 API loop를 쓴다. 다른 드라이버가 포팅되면
// 해당 집합에 추가한다(조용한 오폭 방지).
const CLI_EXECUTABLE_KINDS = new Set(["claude-code", "codex", "gemini"]);
const API_EXECUTABLE_KINDS = new Set(["ollama"]);
const EXECUTABLE_KINDS = new Set([
  ...CLI_EXECUTABLE_KINDS,
  ...API_EXECUTABLE_KINDS,
]);

function apiRuntime(kind, model, source) {
  if (!API_EXECUTABLE_KINDS.has(kind)) return null;
  return {
    kind,
    backend: kind,
    ...(model ? { model } : {}),
    source,
  };
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
    const api = apiRuntime(explicit, null, "explicit");
    if (api) return api;
    const bin = RUNTIME_BIN[explicit];
    if (!bin) throw new NoRuntimeError(`unknown runtime: ${explicit}`);
    if (!CLI_EXECUTABLE_KINDS.has(explicit)) {
      throw new NoRuntimeError(`runtime '${explicit}' has no v2 streaming driver yet (available: ${[...EXECUTABLE_KINDS].join(", ")})`);
    }
    const p = whichSync(bin);
    if (!p) throw new NoRuntimeError(`runtime '${explicit}' requested but '${bin}' is not on PATH`);
    return { kind: explicit, bin: p, source: "explicit" };
  }
  const pref = prefs && prefs.runtime;
  if (pref && API_EXECUTABLE_KINDS.has(pref)) {
    return apiRuntime(pref, null, "prefs");
  }
  if (pref && CLI_EXECUTABLE_KINDS.has(pref)) {
    const p = whichSync(RUNTIME_BIN[pref]);
    if (p) return { kind: pref, bin: p, source: "prefs" };
  }
  if (db) {
    const active = activeRuntimeRow(db);
    if (active && API_EXECUTABLE_KINDS.has(active.kind)) {
      return apiRuntime(active.kind, active.model || undefined, "active");
    }
    if (active && CLI_EXECUTABLE_KINDS.has(active.kind)) {
      const p = whichSync(RUNTIME_BIN[active.kind]);
      if (p) return { kind: active.kind, bin: p, model: active.model || undefined, source: "active" };
    }
  }
  const found = listAvailableCliRuntimes().filter((r) => CLI_EXECUTABLE_KINDS.has(r.kind));
  if (found.length) return { kind: found[0].kind, bin: found[0].path, source: "detected" };
  // 신규 사용자의 최빈 막다른 길: "설치하라"만 있고 방법이 없으면 여기서 이탈한다.
  // 실제 설치 명령을 그대로 준다(데스크탑 온보딩의 "Claude Code 무료로 설치하기"와 동형).
  throw new NoRuntimeError([
    "no_runtime: no agent CLI is connected — Agentlas runs your agents on a CLI you already subscribe to.",
    "",
    "Install one, then rerun:",
    "  npm i -g @anthropic-ai/claude-code    # Claude Code",
    "  npm i -g @openai/codex                # Codex CLI",
    "  npm i -g @google/gemini-cli           # Gemini CLI",
    "",
    "Already installed? Make sure its binary is on PATH (agentlas doctor shows what was detected).",
  ].join("\n"));
}

module.exports = {
  resolveRuntime,
  NoRuntimeError,
  EXECUTABLE_KINDS,
  CLI_EXECUTABLE_KINDS,
  API_EXECUTABLE_KINDS,
};
