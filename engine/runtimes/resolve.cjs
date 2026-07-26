"use strict";
/*
 * runtimes/resolve — 이번 실행에 쓸 런타임 확정.
 * 사다리: 명시(--runtime) > prefs.runtime(실행 파일 존재 시) > 공유 DB active_runtime >
 *         PATH에서 처음 발견된 CLI.
 * 아무것도 없으면 no_runtime "정직 정지" — 키워드/저품질 폴백 금지(오너 결정).
 */
const { RUNTIME_BIN, whichSync, listAvailableCliRuntimes, activeRuntimeRow } = require("./detect.cjs");

// native-host가 스트리밍 드라이버를 갖춘 런타임만 실행 대상으로 삼는다.
// kimi/grok/cursor 드라이버가 포팅되면 여기에 추가한다 (조용한 오폭 방지).
const EXECUTABLE_KINDS = new Set(["claude-code", "codex", "gemini"]);

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
    const bin = RUNTIME_BIN[explicit];
    if (!bin) throw new NoRuntimeError(`unknown runtime: ${explicit}`);
    if (!EXECUTABLE_KINDS.has(explicit)) {
      throw new NoRuntimeError(`runtime '${explicit}' has no v2 streaming driver yet (available: ${[...EXECUTABLE_KINDS].join(", ")})`);
    }
    const p = whichSync(bin);
    if (!p) throw new NoRuntimeError(`runtime '${explicit}' requested but '${bin}' is not on PATH`);
    return { kind: explicit, bin: p, source: "explicit" };
  }
  const pref = prefs && prefs.runtime;
  if (pref && EXECUTABLE_KINDS.has(pref)) {
    const p = whichSync(RUNTIME_BIN[pref]);
    if (p) return { kind: pref, bin: p, source: "prefs" };
  }
  if (db) {
    const active = activeRuntimeRow(db);
    if (active && EXECUTABLE_KINDS.has(active.kind)) {
      const p = whichSync(RUNTIME_BIN[active.kind]);
      if (p) return { kind: active.kind, bin: p, model: active.model || undefined, source: "active" };
    }
  }
  const found = listAvailableCliRuntimes().filter((r) => EXECUTABLE_KINDS.has(r.kind));
  if (found.length) return { kind: found[0].kind, bin: found[0].path, source: "detected" };
  throw new NoRuntimeError(
    "no_runtime: no agent CLI found (claude / codex / gemini / kimi / grok / cursor-agent). Install one and retry.",
  );
}

module.exports = { resolveRuntime, NoRuntimeError, EXECUTABLE_KINDS };
