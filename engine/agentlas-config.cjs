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
const {
  readJsonFile,
  writePrivateJsonAtomic,
  withPrivateStateLock,
} = require("./mcp/contract.cjs");

function prefsPath(userDataDir) {
  return path.join(userDataDir, "cli-prefs.json");
}
function backupPath(userDataDir) {
  return prefsPath(userDataDir) + ".bak";
}
function readPrefsFile(file) {
  try {
    const { value } = readJsonFile(file, "CLI preferences");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function loadPrefs(userDataDir) {
  return readPrefsFile(prefsPath(userDataDir)) || readPrefsFile(backupPath(userDataDir)) || {};
}

function withPrefsLock(userDataDir, callback) {
  return withPrivateStateLock(prefsPath(userDataDir), {
    unsafe: "preferences lock is unsafe",
    busy: "preferences lock timeout",
  }, callback);
}

function atomicWrite(file, value) {
  writePrivateJsonAtomic(file, value);
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
    let currentStat = null;
    try { currentStat = fs.lstatSync(file); } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (currentStat && (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.nlink !== 1)) {
      throw new Error("CLI preferences path is unsafe");
    }
    const currentWasValid = Boolean(readPrefsFile(file));
    const current = loadPrefs(userDataDir);
    if (currentStat && !currentWasValid) {
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
