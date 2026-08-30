"use strict";
/*
 * mcp/contract — MCP 서브시스템 공용 저수준 계약(검증·안전텍스트·프라이빗 JSON IO·락).
 *
 * v1 engine/agentlas-experience-mcp.cjs에서 MCP 관심사만 추출한 v2 모듈군의 바닥층.
 * 여기에는 기능 로직이 없다: 상위(inventory/probe/plan/consent)가 공유하는
 * 불변 계약만 둔다. 검증 규칙 하나라도 느슨해지면 공개 투영/동의 영수증의
 * 보안 경계가 같이 무너지므로, v1 동작을 토씨까지 보존한다.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_APPROVED_MCP_PER_BUILD = 8;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_WAIT_MS = 2_000;
const STATE_LOCK_OWNER_MAX_BYTES = 512;

// Public contract text must be compact, value-free, and instruction-safe.
const UNSAFE_TEXT_PATTERNS = [
  { code: "openai-secret", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: "github-secret", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { code: "aws-secret", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { code: "credential", re: /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|private[_ -]?key|authorization)\s*[:=]\s*\S+/i },
  { code: "bearer", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { code: "private-path", re: /(?:file:\/\/|(?:^|[\s"'`()\[\]{}=:,;])(?:\.\.[/\\]|~[/\\]|\/(?!\/|\s)(?:[^/\s"'`<>]+\/)*[^/\s"'`<>]+|[A-Za-z]:[/\\]\S+|\\\\[^\\/\s]+[\\/][^\\/\s]+))/i },
  { code: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: "phone", re: /(?:\+?\d[\d .()-]{8,}\d)/ },
  { code: "account-id", re: /\b(?:account|customer|client|user)[ _-]?(?:id|number|no)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}\b|(?:계정|고객|사용자)[ _-]?(?:id|아이디|번호)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}/i },
  { code: "raw-prompt", re: /(?:raw[_ -]?prompt|full[_ -]?transcript|conversation[_ -]?dump|system[_ -]?prompt|(?:^|\n)\s*(?:system|assistant|user|tool)\s*:|(?:AGENTS|CLAUDE|GEMINI)\.md|\.agentlas[\\/])/i },
  { code: "prompt-injection", re: /(?:ignore|disregard|override)[\s_-]+(?:all[\s_-]+)?(?:previous|prior|system|developer|hidden)[\s_-]+(?:instructions?|prompts?|rules?|directives?)/i },
  { code: "exfiltration", re: /(?:reveal|show|print|dump|expose|leak|send|upload|exfiltrate|steal)[\s_-]+(?:(?:the|all)[\s_-]+)?(?:secret|credential|token|cookie|password|private[\s_-]?key|api[\s_-]?key)/i },
  { code: "safety-bypass", re: /(?:disable|bypass|skip|remove|turn[\s_-]+off)[\s_-]+(?:(?:the|all)[\s_-]+)?(?:safety|guardrails?|approval|consent|permission[\s_-]?checks?|security[\s_-]?checks?)/i },
  { code: "opaque-blob", re: /\b(?:[A-Fa-f0-9]{128,}|[A-Za-z0-9+/]{124,}={0,2})\b/ },
];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, required, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing: ${key}`);
  }
}

function assertId(value, label) {
  if (!ID_RE.test(String(value || ""))) throw new Error(`${label} is not a valid Agentlas id`);
  return String(value);
}

function assertUniqueIds(value, label, options = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (options.min && value.length < options.min) throw new Error(`${label} must have at least ${options.min} item(s)`);
  if (options.max && value.length > options.max) throw new Error(`${label} has too many items`);
  const items = value.map((item, index) => assertId(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} must be unique`);
  return items;
}

function assertSafeText(value, label, max = 300) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i.test(text)) throw new Error(`${label} must be compact single-line text`);
  const unsafe = UNSAFE_TEXT_PATTERNS.find((pattern) => pattern.re.test(text));
  if (unsafe) throw new Error(`${label} is not public-safe (${unsafe.code})`);
  return text;
}

function assertIsoDateOrNull(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date-time or null`);
  return value;
}

function safeCatalogId(value) {
  const text = String(value || "").trim();
  return ID_RE.test(text) && !UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.re.test(text)) ? text : null;
}

function safeDisplayName(value, fallback) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!text || UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.re.test(text))) return fallback;
  return text;
}

function fileIdentityEqual(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

function fileTimesEqual(left, right) {
  return Boolean(left && right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertRegularJsonFile(stat, label) {
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
  }
}

function assertJsonFileSize(stat, label) {
  if (stat.size <= 0 || stat.size > MAX_JSON_BYTES) throw new Error(`${label} has an invalid size`);
}

function openReadOnlyNoFollow(filePath) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    // Node does not expose a no-follow open flag on every Windows filesystem.
    // Keep the lstat/fstat/path identity checks below as the fallback there;
    // never silently drop O_NOFOLLOW on POSIX.
    if (process.platform === "win32" && noFollow && ["EINVAL", "ENOTSUP"].includes(error && error.code)) {
      return fs.openSync(filePath, fs.constants.O_RDONLY);
    }
    throw error;
  }
}

function readBoundedDescriptor(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    if (capacity <= 0) break;
    const chunk = Buffer.allocUnsafe(capacity);
    const result = fs.readSync(fd, chunk, 0, capacity, null);
    const bytesRead = typeof result === "number" ? result : result.bytesRead;
    if (!Number.isInteger(bytesRead) || bytesRead < 0) throw new Error("descriptor read returned an invalid byte count");
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { bytes: Buffer.concat(chunks, total), byteLength: total };
}

function readJsonFile(filePath, label) {
  const absolute = path.resolve(filePath);
  let fd;
  let listed;
  try {
    listed = fs.lstatSync(absolute);
    assertRegularJsonFile(listed, label);
    assertJsonFileSize(listed, label);
    fd = openReadOnlyNoFollow(absolute);
  } catch (error) {
    if (error && error.code === "ELOOP") {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    assertRegularJsonFile(before, label);
    assertJsonFileSize(before, label);
    if (!fileIdentityEqual(listed, before) || !fileTimesEqual(listed, before) || listed.size !== before.size) {
      throw new Error(`${label} changed while it was being read`);
    }

    let captured;
    try {
      captured = readBoundedDescriptor(fd, MAX_JSON_BYTES);
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
    const after = fs.fstatSync(fd);
    let current;
    try { current = fs.lstatSync(absolute); }
    catch { throw new Error(`${label} changed while it was being read`); }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
      throw new Error(`${label} changed while it was being read`);
    }
    if (captured.byteLength <= 0 || captured.byteLength > MAX_JSON_BYTES || after.size <= 0 || after.size > MAX_JSON_BYTES) {
      throw new Error(`${label} has an invalid size`);
    }
    if (
      !fileIdentityEqual(before, after) || !fileTimesEqual(before, after) || after.size !== before.size ||
      captured.byteLength !== after.size || !fileIdentityEqual(before, current) ||
      !fileTimesEqual(before, current) || current.size !== after.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    let value;
    try { value = JSON.parse(captured.bytes.toString("utf8")); }
    catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
    return { absolute, value };
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function writePrivateJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
  }
}

function waitSync(milliseconds) {
  // Atomics.wait은 지원 Node 20+에서 스핀 없이 대기하는 유일한 동기 sleep이다.
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    // EPERM and unknown failures mean the process may still be alive. Never
    // reclaim a stale-looking lock when liveness cannot be disproved.
    return true;
  }
}

function readLockOwner(lockPath, labels) {
  const ownerPath = path.join(lockPath, "owner.json");
  let fd;
  try {
    const listed = fs.lstatSync(ownerPath);
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1) throw new Error(labels.unsafe);
    fd = openReadOnlyNoFollow(ownerPath);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > STATE_LOCK_OWNER_MAX_BYTES) {
      throw new Error(labels.unsafe);
    }
    // 정상 release/다음 owner 획득과 겹친 교체는 unsafe 파일이 아니라 재시도 신호다.
    if (!fileIdentityEqual(listed, before) || !fileTimesEqual(listed, before)) return null;
    const captured = readBoundedDescriptor(fd, STATE_LOCK_OWNER_MAX_BYTES);
    const after = fs.fstatSync(fd);
    let current;
    try { current = fs.lstatSync(ownerPath); }
    catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw new Error(labels.unsafe);
    }
    if (
      captured.byteLength !== before.size || !fileIdentityEqual(before, after) || !fileTimesEqual(before, after) ||
      after.size !== before.size || !fileIdentityEqual(before, current) || !fileTimesEqual(before, current) ||
      current.size !== after.size
    ) return null;
    let owner;
    try { owner = JSON.parse(captured.bytes.toString("utf8")); }
    catch { throw new Error(labels.unsafe); }
    if (
      !owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.nonce !== "string" || !/^[a-f0-9]{32}$/.test(owner.nonce)
    ) throw new Error(labels.unsafe);
    return owner;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    if (error && error.code === "ELOOP") throw new Error(labels.unsafe);
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * <stateFile>.lock directory 기반 상호배제. 크래시 잔류 락은 owner PID가
 * 실제로 죽었다고 확인될 때만 고유 quarantine 경로로 회수한다. 디렉터리
 * rename이 소유권 hand-off 경계이므로 이전 소유자의 cleanup이 successor를
 * unlink할 수 없다.
 */
