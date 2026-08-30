"use strict";
/*
 * project/env-file — .env 계열 파일 읽기/한 줄 갱신 헬퍼.
 *
 * readDotEnvFile은 commands/env.cjs에서 이관했다 (명령 파일끼리 import 금지 규칙
 * 때문에 creds 명령이 공유하려면 기능 모듈로 내려와야 한다).
 * upsertEnvLine은 v1 monolith 11226–11238 포팅.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_DOT_ENV_BYTES = 512 * 1024;

function readEnvSnapshot(file) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, body: "" };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DOT_ENV_BYTES) {
    throw new Error("credential env target must be a bounded regular non-symbolic-link file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() || opened.size > MAX_DOT_ENV_BYTES ||
      opened.dev !== before.dev || opened.ino !== before.ino
    ) throw new Error("credential env target changed while opening");
    return {
      exists: true,
      body: fs.readFileSync(fd, "utf8"),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertEnvSnapshotUnchanged(file, snapshot) {
  let current;
  try { current = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === "ENOENT" && !snapshot.exists) return;
    throw new Error("credential env target changed before replacement");
  }
  if (
    !snapshot.exists || !current.isFile() || current.isSymbolicLink() ||
    current.dev !== snapshot.dev || current.ino !== snapshot.ino ||
    current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ctimeMs !== snapshot.ctimeMs
  ) throw new Error("credential env target changed before replacement");
}

function replaceEnvFileAtomic(temp, file, snapshot) {
  assertEnvSnapshotUnchanged(file, snapshot);
  try {
    fs.renameSync(temp, file);
    return;
  } catch (error) {
    if (
      process.platform !== "win32" || !snapshot.exists ||
      !["EEXIST", "EPERM", "EACCES"].includes(error && error.code)
    ) throw error;
  }
  assertEnvSnapshotUnchanged(file, snapshot);
  const backup = `${file}.agentlas-${process.pid}-${crypto.randomUUID()}.bak`;
  fs.renameSync(file, backup);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (!fs.existsSync(file)) fs.renameSync(backup, file); } catch { /* leave the backup recoverable */ }
    throw error;
  }
  try { fs.rmSync(backup, { force: true }); } catch { /* committed target is authoritative */ }
}

/** .env 파싱 — 값 보존 없이 키만 필요할 때도 같은 파서를 쓴다 (KEY=VALUE, # 주석). */
function readDotEnvFile(file) {
  const result = {};
  let raw;
  try {
    raw = readEnvSnapshot(file).body;
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) result[key] = trimmed.slice(eq + 1);
  }
  return result;
}

function upsertEnvLine(file, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(String(key || ""))) throw new Error("credential env key must look like ENV_NAME");
  const text = String(value == null ? "" : value);
  if (/[\u0000\r\n]/.test(text)) throw new Error("credential env value must be a single line; use `agentlas creds file` for multiline credentials");
  const snapshot = readEnvSnapshot(file);
  let body = snapshot.body;
  const line = `${key}=${text}`;
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
  // Replacement strings interpret `$&`, `$1`, and similar tokens. Credentials
  // are opaque bytes, so use a function replacement and preserve them verbatim.
  if (re.test(body)) body = body.replace(re, () => line);
  else body = body ? body.replace(/\n?$/, "\n") + line + "\n" : line + "\n";
  if (Buffer.byteLength(body, "utf8") > MAX_DOT_ENV_BYTES) throw new Error("credential env file exceeds the 512 KiB safety limit");
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    replaceEnvFileAtomic(temp, file, snapshot);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
  // 이 헬퍼의 모든 호출자는 credential 값/경로를 기록한다. 새 파일뿐 아니라 기존 0644
  // 파일도 매번 0600으로 수렴시켜 같은 머신의 다른 계정이 읽지 못하게 한다.
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/읽기전용 FS best-effort */ }
}

module.exports = { MAX_DOT_ENV_BYTES, readDotEnvFile, upsertEnvLine };
