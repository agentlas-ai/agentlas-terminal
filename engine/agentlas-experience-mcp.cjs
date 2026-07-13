"use strict";

/**
 * Terminal-owned Experience/MCP v1 surface.
 *
 * Boundaries:
 * - Experience publication commands persist local intent only. They never call
 *   the Hub and never manufacture a server receipt.
 * - MCP discovery reads Agentlas' trusted system-global registry metadata. It
 *   never executes, connects, downloads, or copies server definitions.
 * - Credential values, MCP commands/args/URLs, and base-agent bytes never enter
 *   the public projection or the builder directive.
 * - This store is private Terminal state, not a Desktop SQLite mirror.
 */

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const {
  buildMcpChildEnv,
  hasSensitiveRuntimeArgument,
  mcpRuntimeHome,
  normalizeCredentialKeyNames,
} = require("./agentlas-mcp-env.cjs");

const TOKEN_BUDGET = Object.freeze({
  coreMemoryMaxTokens: 150,
  experienceRetrievalMaxTokens: 800,
  experienceRetrievalMaxItems: 8,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const EXPERIENCE_STATE_SCHEMA = "agentlas.terminal-experience-intents.v1";
const EXPERIENCE_INTENT_SCHEMA = "agentlas.terminal-experience-intent.v1";
const MCP_CONSENT_STATE_SCHEMA = "agentlas.terminal-mcp-consents.v1";
const MCP_CONSENT_RECEIPT_SCHEMA = "agentlas.terminal-mcp-consent.v1";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BUILD_DIRECTIVE_CHARS = 1400;
const MAX_APPROVED_MCP_PER_BUILD = 8;
const MCP_PROBE_CONCURRENCY = 3;
const MCP_PROBE_PER_SERVER_TIMEOUT_MS = 8_000;
const MCP_PROBE_TOTAL_TIMEOUT_MS = 12_000;
const EXPERIENCE_LOCK_STALE_MS = 30_000;
const EXPERIENCE_LOCK_WAIT_MS = 2_000;

const EXPERIENCE_PACK_REQUIRED = [
  "schemaVersion", "kind", "experiencePackId", "releaseId", "ownerRef", "version",
  "baseCompatibility", "itemIds", "evidenceReceiptIds", "mcpRequirements",
  "containsBasePackageMaterial", "contentHash", "visibility", "status",
];
const EXPERIENCE_PACK_ALLOWED = new Set([...EXPERIENCE_PACK_REQUIRED, "createdAt", "releasedAt", "withdrawnAt"]);
const MCP_REQUIREMENT_REQUIRED = [
  "schemaVersion", "kind", "requirementId", "catalogId", "reason", "capabilities",
  "required", "requiresKey", "priority", "permissions", "alternatives", "unavailablePolicy",
];
const MCP_REQUIREMENT_ALLOWED = new Set([...MCP_REQUIREMENT_REQUIRED, "credentialMetadata"]);

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

function validateCredentialMetadata(value, label) {
  const allowed = new Set(["provider", "env", "allowedHosts", "scopes", "setupUrl", "brokerMode"]);
  assertExactKeys(value, allowed, ["provider", "env"], label);
  assertId(value.provider, `${label}.provider`);
  if (!Array.isArray(value.env) || !value.env.length || new Set(value.env).size !== value.env.length || value.env.some((key) => !ENV_RE.test(String(key)))) {
    throw new Error(`${label}.env must contain unique uppercase environment names`);
  }
  assertSafeText(value.provider, `${label}.provider`, 255);
  value.env.forEach((key, index) => assertSafeText(key, `${label}.env[${index}]`, 255));
  if (value.allowedHosts != null) {
    if (!Array.isArray(value.allowedHosts) || !value.allowedHosts.length || new Set(value.allowedHosts).size !== value.allowedHosts.length) {
      throw new Error(`${label}.allowedHosts must be a non-empty unique list`);
    }
    const hostRe = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
    for (const host of value.allowedHosts) {
      if (typeof host !== "string" || host.length > 255 || !hostRe.test(host)) throw new Error(`${label}.allowedHosts contains an invalid host`);
      assertSafeText(host, `${label}.allowedHosts`, 255);
    }
  }
  if (value.scopes != null) {
    if (!Array.isArray(value.scopes) || !value.scopes.length || new Set(value.scopes).size !== value.scopes.length) {
      throw new Error(`${label}.scopes must be a non-empty unique list`);
    }
    for (const scope of value.scopes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(String(scope))) throw new Error(`${label}.scopes contains an invalid scope`);
      assertSafeText(scope, `${label}.scopes`, 128);
    }
  }
  if (value.setupUrl != null) {
    let parsed;
    try { parsed = new URL(value.setupUrl); } catch { throw new Error(`${label}.setupUrl must be a safe HTTPS provider page`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      throw new Error(`${label}.setupUrl must be HTTPS without userinfo, custom port, query, or fragment`);
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(parsed.hostname)) {
      throw new Error(`${label}.setupUrl hostname is invalid`);
    }
    assertSafeText(value.setupUrl, `${label}.setupUrl`, 2048);
  }
  if (value.brokerMode != null && !["host-bound-broker", "runtime-env-injection", "provider-managed-oauth", "manual-provider-page"].includes(value.brokerMode)) {
    throw new Error(`${label}.brokerMode is invalid`);
  }
  return value;
}

function validateMcpRequirement(value, label = "mcpRequirement") {
  assertExactKeys(value, MCP_REQUIREMENT_ALLOWED, MCP_REQUIREMENT_REQUIRED, label);
  if (value.schemaVersion !== "agentlas.mcp-requirement.v1" || value.kind !== "agentlas-mcp-requirement") {
    throw new Error(`${label} has an unsupported schema`);
  }
  assertId(value.requirementId, `${label}.requirementId`);
  assertId(value.catalogId, `${label}.catalogId`);
  assertSafeText(value.reason, `${label}.reason`, 300);
  const capabilities = assertUniqueIds(value.capabilities, `${label}.capabilities`, { min: 1 });
  if (typeof value.required !== "boolean" || typeof value.requiresKey !== "boolean") throw new Error(`${label} required/requiresKey must be boolean`);
  if (!Number.isInteger(value.priority) || value.priority < 1 || value.priority > 1000) throw new Error(`${label}.priority is invalid`);
  const permissions = assertUniqueIds(value.permissions, `${label}.permissions`);
  const alternatives = assertUniqueIds(value.alternatives, `${label}.alternatives`);
  if (alternatives.includes(value.catalogId)) throw new Error(`${label}.alternatives must not contain the primary catalogId`);
  [...capabilities, ...permissions, ...alternatives].forEach((text, index) => assertSafeText(text, `${label}.publicText[${index}]`, 255));
  const unavailable = assertObject(value.unavailablePolicy, `${label}.unavailablePolicy`);
  assertExactKeys(unavailable, new Set(["build", "rental", "execution"]), ["build", "rental", "execution"], `${label}.unavailablePolicy`);
  if (unavailable.build !== "degrade") throw new Error(`${label} must degrade rather than abort a build`);
  const expectedRental = value.required ? "exclude-variant" : "continue-degraded";
  if (unavailable.rental !== expectedRental) throw new Error(`${label} rental policy must be ${expectedRental}`);
  if (!["use-alternative", "disable-capability", "continue-degraded"].includes(unavailable.execution)) throw new Error(`${label} execution policy is invalid`);
  if (value.credentialMetadata != null) validateCredentialMetadata(value.credentialMetadata, `${label}.credentialMetadata`);
  if (value.requiresKey && value.credentialMetadata == null) throw new Error(`${label} requires credential metadata`);
  return value;
}

function validateExperiencePack(value) {
  assertExactKeys(value, EXPERIENCE_PACK_ALLOWED, EXPERIENCE_PACK_REQUIRED, "experience pack");
  if (value.schemaVersion !== "agentlas.experience-pack.v1" || value.kind !== "agentlas-experience-pack") {
    throw new Error("experience pack has an unsupported schema");
  }
  for (const key of ["experiencePackId", "releaseId", "ownerRef", "version"]) assertId(value[key], `experience pack.${key}`);
  const base = assertObject(value.baseCompatibility, "experience pack.baseCompatibility");
  assertExactKeys(base, new Set(["agentDefinitionId", "compatibleBaseReleaseIds"]), ["agentDefinitionId", "compatibleBaseReleaseIds"], "experience pack.baseCompatibility");
  assertId(base.agentDefinitionId, "experience pack.baseCompatibility.agentDefinitionId");
  assertUniqueIds(base.compatibleBaseReleaseIds, "experience pack.baseCompatibility.compatibleBaseReleaseIds", { min: 1 });
  assertUniqueIds(value.itemIds, "experience pack.itemIds", { min: value.status === "active" ? 1 : 0 });
  assertUniqueIds(value.evidenceReceiptIds, "experience pack.evidenceReceiptIds");
  if (!Array.isArray(value.mcpRequirements) || value.mcpRequirements.length > 64) throw new Error("experience pack.mcpRequirements is invalid");
  value.mcpRequirements.forEach((requirement, index) => validateMcpRequirement(requirement, `experience pack.mcpRequirements[${index}]`));
  if (value.containsBasePackageMaterial !== false) throw new Error("experience pack must reference the base release; copied base material is forbidden");
  if (!HASH_RE.test(String(value.contentHash || ""))) throw new Error("experience pack.contentHash is invalid");
  if (!["private", "unlisted", "public"].includes(value.visibility)) throw new Error("experience pack.visibility is invalid");
  if (!["draft", "active", "suspended", "withdrawn", "deleted"].includes(value.status)) throw new Error("experience pack.status is invalid");
  for (const key of ["createdAt", "releasedAt", "withdrawnAt"]) if (Object.prototype.hasOwnProperty.call(value, key)) assertIsoDateOrNull(value[key], `experience pack.${key}`);
  return value;
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

function experienceStatePath(userDataDir) {
  return path.join(userDataDir, "terminal", "experience-intents-v1.json");
}

function mcpConsentStatePath(userDataDir) {
  return path.join(userDataDir, "terminal", "mcp-consents-v1.json");
}

function waitSync(milliseconds) {
  // Atomics.wait is a bounded, non-spinning sleep available in supported Node 20+.
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function emptyMcpConsentState() {
  return { schemaVersion: MCP_CONSENT_STATE_SCHEMA, updatedAt: null, receipts: [] };
}

function validateMcpConsentReceipt(receipt, index) {
  const label = `Terminal MCP consent.receipts[${index}]`;
  const keys = ["schemaVersion", "catalogId", "registryServerId", "consentFingerprint", "source", "consentedAt"];
  assertExactKeys(receipt, new Set(keys), keys, label);
  if (receipt.schemaVersion !== MCP_CONSENT_RECEIPT_SCHEMA) throw new Error(`${label}.schemaVersion is invalid`);
  assertId(receipt.catalogId, `${label}.catalogId`);
  assertId(receipt.registryServerId, `${label}.registryServerId`);
  if (!/^[0-9a-f]{64}$/.test(String(receipt.consentFingerprint || ""))) throw new Error(`${label}.consentFingerprint is invalid`);
  if (receipt.source !== "terminal-build-one-pass") throw new Error(`${label}.source is invalid`);
  if (typeof receipt.consentedAt !== "string" || !receipt.consentedAt) throw new Error(`${label}.consentedAt is invalid`);
  assertIsoDateOrNull(receipt.consentedAt, `${label}.consentedAt`);
  return receipt;
}

function loadMcpConsentState(userDataDir) {
  const file = mcpConsentStatePath(userDataDir);
  if (!fs.existsSync(file)) return emptyMcpConsentState();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error("Terminal MCP consent state is unsafe or too large");
  }
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assertExactKeys(state, new Set(["schemaVersion", "updatedAt", "receipts"]), ["schemaVersion", "updatedAt", "receipts"], "Terminal MCP consent state");
  if (state.schemaVersion !== MCP_CONSENT_STATE_SCHEMA || !Array.isArray(state.receipts) || state.receipts.length > 256) {
    throw new Error("Terminal MCP consent state schema is invalid");
  }
  assertIsoDateOrNull(state.updatedAt, "Terminal MCP consent state.updatedAt");
  state.receipts.forEach(validateMcpConsentReceipt);
  return state;
}

function withMcpConsentStateLock(userDataDir, action) {
  const stateFile = mcpConsentStatePath(userDataDir);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const lockFile = `${stateFile}.lock`;
  const deadline = Date.now() + EXPERIENCE_LOCK_WAIT_MS;
  let descriptor = null;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Terminal MCP consent lock is unsafe");
        if (Date.now() - stat.mtimeMs > EXPERIENCE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("Terminal MCP consent state is busy; retry the command");
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

function withExperienceStateLock(userDataDir, action) {
  const stateFile = experienceStatePath(userDataDir);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const lockFile = `${stateFile}.lock`;
  const deadline = Date.now() + EXPERIENCE_LOCK_WAIT_MS;
  let descriptor = null;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Terminal experience lock is unsafe");
        if (Date.now() - stat.mtimeMs > EXPERIENCE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("Terminal experience state is busy; retry the command");
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

function emptyExperienceState() {
  return { schemaVersion: EXPERIENCE_STATE_SCHEMA, updatedAt: null, intents: [] };
}

function loadExperienceState(userDataDir) {
  const file = experienceStatePath(userDataDir);
  if (!fs.existsSync(file)) return emptyExperienceState();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error("Terminal experience state is unsafe or too large");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assertExactKeys(state, new Set(["schemaVersion", "updatedAt", "intents"]), ["schemaVersion", "updatedAt", "intents"], "Terminal experience state");
  if (state.schemaVersion !== EXPERIENCE_STATE_SCHEMA || !Array.isArray(state.intents)) throw new Error("Terminal experience state schema is invalid");
  assertIsoDateOrNull(state.updatedAt, "Terminal experience state.updatedAt");
  state.intents.forEach((intent, index) => validateStoredExperienceIntent(intent, index));
  return state;
}

function validateStoredExperienceIntent(intent, index) {
  const label = `Terminal experience state.intents[${index}]`;
  const required = [
    "schemaVersion", "intentId", "experiencePackId", "releaseId", "ownerRef", "version", "contentHash",
    "compatibleBaseReleaseIds", "mcpRequirementIds", "sourcePath", "desiredAction", "localState", "hubReceipt",
    "contractValidatedAt", "contentVerified", "updatedAt",
  ];
  assertExactKeys(intent, new Set(required), required, label);
  if (intent.schemaVersion !== EXPERIENCE_INTENT_SCHEMA) throw new Error(`${label}.schemaVersion is invalid`);
  for (const key of ["intentId", "experiencePackId", "releaseId", "ownerRef", "version"]) assertId(intent[key], `${label}.${key}`);
  if (!HASH_RE.test(String(intent.contentHash || ""))) throw new Error(`${label}.contentHash is invalid`);
  assertUniqueIds(intent.compatibleBaseReleaseIds, `${label}.compatibleBaseReleaseIds`, { min: 1 });
  assertUniqueIds(intent.mcpRequirementIds, `${label}.mcpRequirementIds`);
  if (typeof intent.sourcePath !== "string" || !path.isAbsolute(intent.sourcePath) || intent.sourcePath.length > 4096 || /[\0\r\n]/.test(intent.sourcePath)) throw new Error(`${label}.sourcePath is invalid`);
  if (!['publish', 'unpublish'].includes(intent.desiredAction)) throw new Error(`${label}.desiredAction is invalid`);
  const expectedState = intent.desiredAction === "publish" ? "publish-requested" : "unpublish-requested";
  if (intent.localState !== expectedState) throw new Error(`${label}.localState is inconsistent`);
  if (intent.hubReceipt !== null) throw new Error(`${label}.hubReceipt cannot be synthesized locally`);
  if (intent.contentVerified !== false) throw new Error(`${label}.contentVerified cannot be asserted from a declaration alone`);
  assertIsoDateOrNull(intent.contractValidatedAt, `${label}.contractValidatedAt`);
  assertIsoDateOrNull(intent.updatedAt, `${label}.updatedAt`);
  return intent;
}

function saveExperienceState(userDataDir, state) {
  state.updatedAt = new Date().toISOString();
  writePrivateJsonAtomic(experienceStatePath(userDataDir), state);
}

function publicExperienceIntent(intent) {
  return {
    schemaVersion: intent.schemaVersion,
    intentId: intent.intentId,
    experiencePackId: intent.experiencePackId,
    releaseId: intent.releaseId,
    ownerRef: intent.ownerRef,
    version: intent.version,
    contentHash: intent.contentHash,
    compatibleBaseReleaseIds: intent.compatibleBaseReleaseIds,
    desiredAction: intent.desiredAction,
    localState: intent.localState,
    hubPublication: { status: "not-submitted", receiptPresent: false },
    updatedAt: intent.updatedAt,
  };
}

function parseSimpleFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === "--json") flags.json = true;
    else if (token.startsWith("--") && token.includes("=")) {
      const at = token.indexOf("=");
      flags[token.slice(2, at)] = token.slice(at + 1);
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      if (index + 1 < args.length && !String(args[index + 1]).startsWith("--")) flags[key] = String(args[++index]);
      else flags[key] = true;
    } else flags._.push(token);
  }
  return flags;
}

function renderExperienceList(intents) {
  if (!intents.length) return "No local Experience Pack publication intents.\nHub publication: not attempted.";
  const lines = ["LOCAL EXPERIENCE INTENTS (Terminal-owned; not Hub publication)"];
  for (const intent of intents) lines.push(`- ${intent.experiencePackId}@${intent.version} · ${intent.localState} · Hub receipt: none`);
  return lines.join("\n");
}

function findIntent(state, ref) {
  const matches = state.intents.filter((intent) => [intent.intentId, intent.experiencePackId, intent.releaseId].includes(ref));
  if (!matches.length) return null;
  return matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

function publishExperienceIntent(userDataDir, sourcePath, cwd) {
  if (!sourcePath) throw new Error("usage: agentlas experience publish <experience-pack.json>");
  const source = path.resolve(cwd || process.cwd(), sourcePath);
  const { absolute, value } = readJsonFile(source, "experience pack");
  const pack = validateExperiencePack(value);
  const now = new Date().toISOString();
  const intentId = `experience-intent:${crypto.createHash("sha256").update(`${pack.releaseId}\0${pack.contentHash}`).digest("hex").slice(0, 32)}`;
  const intent = {
    schemaVersion: EXPERIENCE_INTENT_SCHEMA,
    intentId,
    experiencePackId: pack.experiencePackId,
    releaseId: pack.releaseId,
    ownerRef: pack.ownerRef,
    version: pack.version,
    contentHash: pack.contentHash,
    compatibleBaseReleaseIds: [...pack.baseCompatibility.compatibleBaseReleaseIds],
    mcpRequirementIds: pack.mcpRequirements.map((requirement) => requirement.requirementId),
    sourcePath: absolute,
    desiredAction: "publish",
    localState: "publish-requested",
    hubReceipt: null,
    contractValidatedAt: now,
    contentVerified: false,
    updatedAt: now,
  };
  withExperienceStateLock(userDataDir, () => {
    const state = loadExperienceState(userDataDir);
    const existing = state.intents.findIndex((row) => row.intentId === intentId);
    if (existing >= 0) state.intents[existing] = intent;
    else state.intents.push(intent);
    saveExperienceState(userDataDir, state);
  });
  return publicExperienceIntent(intent);
}

function unpublishExperienceIntent(userDataDir, ref) {
  if (!ref) throw new Error("usage: agentlas experience unpublish <pack-id|release-id|intent-id>");
  let intent;
  withExperienceStateLock(userDataDir, () => {
    const state = loadExperienceState(userDataDir);
    intent = findIntent(state, ref);
    if (!intent) throw new Error(`local Experience Pack intent not found: ${ref}`);
    intent.desiredAction = "unpublish";
    intent.localState = "unpublish-requested";
    intent.hubReceipt = null;
    intent.updatedAt = new Date().toISOString();
    saveExperienceState(userDataDir, state);
  });
  return publicExperienceIntent(intent);
}

function cmdExperience(options) {
  const args = options.args || [];
  const sub = args[0] || "list";
  const flags = parseSimpleFlags(args.slice(1));
  const emit = options.out || console.log;
  const userData = options.userDataDir;
  if (!userData) throw new Error("Terminal userData path is required");
  if (sub === "list" || sub === "ls") {
    const list = loadExperienceState(userData).intents.map(publicExperienceIntent);
    emit(flags.json ? JSON.stringify({ localOnly: true, hubPublicationAttempted: false, intents: list }, null, 2) : renderExperienceList(list));
    return list;
  }
  if (sub === "inspect" || sub === "show") {
    const ref = flags._[0];
    if (!ref) throw new Error("usage: agentlas experience inspect <pack-id|release-id|intent-id>");
    const intent = findIntent(loadExperienceState(userData), ref);
    if (!intent) throw new Error(`local Experience Pack intent not found: ${ref}`);
    const projected = publicExperienceIntent(intent);
    emit(flags.json ? JSON.stringify(projected, null, 2) : [
      `${projected.experiencePackId}@${projected.version}`,
      `release: ${projected.releaseId}`,
      `local intent: ${projected.desiredAction} (${projected.localState})`,
      "Hub publication: not submitted · server receipt: none",
      "base package: referenced only (not copied)",
    ].join("\n"));
    return projected;
  }
  if (sub === "publish") {
    const intent = publishExperienceIntent(userData, flags._[0], options.cwd);
    emit(flags.json ? JSON.stringify(intent, null, 2) : [
      `Local publish intent saved: ${intent.experiencePackId}@${intent.version}`,
      "Hub publication: NOT performed · server receipt: none",
      "Use the Hub API/UI later; this command does not claim remote publication.",
    ].join("\n"));
    return intent;
  }
  if (sub === "unpublish") {
    const intent = unpublishExperienceIntent(userData, flags._[0]);
    emit(flags.json ? JSON.stringify(intent, null, 2) : [
      `Local unpublish intent saved: ${intent.experiencePackId}@${intent.version}`,
      "Hub state: unchanged · no server request or receipt was created.",
    ].join("\n"));
    return intent;
  }
  throw new Error(`unknown experience subcommand: ${sub} (list|inspect|publish|unpublish)`);
}

function readCredentialNames(userDataDir, env = process.env) {
  const names = new Set(Object.keys(env || {}).filter((key) => ENV_RE.test(key) && env[key]));
  const files = [
    path.join(userDataDir, "credentials.env"),
    path.join(os.homedir(), ".agentlas", "credentials.env"),
  ];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        let observed = match[2];
        if ((observed.startsWith('"') && observed.endsWith('"')) || (observed.startsWith("'") && observed.endsWith("'"))) observed = observed.slice(1, -1);
        if (observed) names.add(match[1]);
      }
    } catch { /* absent/unreadable means no observed key */ }
  }
  return names;
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

function collectSystemMcpInventory(db, options = {}) {
  let rows = [];
  let registryStatus = "complete";
  try {
    rows = db.prepare("SELECT id, catalog_id, name, name_en, transport, env_keys_json, enabled FROM mcp_servers ORDER BY installed_at ASC LIMIT 1025").all();
  } catch {
    // An unreadable registry is not the same fact as a readable empty registry.
    // Both fail closed to empty-MCP, but the user-facing plan preserves the cause.
    registryStatus = "unavailable";
  }
  if (!Array.isArray(rows)) {
    rows = [];
    registryStatus = "unavailable";
  }
  if (rows.length > 1024) {
    rows = [];
    registryStatus = "unavailable";
  }
  const credentialNames = readCredentialNames(options.userDataDir || "", options.env || process.env);
  const inventory = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || Number(row.enabled) === 0) continue;
    const catalogId = safeCatalogId(row.catalog_id) || safeCatalogId(row.id);
    if (!catalogId || seen.has(catalogId)) continue;
    seen.add(catalogId);
    let keyNames = [];
    let credentialMetadataStatus = "complete";
    try {
      if (String(row.env_keys_json || "[]").length > 64 * 1024) throw new Error("credential metadata too large");
      const parsed = JSON.parse(row.env_keys_json || "[]");
      keyNames = normalizeCredentialKeyNames(parsed);
    } catch { credentialMetadataStatus = "unavailable"; }
    const item = {
      catalogId,
      name: safeDisplayName(row.name || row.name_en, catalogId),
      source: "system-global",
      enabled: true,
      keyRequired: credentialMetadataStatus !== "complete" || keyNames.length > 0,
      keyPresent: credentialMetadataStatus === "complete" && (keyNames.length === 0 || keyNames.every((key) => credentialNames.has(key))),
      credentialMetadataStatus,
    };
    Object.defineProperty(item, "registryServerId", { value: String(row.id), enumerable: false });
    Object.defineProperty(item, "transport", { value: String(row.transport || ""), enumerable: false });
    Object.defineProperty(item, "credentialKeyNames", { value: keyNames, enumerable: false });
    Object.defineProperty(item, "credentialKeyFingerprint", {
      value: crypto.createHash("sha256").update(JSON.stringify(keyNames), "utf8").digest("hex"),
      enumerable: false,
    });
    inventory.push(item);
  }
  Object.defineProperty(inventory, "registryStatus", { value: registryStatus, enumerable: false });
  return inventory;
}

function validateMcpPolicy(value) {
  const required = [
    "schemaVersion", "kind", "registryResolutionOrder", "consentMode", "serverDefinitionsFromPackage",
    "credentialValuesAllowed", "failureIsolation", "permissionWidening", "toolSchemaLoading", "skillLoading",
    "contextBudget", "requirements",
  ];
  assertExactKeys(value, new Set(required), required, "MCP policy");
  if (value.schemaVersion !== "agentlas.mcp-policy.v1" || value.kind !== "agentlas-mcp-policy") throw new Error("MCP policy schema is invalid");
  if (!Array.isArray(value.registryResolutionOrder) || value.registryResolutionOrder[0] !== "system-global") throw new Error("MCP policy must resolve system-global inventory first");
  const allowedLayers = new Set(["system-global", "project-local", "catalog-recommendation"]);
  if (new Set(value.registryResolutionOrder).size !== value.registryResolutionOrder.length || value.registryResolutionOrder.some((layer) => !allowedLayers.has(layer))) throw new Error("MCP policy registry order is invalid");
  if (value.consentMode !== "one-pass" || value.serverDefinitionsFromPackage !== false || value.credentialValuesAllowed !== false || value.failureIsolation !== "per-requirement") throw new Error("MCP policy weakens the frozen safety boundary");
  if (value.permissionWidening !== "ask" || value.toolSchemaLoading !== "selected-tools-only" || value.skillLoading !== "triggered-only") throw new Error("MCP policy loading/permission mode is invalid");
  const budget = assertObject(value.contextBudget, "MCP policy.contextBudget");
  assertExactKeys(budget, new Set(Object.keys(TOKEN_BUDGET)), Object.keys(TOKEN_BUDGET), "MCP policy.contextBudget");
  for (const [key, max] of Object.entries(TOKEN_BUDGET)) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0 || budget[key] > max) throw new Error(`MCP policy.contextBudget.${key} exceeds the frozen maximum`);
  }
  if (!Array.isArray(value.requirements) || value.requirements.length > 64) throw new Error("MCP policy requirements are invalid");
  value.requirements.forEach((requirement, index) => validateMcpRequirement(requirement, `MCP policy.requirements[${index}]`));
  const requirementIds = value.requirements.map((requirement) => requirement.requirementId);
  if (new Set(requirementIds).size !== requirementIds.length) throw new Error("MCP policy requirementId values must be unique");
  return value;
}

