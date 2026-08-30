"use strict";
/*
 * runtimes/detect — 실행 가능한 런타임 탐지.
 * 데스크탑 electron/runtime/detect.ts 와 동일한 어휘(RuntimeKind)를 쓴다:
 *   claude-code | codex | gemini | kimi | grok | cursor | byok | ollama | lmstudio | mlx
 * 여기서는 "실행 파일이 있는가"만 결정론적으로 본다. 모델 응답 여부는 판정하지 않는다
 * (없으면 no_runtime 정직 정지 — 폴백 금지는 상위 계층의 계약).
 */
const fs = require("node:fs");
const path = require("node:path");
// kind 목록/실행 파일 이름의 정본은 runtimes/kinds.cjs 하나다 — 여기서 다시 적지 않는다.
const { RUNTIME_BIN, CLI_KINDS } = require("./kinds.cjs");

const CLI_RUNTIMES = CLI_KINDS;

function whichSync(bin) {
  const name = typeof bin === "string" ? bin.trim() : "";
  if (!name || name.includes("\0") || path.basename(name) !== name) return null;
  const pathValue = String(process.env.PATH || "");
  if (!pathValue) return null;
  const windows = process.platform === "win32";
  const configuredExts = windows
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasWindowsExt = windows && configuredExts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const extensions = hasWindowsExt ? [""] : configuredExts;
  for (const rawDir of pathValue.split(path.delimiter)) {
    const unquoted = rawDir.length >= 2 && rawDir.startsWith('"') && rawDir.endsWith('"')
      ? rawDir.slice(1, -1)
      : rawDir;
    const directory = path.resolve(unquoted || ".");
    for (const ext of extensions) {
      const candidate = path.join(directory, name + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue to the next PATH entry just like a shell command lookup.
      }
    }
  }
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
