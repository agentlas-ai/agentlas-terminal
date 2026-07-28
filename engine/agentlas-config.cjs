"use strict";
/*
 * CLI preferences (separate from the app's SQLite/keychain) — first-run onboarding result.
 * Stored at <userData>/cli-prefs.json: { onboarded, language, runtime, permission }.
 * `lang` is the v1 key for the same value — still read (engine/agentlas.cjs resolveLang)
 * so an upgraded user keeps the language they chose, but never written by v2.
 * Persisted permission is read|write; unrestricted/full is session-only.
 */
const fs = require("node:fs");
const path = require("node:path");
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

function prefsPath(userDataDir) {
  return path.join(userDataDir, "cli-prefs.json");
}
function backupPath(userDataDir) {
  return prefsPath(userDataDir) + ".bak";
}
function readPrefsFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function loadPrefs(userDataDir) {
  return readPrefsFile(prefsPath(userDataDir)) || readPrefsFile(backupPath(userDataDir)) || {};
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* old Node fallback */ }
  }
}

function withPrefsLock(userDataDir, callback) {
  const lock = prefsPath(userDataDir) + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("preferences lock timeout");
      sleepSync(10);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* stale lock recovery handles interrupted writers */ }
  }
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* win32 */ }
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* already renamed or never created */ }
  }
}

function mergePrefs(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value && typeof value === "object" && !Array.isArray(value)
      && next[key] && typeof next[key] === "object" && !Array.isArray(next[key])
    ) {
      next[key] = mergePrefs(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/*
 * Throws on failure (lock timeout, read-only data dir, ENOSPC …) — it used to
 * swallow every error and return null, so `agentlas setup` announced "All set."
 * and exited 0 while the user's language/runtime/permission were never written.
 * A caller that cannot persist must be able to say so; use savePrefs for the
 * best-effort boolean contract.
 */
function updatePrefs(userDataDir, patch) {
  fs.mkdirSync(userDataDir, { recursive: true });
  return withPrefsLock(userDataDir, () => {
    const file = prefsPath(userDataDir);
    const currentWasValid = Boolean(readPrefsFile(file));
    const current = loadPrefs(userDataDir);
    if (fs.existsSync(file) && !currentWasValid) {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}-${process.pid}`); } catch { /* recover from backup */ }
    }
    const next = mergePrefs(current, patch);
    if (currentWasValid) atomicWrite(backupPath(userDataDir), current);
    atomicWrite(file, next);
    return next;
  });
}

function savePrefs(userDataDir, prefs) {
  try {
    return Boolean(updatePrefs(userDataDir, prefs));
  } catch {
    return false;
  }
}

module.exports = { prefsPath, loadPrefs, savePrefs, updatePrefs, mergePrefs };