function loadProjectMcpPolicy(cwd) {
  const file = path.join(cwd || process.cwd(), ".agentlas", "mcp-policy.json");
  if (!fs.existsSync(file)) return null;
  const { value } = readJsonFile(file, "MCP policy");
  return validateMcpPolicy(value);
}

function syntheticRequirement(catalogId, required, priority) {
  const suffix = crypto.createHash("sha256").update(catalogId).digest("hex").slice(0, 24);
  return {
    schemaVersion: "agentlas.mcp-requirement.v1",
    kind: "agentlas-mcp-requirement",
    requirementId: `terminal-requirement:${suffix}`,
    catalogId,
    reason: required ? "Explicitly required for this Terminal build" : "Explicitly recommended for this Terminal build",
    capabilities: [`terminal-mcp:${suffix}`],
    required,
    requiresKey: false,
    priority,
    permissions: [],
    alternatives: [],
    unavailablePolicy: {
      build: "degrade",
      rental: required ? "exclude-variant" : "continue-degraded",
      execution: required ? "use-alternative" : "continue-degraded",
    },
  };
}

const HEURISTIC_GROUPS = [
  [/(browser|playwright|chrome|web)/i, /(?:browser|website|web page|웹|브라우저|사이트|페이지|로그인)/i],
  [/(github|gitlab|source)/i, /(?:github|gitlab|repository|pull request|issue|깃허브|레포|저장소)/i],
  [/(figma|design)/i, /(?:figma|mockup|design|ui|ux|피그마|디자인)/i],
  [/(postgres|mysql|sqlite|database|mongo)/i, /(?:database|sql|query|schema|db|데이터베이스|쿼리)/i],
  [/(notion|docs|drive)/i, /(?:notion|document|docs|drive|노션|문서|드라이브)/i],
  [/(slack|teams|discord)/i, /(?:slack|teams|discord|message|슬랙|메시지)/i],
  [/(search|research)/i, /(?:search|research|lookup|검색|리서치|조사)/i],
];