function withPrivateStateLock(stateFile, labels, action) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const lockPath = `${stateFile}.lock`;
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let acquiredOwner = null;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
      if (error.code === "ENOENT") continue;
      let stat;
      try { stat = fs.lstatSync(lockPath); }
      catch (statError) {
        if (statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(labels.unsafe);
      let owner;
      try { owner = readLockOwner(lockPath, labels); }
      catch (ownerError) { throw ownerError; }
      if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
        // Missing or malformed owner identity is not evidence of a dead PID.
        // Stay fail-closed rather than stealing a possibly live lock.
        if (!owner || processIsAlive(owner.pid)) {
          if (Date.now() >= deadline) throw new Error(labels.busy);
          waitSync(25);
          continue;
        }
        const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
        try {
          fs.renameSync(lockPath, quarantine);
          fs.rmSync(quarantine, { recursive: true, force: true });
          continue;
        } catch (reclaimError) {
          if (reclaimError && reclaimError.code === "ENOENT") continue;
          throw reclaimError;
        }
      }
      if (Date.now() >= deadline) throw new Error(labels.busy);
      waitSync(25);
      // 기존 소유자가 정상적으로 보유 중이다. 같은 디렉터리의 owner.json에
      // 쓰기를 시도하면 EEXIST 처리 중 활성 잠금을 abandoned로 오인해 지울 수 있다.
      continue;
    }
    try {
      acquiredOwner = {
        pid: process.pid,
        nonce: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      // owner.json 자체도 원자적으로 공개한다. mkdir 직후의 부분 쓰기를 다른
      // contender가 size=0/malformed unsafe lock으로 관측하면 정상 경합이 실패한다.
      writePrivateJsonAtomic(path.join(lockPath, "owner.json"), acquiredOwner);
      acquired = true;
    } catch (error) {
      const abandoned = `${lockPath}.abandoned-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.renameSync(lockPath, abandoned);
        fs.rmSync(abandoned, { recursive: true, force: true });
      } catch { /* original owner-write error remains authoritative */ }
      throw error;
    }
  }
  try {
    return action();
  } finally {
    let ownsLock = false;
    try {
      const owner = readLockOwner(lockPath, labels);
      ownsLock = Boolean(owner && acquiredOwner && owner.pid === acquiredOwner.pid && owner.nonce === acquiredOwner.nonce);
    } catch { /* do not remove an unverified lock */ }
    if (ownsLock) {
      const cleanup = `${lockPath}.done-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.renameSync(lockPath, cleanup);
        fs.rmSync(cleanup, { recursive: true, force: true });
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
  }
}

function parseIdList(value) {
  if (!value || value === true) return [];
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseRuntimeServerArgs(value) {
  if (typeof value !== "string" || value.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some((item) => typeof item !== "string" || item.length > 4096 || /[\u0000\r\n]/.test(item))) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  ID_RE,
  HASH_RE,
  ENV_RE,
  MAX_JSON_BYTES,
  MAX_APPROVED_MCP_PER_BUILD,
  UNSAFE_TEXT_PATTERNS,
  assertObject,
  assertExactKeys,
  assertId,
  assertUniqueIds,
  assertSafeText,
  assertIsoDateOrNull,
  safeCatalogId,
  safeDisplayName,
  readJsonFile,
  writePrivateJsonAtomic,
  waitSync,
  withPrivateStateLock,
  parseIdList,
  parseRuntimeServerArgs,
};
