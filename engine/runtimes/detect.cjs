"use strict";
/*
 * runtimes/detect — 실행 가능한 런타임 탐지.
 * 데스크탑 electron/runtime/detect.ts 와 동일한 어휘(RuntimeKind)를 쓴다:
 *   claude-code | codex | gemini | kimi | grok | cursor | byok | ollama | lmstudio | mlx
 * 여기서는 "실행 파일이 있는가"만 결정론적으로 본다. 모델 응답 여부는 판정하지 않는다
 * (없으면 no_runtime 정직 정지 — 폴백 금지는 상위 계층의 계약).
 */
const { spawnSync } = require("node:child_process");
// kind 목록/실행 파일 이름의 정본은 runtimes/kinds.cjs 하나다 — 여기서 다시 적지 않는다.
const { RUNTIME_BIN, CLI_KINDS } = require("./kinds.cjs");

const CLI_RUNTIMES = CLI_KINDS;

function whichSync(bin) {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(cmd, [bin], { encoding: "utf8", timeout: 4000 });
    if (res.status === 0) {
      const line = String(res.stdout || "").split(/\r?\n/).find((l) => l.trim());
      return line ? line.trim() : null;
    }
  } catch { /* not found */ }
  return null;
}

/** PATH에서 찾은 CLI 런타임 목록: [{kind, bin, path}] */
function listAvailableCliRuntimes() {
  const found = [];
  for (const kind of CLI_RUNTIMES) {
    const bin = RUNTIME_BIN[kind];
    const p = whichSync(bin);
    if (p) found.push({ kind, bin, path: p });
  }
  return found;
}

/** 공유 DB의 active_runtime 행(데스크탑이 마지막으로 확정한 런타임). 없으면 null. */
function activeRuntimeRow(db) {
  try {
    return db.prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id=1").get() || null;
  } catch {
    return null;
  }
}

module.exports = { RUNTIME_BIN, CLI_RUNTIMES, whichSync, listAvailableCliRuntimes, activeRuntimeRow };