function inferRequirements(request, inventory) {
  const text = String(request || "");
  const results = [];
  for (const item of inventory) {
    const direct = text.toLowerCase().includes(item.catalogId.toLowerCase()) || text.toLowerCase().includes(item.name.toLowerCase());
    const heuristic = HEURISTIC_GROUPS.some(([nameRe, taskRe]) => nameRe.test(`${item.catalogId} ${item.name}`) && taskRe.test(text));
    if (direct || heuristic) results.push(syntheticRequirement(item.catalogId, false, results.length + 100));
  }
  return results.slice(0, 8);
}

function indexInventory(inventory) {
  return new Map((inventory || []).map((item) => [item.catalogId, item]));
}

function resolveMcpRequirement(requirement, inventoryById) {
  const order = [requirement.catalogId, ...(requirement.alternatives || [])];
  const attempted = [];
  const candidates = [];
  for (const catalogId of order) {
    const item = inventoryById.get(catalogId);
    if (!item) {
      attempted.push({ catalogId, status: "unavailable" });
      continue;
    }
    if (item.transport !== "stdio") {
      attempted.push({ catalogId, status: "runtime-incompatible" });
      continue;
    }
    const keyRequired = requirement.requiresKey || item.keyRequired;
    // The trusted registry owns credential mapping. A package cannot turn an
    // uncredentialed registry row into "key present" merely by declaring env metadata.
    const keyPresent = keyRequired ? (item.keyRequired && item.keyPresent) : true;
    if (!keyPresent) {
      attempted.push({ catalogId, status: "missing-key" });
      continue;
    }
    candidates.push({ item, keyRequired, keyPresent: true });
  }
  if (candidates.length) {
    return {
      selected: candidates[0].item,
      candidates,
      status: "available",
      attempted,
      keyRequired: candidates[0].keyRequired,
      keyPresent: true,
    };
  }
  const primary = inventoryById.get(requirement.catalogId);
  const keyRequired = requirement.requiresKey || Boolean(primary && primary.keyRequired);
  const missingKey = attempted.some((attempt) => attempt.status === "missing-key");
  return { selected: null, candidates: [], status: missingKey ? "missing-key" : "unavailable", attempted, keyRequired, keyPresent: false };
}

