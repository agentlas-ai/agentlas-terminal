"use strict";

/*
 * experience/intents — 경험 팩 publish/unpublish "로컬 의도" 저장소.
 *
 * v1 engine/agentlas-experience-mcp.cjs의 Experience 의도 저장 슬라이스를 토씨
 * 그대로 이식했다(MCP 서브시스템은 engine/mcp/*로 분리 — 이 파일은 그 스코프가
 * 아니다). 절대 계약(약화 금지):
 *  - publish/unpublish 명령은 로컬 의도만 영속화한다. Hub를 호출하지 않고,
 *    서버 영수증을 위조하지 않는다(hubReceipt는 항상 null로만 저장 가능).
 *  - 자격증명 값, MCP command/args/URL, base 패키지 바이트는 공개 투영에
 *    절대 들어가지 않는다. contentVerified는 선언만으로 true가 될 수 없다.
 *  - 상태 파일은 <userData>/terminal/experience-intents-v1.json — v1과 동일
 *    포맷/경로. 쓰기는 0600 원자적 쓰기(임시파일+rename)만 사용한다.
 *
 * 검증 프리미티브(assert 계열, UNSAFE_TEXT_PATTERNS)는 engine/mcp/contract.cjs에도
 * 존재하지만, 의도 저장소는 mcp 서브시스템 변경과 독립적으로 보안 경계를
 * 유지해야 하므로 v1 원문을 여기 동결한다(우연한 규칙 완화 전파 방지).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const EXPERIENCE_STATE_SCHEMA = "agentlas.terminal-experience-intents.v1";
const EXPERIENCE_INTENT_SCHEMA = "agentlas.terminal-experience-intent.v1";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
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
  // base 패키지 복사 반입 금지 — 참조만 허용(오너 결정, 완화 불가).
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

function waitSync(milliseconds) {
  // Atomics.wait은 지원 Node 20+에서 스핀 없이 대기하는 유일한 동기 sleep이다.
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
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
  if (!["publish", "unpublish"].includes(intent.desiredAction)) throw new Error(`${label}.desiredAction is invalid`);
  const expectedState = intent.desiredAction === "publish" ? "publish-requested" : "unpublish-requested";
  if (intent.localState !== expectedState) throw new Error(`${label}.localState is inconsistent`);
  // 서버 영수증은 로컬에서 합성될 수 없다 — 위조 발행 주장 차단의 핵심 게이트.
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

/**
 * cmdExperience — 레거시 pack-only 로컬 의도 표면.
 * v2에서는 `agentlas experience legacy-*` 로만 도달한다(모던 명령은
 * agentlas-experience-exchange.cjs의 cmdExperienceExchange가 처리).
 */
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

module.exports = {
  EXPERIENCE_STATE_SCHEMA,
  EXPERIENCE_INTENT_SCHEMA,
  UNSAFE_TEXT_PATTERNS,
  assertObject,
  assertExactKeys,
  assertId,
  assertUniqueIds,
  assertSafeText,
  assertIsoDateOrNull,
  validateCredentialMetadata,
  validateMcpRequirement,
  validateExperiencePack,
  readJsonFile,
  writePrivateJsonAtomic,
  parseSimpleFlags,
  experienceStatePath,
  withExperienceStateLock,
  loadExperienceState,
  publishExperienceIntent,
  unpublishExperienceIntent,
  cmdExperience,
};
