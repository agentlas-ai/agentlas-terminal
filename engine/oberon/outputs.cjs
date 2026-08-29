"use strict";
/*
 * oberon/outputs — 렌더 산출물 조회/열기.
 * v1 §12494-12540 (oberonList / oberonOpen) 충실 포팅.
 * 산출물 홈은 <userData>/oberon/ — Desktop Oberon 렌더 잡과 같은 위치를 공유한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { userDataDir } = require("../core/paths.cjs");
const { fail } = require("./common.cjs");

function oberonHome() {
  return path.join(userDataDir(), "oberon");
}

// `oberon list` — 최근 렌더 산출물 15개 (mtime 내림차순).
function list(io) {
  const dir = oberonHome();
  if (!fs.existsSync(dir)) {
    io.out("No render outputs yet. Start with agentlas oberon scaffold my.json.");
    return 0;
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      const files = (() => {
        try {
          return fs.readdirSync(full);
        } catch {
          return [];
        }
      })();
      return { name: d.name, full, mtime, files };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 15);
  if (!entries.length) {
    io.out("No render outputs yet.");
    return 0;
  }
  io.out(`Recent Oberon renders (${dir}):\n`);
  for (const e of entries) {
    // master/titled 최종본만 요약에 노출 (중간 클립·로그 숨김) — v1 필터 그대로.
    const masters = e.files.filter((f) => /master|titled/.test(f) && /\.(mp4|mov)$/.test(f));
    const when = e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ") : "";
    io.out(`  ${when}  ${e.name}`);
    if (masters.length) io.out(`            ${masters.join(", ")}`);
  }
  io.out(`\nOpen the folder with: agentlas oberon open`);
  return 0;
}

// `oberon open [path]` — 산출물 폴더를 OS 파일 매니저로 연다.
function open(io, args, options = {}) {
  const target = args[0] ? path.resolve(args[0]) : oberonHome();
  if (!fs.existsSync(target)) fail(`Path not found: ${target}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  // `spawn(...).unref()` reported success before the OS opener had even spawned;
  // a missing xdg-open/explorer then emitted an unhandled error and crashed the CLI
  // after printing "Opening". The opener command is short-lived, so wait for its
  // launch result and only claim success on exit 0.
  const launch = options.spawnSyncImpl || spawnSync;
  const result = launch(opener, [target], { stdio: "ignore", windowsHide: true });
  if (result && result.error) fail(`Could not open ${target}: ${result.error.message}`);
  if (!result || result.status !== 0) fail(`Could not open ${target} (opener exit ${result && result.status != null ? result.status : "unknown"})`);
  io.out(`Opening folder: ${target}`);
  return 0;
}

module.exports = { list, open, oberonHome };