function buildMcpPlan(options) {
  const inventory = options.inventory || [];
  const inventoryById = indexInventory(inventory);
  const policyRequirements = options.policy ? options.policy.requirements : [];
  const requirements = [...policyRequirements];
  const known = new Set(requirements.map((requirement) => requirement.catalogId));
  for (const catalogId of options.requiredIds || []) {
    assertId(catalogId, "--require-mcp");
    if (!known.has(catalogId)) { requirements.push(syntheticRequirement(catalogId, true, 1)); known.add(catalogId); }
  }
  for (const catalogId of options.recommendedIds || []) {
    assertId(catalogId, "--recommend-mcp");
    if (!known.has(catalogId)) { requirements.push(syntheticRequirement(catalogId, false, 500)); known.add(catalogId); }
  }
  if (!requirements.length) requirements.push(...inferRequirements(options.request, inventory));
  const entries = requirements
    .map((requirement) => {
      const resolution = resolveMcpRequirement(requirement, inventoryById);
      const entry = {
        requirementId: requirement.requirementId,
        requestedCatalogId: requirement.catalogId,
        resolvedCatalogId: resolution.selected ? resolution.selected.catalogId : null,
        name: resolution.selected ? resolution.selected.name : requirement.catalogId,
        source: resolution.selected ? resolution.selected.source : null,
        required: requirement.required,
        priority: requirement.priority,
        reason: requirement.reason,
        status: resolution.status,
        keyRequired: resolution.keyRequired,
        keyPresent: resolution.keyRequired ? resolution.keyPresent : null,
        permissions: [...(requirement.permissions || [])],
        permissionBasis: "package-declared",
        permissionEnforced: false,
        fallbackCatalogIds: resolution.candidates.slice(1).map((candidate) => candidate.item.catalogId),
        alternativesTried: resolution.attempted.map((attempt) => ({ catalogId: attempt.catalogId, status: attempt.status })),
        unavailableBuildPolicy: "degrade",
      };
      Object.defineProperty(entry, "registryServerId", {
        value: resolution.selected?.registryServerId || null,
        enumerable: false,
      });
      Object.defineProperty(entry, "credentialKeyFingerprint", {
        value: resolution.selected?.credentialKeyFingerprint || null,
        enumerable: false,
      });
      Object.defineProperty(entry, "runtimeCandidates", {
        value: resolution.candidates.map((candidate) => ({
          resolvedCatalogId: candidate.item.catalogId,
          registryServerId: candidate.item.registryServerId || null,
          credentialKeyFingerprint: candidate.item.credentialKeyFingerprint || null,
        })),
        enumerable: false,
      });
      return entry;
    })
    .sort((a, b) => Number(b.required) - Number(a.required) || a.priority - b.priority || a.requestedCatalogId.localeCompare(b.requestedCatalogId));
  return {
    schemaVersion: "agentlas.terminal-mcp-build-plan.v1",
    planId: crypto.randomUUID(),
    registryStatus: options.registryStatus || inventory.registryStatus || "complete",
    registryResolutionOrder: options.policy ? [...options.policy.registryResolutionOrder] : ["system-global"],
    discoveryNetworkUsed: false,
    consentMode: "one-pass",
    entries,
    availableCatalogIds: [...new Set(entries.flatMap((entry) =>
      entry.status === "available" ? (entry.runtimeCandidates || []).map((candidate) => candidate.resolvedCatalogId) : []
    ))],
    maxApprovedMcp: MAX_APPROVED_MCP_PER_BUILD,
    shortages: entries.filter((entry) => entry.status !== "available").map((entry) => ({
      requirementId: entry.requirementId,
      catalogId: entry.requestedCatalogId,
      required: entry.required,
      status: entry.status,
      effect: "build-degraded-only",
    })),
  };
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

function materializeTrustedSystemMcpServer(row, options = {}) {
  const catalogId = safeCatalogId(row?.catalog_id) || safeCatalogId(row?.id);
  const registryServerId = String(row?.id || "");
  const args = parseRuntimeServerArgs(row?.args_json || "[]");
  let credentialKeyNames = null;
  try {
    if (String(row?.env_keys_json || "[]").length > 64 * 1024) throw new Error("credential metadata too large");
    credentialKeyNames = normalizeCredentialKeyNames(JSON.parse(row?.env_keys_json || "[]"));
  } catch { /* fail closed below */ }
  if (
    !row || !catalogId || !ID_RE.test(registryServerId) || Number(row.enabled) === 0 || row.transport !== "stdio" || typeof row.command !== "string" ||
    !row.command.trim() || row.command.length > 4096 || /[\u0000\r\n]/.test(row.command) || !args ||
    !credentialKeyNames || hasSensitiveRuntimeArgument(row.command, args)
  ) return null;
  const server = {
    id: registryServerId,
    catalog_id: catalogId,
    name: catalogId,
    transport: "stdio",
    command: row.command,
    args_json: JSON.stringify(args),
    enabled: 1,
  };
  Object.defineProperty(server, "credentialKeyNames", { value: credentialKeyNames, enumerable: false });
  Object.defineProperty(server, "credentialKeyFingerprint", {
    value: crypto.createHash("sha256").update(JSON.stringify(credentialKeyNames), "utf8").digest("hex"),
    enumerable: false,
  });
  Object.defineProperty(server, "consentFingerprint", {
    value: crypto.createHash("sha256").update(JSON.stringify({
      schemaVersion: "agentlas.terminal-mcp-consent-fingerprint.v1",
      registryServerId,
      catalogId,
      transport: "stdio",
      command: row.command,
      args,
      credentialKeyNames,
    }), "utf8").digest("hex"),
    enumerable: false,
  });
  if (options.createRuntimeHome !== false) {
    Object.defineProperty(server, "mcpRuntimeHome", {
      value: mcpRuntimeHome(options.userDataDir, `${catalogId}\0${row.id}`),
      enumerable: false,
    });
  }
  return server;
}

function persistMcpConsentReceipts(userDataDir, servers) {
  if (!userDataDir || !(servers || []).length) return false;
  withMcpConsentStateLock(userDataDir, () => {
    const state = loadMcpConsentState(userDataDir);
    const now = new Date().toISOString();
    for (const server of servers) {
      if (!server || !ID_RE.test(String(server.id || "")) || !safeCatalogId(server.catalog_id) || !/^[0-9a-f]{64}$/.test(String(server.consentFingerprint || ""))) continue;
      const receipt = {
        schemaVersion: MCP_CONSENT_RECEIPT_SCHEMA,
        catalogId: server.catalog_id,
        registryServerId: server.id,
        consentFingerprint: server.consentFingerprint,
        source: "terminal-build-one-pass",
        consentedAt: now,
      };
      const existing = state.receipts.findIndex((item) => item.catalogId === receipt.catalogId && item.registryServerId === receipt.registryServerId);
      if (existing >= 0) state.receipts[existing] = receipt;
      else state.receipts.push(receipt);
    }
    state.receipts.sort((a, b) => String(b.consentedAt).localeCompare(String(a.consentedAt)) || a.catalogId.localeCompare(b.catalogId));
    state.receipts = state.receipts.slice(0, 256);
    state.updatedAt = now;
    writePrivateJsonAtomic(mcpConsentStatePath(userDataDir), state);
  });
  return true;
}

function readConsentedSystemMcpServers(db, options = {}) {
  let state;
  try { state = loadMcpConsentState(options.userDataDir); }
  catch { return []; }
  const servers = [];
  const seen = new Set();
  for (const receipt of state.receipts) {
    if (seen.has(receipt.catalogId)) continue;
    let row = null;
    try {
      row = db.prepare(
        "SELECT id, catalog_id, name, name_en, transport, command, args_json, env_keys_json, enabled FROM mcp_servers WHERE id=? LIMIT 1",
      ).get(receipt.registryServerId);
    } catch { continue; }
    const server = materializeTrustedSystemMcpServer(row, options);
    if (
      !server || server.id !== receipt.registryServerId || server.catalog_id !== receipt.catalogId ||
      server.consentFingerprint !== receipt.consentFingerprint
    ) continue;
    seen.add(receipt.catalogId);
    servers.push(server);
  }
  return servers;
}

/**
 * Post-consent only. Re-read the exact trusted system-global row with executable
 * fields; no package/catalog content can supply this material.
 */
function readApprovedSystemMcpServer(db, entry, options = {}) {
  if (!entry?.registryServerId || !entry.resolvedCatalogId) return null;
  let row = null;
  try {
    row = db.prepare(
      "SELECT id, catalog_id, name, name_en, transport, command, args_json, env_keys_json, enabled FROM mcp_servers WHERE id=? LIMIT 1",
    ).get(entry.registryServerId);
  } catch {
    return null;
  }
  const server = materializeTrustedSystemMcpServer(row, options);
  if (
    !server || String(row.id) !== entry.registryServerId || server.catalog_id !== entry.resolvedCatalogId ||
    !entry.credentialKeyFingerprint || server.credentialKeyFingerprint !== entry.credentialKeyFingerprint
  ) return null;
  return server;
}

function probeSystemMcpServerConnection(server, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(50, Math.min(30_000, Math.trunc(requestedTimeout)))
    : MCP_PROBE_PER_SERVER_TIMEOUT_MS;
  const spawnImpl = options.spawn || spawn;
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let initialized = false;
    let abortHandler = null;
    let forceKillTimer = null;
    let childClosed = false;
    const terminateChild = (signal) => {
      const pid = Number(child?.pid);
      if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
        try { process.kill(-pid, signal); return; } catch { /* fall through */ }
      }
      try { child?.kill(signal); } catch { /* noop */ }
    };
    const finish = (connected, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal && abortHandler) options.signal.removeEventListener?.("abort", abortHandler);
      try { child?.stdin?.end(); } catch { /* noop */ }
      if (!childClosed) {
        terminateChild("SIGTERM");
        forceKillTimer = setTimeout(() => terminateChild("SIGKILL"), 250);
        forceKillTimer.unref?.();
      }
      resolve({ connected, reason });
    };
    const onMessage = (message) => {
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id === 1) {
        if (message.error || !message.result) return finish(false, "initialize_failed");
        initialized = true;
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } catch {
          finish(false, "connection_failed");
        }
      } else if (message.id === 2 && initialized) {
        finish(!message.error && Boolean(message.result), message.error ? "tools_list_failed" : "connected");
      }
    };
    const drain = () => {
      while (buffer.length) {
        const header = buffer.toString("ascii", 0, Math.min(buffer.length, 64 * 1024)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
        if (header) {
          const headerBytes = Buffer.byteLength(header[0], "ascii");
          const bodyBytes = Number(header[1]);
          if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 1024 * 1024) return finish(false, "invalid_protocol_frame");
          if (buffer.length < headerBytes + bodyBytes) return;
          const body = buffer.subarray(headerBytes, headerBytes + bodyBytes).toString("utf8");
          buffer = buffer.subarray(headerBytes + bodyBytes);
          try { onMessage(JSON.parse(body)); } catch { /* ignore non-JSON noise */ }
          continue;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8").trim();
        buffer = buffer.subarray(newline + 1);
        if (!line || /^Content-Length:/i.test(line)) continue;
        try { onMessage(JSON.parse(line)); } catch { /* ignore banners */ }
      }
    };
    const timer = setTimeout(() => finish(false, "connection_timeout"), timeoutMs);
    try {
      child = spawnImpl(server.command, parseRuntimeServerArgs(server.args_json) || [], {
        cwd: options.cwd || process.cwd(),
        env: buildMcpChildEnv(options.env || process.env, server.credentialKeyNames || [], {
          runtimeHome: server.mcpRuntimeHome || mcpRuntimeHome(options.userDataDir, server.catalog_id || server.id || server.command),
        }),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.once("error", () => finish(false, "connection_failed"));
      child.once("close", () => {
        childClosed = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        forceKillTimer = null;
        finish(false, "connection_closed");
      });
      child.stdout.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > 1024 * 1024) return finish(false, "protocol_output_limit");
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        drain();
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agentlas-terminal-build", version: "1" },
        },
      })}\n`);
      if (options.signal) {
        abortHandler = () => finish(false, "connection_timeout");
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener?.("abort", abortHandler, { once: true });
      }
    } catch {
      finish(false, "connection_failed");
    }
  });
}

async function resolveApprovedMcpRuntimeAllowlist(options) {
  const approved = new Set(options.approvedIds || []);
  const selectedGroups = (options.plan?.entries || []).map((entry) => {
    if (entry.status !== "available") return null;
    const candidates = Array.isArray(entry.runtimeCandidates) && entry.runtimeCandidates.length
      ? entry.runtimeCandidates
      : [{
          resolvedCatalogId: entry.resolvedCatalogId,
          registryServerId: entry.registryServerId,
          credentialKeyFingerprint: entry.credentialKeyFingerprint,
        }];
    const approvedCandidates = candidates.filter(
      (candidate) => candidate.resolvedCatalogId && approved.has(candidate.resolvedCatalogId),
    );
    return approvedCandidates.length ? { entry, candidates: approvedCandidates } : null;
  }).filter(Boolean);
  const probe = options.probeServer || ((server, probeOptions = {}) => probeSystemMcpServerConnection(server, {
    cwd: options.cwd,
    env: options.env,
    userDataDir: options.userDataDir,
    timeoutMs: probeOptions.timeoutMs,
    signal: probeOptions.signal,
  }));
  const bounded = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
  };
  const concurrency = bounded(options.probeConcurrency, MCP_PROBE_CONCURRENCY, 1, MAX_APPROVED_MCP_PER_BUILD);
  const perServerTimeoutMs = bounded(options.probeTimeoutMs, MCP_PROBE_PER_SERVER_TIMEOUT_MS, 50, 30_000);
  const totalTimeoutMs = bounded(options.totalProbeTimeoutMs, MCP_PROBE_TOTAL_TIMEOUT_MS, 50, 60_000);
  const deadline = Date.now() + totalTimeoutMs;
  const outcomes = new Array(selectedGroups.length);
  let nextIndex = 0;

  const probeCandidate = async (candidate) => {
    let server = null;
    try { server = readApprovedSystemMcpServer(options.db, candidate, { userDataDir: options.userDataDir }); }
    catch { /* one unsafe/unwritable runtime boundary excludes only this server */ }
    if (!server) return { candidate, server: null, status: { connected: false, reason: "registry_row_unavailable" } };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { candidate, server, status: { connected: false, reason: "probe_total_deadline" } };
    const timeoutMs = Math.min(perServerTimeoutMs, remainingMs);
    const controller = new AbortController();
    let timer = null;
    let status;
    try {
      status = await Promise.race([
        Promise.resolve(probe(server, { timeoutMs, signal: controller.signal })),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ connected: false, reason: "connection_timeout" });
          }, timeoutMs);
        }),
      ]);
    } catch {
      status = { connected: false, reason: "connection_failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { candidate, server, status };
  };

  // Different requirements use a small worker pool. Alternatives for one
  // requirement are deliberately sequential so a failed primary cannot fan
  // out package-manager processes or affect unrelated server groups.
  const work = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= selectedGroups.length) return;
      const group = selectedGroups[index];
      const attempts = [];
      for (const candidate of group.candidates) {
        const outcome = await probeCandidate(candidate);
        attempts.push(outcome);
        if (outcome.status?.connected) break;
      }
      outcomes[index] = { entry: group.entry, attempts };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selectedGroups.length) }, () => work()));

  const attached = [];
  const failed = [];
  const servers = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index] || {
      entry: selectedGroups[index]?.entry,
      attempts: [],
    };
    for (const attempt of outcome.attempts) {
      const catalogId = attempt.candidate.resolvedCatalogId;
      if (!attempt.status?.connected) {
        failed.push({ catalogId, reason: safeCatalogId(attempt.status?.reason) || "connection_failed" });
        continue;
      }
      attached.push({ catalogId, registryServerId: attempt.server.id, status: "connected" });
      servers.push(attempt.server);
      break;
    }
  }
  let consentPersisted = servers.length === 0;
  if (servers.length) {
    try { consentPersisted = persistMcpConsentReceipts(options.userDataDir, servers); }
    catch { consentPersisted = false; }
  }
  const receipt = {
    schemaVersion: "agentlas.terminal-mcp-runtime-allowlist.v1",
    planId: options.plan?.planId || null,
    approvedCatalogIds: [...approved].sort(),
    attached,
    failed,
    emptyMode: attached.length === 0,
    consentPersisted,
  };
  Object.defineProperty(receipt, "servers", { value: servers, enumerable: false });
  return receipt;
}

function parseIdList(value) {
  if (!value || value === true) return [];
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function tokenizeBuildCommandLine(value) {
  const tokens = [];
  let current = "";
  let quote = null;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && quote !== "'") {
      const next = source[index + 1];
      if (next && (/\s/.test(next) || next === "\\" || next === '"' || next === "'")) {
        current += next;
        index += 1;
      } else {
        // Preserve Windows paths and ordinary backslashes. This parser only
        // consumes escapes needed to group command-line tokens; it never
        // applies shell expansion or command substitution.
        current += "\\";
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current), current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote in /build command");
  if (current) tokens.push(current);
  return tokens;
}

function parseBuildArgs(args) {
  const buildArgs = args;
  const options = {
    task: [], requiredIds: [], recommendedIds: [], approvedIds: [],
    experienceTaskSignatures: [], experienceEnvironmentTags: [],
    experiencePackReleaseIds: [], experienceBaseReleaseId: null, experienceAgentDefinitionId: null,
    approveAll: false, noMcp: false, noExperience: false, planOnly: false, json: false,
  };
  for (let index = 0; index < buildArgs.length; index += 1) {
    const token = String(buildArgs[index]);
    const take = () => (index + 1 < buildArgs.length ? String(buildArgs[++index]) : "");
    if (token === "--mcp-plan-only") options.planOnly = true;
    else if (token === "--mcp-json") options.json = true;
    else if (token === "--approve-all-mcp") options.approveAll = true;
    else if (token === "--no-mcp") options.noMcp = true;
    else if (token === "--no-experience") options.noExperience = true;
    else if (token === "--experience-base-release") options.experienceBaseReleaseId = take();
    else if (token.startsWith("--experience-base-release=")) options.experienceBaseReleaseId = token.slice(26);
    else if (token === "--experience-pack-release") options.experiencePackReleaseIds.push(...parseIdList(take()));
    else if (token.startsWith("--experience-pack-release=")) options.experiencePackReleaseIds.push(...parseIdList(token.slice(26)));
    else if (token === "--experience-agent-definition") options.experienceAgentDefinitionId = take();
    else if (token.startsWith("--experience-agent-definition=")) options.experienceAgentDefinitionId = token.slice(30);
    else if (token === "--experience-task-signature") options.experienceTaskSignatures.push(...parseIdList(take()));
    else if (token.startsWith("--experience-task-signature=")) options.experienceTaskSignatures.push(...parseIdList(token.slice(28)));
    else if (token === "--experience-environment") options.experienceEnvironmentTags.push(...parseIdList(take()));
    else if (token.startsWith("--experience-environment=")) options.experienceEnvironmentTags.push(...parseIdList(token.slice(25)));
    else if (token === "--approve-mcp") options.approvedIds.push(...parseIdList(take()));
    else if (token.startsWith("--approve-mcp=")) options.approvedIds.push(...parseIdList(token.slice(14)));
    else if (token === "--require-mcp") options.requiredIds.push(...parseIdList(take()));
    else if (token.startsWith("--require-mcp=")) options.requiredIds.push(...parseIdList(token.slice(14)));
    else if (token === "--recommend-mcp") options.recommendedIds.push(...parseIdList(take()));
    else if (token.startsWith("--recommend-mcp=")) options.recommendedIds.push(...parseIdList(token.slice(16)));
    else options.task.push(token);
  }
  options.request = options.task.join(" ").trim();
  options.requiredIds = [...new Set(options.requiredIds)];
  options.recommendedIds = [...new Set(options.recommendedIds)];
  options.approvedIds = [...new Set(options.approvedIds)];
  options.experienceTaskSignatures = [...new Set(options.experienceTaskSignatures)];
  options.experienceEnvironmentTags = [...new Set(options.experienceEnvironmentTags)];
  options.experiencePackReleaseIds = [...new Set(options.experiencePackReleaseIds)];
  if (options.experienceBaseReleaseId) assertId(options.experienceBaseReleaseId, "--experience-base-release");
  if (options.experienceAgentDefinitionId) assertId(options.experienceAgentDefinitionId, "--experience-agent-definition");
  options.experiencePackReleaseIds.forEach((id) => assertId(id, "--experience-pack-release"));
  return options;
}

function renderMcpPlan(plan) {
  const lines = [`MCP BUILD PLAN · system-global registry first · registry: ${plan.registryStatus} · no network discovery`];
  if (plan.registryStatus === "unavailable") lines.push("- System-global registry could not be read. Build continues safely in empty-MCP mode; no install/network fallback was attempted.");
  if (!plan.entries.length) lines.push("- No relevant MCP recommended. Build continues in empty-MCP mode.");
  for (const entry of plan.entries) {
    const key = entry.keyRequired ? (entry.keyPresent ? "key: present" : "key: missing") : "key: not needed";
    const requirement = entry.required ? "required" : "optional";
    const permissions = entry.permissions.length ? entry.permissions.join(",") : "none";
    lines.push(`- P${entry.priority} ${entry.name} [${entry.resolvedCatalogId || entry.requestedCatalogId}] · ${requirement} · ${entry.status} · ${key}`);
    lines.push(`  ${entry.reason}`);
    if (entry.fallbackCatalogIds?.length) lines.push(`  approved fallback order: ${entry.fallbackCatalogIds.join(",")}`);
    lines.push(`  permissions: ${permissions} · declared only; host enforcement not yet verified`);
  }
  if (plan.shortages.length) lines.push(`Shortages are isolated: ${plan.shortages.length} requirement(s) degrade only; the build does not abort.`);
  lines.push("Recommendation only: no MCP is attached until one explicit consent; this plan performs no network key probe or install.");
  return lines.join("\n");
}

function normalizeConsentAnswer(answer, availableIds) {
  const text = String(answer || "").trim();
  if (/^(?:y|yes|all|전체)$/i.test(text)) return [...availableIds];
  if (!text || /^(?:n|no|none|없이|아니)$/i.test(text)) return [];
  const requested = parseIdList(text);
  const allowed = new Set(availableIds);
  return requested.filter((id) => allowed.has(id));
}

function askMcpConsentOnce(plan, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stderr;
  if (!input.isTTY || !output.isTTY || !plan.availableCatalogIds.length) return Promise.resolve([]);
  const rl = readline.createInterface({ input, output, terminal: true });
  return new Promise((resolve) => {
    rl.question("Attach the available MCP recommendations? [y=all / n=none / comma-separated ids] ", (answer) => {
      rl.close();
      resolve(normalizeConsentAnswer(answer, plan.availableCatalogIds));
    });
  });
}

function buildMcpDirective(plan, approvedIds) {
  const approved = fitApprovedMcpIds(plan, approvedIds);
  const shortages = plan.shortages.map((item) => item.catalogId);
  const base = [
    "[AGENTLAS_MCP_BUILD_CONTEXT v1]",
    "Resolve MCP only from the host system-global registry; package IDs/requirements only, never server definitions or credentials.",
  ].join(" ");
  const approvedClause = `Approved catalog IDs: ${approved.length ? approved.join(",") : "none"}.`;
  const shortagePrefix = "Unavailable or missing-key IDs: ";
  const shortageSuffix = "; degrade each capability independently and continue the build.";
  const fittedShortages = [];
  for (const id of shortages.slice(0, 16)) {
    const omitted = shortages.length - fittedShortages.length - 1;
    const proposal = `${shortagePrefix}${fittedShortages.concat(id).join(",")}${omitted > 0 ? ` (+${omitted} more)` : ""}${shortageSuffix}`;
    if (`${base} ${approvedClause} ${proposal}`.length > MAX_BUILD_DIRECTIVE_CHARS) break;
    fittedShortages.push(id);
  }
  const omittedShortages = shortages.length - fittedShortages.length;
  const shortageValue = shortages.length === 0
    ? "none"
    : fittedShortages.length
      ? `${fittedShortages.join(",")}${omittedShortages > 0 ? ` (+${omittedShortages} more)` : ""}`
      : `${shortages.length} unresolved (IDs omitted from prompt; declared policy remains source)`;
  const shortageClause = `${shortagePrefix}${shortageValue}${shortageSuffix}`;
  const line = `${base} ${approvedClause} ${shortageClause}`;
  if (line.length > MAX_BUILD_DIRECTIVE_CHARS) throw new Error("internal MCP builder directive exceeded its context limit");
  return line;
}

function fitApprovedMcpIds(plan, requestedIds) {
  const available = new Set(plan.availableCatalogIds || []);
  const requested = [...new Set((requestedIds || []).filter((id) => available.has(id)))].slice(0, MAX_APPROVED_MCP_PER_BUILD);
  const accepted = [];
  const fixedReserve = 520; // frozen instruction + minimum shortage/degrade clause
  for (const id of requested) {
    const clause = `Approved catalog IDs: ${accepted.concat(id).join(",")}.`;
    if (clause.length + fixedReserve > MAX_BUILD_DIRECTIVE_CHARS) break;
    accepted.push(id);
  }
  return accepted;
}

function renderBuildMcpResult(plan, approvedIds, runtimeAllowlist = null) {
  const approved = new Set(approvedIds || []);
  const attached = new Set((runtimeAllowlist?.attached || []).map((item) => item.catalogId));
  const failed = new Map((runtimeAllowlist?.failed || []).map((item) => [item.catalogId, item.reason]));
  const lines = ["MCP BUILD RESULT"];
  for (const entry of plan.entries) {
    let status = entry.status;
    if (entry.status === "available") {
      const candidateIds = [entry.resolvedCatalogId, ...(entry.fallbackCatalogIds || [])].filter(Boolean);
      const attachedId = candidateIds.find((id) => attached.has(id));
      const approvedId = candidateIds.find((id) => approved.has(id));
      const failedId = candidateIds.find((id) => failed.has(id));
      status = attachedId
        ? attachedId === entry.resolvedCatalogId ? "connected-and-allowlisted" : `fallback-connected-and-allowlisted:${attachedId}`
        : failedId
          ? `failed-isolated:${failedId}:${failed.get(failedId)}`
          : approvedId
            ? "approved-but-not-attached"
            : "skipped";
    }
    lines.push(`- ${entry.resolvedCatalogId || entry.requestedCatalogId}: ${status}`);
  }
  if (!runtimeAllowlist || runtimeAllowlist.emptyMode) lines.push("- Build continued in empty-MCP mode.");
  if (runtimeAllowlist && runtimeAllowlist.consentPersisted === false) lines.push("- Runtime consent was one-pass only because its local fingerprint receipt could not be saved.");
  lines.push("Only the post-consent host allowlist reached the builder; tool-call success is not implied by connection readiness.");
  return lines.join("\n");
}

async function cmdBuild(options) {
  const parsed = parseBuildArgs(options.args || []);
  const emit = options.out || console.log;
  const inventory = collectSystemMcpInventory(options.db, { userDataDir: options.userDataDir, env: options.env || process.env });
  const policy = loadProjectMcpPolicy(options.cwd || process.cwd());
  const plan = buildMcpPlan({
    inventory, policy, request: parsed.request,
    requiredIds: parsed.requiredIds, recommendedIds: parsed.recommendedIds,
  });
  emit(parsed.json ? JSON.stringify(plan, null, 2) : renderMcpPlan(plan));
  if (parsed.planOnly) return { plan, approvedIds: [], invoked: false };

  let approvedIds = [];
  if (!parsed.noMcp) {
    if (parsed.approveAll) approvedIds = [...plan.availableCatalogIds];
    else if (parsed.approvedIds.length) approvedIds = normalizeConsentAnswer(parsed.approvedIds.join(","), plan.availableCatalogIds);
    else approvedIds = await askMcpConsentOnce(plan, { input: options.input, output: options.promptOutput });
  }
  approvedIds = fitApprovedMcpIds(plan, approvedIds);
  const runtimeAllowlist = await resolveApprovedMcpRuntimeAllowlist({
    db: options.db,
    plan,
    approvedIds,
    cwd: options.cwd || process.cwd(),
    userDataDir: options.userDataDir,
    env: options.runtimeEnv || options.env || process.env,
    probeServer: options.probeMcpServer,
  });
  const attachedIds = runtimeAllowlist.attached.map((item) => item.catalogId);
  const directive = buildMcpDirective(plan, attachedIds);
  let experienceContext = { text: "", itemIds: [], estimatedTokens: 0, authority: "local-advisory", serverRentalResolutionReceiptPresent: false };
  if (
    !parsed.noExperience &&
    parsed.experienceBaseReleaseId &&
    parsed.experienceTaskSignatures.length &&
    parsed.experiencePackReleaseIds.length === 1
  ) {
    const exchange = require("./agentlas-experience-exchange.cjs");
    experienceContext = exchange.buildLocalExperienceAdvisory({
      userDataDir: options.userDataDir,
      cwd: options.cwd || process.cwd(),
      baseAgentReleaseId: parsed.experienceBaseReleaseId,
      agentDefinitionId: parsed.experienceAgentDefinitionId,
      experiencePackReleaseIds: parsed.experiencePackReleaseIds,
      taskSignatures: parsed.experienceTaskSignatures,
      environmentTags: parsed.experienceEnvironmentTags.length
        ? parsed.experienceEnvironmentTags
        : exchange.defaultEnvironmentTags(),
    });
  }
  const builderRequest = [parsed.request, directive, experienceContext.text].filter(Boolean).join("\n\n");
  if (typeof options.invokeBuild === "function") {
    await options.invokeBuild(builderRequest, {
      plan,
      approvedIds,
      experienceContext,
      mcpRuntimeAllowlist: runtimeAllowlist,
      mcpServers: runtimeAllowlist.servers,
    });
  }
  emit(renderBuildMcpResult(plan, approvedIds, runtimeAllowlist));
  if (experienceContext.itemIds.length) emit(`Local Experience advisory attached: ${experienceContext.itemIds.length} item(s), ~${experienceContext.estimatedTokens} tokens · no server rental-resolution receipt.`);
  return { plan, approvedIds, mcpRuntimeAllowlist: runtimeAllowlist, experienceContext, invoked: typeof options.invokeBuild === "function" };
}

function validateVariantCandidate(candidate, index) {
  const allowed = new Set(["variantId", "baseAgentReleaseId", "experiencePackReleaseId", "status", "compatibilityStatus", "score", "mcpRequirements"]);
  assertExactKeys(candidate, allowed, ["variantId", "baseAgentReleaseId", "experiencePackReleaseId", "status", "compatibilityStatus", "score", "mcpRequirements"], `candidate[${index}]`);
  for (const key of ["variantId", "baseAgentReleaseId", "experiencePackReleaseId"]) assertId(candidate[key], `candidate[${index}].${key}`);
  const requirements = candidate.mcpRequirements == null ? [] : candidate.mcpRequirements;
  if (!Array.isArray(requirements) || requirements.length > 64) throw new Error(`candidate[${index}].mcpRequirements is invalid`);
  requirements.forEach((requirement, requirementIndex) => validateMcpRequirement(requirement, `candidate[${index}].mcpRequirements[${requirementIndex}]`));
  const score = Number(candidate.score);
  if (!Number.isFinite(score) || score < 0 || score > 1_000_000) throw new Error(`candidate[${index}].score is outside the local-preview range`);
  return {
    variantId: candidate.variantId,
    baseAgentReleaseId: candidate.baseAgentReleaseId,
    experiencePackReleaseId: candidate.experiencePackReleaseId,
    status: String(candidate.status || "draft"),
    compatibilityStatus: String(candidate.compatibilityStatus || "unverified"),
    score,
    mcpRequirements: requirements,
  };
}

function resolveVariantCandidates(options) {
  const candidates = (options.candidates || []).map(validateVariantCandidate);
  const inventoryById = indexInventory(options.inventory || []);
  if (!options.baseAgentReleaseId) {
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision: "error",
      code: "EXACT_BASE_RELEASE_REQUIRED",
      selectedVariantId: null,
      baseAgentReleaseId: null,
      experiencePackReleaseId: null,
      fallbackOrder: [],
      degradedMcpIds: [],
      excluded: [],
      requiredMcpFailureScope: "variant-only",
    };
  }
  const excluded = [];
  const eligible = [];
  for (const candidate of candidates) {
    const reasons = [];
    if (candidate.status !== "active") reasons.push(`variant-status:${candidate.status}`);
    if (candidate.compatibilityStatus !== "verified") reasons.push(`compatibility:${candidate.compatibilityStatus}`);
    if (options.baseAgentReleaseId && candidate.baseAgentReleaseId !== options.baseAgentReleaseId) reasons.push("base-release-mismatch");
    const degradedMcpIds = [];
    for (const requirement of candidate.mcpRequirements) {
      const resolution = resolveMcpRequirement(requirement, inventoryById);
      if (resolution.status !== "available" && requirement.required) reasons.push(`required-mcp-${resolution.status}:${requirement.catalogId}`);
      else if (resolution.status !== "available") degradedMcpIds.push(requirement.catalogId);
    }
    if (reasons.length) excluded.push({ variantId: candidate.variantId, reasons });
    else eligible.push({ ...candidate, degradedMcpIds });
  }
  eligible.sort((a, b) => b.score - a.score || a.variantId.localeCompare(b.variantId));
  const selected = eligible[0] || null;
  const baseRelease = options.baseAgentReleaseId;
  if (selected) {
    const decision = options.preferredVariantId && options.preferredVariantId !== selected.variantId ? "fallback" : "selected";
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision,
      selectedVariantId: selected.variantId,
      baseAgentReleaseId: selected.baseAgentReleaseId,
      experiencePackReleaseId: selected.experiencePackReleaseId,
      fallbackOrder: eligible.slice(1).map((candidate) => candidate.variantId),
      degradedMcpIds: selected.degradedMcpIds,
      excluded,
      requiredMcpFailureScope: "variant-only",
    };
  }
  if (options.allowBaseOnly !== false && baseRelease) {
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision: "base-only",
      selectedVariantId: null,
      baseAgentReleaseId: baseRelease,
      experiencePackReleaseId: null,
      fallbackOrder: [],
      degradedMcpIds: [],
      excluded,
      requiredMcpFailureScope: "variant-only",
    };
  }
  return {
    schemaVersion: "agentlas.terminal-variant-resolution.v1",
    authority: "local-advisory",
    executionAuthorized: false,
    reputationAccepted: false,
    serverResolutionReceiptPresent: false,
    decision: "error",
    code: "NO_ELIGIBLE_VARIANT_AND_NO_BASE_FALLBACK",
    selectedVariantId: null,
    baseAgentReleaseId: baseRelease,
    experiencePackReleaseId: null,
    fallbackOrder: [],
    degradedMcpIds: [],
    excluded,
    requiredMcpFailureScope: "variant-only",
  };
}

function renderVariantResolution(result) {
  const lines = [
    `VARIANT RESOLUTION: ${result.decision}`,
    "Local compatibility preview only; Hub rental requires a Web server resolution receipt.",
    "Candidate score/verified claims are not accepted as reputation, payment, rental, or execution authority.",
  ];
  if (result.decision === "selected") lines.push(`selected: ${result.selectedVariantId}`);
  else if (result.decision === "fallback") lines.push(`fallback selected: ${result.selectedVariantId}`);
  else if (result.decision === "base-only") lines.push(`base-only: ${result.baseAgentReleaseId} (no Experience Pack attached)`);
  else lines.push(`error: ${result.code}`);
  if (result.fallbackOrder.length) lines.push(`next fallbacks: ${result.fallbackOrder.join(", ")}`);
  for (const excluded of result.excluded) lines.push(`excluded only ${excluded.variantId}: ${excluded.reasons.join(", ")}`);
  lines.push("Required MCP shortages exclude only the affected variant; they never create an agent-wide shortage.");
  return lines.join("\n");
}

function cmdVariant(options) {
  const args = options.args || [];
  const sub = args[0] || "resolve";
  if (sub !== "resolve") throw new Error(`unknown variant subcommand: ${sub} (resolve)`);
  const flags = parseSimpleFlags(args.slice(1));
  let candidates = [];
  let baseAgentReleaseId = flags["base-release"] || null;
  const candidateFile = flags.candidates || flags._[0];
  if (candidateFile) {
    const { value } = readJsonFile(path.resolve(options.cwd || process.cwd(), candidateFile), "variant candidates");
    if (Array.isArray(value)) candidates = value;
    else {
      assertObject(value, "variant candidate document");
      if (!Array.isArray(value.candidates)) throw new Error("variant candidate document must contain candidates[]");
      candidates = value.candidates;
      if (!baseAgentReleaseId && value.baseAgentReleaseId) baseAgentReleaseId = value.baseAgentReleaseId;
    }
  }
  if (baseAgentReleaseId) assertId(baseAgentReleaseId, "--base-release");
  const inventory = collectSystemMcpInventory(options.db, { userDataDir: options.userDataDir, env: options.env || process.env });
  const result = resolveVariantCandidates({
    candidates,
    inventory,
    baseAgentReleaseId,
    preferredVariantId: flags.prefer || null,
    allowBaseOnly: flags["no-base-only"] !== true,
  });
  const emit = options.out || console.log;
  emit(flags.json ? JSON.stringify(result, null, 2) : renderVariantResolution(result));
  if (result.decision === "error") (options.setExitCode || ((code) => { process.exitCode = code; }))(2);
  return result;
}

function estimateTokens(text) {
  // UTF-8 bytes / 3 is deliberately conservative for Korean and mixed code.
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 3);
}

function buildExperienceContext(items, options = {}) {
  const maxItems = Math.min(TOKEN_BUDGET.experienceRetrievalMaxItems, Math.max(0, Number(options.maxItems ?? TOKEN_BUDGET.experienceRetrievalMaxItems)));
  const maxTokens = Math.min(TOKEN_BUDGET.experienceRetrievalMaxTokens, Math.max(0, Number(options.maxTokens ?? TOKEN_BUDGET.experienceRetrievalMaxTokens)));
  const relevant = (items || [])
    .filter((item) => item && item.relevant === true && item.status === "promoted")
    .sort((a, b) => Number(b.relevance || 0) - Number(a.relevance || 0) || String(a.id).localeCompare(String(b.id)));
  if (!relevant.length || !maxItems || !maxTokens) return { text: "", itemIds: [], estimatedTokens: 0 };
  let text = "EXPERIENCE (verified relevant items only):";
  const itemIds = [];
  for (const item of relevant.slice(0, maxItems)) {
    const id = assertId(item.id, "experience context item.id");
    const summary = assertSafeText(item.summary, "experience context item.summary", 320);
    const next = `${text}\n- [${id}] ${summary}`;
    if (estimateTokens(next) > maxTokens) continue;
    text = next;
    itemIds.push(id);
  }
  if (!itemIds.length) return { text: "", itemIds: [], estimatedTokens: 0 };
  return { text, itemIds, estimatedTokens: estimateTokens(text) };
}

module.exports = {
  TOKEN_BUDGET,
  MCP_PROBE_CONCURRENCY,
  MCP_PROBE_PER_SERVER_TIMEOUT_MS,
  MCP_PROBE_TOTAL_TIMEOUT_MS,
  validateExperiencePack,
  validateMcpRequirement,
  validateMcpPolicy,
  experienceStatePath,
  loadExperienceState,
  publishExperienceIntent,
  unpublishExperienceIntent,
  cmdExperience,
  collectSystemMcpInventory,
  loadProjectMcpPolicy,
  resolveMcpRequirement,
  buildMcpPlan,
  parseBuildArgs,
  tokenizeBuildCommandLine,
  normalizeConsentAnswer,
  askMcpConsentOnce,
  fitApprovedMcpIds,
  buildMcpDirective,
  mcpConsentStatePath,
  loadMcpConsentState,
  materializeTrustedSystemMcpServer,
  persistMcpConsentReceipts,
  readConsentedSystemMcpServers,
  readApprovedSystemMcpServer,
  probeSystemMcpServerConnection,
  resolveApprovedMcpRuntimeAllowlist,
  cmdBuild,
  resolveVariantCandidates,
  cmdVariant,
  estimateTokens,
  buildExperienceContext,
};
