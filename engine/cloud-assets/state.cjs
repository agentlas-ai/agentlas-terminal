"use strict";
/*
 * cloud-assets/state — Agent Cloud 자산 리비전의 로컬 관측 상태.
 *
 * 두 저장소를 관리한다 (v1 monolith의 asset-state 계열 충실 이식):
 *  1. <userData>/cloud-asset-state.v1.json — 이 머신이 "관측한" 각 자산의
 *     마지막 리비전 디스크립터 + 소스 루트 목록 + 삭제 톰스톤(deletedBases).
 *  2. <sourceRoot>/.agentlas-cloud-package.json — 소스 폴더 마커. scope별
 *     디스크립터(cloudAssets)를 담아 다음 save의 CAS 베이스가 된다.
 *
 * 계약(약화 금지):
 *  - 관측한 베이스 리비전 없이는 어떤 덮어쓰기도 시도하지 않는다. 이 파일이
 *    깨졌으면 조용히 새로 만들지 않고 정직하게 실패한다 (조용한 기본값 금지).
 *  - 삭제 톰스톤: delete가 커밋된 (rootPath, slug, scope, cloudId, revision)은
 *    다시 베이스로 채택되지 않는다 — delete→재저장은 반드시 새 생성(If-None-Match)이다.
 *  - 상태 파일 쓰기는 O_EXCL temp → fsync → rename → dir fsync (크래시 원자성).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataDir } = require("../core/paths.cjs");
const {
  CLOUD_ASSET_SCOPES,
  CLOUD_PACKAGE_HASH_V1,
  CLOUD_RESTORE_MARKER_PATH,
  cloudSlug,
  cloudFsyncDirectory,
  normalizeCloudAssetDescriptor,
} = require("../hub/install.cjs");

const CLOUD_ASSET_STATE_FILE = "cloud-asset-state.v1.json";
const CLOUD_ASSET_STATE_MAX_BYTES = 1024 * 1024;
const CLOUD_ASSET_LOCK_STALE_MS = 30_000;
const CLOUD_ASSET_LOCK_WAIT_MS = 10_000;

function waitSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

const STATE_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function stateSameDirectoryIdentity(left, right) {
  return Boolean(
    left && right && left.isDirectory() && right.isDirectory() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function stateDirectoryAnchor(target, label, { allowMissing = false, containedBy = null } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a safe managed directory`);
  }
  let realpath;
  try { realpath = fs.realpathSync.native(target); }
  catch (error) { throw new Error(`${label} could not be canonicalized: ${error.message || error}`); }
  if (containedBy && !(
    realpath === containedBy.realpath || realpath.startsWith(`${containedBy.realpath}${path.sep}`)
  )) {
    throw new Error(`${label} escapes its managed root`);
  }
  return { path: target, realpath, dev: stat.dev, ino: stat.ino, stat };
}

function stateAssertDirectoryAnchor(anchor, label, containedBy = null) {
  const current = stateDirectoryAnchor(anchor.path, label, { allowMissing: false, containedBy });
  if (
    !stateSameDirectoryIdentity(anchor.stat || anchor, current.stat || current) ||
    current.realpath !== anchor.realpath
  ) {
    throw new Error(`${label} changed while it was being used`);
  }
  return current;
}

function stateEnsureDirectory(target, label) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const anchor = stateDirectoryAnchor(target, label);
  try { fs.chmodSync(target, 0o700); } catch { /* Windows/best-effort */ }
  stateAssertDirectoryAnchor(anchor, label);
  return anchor;
}

