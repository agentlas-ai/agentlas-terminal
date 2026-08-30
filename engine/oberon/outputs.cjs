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

const MAX_RENDER_DIRECTORIES = 4096;
const MAX_FILES_PER_RENDER = 4096;

function terminalSafe(value, maxLength = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, maxLength);
}

function readDirectoryBounded(dir, maxEntries, label) {
  const handle = fs.opendirSync(dir);
  const entries = [];
  try {
    while (entries.length <= maxEntries) {
      const entry = handle.readSync();
      if (!entry) return entries;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  fail(`${label} contains more than ${maxEntries} entries; narrow or clean the output directory first`);
}

function oberonHome() {
  return path.join(userDataDir(), "oberon");
}

// `oberon list` — 최근 렌더 산출물 15개 (mtime 내림차순).
function list(io) {
  const dir = oberonHome();
  let homeStat;
  try { homeStat = fs.lstatSync(dir); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    io.out("No render outputs yet. Start with agentlas oberon scaffold my.json.");
    return 0;
  }
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) fail(`Oberon output home must be a regular directory, not a symbolic link: ${terminalSafe(dir)}`);
  const entries = readDirectoryBounded(dir, MAX_RENDER_DIRECTORIES, "Oberon output home")
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      let mtime = 0;
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        mtime = stat.mtimeMs;
      } catch {}
      return { name: d.name, full, mtime };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 15)
    .map((entry) => {
      let files = [];
      try {
        files = readDirectoryBounded(entry.full, MAX_FILES_PER_RENDER, `Oberon render ${terminalSafe(entry.name)}`).map((file) => file.name);
      } catch (error) {
        if (error && error.oberonFail) throw error;
      }
      return { ...entry, files };
    });
  if (!entries.length) {
    io.out("No render outputs yet.");
    return 0;
  }
  io.out(`Recent Oberon renders (${terminalSafe(dir, 4096)}):\n`);
  for (const e of entries) {
    // master/titled 최종본만 요약에 노출 (중간 클립·로그 숨김) — v1 필터 그대로.
    const masters = e.files.filter((f) => /master|titled/.test(f) && /\.(mp4|mov)$/.test(f));
    const when = e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ") : "";
    io.out(`  ${when}  ${terminalSafe(e.name)}`);
    if (masters.length) io.out(`            ${masters.map((name) => terminalSafe(name)).join(", ")}`);
  }
  io.out(`\nOpen the folder with: agentlas oberon open`);
  return 0;
}

// `oberon open [path]` — 산출물 폴더를 OS 파일 매니저로 연다.
function open(io, args, options = {}) {
  if (args.length > 1) fail("Oberon open accepts at most one path");
  const target = args[0] ? path.resolve(args[0]) : oberonHome();
  if (!fs.existsSync(target)) fail(`Path not found: ${target}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  // `spawn(...).unref()` reported success before the OS opener had even spawned;
  // a missing xdg-open/explorer then emitted an unhandled error and crashed the CLI
  // after printing "Opening". The opener command is short-lived, so wait for its
  // launch result and only claim success on exit 0.
  const launch = options.spawnSyncImpl || spawnSync;
  const result = launch(opener, [target], { stdio: "ignore", windowsHide: true });
  if (result && result.error) fail(`Could not open ${terminalSafe(target, 4096)}: ${terminalSafe(result.error.message)}`);
  if (!result || result.status !== 0) fail(`Could not open ${terminalSafe(target, 4096)} (opener exit ${result && result.status != null ? result.status : "unknown"})`);
  io.out(`Opening folder: ${terminalSafe(target, 4096)}`);
  return 0;
}

module.exports = { list, open, oberonHome };
