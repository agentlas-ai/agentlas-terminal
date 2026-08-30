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

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_RUN_GRAPH_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_LIST_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_ENTRY_BYTES = 4 * 1024;
const MAX_LOCK_RECORD_BYTES = 16 * 1024;
const LOCK_WAIT_MS = 120_000;
const LOCK_RETRY_MS = 50;
const UNKNOWN_LOCK_STALE_MS = 5 * 60_000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const versionQueues = new Map();

function sameFileIdentity(left, right) {
  return !!left && !!right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink;
}

function readFdBounded(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const want = Math.min(8192, maxBytes - total + 1);
    const buffer = Buffer.allocUnsafe(want);
    const count = fs.readSync(fd, buffer, 0, want, null);
    if (!count) break;
    total += count;
    if (total > maxBytes) return null;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function readBoundedRegularFile(filePath, maxBytes) {
  let fd = null;
  try {
    const before = fs.lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maxBytes) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes || !sameFileIdentity(before, opened)) return null;
    const contents = readFdBounded(fd, maxBytes);
    const after = fs.fstatSync(fd);
    if (
      contents === null || !after.isFile() || after.nlink !== 1 || !sameFileIdentity(opened, after) ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      after.size !== contents.length
    ) return null;
    return contents;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function ensureRealDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(String(directory || ""));
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe desktop-core directory: ${resolved}`);
  return { path: resolved, stat, realpath: fs.realpathSync.native(resolved) };
}

function safeRemoveVersionDir(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(directory);
  else fs.rmSync(directory, { recursive: true, force: true });
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

// env 오버라이드는 테스트 전용(게이트가 로컬 서버를 가리키는 가짜 매니페스트로 전 경로를 잠근다).
function manifestPath() { return process.env.AGENTLAS_DESKTOP_CORE_MANIFEST || path.join(__dirname, "..", "vendor", "desktop-core.manifest.json"); }

function readManifest() {
  try {
    const raw = readBoundedRegularFile(manifestPath(), MAX_MANIFEST_BYTES);
    return raw === null ? null : JSON.parse(raw.toString("utf8"));
  } catch { return null; }
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

function normalizedCacheManifest(manifest) {
  const version = normalizedCacheVersion(manifest?.version);
  const sha256 = typeof manifest?.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
  if (!version || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { version, sha256 };
}

function normalizedManifest(manifest) {
  const cacheManifest = normalizedCacheManifest(manifest);
  if (!cacheManifest) return null;
  if (typeof manifest.url !== "string" || Buffer.byteLength(manifest.url, "utf8") > 2048) return null;
  let url;
  try { url = new URL(manifest.url); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  let sizeBytes = null;
  if (manifest.sizeBytes !== undefined && manifest.sizeBytes !== null) {
    const candidate = Number(manifest.sizeBytes);
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_ARCHIVE_BYTES) return null;
    sizeBytes = candidate;
  }
  return { ...cacheManifest, url: url.toString(), sizeBytes };
}

function cacheRootInfo({ create = false } = {}) {
  const dataRoot = ensureRealDirectory(userDataDir(), { create });
  const root = ensureRealDirectory(cacheRoot(), { create });
  if (path.dirname(root.realpath) !== dataRoot.realpath) throw new Error("Refusing to use a redirected desktop-core cache directory.");
  return root;
}

function isLivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockRecord(lockPath) {
  const raw = readBoundedRegularFile(lockPath, MAX_LOCK_RECORD_BYTES);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw.toString("utf8"));
    if (!record || typeof record !== "object" || typeof record.token !== "string" || !record.token
      || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
    return record;
  } catch {
    return null;
  }
}

function removeLockIfOwned(lockPath, token) {
  try {
    const before = fs.lstatSync(lockPath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return false;
    const record = readLockRecord(lockPath);
    if (!record || record.token !== token) return false;
    const current = fs.lstatSync(lockPath);
    if (!sameFileIdentity(before, current)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function removeUnknownLockIfUnchanged(lockPath, expected) {
  try {
    const current = fs.lstatSync(lockPath);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameFileIdentity(expected, current)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function waitForLock() {
  return new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
}

async function acquireFileVersionLock(version) {
  const rootInfo = cacheRootInfo({ create: true });
  const lockPath = path.join(rootInfo.path, `${version}.lock`);
  const token = crypto.randomUUID();
  const payload = Buffer.from(JSON.stringify({ token, pid: process.pid, claimedAt: new Date().toISOString() }) + "\n", "utf8");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    let fd = null;
    let created = false;
    try {
      const currentRoot = fs.lstatSync(rootInfo.path);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootInfo.stat.dev || currentRoot.ino !== rootInfo.stat.ino) {
        throw new Error("Desktop-core cache directory changed while locking.");
      }
      fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
      created = true;
      const createdStat = fs.fstatSync(fd);
      if (!createdStat.isFile() || createdStat.nlink !== 1) throw new Error("Unsafe desktop-core cache lock.");
      writeAll(fd, payload);
      fs.fsyncSync(fd);
      const writtenStat = fs.fstatSync(fd);
      if (!sameFileIdentity(createdStat, writtenStat) || writtenStat.size !== payload.length) throw new Error("Desktop-core cache lock changed while claiming.");
      fs.closeSync(fd);
      fd = null;
      return { path: lockPath, token };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* preserve original */ }
      }
      if (created) removeLockIfOwned(lockPath, token);
      if (error?.code !== "EEXIST") throw error;
    }

    let stat;
    try { stat = fs.lstatSync(lockPath); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe desktop-core cache lock.");
    const record = readLockRecord(lockPath);
    if (record && isLivePid(record.pid)) {
      if (Date.now() >= deadline) throw Object.assign(new Error("Another process is downloading this desktop core."), { code: "desktop_core_lock_busy" });
      await waitForLock();
      continue;
    }
    if (!record && Date.now() - stat.mtimeMs < UNKNOWN_LOCK_STALE_MS) {
      if (Date.now() >= deadline) throw Object.assign(new Error("The desktop-core cache lock is unreadable."), { code: "desktop_core_lock_busy" });
      await waitForLock();
      continue;
    }
    if (record) removeLockIfOwned(lockPath, record.token);
    else removeUnknownLockIfUnchanged(lockPath, stat);
    if (Date.now() >= deadline) throw Object.assign(new Error("Could not claim the desktop-core cache lock."), { code: "desktop_core_lock_busy" });
  }
}

function releaseFileVersionLock(lock) {
  if (lock) removeLockIfOwned(lock.path, lock.token);
}

async function withVersionLock(version, work) {
  const previous = versionQueues.get(version) || Promise.resolve();
  let finishTurn;
  const turn = new Promise((resolve) => { finishTurn = resolve; });
  versionQueues.set(version, turn);
  let lock = null;
  try {
    await previous;
    lock = await acquireFileVersionLock(version);
    return await work();
  } finally {
    releaseFileVersionLock(lock);
    finishTurn();
    if (versionQueues.get(version) === turn) versionQueues.delete(version);
  }
}

/** 이미 캐시에 온전히 풀려 있으면 그 dist 경로, 아니면 null. */
function cachedCoreRoot(manifest = readManifest()) {
  const normalized = normalizedCacheManifest(manifest);
  if (!normalized) return null;
  const { version, sha256 } = normalized;
  const dist = cacheDistDir(version);
  const marker = path.join(cacheDir(version), ".complete");
  try {
    cacheRootInfo();
    ensureRealDirectory(cacheDir(version));
    ensureRealDirectory(dist);
    ensureRealDirectory(path.join(dist, "electron"));
    ensureRealDirectory(path.join(dist, "electron", "workflow"));
    const runGraph = path.join(dist, "electron", "workflow", "run-graph.js");
    if (readBoundedRegularFile(runGraph, MAX_RUN_GRAPH_BYTES) === null) return null;
    const markerRaw = readBoundedRegularFile(marker, MAX_MARKER_BYTES);
    if (markerRaw === null) return null;
    const completed = JSON.parse(markerRaw.toString("utf8"));
    if (
      completed?.schemaVersion === 2
      && String(completed.version) === version
      && typeof completed.sha256 === "string"
      && completed.sha256.toLowerCase() === sha256
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
  let root;
  try { root = cacheRootInfo().path; } catch { return 0; }
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === String(keepVersion) || entry.name.includes(".partial-")) continue;
    const dir = path.join(root, entry.name);
    const activeLock = readLockRecord(path.join(root, `${entry.name}.lock`));
    if (activeLock && isLivePid(activeLock.pid)) continue;
    const recognizable = readBoundedRegularFile(path.join(dir, ".complete"), MAX_MARKER_BYTES) !== null
      || readBoundedRegularFile(path.join(dir, "desktop-core.tar.gz"), MAX_ARCHIVE_BYTES) !== null
      || readBoundedRegularFile(path.join(dir, "dist", "electron", "workflow", "run-graph.js"), MAX_RUN_GRAPH_BYTES) !== null;
    if (!recognizable) continue;
    safeRemoveVersionDir(dir);
    removed += 1;
  }
  return removed;
}

async function downloadArchive(response, tarPath, expectedSize) {
  const maxBytes = MAX_ARCHIVE_BYTES;
  const maxStoredBytes = expectedSize === null ? maxBytes : Math.min(maxBytes, expectedSize + 1);
  const hash = crypto.createHash("sha256");
  let fd = null;
  let readBytes = 0;
  let storedBytes = 0;
  let hardOverflow = false;
  let sizeOverflow = false;
  const writeChunk = (chunk) => {
    if (!chunk || !chunk.length) return true;
    if (readBytes + chunk.length > maxBytes) {
      const keep = Math.max(0, maxBytes - readBytes);
      if (keep) hash.update(chunk.subarray(0, keep));
      readBytes = maxBytes;
      hardOverflow = true;
      return false;
    }
    hash.update(chunk);
    readBytes += chunk.length;
    if (expectedSize !== null && readBytes > expectedSize) sizeOverflow = true;
    if (storedBytes < maxStoredBytes) {
      const keep = chunk.subarray(0, Math.min(chunk.length, maxStoredBytes - storedBytes));
      if (keep.length) {
        writeAll(fd, keep);
        storedBytes += keep.length;
      }
    }
    return true;
  };

  try {
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      hardOverflow = true;
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
    } else {
      fd = fs.openSync(tarPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("Download response is not streamable.");
      }
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!writeChunk(Buffer.from(next.value))) {
          try { await reader.cancel(); } catch { /* best effort */ }
          break;
        }
      }
    }
    if (fd === null) {
      fd = fs.openSync(tarPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (expectedSize !== null && readBytes !== expectedSize) sizeOverflow = true;
    return { size: readBytes, storedSize: storedBytes, digest: hash.digest("hex"), hardOverflow, sizeOverflow };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* preserve original */ }
    }
  }
}

function writeCompleteMarker(directory, marker) {
  const markerPath = path.join(directory, ".complete");
  try {
    fs.lstatSync(markerPath);
    throw new Error("Unsafe desktop-core completion marker already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const payload = Buffer.from(JSON.stringify(marker) + "\n", "utf8");
  if (payload.length > MAX_MARKER_BYTES) throw new Error("Desktop-core completion marker is too large.");
  let fd = null;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    const created = fs.fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1) throw new Error("Unsafe desktop-core completion marker.");
    writeAll(fd, payload);
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (!sameFileIdentity(created, written) || written.size !== payload.length) throw new Error("Desktop-core completion marker changed while writing.");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* preserve original */ }
    }
  }
}

function archiveList(tarPath, verbose = false) {
  const listed = spawnSync("tar", [verbose ? "-tvzf" : "-tzf", tarPath], {
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    timeout: 30_000,
  });
  if (listed.status !== 0 || listed.error || !Buffer.isBuffer(listed.stdout)) return null;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(listed.stdout); } catch { return null; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.length > 0 && lines.length <= MAX_ARCHIVE_ENTRIES ? lines : null;
}

function validateArchiveEntries(tarPath) {
  const names = archiveList(tarPath, false);
  const verbose = archiveList(tarPath, true);
  if (!names || !verbose || names.length !== verbose.length) return false;
  for (let index = 0; index < names.length; index += 1) {
    const raw = names[index];
    if (
      Buffer.byteLength(raw, "utf8") > MAX_ARCHIVE_ENTRY_BYTES ||
      /[\\\u0000-\u001f\u007f]/.test(raw) || path.isAbsolute(raw) ||
      !["-", "d"].includes(verbose[index][0])
    ) return false;
    const name = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const segments = name.split("/");
    if (!name || segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
    if (!["dist", "node_modules", "VENDORED.json"].includes(segments[0])) return false;
    if (segments[0] === "VENDORED.json" && segments.length !== 1) return false;
  }
  return true;
}

/**
 * 매니페스트가 가리키는 데스크탑 코어를 내려받아 캐시에 푼다.
 * onNotice(text): 사용자에게 보여줄 안내(무엇을·왜 받는지) — 조용히 받지 않는다.
 * 반환: 성공 시 dist 경로, 실패 시 null(호출부가 정직하게 멈춘다).
 */
async function fetchDesktopCore({ onNotice } = {}) {
  const manifest = readManifest();
  const say = (t) => { if (typeof onNotice === "function") onNotice(t); };
  const normalized = normalizedManifest(manifest);
  if (!normalized) return null;
  const { version, sha256, url, sizeBytes } = normalized;
  try {
    return await withVersionLock(version, async () => {
      const existing = cachedCoreRoot({ ...manifest, ...normalized });
      if (existing) return existing;

      say(`Downloading the graph-execution engine (${sizeBytes ? Math.round(sizeBytes / 1024 / 1024) + " MB" : "one-time"}) from ${url} …`);
      const rootInfo = cacheRootInfo({ create: true });
      const dir = cacheDir(version);
      const partialDir = path.join(
        rootInfo.path,
        `${version}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
      );
      fs.mkdirSync(partialDir, { recursive: false, mode: 0o700 });
      let keepPartial = true;
      const tarPath = path.join(partialDir, "desktop-core.tar.gz");
      try {
        let res;
        try {
          res = await fetch(url);
        } catch (error) {
          say(`Download failed: ${error?.message || error}`);
          return null;
        }
        if (!res.ok) {
          say(`Download failed: HTTP ${res.status}`);
          return null;
        }
        const downloaded = await downloadArchive(res, tarPath, sizeBytes);
        if (downloaded.digest !== sha256) {
          say(`Checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${downloaded.digest.slice(0, 12)}…) — refusing to use it.`);
          return null;
        }
        if (downloaded.hardOverflow || downloaded.sizeOverflow || (sizeBytes !== null && downloaded.size !== sizeBytes)) {
          say(`Size mismatch (expected ${sizeBytes ?? MAX_ARCHIVE_BYTES} bytes, got ${downloaded.size}${downloaded.hardOverflow ? "+" : ""}) — refusing to use it.`);
          return null;
        }
        if (!validateArchiveEntries(tarPath)) {
          say("Downloaded archive contains unsafe or unexpected files.");
          return null;
        }

        const extract = spawnSync("tar", ["-xzf", tarPath, "-C", partialDir, "--no-same-owner", "--no-same-permissions"], { encoding: "utf8" });
        if (extract.status !== 0) {
          say(`Extraction failed: ${extract.stderr || extract.error || "unknown error"}`);
          return null;
        }
        fs.unlinkSync(tarPath);

        const extractedDist = path.join(partialDir, "dist");
        const workflowDir = path.join(extractedDist, "electron", "workflow");
        ensureRealDirectory(partialDir);
        ensureRealDirectory(extractedDist);
        ensureRealDirectory(path.join(extractedDist, "electron"));
        ensureRealDirectory(workflowDir);
        if (readBoundedRegularFile(path.join(workflowDir, "run-graph.js"), MAX_RUN_GRAPH_BYTES) === null) {
          say("Downloaded archive did not contain safe expected engine files.");
          return null;
        }
        writeCompleteMarker(partialDir, {
          schemaVersion: 2,
          version,
          sha256,
          completedAt: new Date().toISOString(),
        });
        cacheRootInfo();
        safeRemoveVersionDir(dir);
        fs.renameSync(partialDir, dir);
        keepPartial = false;
        const ready = cachedCoreRoot({ ...manifest, ...normalized });
        if (!ready) {
          safeRemoveVersionDir(dir);
          say("Downloaded archive failed cache safety validation.");
          return null;
        }
        pruneStaleCaches(version);
        say("Engine ready.");
        return ready;
      } finally {
        if (keepPartial) {
          try { safeRemoveVersionDir(partialDir); } catch { /* preserve the original result */ }
        }
      }
    });
  } catch (error) {
    say(`Desktop-core cache unavailable: ${error?.message || error}`);
    return null;
  }
}

module.exports = { readManifest, cachedCoreRoot, fetchDesktopCore, cacheDistDir, pruneStaleCaches };
