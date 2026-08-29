"use strict";
/*
 * core/desktop-core-fetch — 데스크탑 코어를 필요할 때만 내려받는다 (2026-08-06).
 *
 * 배경(오너: "코덱스는 어떻게 했냐"): 코덱스 CLI는 무거운 실행파일을 npm 패키지 안에 미리
 * 담지 않는다 — 설치 시점(postinstall)에 그 사람 플랫폼용 파일만 GitHub Release 에서 내려받는다.
 * 우리도 같은 패턴을 쓴다: 그래프 실행 커널(52MB, engine/vendor/desktop-core.cjs 가 재사용하는
 * 데스크탑 코어)은 git 에 커밋하지 않고, `graph run` 을 실제로 쓸 때만 GitHub Release 자산을
 * 내려받아 로컬 캐시(userDataDir()/desktop-core-cache/<version>/)에 푼다. 다음부턴 캐시를 쓴다.
 *
 * 안전: 무엇을 왜 받는지 사용자에게 **말하고** 받는다(조용히 안 받는다). sha256 체크섬으로
 * 무결성을 확인한 뒤에만 푼다 — 받아온 걸 검증 없이 실행하지 않는다.
 *
 * 매니페스트(engine/vendor/desktop-core.manifest.json, git 커밋 — 이 파일만 작다)가
 * {version, url, sha256, sizeBytes} 를 담는다. 실물(52MB)은 그 url 이 가리키는 곳에서 온다.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { userDataDir } = require("./paths.cjs");

// env 오버라이드는 테스트 전용(게이트가 로컬 서버를 가리키는 가짜 매니페스트로 전 경로를 잠근다).
function manifestPath() { return process.env.AGENTLAS_DESKTOP_CORE_MANIFEST || path.join(__dirname, "..", "vendor", "desktop-core.manifest.json"); }

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), "utf8")); } catch { return null; }
}

function cacheRoot() { return path.join(userDataDir(), "desktop-core-cache"); }
function normalizedCacheVersion(version) {
  const value = String(version ?? "").trim();
  if (!value || value === "." || value === "..") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;
}
function cacheDir(version) {
  const normalized = normalizedCacheVersion(version);
  if (!normalized) throw new TypeError("Desktop core manifest has an unsafe cache version");
  return path.join(cacheRoot(), normalized);
}
function cacheDistDir(version) { return path.join(cacheDir(version), "dist"); }

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** 이미 캐시에 온전히 풀려 있으면 그 dist 경로, 아니면 null. */
function cachedCoreRoot(manifest = readManifest()) {
  const version = normalizedCacheVersion(manifest?.version);
  if (!version || !manifest?.sha256) return null;
  const dist = cacheDistDir(version);
  const marker = path.join(cacheDir(version), ".complete");
  if (!fs.existsSync(path.join(dist, "electron", "workflow", "run-graph.js"))) return null;
  try {
    const completed = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (
      completed?.schemaVersion === 2
      && String(completed.version) === version
      && completed.sha256 === manifest.sha256
    ) return dist;
  } catch {
    // Timestamp-only and malformed markers predate the content-bound cache
    // contract. They must be refreshed instead of trusted as executable code.
  }
  return null;
}

/**
 * Remove only cache entries that are recognizably old engine downloads.
 * Unknown files under the dedicated root are preserved: cleanup must never
 * widen from a versioned engine cache into arbitrary user data.
 */
function pruneStaleCaches(keepVersion) {
  const root = cacheRoot();
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === String(keepVersion) || entry.name.includes(".partial-")) continue;
    const dir = path.join(root, entry.name);
    const recognizable = fs.existsSync(path.join(dir, ".complete"))
      || fs.existsSync(path.join(dir, "desktop-core.tar.gz"))
      || fs.existsSync(path.join(dir, "dist", "electron", "workflow", "run-graph.js"));
    if (!recognizable) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 매니페스트가 가리키는 데스크탑 코어를 내려받아 캐시에 푼다.
 * onNotice(text): 사용자에게 보여줄 안내(무엇을·왜 받는지) — 조용히 받지 않는다.
 * 반환: 성공 시 dist 경로, 실패 시 null(호출부가 정직하게 멈춘다).
 */
async function fetchDesktopCore({ onNotice } = {}) {
  const manifest = readManifest();
  const version = normalizedCacheVersion(manifest?.version);
  if (!manifest || !version || !manifest.url || !manifest.sha256) return null;

  const existing = cachedCoreRoot({ ...manifest, version });
  if (existing) return existing;

  const say = (t) => { if (typeof onNotice === "function") onNotice(t); };
  say(`Downloading the graph-execution engine (${manifest.sizeBytes ? Math.round(manifest.sizeBytes / 1024 / 1024) + " MB" : "one-time"}) from ${manifest.url} …`);

  const dir = cacheDir(version);
  const partialDir = path.join(
    cacheRoot(),
    `${version}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  fs.mkdirSync(partialDir, { recursive: true });
  const tarPath = path.join(partialDir, "desktop-core.tar.gz");

  let res;
  try {
    res = await fetch(manifest.url);
  } catch (error) {
    say(`Download failed: ${error?.message || error}`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }
  if (!res.ok) {
    say(`Download failed: HTTP ${res.status}`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarPath, buf);

  const digest = sha256File(tarPath);
  if (digest !== manifest.sha256) {
    say(`Checksum mismatch (expected ${manifest.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…) — refusing to use it.`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }
  if (Number.isFinite(Number(manifest.sizeBytes)) && Number(manifest.sizeBytes) !== buf.length) {
    say(`Size mismatch (expected ${manifest.sizeBytes} bytes, got ${buf.length}) — refusing to use it.`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }

  const extract = spawnSync("tar", ["-xzf", tarPath, "-C", partialDir], { encoding: "utf8" });
  if (extract.status !== 0) {
    say(`Extraction failed: ${extract.stderr || extract.error || "unknown error"}`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }
  fs.rmSync(tarPath);

  if (!fs.existsSync(path.join(partialDir, "dist", "electron", "workflow", "run-graph.js"))) {
    say("Downloaded archive did not contain the expected engine files.");
    fs.rmSync(partialDir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(partialDir, ".complete"), JSON.stringify({
    schemaVersion: 2,
    version,
    sha256: manifest.sha256,
    completedAt: new Date().toISOString(),
  }) + "\n");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partialDir, dir);
  pruneStaleCaches(version);
  say("Engine ready.");
  return cacheDistDir(version);
}

module.exports = { readManifest, cachedCoreRoot, fetchDesktopCore, cacheDistDir, pruneStaleCaches };