function stateSameFileIdentity(left, right) {
  return Boolean(
    left && right && left.isFile() && right.isFile() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function stateSameFileSnapshot(left, right) {
  return stateSameFileIdentity(left, right) && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function stateFileSnapshot(file, label, { allowMissing = false, maxBytes = CLOUD_ASSET_STATE_MAX_BYTES, allowHardLinks = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowHardLinks && stat.nlink !== 1) || stat.size > maxBytes) {
    throw new Error(`${label} is not a bounded private file`);
  }
  return stat;
}

function stateRemoveOwnedFile(file, expected, { allowLinked = false } = {}) {
  try {
    const current = fs.lstatSync(file);
    if (stateSameFileIdentity(current, expected) && (current.nlink === 1 || (allowLinked && current.nlink >= 2))) {
      fs.unlinkSync(file);
    }
  } catch { /* leave unknown successors and recovery artifacts untouched */ }
}

function stateWriteTemp(directory, name, payload, label) {
  stateAssertDirectoryAnchor(directory, `${label} directory`);
  const file = path.join(directory.realpath, name);
  let fd;
  let created;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | STATE_NOFOLLOW, 0o600);
    created = fs.fstatSync(fd);
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) {
      throw new Error(`${label} temporary file is unsafe`);
    }
    const bytes = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} temporary file write stalled`);
      offset += written;
    }
    try { fs.fchmodSync(fd, 0o600); } catch { /* Windows/best-effort */ }
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (!stateSameFileIdentity(created, written) || written.nlink !== 1 || written.size !== bytes.length) {
      throw new Error(`${label} temporary file changed while writing`);
    }
    return { path: file, stat: written };
  } catch (error) {
    if (created) stateRemoveOwnedFile(file, created);
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* preserve original failure */ }
  }
}

function stateRestoreBackup(backup, target, expected, label) {
  try {
    if (stateFileSnapshot(target, `${label} successor`, { allowMissing: true })) return false;
    const current = stateFileSnapshot(backup, `${label} backup`);
    if (!current || !stateSameFileIdentity(current, expected) || current.nlink !== 1) return false;
    fs.linkSync(backup, target);
    const restored = stateFileSnapshot(target, `${label} restored`);
    if (!restored || !stateSameFileIdentity(restored, expected) || restored.nlink < 2) return false;
    fs.unlinkSync(backup);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish a state/marker file only after the managed directory and the
 * previously observed target have remained the same. Existing targets are
 * quarantined first, then the new file is linked with no-replace semantics;
 * an unexpected successor is never overwritten.
 */
function statePublishFile(directory, targetName, temporary, expected, label) {
  stateAssertDirectoryAnchor(directory, `${label} directory`);
  const target = path.join(directory.realpath, targetName);
  const current = stateFileSnapshot(target, `${label} target`, { allowMissing: true });
  if ((expected && (!current || !stateSameFileSnapshot(current, expected))) || (!expected && current)) {
    throw new Error(`${label} changed before publication`);
  }
  let backup = null;
  let linked = false;
  try {
    if (expected) {
      backup = `${target}.previous-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.renameSync(target, backup);
      const moved = stateFileSnapshot(backup, `${label} backup`);
      if (!moved || !stateSameFileIdentity(moved, expected) || moved.nlink !== 1) {
        stateRestoreBackup(backup, target, expected, label);
        throw new Error(`${label} target changed before publication`);
      }
      stateAssertDirectoryAnchor(directory, `${label} directory`);
      if (stateFileSnapshot(target, `${label} successor`, { allowMissing: true })) {
        throw new Error(`${label} successor appeared during publication`);
      }
    }
    stateAssertDirectoryAnchor(directory, `${label} directory`);
    if (stateFileSnapshot(target, `${label} successor`, { allowMissing: true })) {
      throw new Error(`${label} successor appeared during publication`);
    }
    fs.linkSync(temporary.path, target);
    linked = true;
    const linkedTarget = stateFileSnapshot(target, `${label} target`, { allowHardLinks: true });
    if (!linkedTarget || !stateSameFileIdentity(linkedTarget, temporary.stat) || linkedTarget.nlink < 2) {
      throw new Error(`${label} publication produced an unsafe target`);
    }
    stateAssertDirectoryAnchor(directory, `${label} directory`);
    stateRemoveOwnedFile(temporary.path, temporary.stat, { allowLinked: true });
    const installed = stateFileSnapshot(target, `${label} target`);
    if (!installed || !stateSameFileIdentity(installed, temporary.stat) || installed.nlink !== 1) {
      throw new Error(`${label} identity changed after publication`);
    }
    try { fs.chmodSync(target, 0o600); } catch { /* Windows/best-effort */ }
    const final = stateFileSnapshot(target, `${label} target`);
    if (!final || !stateSameFileIdentity(final, temporary.stat) || final.nlink !== 1 ||
        (process.platform !== "win32" && (final.mode & 0o777) !== 0o600)) {
      throw new Error(`${label} mode or identity changed after publication`);
    }
    stateAssertDirectoryAnchor(directory, `${label} directory`);
    if (backup) {
      const backupStat = stateFileSnapshot(backup, `${label} backup`, { allowMissing: true });
      if (backupStat && stateSameFileIdentity(backupStat, expected) && backupStat.nlink === 1) {
        fs.unlinkSync(backup);
      }
    }
    return target;
  } catch (error) {
    if (linked) stateRemoveOwnedFile(target, temporary.stat);
    stateRemoveOwnedFile(temporary.path, temporary.stat);
    if (backup) stateRestoreBackup(backup, target, expected, label);
    throw error;
  }
}

