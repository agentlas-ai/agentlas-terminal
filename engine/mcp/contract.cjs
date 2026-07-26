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

function readJsonFile(filePath, label) {
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file (symlinks are not accepted)`);
  if (stat.size <= 0 || stat.size > MAX_JSON_BYTES) throw new Error(`${label} has an invalid size`);
  let value;
  try { value = JSON.parse(fs.readFileSync(absolute, "utf8")); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
  return { absolute, value };
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

/**
 * <stateFile>.lock 파일 기반 상호배제. 크래시 잔류 락은 STALE_MS 이후 회수한다.
 * busyMessage/unsafeMessage를 호출자가 주어 사용자 문구를 상태별로 유지한다.
 */
function withPrivateStateLock(stateFile, labels, action) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const lockFile = `${stateFile}.lock`;
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let descriptor = null;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(labels.unsafe);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(labels.busy);
      waitSync(25);
    }
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* noop */ }
    try { fs.unlinkSync(lockFile); } catch { /* crash recovery handles leftovers */ }
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
