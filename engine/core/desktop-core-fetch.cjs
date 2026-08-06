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

function cacheDir(version) { return path.join(userDataDir(), "desktop-core-cache", String(version)); }
function cacheDistDir(version) { return path.join(cacheDir(version), "dist"); }

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** 이미 캐시에 온전히 풀려 있으면 그 dist 경로, 아니면 null. */
function cachedCoreRoot(manifest = readManifest()) {
  if (!manifest) return null;
  const dist = cacheDistDir(manifest.version);
  const marker = path.join(cacheDir(manifest.version), ".complete");
  if (fs.existsSync(marker) && fs.existsSync(path.join(dist, "electron", "workflow", "run-graph.js"))) return dist;
  return null;
}

/**
 * 매니페스트가 가리키는 데스크탑 코어를 내려받아 캐시에 푼다.
 * onNotice(text): 사용자에게 보여줄 안내(무엇을·왜 받는지) — 조용히 받지 않는다.
 * 반환: 성공 시 dist 경로, 실패 시 null(호출부가 정직하게 멈춘다).
 */
async function fetchDesktopCore({ onNotice } = {}) {
  const manifest = readManifest();
  if (!manifest || !manifest.url || !manifest.sha256) return null;

  const existing = cachedCoreRoot(manifest);
  if (existing) return existing;

  const say = (t) => { if (typeof onNotice === "function") onNotice(t); };
  say(`Downloading the graph-execution engine (${manifest.sizeBytes ? Math.round(manifest.sizeBytes / 1024 / 1024) + " MB" : "one-time"}) from ${manifest.url} …`);

  const dir = cacheDir(manifest.version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tarPath = path.join(dir, "desktop-core.tar.gz");

  const res = await fetch(manifest.url);
  if (!res.ok) { say(`Download failed: HTTP ${res.status}`); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarPath, buf);

  const digest = sha256File(tarPath);
  if (digest !== manifest.sha256) {
    say(`Checksum mismatch (expected ${manifest.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…) — refusing to use it.`);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  const extract = spawnSync("tar", ["-xzf", tarPath, "-C", dir], { encoding: "utf8" });
  if (extract.status !== 0) {
    say(`Extraction failed: ${extract.stderr || extract.error || "unknown error"}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  fs.rmSync(tarPath);

  if (!fs.existsSync(path.join(cacheDistDir(manifest.version), "electron", "workflow", "run-graph.js"))) {
    say("Downloaded archive did not contain the expected engine files.");
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(dir, ".complete"), new Date().toISOString());
  say("Engine ready.");
  return cacheDistDir(manifest.version);
}

module.exports = { readManifest, cachedCoreRoot, fetchDesktopCore, cacheDistDir };