function stateWriteLockOwner(lockParent, lock, owner) {
  stateAssertDirectoryAnchor(lockParent, "Cloud asset lock parent");
  stateAssertDirectoryAnchor(lock, "Cloud asset lock", lockParent);
  const ownerPath = path.join(lock.realpath, "owner.json");
  let fd;
  let created;
  try {
    fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | STATE_NOFOLLOW, 0o600);
    created = fs.fstatSync(fd);
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) {
      throw new Error("lock owner is not a bounded private file");
    }
    const payload = Buffer.from(JSON.stringify(owner) + "\n", "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const written = fs.writeSync(fd, payload, offset, payload.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) throw new Error("lock owner write stalled");
      offset += written;
    }
    try { fs.fchmodSync(fd, 0o600); } catch { /* Windows/best-effort */ }
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (!stateSameFileIdentity(created, written) || written.nlink !== 1 || written.size !== payload.length) {
      throw new Error("lock owner changed while it was written");
    }
  } catch (error) {
    if (created) stateRemoveOwnedFile(ownerPath, created);
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* preserve original failure */ }
  }
  stateAssertDirectoryAnchor(lockParent, "Cloud asset lock parent");
  stateAssertDirectoryAnchor(lock, "Cloud asset lock", lockParent);
  const written = stateFileSnapshot(ownerPath, "Cloud asset lock owner", { maxBytes: 512 });
  if (!written || !stateSameFileIdentity(written, created) || written.nlink !== 1 || (written.mode & 0o777) !== 0o600) {
    throw new Error("lock owner changed while it was written");
  }
}

function stateRemoveOwnedLockDirectory(directoryPath, expected) {
  let current;
  try { current = stateDirectoryAnchor(directoryPath, "Cloud asset lock cleanup"); }
  catch { return false; }
  if (!stateSameDirectoryIdentity(current.stat, expected.stat || expected)) return false;
  const ownerPath = path.join(current.realpath, "owner.json");
  const owner = stateFileSnapshot(ownerPath, "Cloud asset lock owner", { allowMissing: true, maxBytes: 512 });
  if (owner) {
    try { fs.unlinkSync(ownerPath); } catch { return false; }
  }
  try {
    fs.rmdirSync(current.realpath);
    return true;
  } catch {
    // Never recursively delete a lock directory after its identity is no
    // longer provable; leave the artifact for bounded stale-lock recovery.
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // failures also stay fail-safe: never steal a lock from a possibly live owner.
    return true;
  }
}

function readLockOwner(lockPath, lockAnchor = null) {
  if (lockAnchor) stateAssertDirectoryAnchor(lockAnchor, "Cloud asset lock");
  const ownerPath = path.join(lockAnchor ? lockAnchor.realpath : lockPath, "owner.json");
  let fd;
  try {
    const listed = stateFileSnapshot(ownerPath, "Cloud asset lock owner", { allowMissing: true, maxBytes: 512 });
    if (!listed) return null;
    fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 512 || !stateSameFileIdentity(before, listed)) {
      throw new Error("lock owner is not a bounded private file");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (
      Buffer.byteLength(raw, "utf8") !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("lock owner changed while it was read");
    }
    const parsed = JSON.parse(raw);
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== "string" || !/^[a-f0-9]{32}$/.test(parsed.nonce)) {
      throw new Error("lock owner identity is invalid");
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * Directory rename is the lock hand-off boundary. A stale lock is moved to a
 * unique quarantine path before cleanup, so a new owner's lock can never be
 * removed by the old cleanup path.
 */
function withCloudAssetLock(targetPath, label, action) {
  const lockPath = `${targetPath}.lock`;
  const lockParent = path.dirname(lockPath);
  const lockParentAnchor = stateEnsureDirectory(lockParent, `${label} lock parent`);
  const lockName = path.basename(lockPath);
  const lockActualPath = path.join(lockParentAnchor.realpath, lockName);
  const deadline = Date.now() + CLOUD_ASSET_LOCK_WAIT_MS;
  let acquired = false;
  let lockAnchor = null;
  while (!acquired) {
    let createdLock = false;
    try {
      stateAssertDirectoryAnchor(lockParentAnchor, `${label} lock parent`);
      fs.mkdirSync(lockActualPath, { mode: 0o700 });
      createdLock = true;
      lockAnchor = stateDirectoryAnchor(lockActualPath, `${label} lock`, { containedBy: lockParentAnchor });
      try { fs.chmodSync(lockActualPath, 0o700); } catch { /* Windows/best-effort */ }
      stateAssertDirectoryAnchor(lockParentAnchor, `${label} lock parent`);
      stateAssertDirectoryAnchor(lockAnchor, `${label} lock`, lockParentAnchor);
      const owner = {
        pid: process.pid,
        nonce: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      stateWriteLockOwner(lockParentAnchor, lockAnchor, owner);
      acquired = true;
    } catch (error) {
      if (!createdLock && error && (error.code === "EEXIST" || error.code === "ENOENT")) {
        if (error.code === "ENOENT") continue;
        let lock = null;
        try {
          lock = stateDirectoryAnchor(lockActualPath, `${label} lock`, {
            allowMissing: true,
            containedBy: lockParentAnchor,
          });
        } catch (statError) {
          if (statError && statError.code === "ENOENT") continue;
          throw statError;
        }
        if (!lock) continue;
        let owner = null;
        try { owner = readLockOwner(lockActualPath, lock); } catch { owner = null; }
        if (Date.now() - lock.stat.mtimeMs > CLOUD_ASSET_LOCK_STALE_MS && (!owner || !processIsAlive(owner.pid))) {
          stateAssertDirectoryAnchor(lockParentAnchor, `${label} lock parent`);
          stateAssertDirectoryAnchor(lock, `${label} lock`, lockParentAnchor);
          const quarantine = path.join(
            lockParentAnchor.realpath,
            `${lockName}.stale-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
          );
          try {
            fs.renameSync(lockActualPath, quarantine);
            const moved = stateDirectoryAnchor(quarantine, `${label} stale lock`, { containedBy: lockParentAnchor });
            if (stateSameDirectoryIdentity(moved.stat, lock.stat)) stateRemoveOwnedLockDirectory(quarantine, moved);
          } catch (reclaimError) {
            if (reclaimError && reclaimError.code === "ENOENT") continue;
            throw reclaimError;
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`${label} is busy; retry after the active operation finishes`);
        waitSync(25);
        continue;
      }
      if (lockAnchor && !acquired) {
        const abandoned = path.join(
          lockParentAnchor.realpath,
          `${lockName}.abandoned-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
        );
        try {
          stateAssertDirectoryAnchor(lockParentAnchor, `${label} lock parent`);
          stateAssertDirectoryAnchor(lockAnchor, `${label} lock`, lockParentAnchor);
          fs.renameSync(lockActualPath, abandoned);
          const moved = stateDirectoryAnchor(abandoned, `${label} abandoned lock`, { containedBy: lockParentAnchor });
          if (stateSameDirectoryIdentity(moved.stat, lockAnchor.stat)) stateRemoveOwnedLockDirectory(abandoned, moved);
        } catch { /* original owner-write error remains authoritative */ }
      }
      throw error;
    }
  }
  try {
    return action();
  } finally {
    const cleanup = path.join(
      lockParentAnchor.realpath,
      `${lockName}.done-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
    );
    try {
      stateAssertDirectoryAnchor(lockParentAnchor, `${label} lock parent`);
      stateAssertDirectoryAnchor(lockAnchor, `${label} lock`, lockParentAnchor);
      fs.renameSync(lockActualPath, cleanup);
      const moved = stateDirectoryAnchor(cleanup, `${label} completed lock`, { containedBy: lockParentAnchor });
      if (!stateSameDirectoryIdentity(moved.stat, lockAnchor.stat)) {
        throw new Error(`${label} lock changed while it was being released`);
      }
      stateRemoveOwnedLockDirectory(cleanup, moved);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function normalizeCloudScopeFlag(value) {
  if (value === "owner-private" || value === "private" || value === "private-link") return "owner-private";
  if (value === "hub-public" || value === "marketplace" || value === "public") return "hub-public";
  return null;
}

function cloudDescriptorKey(descriptor) {
  return `${descriptor.scope}:${descriptor.slug}`;
}

function cloudAssetStatePath() {
  return path.join(userDataDir(), CLOUD_ASSET_STATE_FILE);
}

function normalizeCloudAssetState(parsed) {
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets)) {
    throw new Error("state schema is invalid");
  }
  const assets = {};
  for (const [key, raw] of Object.entries(parsed.assets)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`state entry ${key} is invalid`);
    const descriptor = normalizeCloudAssetDescriptor(raw.descriptor, `state entry ${key}`);
    if (key !== cloudDescriptorKey(descriptor)) throw new Error(`state entry ${key} key is invalid`);
    if (!Array.isArray(raw.sourceRoots)) throw new Error(`state entry ${key} sourceRoots is invalid`);
    for (const item of raw.sourceRoots) {
      if (typeof item !== "string" || !path.isAbsolute(item)) throw new Error(`state entry ${key} sourceRoots is invalid`);
    }
    const sourceRoots = [...new Set(raw.sourceRoots.map((item) => path.resolve(item)))].slice(0, 32);
    assets[key] = { descriptor, sourceRoots };
  }
  if (!Array.isArray(parsed.deletedBases)) throw new Error("state deletedBases is invalid");
  const deletedBases = parsed.deletedBases.map((item, index) => {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.rootPath !== "string" || !path.isAbsolute(item.rootPath) ||
      typeof item.slug !== "string" || cloudSlug(item.slug) !== item.slug ||
      !CLOUD_ASSET_SCOPES.has(item.scope) || !/^[A-Za-z0-9_-]{8,128}$/.test(String(item.cloudId || "")) ||
      typeof item.revision !== "string" || !item.revision || item.revision.length > 512 || /["\\\u0000-\u001f\u007f]/.test(item.revision)
    ) {
      throw new Error(`state deletedBases[${index}] is invalid`);
    }
    return {
      rootPath: path.resolve(item.rootPath),
      slug: item.slug,
      scope: item.scope,
      cloudId: item.cloudId,
      revision: item.revision,
    };
  }).slice(-256);
  return { schemaVersion: 1, assets, deletedBases };
}

function readCloudAssetState() {
  const statePath = cloudAssetStatePath();
  let fd;
  try {
    // O_NOFOLLOW: 상태 파일이 심링크로 바꿔치기되면 읽지 않는다 (로컬 상태 위조 방어).
    try {
      fd = fs.openSync(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error && error.code === "ENOENT") return { schemaVersion: 1, assets: {}, deletedBases: [] };
      throw error;
    }
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > CLOUD_ASSET_STATE_MAX_BYTES) {
      throw new Error("state file is not a bounded private file");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (
      Buffer.byteLength(raw, "utf8") !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("state file changed while it was read");
    }
    return normalizeCloudAssetState(JSON.parse(raw));
  } catch (error) {
    // 깨진 상태 파일을 빈 상태로 위장하면 stale 베이스로 원격 리비전을 덮어쓸 수 있다.
    throw new Error(`Agent Cloud local revision state is unreadable: ${error.message || error}`);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

function writeCloudAssetStateUnlocked(state) {
  const statePath = cloudAssetStatePath();
  const normalized = normalizeCloudAssetState(state);
  const directory = stateEnsureDirectory(path.dirname(statePath), "Cloud asset state directory");
  const targetName = path.basename(statePath);
  const target = path.join(directory.realpath, targetName);
  const expected = stateFileSnapshot(target, "Cloud asset state", { allowMissing: true });
  const payload = JSON.stringify(normalized, null, 2) + "\n";
  if (Buffer.byteLength(payload, "utf8") > CLOUD_ASSET_STATE_MAX_BYTES) {
    throw new Error("Cloud asset state exceeds its safety limit");
  }
  const temporary = stateWriteTemp(
    directory,
    `.${targetName}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    payload,
    "Cloud asset state",
  );
  try {
    statePublishFile(directory, targetName, temporary, expected, "Cloud asset state");
    cloudFsyncDirectory(directory.realpath);
  } finally {
    stateRemoveOwnedFile(temporary.path, temporary.stat);
  }
  return normalized;
}

function writeCloudAssetState(state) {
  return withCloudAssetLock(cloudAssetStatePath(), "Agent Cloud local revision state", () => writeCloudAssetStateUnlocked(state));
}

function updateCloudAssetState(mutator) {
  if (typeof mutator !== "function") throw new TypeError("Cloud asset state mutator must be a function");
  return withCloudAssetLock(cloudAssetStatePath(), "Agent Cloud local revision state", () => {
    const state = readCloudAssetState();
    const result = mutator(state);
    writeCloudAssetStateUnlocked(state);
    return result;
  });
}

/** 서버가 준 리비전 영수증을 관측 상태로 승격. sourceRoot가 있으면 톰스톤도 해제한다. */
function rememberCloudAssetDescriptor(value, options = {}) {
  const descriptor = normalizeCloudAssetDescriptor(value);
  return updateCloudAssetState((state) => {
    const key = cloudDescriptorKey(descriptor);
    const previous = state.assets[key];
    const sameRevision = previous && previous.descriptor.cloudId === descriptor.cloudId && previous.descriptor.revision === descriptor.revision;
    const roots = sameRevision ? [...previous.sourceRoots] : [];
    if (options.sourceRoot) {
      const sourceRoot = path.resolve(options.sourceRoot);
      roots.push(sourceRoot);
      state.deletedBases = state.deletedBases.filter(
        (item) => !(item.rootPath === sourceRoot && item.slug === descriptor.slug && item.scope === descriptor.scope),
      );
    }
    state.assets[key] = { descriptor, sourceRoots: [...new Set(roots)].slice(0, 32) };
    return descriptor;
  });
}

function findCloudAssetDescriptor(slug, scope) {
  const safeSlug = cloudSlug(slug);
  const state = readCloudAssetState();
  const matches = Object.values(state.assets).filter(
    (entry) => entry.descriptor.slug === safeSlug && (!scope || entry.descriptor.scope === scope),
  );
  if (!scope && matches.length > 1) {
    // 같은 슬러그가 두 scope에 있으면 "아무거나" 지우지 않는다 — 정확한 지정 강제.
    throw new Error(`Cloud asset ${safeSlug} exists in multiple scopes. Retry with --scope owner-private or --scope hub-public.`);
  }
  return matches.length === 1 ? matches[0] : null;
}

// ── 소스 폴더 마커 (.agentlas-cloud-package.json) ──

function cloudMarkerDescriptors(marker) {
  const descriptors = {};
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return descriptors;
  if (marker.cloudAssets && typeof marker.cloudAssets === "object" && !Array.isArray(marker.cloudAssets)) {
    for (const scope of CLOUD_ASSET_SCOPES) {
      if (!marker.cloudAssets[scope]) continue;
      try {
        const descriptor = normalizeCloudAssetDescriptor(marker.cloudAssets[scope], `local marker ${scope}`);
        if (descriptor.scope === scope) descriptors[scope] = descriptor;
      } catch { /* 레거시/손상 CAS 항목은 베이스 리비전으로 채택하지 않는다 */ }
    }
  }
  if (marker.revision && marker.cloudId && marker.scope) {
    try {
      const descriptor = normalizeCloudAssetDescriptor(marker, "local marker");
      if (!descriptors[descriptor.scope]) descriptors[descriptor.scope] = descriptor;
    } catch { /* legacy marker */ }
  }
  return descriptors;
}

function cloudBaseDescriptorFromMarker(marker, slug, scope) {
  const descriptor = cloudMarkerDescriptors(marker)[scope];
  return descriptor && descriptor.slug === slug ? descriptor : null;
}

/**
 * 다음 save의 CAS 베이스 결정: 마커 vs 상태 저널.
 * 톰스톤에 걸린 마커 디스크립터는 무시(삭제 후 재저장은 새 생성이어야 한다).
 * 둘 다 있으면 같은 cloudId에서 더 최신 관측을 채택한다.
 */
/**
 * 이 slug/scope의 관측된 리비전은 있는데, 이 소스 루트에는 아직 연결되지 않은
 * 경우를 돌려준다.
 *
 * 이 구분이 없으면 base 조회가 null을 돌려주고, 호출부는 그것을 "새 자산"으로
 * 읽어 create precondition을 보낸다. 서버에는 자산이 멀쩡히 존재하므로 412로
 * 거절되고, 사용자는 "다른 PC에서 변경됨 / restore 하세요"라는 엉뚱한 안내를
 * 받는다. restore는 디스크립터를 설치 경로에 묶으므로 소스 루트에서 발행하는
 * 한 영원히 해소되지 않는다. 모름을 그럴듯한 값으로 메꾸지 않기 위한 분기다.
 */
function cloudUnboundDescriptorForSource(rootPath, slug, scope) {
  const state = readCloudAssetState();
  const entry = state.assets[`${scope}:${slug}`];
  if (!entry) return null;
  return entry.sourceRoots.includes(path.resolve(rootPath)) ? null : entry.descriptor;
}

/** 이 소스 루트를 이미 관측된 클라우드 자산에 명시적으로 연결한다. */
function bindCloudAssetSourceRoot(rootPath, slug, scope) {
  return updateCloudAssetState((state) => {
    const key = `${scope}:${slug}`;
    const entry = state.assets[key];
    if (!entry) throw new Error(`No observed Cloud revision for ${key} to bind.`);
    const normalizedRoot = path.resolve(rootPath);
    const roots = [...new Set([...entry.sourceRoots, normalizedRoot])].slice(0, 32);
    state.assets[key] = { descriptor: entry.descriptor, sourceRoots: roots };
    state.deletedBases = state.deletedBases.filter(
      (item) => !(item.rootPath === normalizedRoot && item.slug === slug && item.scope === scope),
    );
    return entry.descriptor;
  });
}

function cloudBaseDescriptorForSource(marker, rootPath, slug, scope) {
  const state = readCloudAssetState();
  const normalizedRoot = path.resolve(rootPath);
  let markerDescriptor = cloudBaseDescriptorFromMarker(marker, slug, scope);
  if (markerDescriptor && state.deletedBases.some((item) =>
    item.rootPath === normalizedRoot && item.slug === slug && item.scope === scope &&
    item.cloudId === markerDescriptor.cloudId && item.revision === markerDescriptor.revision
  )) {
    markerDescriptor = null;
  }
  const entry = state.assets[`${scope}:${slug}`];
  const stateDescriptor = entry && entry.sourceRoots.includes(normalizedRoot) ? entry.descriptor : null;
  if (!markerDescriptor) return stateDescriptor;
  if (!stateDescriptor) return markerDescriptor;
  return stateDescriptor.cloudId === markerDescriptor.cloudId && Date.parse(stateDescriptor.updatedAt) >= Date.parse(markerDescriptor.updatedAt)
    ? stateDescriptor
    : markerDescriptor;
}

function writeCloudSourceMarker(rootPath, scan, descriptor, options = {}) {
  const lockTarget = path.join(
    userDataDir(),
    "cloud-source-marker-locks",
    crypto.createHash("sha256").update(path.resolve(rootPath)).digest("hex"),
  );
  return withCloudAssetLock(lockTarget, "Agent Cloud source marker", () => {
    const rootAnchor = stateDirectoryAnchor(rootPath, "Cloud source marker root");
    const markerPath = path.join(rootAnchor.realpath, CLOUD_RESTORE_MARKER_PATH);
    const expectedMarker = stateFileSnapshot(markerPath, "Cloud source marker", { allowMissing: true });
    const previousMarker = readCloudSourceMarker(rootAnchor.realpath);
    stateAssertDirectoryAnchor(rootAnchor, "Cloud source marker root");
    const currentMarker = stateFileSnapshot(markerPath, "Cloud source marker", { allowMissing: true });
    if ((expectedMarker && (!currentMarker || !stateSameFileSnapshot(currentMarker, expectedMarker))) ||
        (!expectedMarker && currentMarker)) {
      throw new Error("Cloud source marker changed while it was read");
    }
    const descriptors = cloudMarkerDescriptors(previousMarker);
    if (descriptor) descriptors[descriptor.scope] = descriptor;
    if (options.removeDescriptor) {
      const current = descriptors[options.removeDescriptor.scope];
      if (current && current.cloudId === options.removeDescriptor.cloudId && current.revision === options.removeDescriptor.revision) {
        delete descriptors[options.removeDescriptor.scope];
      }
    }
    const latest = descriptor || Object.values(descriptors)[0] || null;
    const marker = {
      schemaVersion: 1,
      source: "agentlas-cloud",
      slug: latest?.slug || options.removeDescriptor?.slug || cloudSlug(path.basename(rootPath)),
      packageHash: descriptor?.packageHash || options.packageHash || previousMarker?.packageHash || "",
      packageHashVersion: descriptor?.packageHashVersion || options.packageHashVersion || previousMarker?.packageHashVersion || CLOUD_PACKAGE_HASH_V1,
      fileCount: Number.isSafeInteger(options.fileCount) ? options.fileCount : (previousMarker?.fileCount || 0),
      totalBytes: Number.isSafeInteger(options.totalBytes) ? options.totalBytes : (previousMarker?.totalBytes || 0),
      executablePaths: Array.isArray(options.executablePaths) ? options.executablePaths : previousMarker?.executablePaths,
      cloudAssets: descriptors,
      ...(latest ? latest : {}),
      restoredAt: previousMarker?.restoredAt,
      savedAt: new Date().toISOString(),
    };
    for (const key of Object.keys(marker)) if (marker[key] === undefined) delete marker[key];
    const temporary = stateWriteTemp(
      rootAnchor,
      `.${CLOUD_RESTORE_MARKER_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
      JSON.stringify(marker, null, 2) + "\n",
      "Cloud source marker",
    );
    try {
      statePublishFile(rootAnchor, CLOUD_RESTORE_MARKER_PATH, temporary, expectedMarker, "Cloud source marker");
      cloudFsyncDirectory(rootAnchor.realpath);
    } finally {
      stateRemoveOwnedFile(temporary.path, temporary.stat);
    }
    return marker;
  });
}

function readCloudSourceMarker(rootPath) {
  const markerPath = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  let fd;
  try {
    try {
      fd = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > CLOUD_ASSET_STATE_MAX_BYTES) {
      throw new Error("marker is not a bounded private file");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (
      Buffer.byteLength(raw, "utf8") !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("marker changed while it was read");
    }
    return JSON.parse(raw);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = {
  CLOUD_ASSET_STATE_FILE,
  normalizeCloudScopeFlag,
  cloudDescriptorKey,
  cloudAssetStatePath,
  readCloudAssetState,
  writeCloudAssetState,
  updateCloudAssetState,
  rememberCloudAssetDescriptor,
  findCloudAssetDescriptor,
  cloudMarkerDescriptors,
  cloudBaseDescriptorFromMarker,
  cloudBaseDescriptorForSource,
  cloudUnboundDescriptorForSource,
  bindCloudAssetSourceRoot,
  writeCloudSourceMarker,
  readCloudSourceMarker,
};
