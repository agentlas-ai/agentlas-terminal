"use strict";

/**
 * Portable Experience Bundle v1 for the independent Agentlas Terminal.
 *
 * This module owns deterministic, model-free bundle validation, a private
 * local cache, and authenticated Web API exchange. It does not activate a
 * public Experience, create a Variant, accept evaluator authority, or turn a
 * local item into reputation evidence.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BUNDLE_SCHEMA = "agentlas.experience-bundle.v1";
const RECEIPT_SCHEMA = "agentlas.experience-upload-receipt.v1";
const BASE_RESOLUTION_SCHEMA = "agentlas.experience-base-resolution.v1";
const STATE_SCHEMA = "agentlas.terminal-experience-exchange.v1";
const MAX_BUNDLE_CANONICAL_BYTES = 3 * 1024 * 1024;
const MAX_BUNDLE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_STORED_ITEMS = 256;
const MAX_MCP_REQUIREMENTS = 64;
const MAX_EVIDENCE_REFS_PER_ITEM = 24;
const MAX_INSTRUCTIONS_PER_ITEM = 8;
const MAX_TASK_SIGNATURES_PER_ITEM = 32;
const MAX_SOURCE_ATTESTATIONS = MAX_STORED_ITEMS * MAX_EVIDENCE_REFS_PER_ITEM;
const EXPERIENCE_RETRIEVAL_MAX_ITEMS = 8;
const EXPERIENCE_RETRIEVAL_MAX_TOKENS = 800;
const EXCHANGE_LOCK_STALE_MS = 30_000;
const EXCHANGE_LOCK_WAIT_MS = 2_000;
const EXPERIENCE_TAXONOMY_PATH = path.join(__dirname, "experience-taxonomy-v1.json");
const EXPERIENCE_TAXONOMY_CHECKSUM = "sha256:413833472e423352518f9591cd0e051c5bc0a7971e53ab3dc7b5aaf7d50c37ab";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateExperienceTaxonomyContract(value) {
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) issues.push("taxonomy must be an object");
  else {
    if (value.schema !== "agentlas.experience-taxonomy.v1") issues.push("taxonomy schema drifted");
    if (value.kind !== "agentlas-experience-taxonomy") issues.push("taxonomy kind drifted");
    if (value.taskSignaturePrefix !== "agentlas.task.v1/") issues.push("taxonomy task prefix drifted");
    if (!Array.isArray(value.taskSlugs) || value.taskSlugs.length !== 23 || value.taskSlugs.includes("general")) issues.push("taxonomy task catalog drifted");
    const environment = value.environment;
    if (
      !environment || environment.osPrefix !== "agentlas.env.v1/os/" ||
      environment.archPrefix !== "agentlas.env.v1/arch/" || environment.runtimePrefix !== "agentlas.env.v1/runtime/" ||
      JSON.stringify(environment.osValues) !== JSON.stringify(["macos", "windows", "linux", "ios", "android", "unknown"]) ||
      JSON.stringify(environment.archValues) !== JSON.stringify(["arm64", "x64", "unknown"]) ||
      environment.runtimePattern !== "^[a-z0-9][a-z0-9._-]{1,63}$" ||
      environment.matching !== "all-canonical-constraints-must-match" ||
      environment.unknownConstraint !== "item-ineligible-base-unaffected"
    ) issues.push("taxonomy environment contract drifted");
    const normalization = value.normalization;
    if (
      !normalization || normalization.unicode !== "NFKC" || normalization.trim !== true || normalization.case !== "lower" ||
      normalization.portableSource !== "canonical-id-only" || normalization.runtimeProfile !== "canonical-id-or-exact-bare-slug" ||
      normalization.fuzzySimilarity !== false || normalization.generalAutoMatch !== false
    ) issues.push("taxonomy normalization contract drifted");
    const checksum = `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
    if (checksum !== EXPERIENCE_TAXONOMY_CHECKSUM) issues.push("taxonomy checksum drifted");
  }
  if (issues.length) {
    const error = new Error(issues.join("; "));
    error.code = "experience_taxonomy_drift";
    error.issues = issues;
    throw error;
  }
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function loadExperienceTaxonomyContract() {
  const stat = fs.lstatSync(EXPERIENCE_TAXONOMY_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Experience taxonomy artifact is unsafe");
  return validateExperienceTaxonomyContract(JSON.parse(fs.readFileSync(EXPERIENCE_TAXONOMY_PATH, "utf8")));
}

const OFFICIAL_EXPERIENCE_CLOUD_HOSTS = new Set([
  "agentlas.cloud",
  "www.agentlas.cloud",
  "api.agentlas.cloud",
  "staging.agentlas.cloud",
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const BUNDLE_ID_RE = /^exb_[0-9a-f]{48}$/;
const UPLOAD_ID_RE = /^exu_[0-9a-f]{48}$/;
const SEMVER_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

const { SECRET_PATTERNS } = require("./agentlas-secret-patterns.cjs");
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\w)(?:\+?\d[\d ().-]{8,}\d)(?!\w)/,
  /\b(?:account|customer|client|tenant|workspace|user)[ _-]?(?:id|key|number|no)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}\b|(?:계정|고객|사용자)[ _-]?(?:id|아이디|번호)\s*[:=#]?\s*[A-Za-z0-9_-]{4,}/i,
];
// Absolute LOCAL paths and file URLs only. The previous alternation matched any
// slash-containing token, so ordinary prose lost its experience: "TCP/IP", "read/write",
// "and/or", and web routes like "GET /api/users" were all reported as a local path. A
// leading-slash path now has to look like a real filesystem root (or start from a home /
// relative marker, a Windows drive, or a UNC share); a lone `/word` — which is what a web
// route looks like — no longer counts, and neither does `word/word` inside a sentence.
const LOCAL_PATH_PATTERNS = [
  /(?:file:\/\/|(?:^|[\s"'`()\[\]{}=:,;])(?:\.\.[/\\]|~[/\\]|\/(?:Users|home|root|private|var|tmp|opt|etc|srv|mnt|media|Volumes|Applications|System|Library|usr)\/[^\s"'`<>]+|[A-Za-z]:[/\\]\S+|\\\\[^\\/\s]+[\\/][^\\/\s]+))/i,
];
const RAW_INTERACTION_PATTERNS = [
  /(?:^|\n)\s*(?:system|assistant|user|tool|customer|agent)\s*:\s+/i,
  /['"]role['"]\s*:\s*['"](?:system|assistant|user|tool)['"]/i,
  /<\|(?:system|assistant|user|im_start|im_end)[^>]*\|>/i,
  /BEGIN[ _-]?(?:SYSTEM[ _-]?PROMPT|BASE[ _-]?PROMPT|AGENT[ _-]?PACKAGE)/i,
  /\b(?:AGENTS|CLAUDE|GEMINI)\.md\b|\.agentlas[/\\]/i,
];
const PROMPT_INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|override)[\s_-]+(?:all[\s_-]+)?(?:previous|prior|system|developer|hidden)[\s_-]+(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:reveal|show|print|dump|expose|leak)[\s_-]+(?:(?:the|all)[\s_-]+)?(?:(?:hidden|system|developer)[\s_-]+)?(?:prompts?|instructions?|credentials?|secrets?|tokens?|api[\s_-]?keys?)\b/i,
  /\b(?:exfiltrate|steal|upload|send)[^\n]{0,120}\b(?:secrets?|credentials?|tokens?|api[\s_-]?keys?|\.env)\b/i,
  /\b(?:disable|bypass|skip|remove|turn[\s_-]+off)[\s_-]+(?:safety|guardrails?|approval|permission|security)\b/i,
];
const BASE_PACKAGE_PATTERNS = [
  /\bcontentBase64\b|\bcloudPackage\b\s*[:=]/i,
  /\b(?:full|raw)\s+(?:system prompt|agent package|base package)\b/i,
  /\bBEGIN AGENTLAS (?:AGENT|PACKAGE)\b/i,
];
const OPAQUE_BLOB_RE = /(?:[A-Fa-f0-9]{128,}|[A-Za-z0-9+/]{124,}={0,2})/;
const PUBLIC_URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const CUSTOMER_DATA_RE = /\b(?:customer|client|tenant|account|workspace|order|invoice)[ _-]?(?:name|email|address|phone|id|number|ref(?:erence)?)\s*[:=#]\s*\S+|(?:고객|클라이언트|계정|주문|송장)[ _-]?(?:이름|이메일|주소|전화|아이디|번호|참조)\s*[:=#]\s*\S+/i;
const FORBIDDEN_KEYS = new Set([
  "basepackage", "basepackagefiles", "baseprompt", "cloudpackage", "contentbase64",
  "files", "fulltranscript", "rawsource", "systemprompt", "transcript", "messages",
  "command", "args", "cwd", "endpoint", "executable", "headers", "serverurl", "transportendpoint",
]);

class ExperienceBundleValidationError extends Error {
  constructor(issues) {
    const unique = [...new Set((issues || []).map(String).filter(Boolean))];
    super(unique.join("; ") || "invalid Portable Experience Bundle");
    this.name = "ExperienceBundleValidationError";
    this.code = "invalid_experience_bundle";
    this.issues = unique;
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(String(left));
  const b = Array.from(String(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (delta) return delta;
  }
  return a.length - b.length;
}

function normalizeJson(value, seen = new Set()) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExperienceBundleValidationError(["canonical JSON forbids non-finite numbers"]);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ExperienceBundleValidationError(["canonical JSON forbids cyclic values"]);
    seen.add(value);
    const result = value.map((child) => normalizeJson(child, seen));
    seen.delete(value);
    return result;
  }
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== "object" || (prototype !== Object.prototype && prototype !== null)) {
    throw new ExperienceBundleValidationError([`canonical JSON forbids ${typeof value}`]);
  }
  if (seen.has(value)) throw new ExperienceBundleValidationError(["canonical JSON forbids cyclic values"]);
  seen.add(value);
  const normalized = Object.create(null);
  for (const rawKey of Object.keys(value)) {
    const key = rawKey.normalize("NFC");
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new ExperienceBundleValidationError([`NFC-normalized object key collision: ${key}`]);
    }
    normalized[key] = normalizeJson(value[rawKey], seen);
  }
  seen.delete(value);
  return normalized;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort(compareCodePoints)) result[key] = canonicalValue(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(normalizeJson(value)));
}

function canonicalHash(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// Load the frozen activation taxonomy only after the canonical JSON machinery
// and its error type have initialized. Any artifact drift stops startup.
const EXPERIENCE_TAXONOMY_V1 = loadExperienceTaxonomyContract();
const CANONICAL_TASK_PREFIX = EXPERIENCE_TAXONOMY_V1.taskSignaturePrefix;
const CANONICAL_ENV_PREFIX = "agentlas.env.v1/";
const CANONICAL_TASK_SLUGS = Object.freeze([...EXPERIENCE_TAXONOMY_V1.taskSlugs]);
const CANONICAL_TASK_IDS = Object.freeze(CANONICAL_TASK_SLUGS.map((slug) => `${CANONICAL_TASK_PREFIX}${slug}`));
const CANONICAL_TASK_ID_SET = new Set(CANONICAL_TASK_IDS);
const CANONICAL_OS_VALUES = new Set(EXPERIENCE_TAXONOMY_V1.environment.osValues);
const CANONICAL_ARCH_VALUES = new Set(EXPERIENCE_TAXONOMY_V1.environment.archValues);
const CANONICAL_RUNTIME_RE = new RegExp(EXPERIENCE_TAXONOMY_V1.environment.runtimePattern);

function sortedUnique(values) {
  const byCanonical = new Map();
  for (const value of values || []) byCanonical.set(canonicalJson(value), value);
  return [...byCanonical.keys()].sort(compareCodePoints).map((key) => byCanonical.get(key));
}

function normalizeMcpRequirement(raw) {
  const value = normalizeJson(raw);
  for (const key of ["capabilities", "permissions", "alternatives"]) {
    if (Array.isArray(value[key])) value[key] = sortedUnique(value[key]);
  }
  if (value.credentialMetadata && typeof value.credentialMetadata === "object" && !Array.isArray(value.credentialMetadata)) {
    for (const key of ["env", "allowedHosts", "scopes"]) {
      if (Array.isArray(value.credentialMetadata[key])) value.credentialMetadata[key] = sortedUnique(value.credentialMetadata[key]);
    }
  }
  return value;
}

function normalizeExperienceItem(raw) {
  const value = normalizeJson(raw);
  for (const key of ["taskSignatures", "environmentConstraints", "evidenceReceiptIds", "supersedesItemIds"]) {
    if (Array.isArray(value[key])) value[key] = sortedUnique(value[key]);
  }
  return value;
}

function normalizeExperienceBundle(payload) {
  const value = normalizeJson(payload);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperienceBundleValidationError(["ExperienceBundle must be an object"]);
  if (value.pack && typeof value.pack === "object" && !Array.isArray(value.pack)) {
    if (value.pack.baseCompatibility && typeof value.pack.baseCompatibility === "object" && !Array.isArray(value.pack.baseCompatibility)) {
      const ids = value.pack.baseCompatibility.compatibleBaseReleaseIds;
      if (Array.isArray(ids)) value.pack.baseCompatibility.compatibleBaseReleaseIds = sortedUnique(ids);
    }
    for (const key of ["itemIds", "evidenceReceiptIds"]) {
      if (Array.isArray(value.pack[key])) value.pack[key] = sortedUnique(value.pack[key]);
    }
    if (Array.isArray(value.pack.mcpRequirements)) {
      value.pack.mcpRequirements = sortedUnique(value.pack.mcpRequirements.map((row) => normalizeMcpRequirement(row)));
    }
  }
  if (Array.isArray(value.items)) value.items = sortedUnique(value.items.map((row) => normalizeExperienceItem(row)));
  if (Array.isArray(value.sourceAttestations)) value.sourceAttestations = sortedUnique(value.sourceAttestations);
  return value;
}

function experiencePackContentPayload(bundle) {
  const value = normalizeExperienceBundle(bundle);
  const pack = value.pack;
  if (!pack || typeof pack !== "object" || !Array.isArray(value.items)) {
    throw new ExperienceBundleValidationError(["ExperienceBundle needs pack and items before hashing"]);
  }
  return {
    schemaVersion: pack.schemaVersion,
    kind: pack.kind,
    experiencePackId: pack.experiencePackId,
    releaseId: pack.releaseId,
    version: pack.version,
    baseCompatibility: pack.baseCompatibility,
    itemIds: pack.itemIds,
    items: value.items,
    evidenceReceiptIds: pack.evidenceReceiptIds,
    mcpRequirements: pack.mcpRequirements,
    containsBasePackageMaterial: pack.containsBasePackageMaterial,
  };
}

function experiencePackContentHash(bundle) {
  return canonicalHash(experiencePackContentPayload(bundle));
}

function experienceBundleHashPayload(bundle) {
  const value = normalizeExperienceBundle(bundle);
  return { content: experiencePackContentPayload(value), sourceAttestations: value.sourceAttestations, privacy: value.privacy };
}

function experienceBundleHash(bundle) {
  return canonicalHash(experienceBundleHashPayload(bundle));
}

function experienceBundleId(bundle) {
  return `exb_${experienceBundleHash(bundle).slice("sha256:".length, "sha256:".length + 48)}`;
}

function strictObject(value, required, allowed, label, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return {};
  }
  const keys = Object.keys(value);
  const missing = [...required].filter((key) => !Object.prototype.hasOwnProperty.call(value, key)).sort(compareCodePoints);
  const unknown = keys.filter((key) => !allowed.has(key)).sort(compareCodePoints);
  if (missing.length) issues.push(`${label} missing required fields: ${missing.join(", ")}`);
  if (unknown.length) issues.push(`${label} contains unknown fields: ${unknown.join(", ")}`);
  return value;
}

function requiredObject(value, required, label, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return {};
  }
  const missing = [...required].filter((key) => !Object.prototype.hasOwnProperty.call(value, key)).sort(compareCodePoints);
  if (missing.length) issues.push(`${label} missing required fields: ${missing.join(", ")}`);
  return value;
}

function checkId(value, label, issues) {
  if (typeof value !== "string" || !ID_RE.test(value)) issues.push(`${label} must be an opaque stable id`);
}

function checkHash(value, label, issues) {
  if (typeof value !== "string" || !HASH_RE.test(value)) issues.push(`${label} must be sha256:<64 lowercase hex>`);
}

function checkString(value, label, minimum, maximum, issues) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) issues.push(`${label} must be a ${minimum}..${maximum} character string`);
}

function checkStringList(value, label, minimum, maximum, issues, options = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== "string" || !item)) {
    issues.push(`${label} must contain at least ${minimum} non-empty strings`);
    return [];
  }
  if (maximum != null && value.length > maximum) issues.push(`${label} must contain at most ${maximum} values`);
  if (new Set(value).size !== value.length) issues.push(`${label} must not contain duplicates`);
  if (options.ids) value.forEach((item, index) => checkId(item, `${label}[${index}]`, issues));
  return value;
}

function checkIso(value, label, issues, nullable = false) {
  if (nullable && value == null) return;
  if (typeof value !== "string") {
    issues.push(`${label} must be an RFC3339 date-time${nullable ? " or null" : ""}`);
    return;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    issues.push(`${label} must be an RFC3339 date-time${nullable ? " or null" : ""}`);
    return;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[7];
  const offsetValid = offset === "Z" || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month] || hour > 23 || minute > 59 || second > 59 || !offsetValid || !Number.isFinite(Date.parse(value))) {
    issues.push(`${label} must be a valid RFC3339 date-time${nullable ? " or null" : ""}`);
  }
}

function validateCredentialMetadata(value, label, issues) {
  const required = new Set(["provider", "env"]);
  const allowed = new Set(["provider", "env", "allowedHosts", "scopes", "setupUrl", "brokerMode"]);
  const data = strictObject(value, required, allowed, label, issues);
  checkId(data.provider, `${label}.provider`, issues);
  const env = checkStringList(data.env, `${label}.env`, 1, 32, issues);
  env.forEach((item, index) => { if (!ENV_RE.test(item)) issues.push(`${label}.env[${index}] must be uppercase environment name`); });
  if (data.allowedHosts != null) {
    const hosts = checkStringList(data.allowedHosts, `${label}.allowedHosts`, 1, 64, issues);
    const hostRe = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
    hosts.forEach((host, index) => { if (host.length > 255 || !hostRe.test(host)) issues.push(`${label}.allowedHosts[${index}] is invalid`); });
  }
  if (data.scopes != null) {
    const scopes = checkStringList(data.scopes, `${label}.scopes`, 1, 64, issues);
    scopes.forEach((scope, index) => { if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(scope)) issues.push(`${label}.scopes[${index}] is invalid`); });
  }
  if (data.setupUrl != null && (
    typeof data.setupUrl !== "string" ||
    data.setupUrl.length > 2048 ||
    !/^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(data.setupUrl)
  )) {
    issues.push(`${label}.setupUrl must be a value-free HTTPS provider page of at most 2048 characters`);
  }
  if (data.brokerMode != null && !["host-bound-broker", "runtime-env-injection", "provider-managed-oauth", "manual-provider-page"].includes(data.brokerMode)) {
    issues.push(`${label}.brokerMode is invalid`);
  }
}

function validateMcpRequirement(value, label, issues) {
  const requiredFields = new Set(["schemaVersion", "kind", "requirementId", "catalogId", "reason", "capabilities", "required", "requiresKey", "priority", "permissions", "alternatives", "unavailablePolicy"]);
  const data = strictObject(value, requiredFields, new Set([...requiredFields, "credentialMetadata"]), label, issues);
  if (data.schemaVersion !== "agentlas.mcp-requirement.v1") issues.push(`${label}.schemaVersion is unsupported`);
  if (data.kind !== "agentlas-mcp-requirement") issues.push(`${label}.kind is unsupported`);
  checkId(data.requirementId, `${label}.requirementId`, issues);
  checkId(data.catalogId, `${label}.catalogId`, issues);
  checkString(data.reason, `${label}.reason`, 1, 300, issues);
  checkStringList(data.capabilities, `${label}.capabilities`, 1, 32, issues, { ids: true });
  checkStringList(data.permissions, `${label}.permissions`, 0, 64, issues, { ids: true });
  const alternatives = checkStringList(data.alternatives, `${label}.alternatives`, 0, 32, issues, { ids: true });
  if (alternatives.includes(data.catalogId)) issues.push(`${label}.alternatives must not contain catalogId`);
  if (typeof data.required !== "boolean" || typeof data.requiresKey !== "boolean") issues.push(`${label}.required/requiresKey must be boolean`);
  if (!Number.isInteger(data.priority) || data.priority < 1 || data.priority > 1000) issues.push(`${label}.priority must be 1..1000`);
  if (data.credentialMetadata != null) validateCredentialMetadata(data.credentialMetadata, `${label}.credentialMetadata`, issues);
  if (data.requiresKey === true && data.credentialMetadata == null) issues.push(`${label}.requiresKey=true requires credentialMetadata`);
  const policy = strictObject(data.unavailablePolicy, new Set(["build", "rental", "execution"]), new Set(["build", "rental", "execution"]), `${label}.unavailablePolicy`, issues);
  if (policy.build !== "degrade") issues.push(`${label}.unavailablePolicy.build must be degrade`);
  const expectedRental = data.required === true ? "exclude-variant" : "continue-degraded";
  if (policy.rental !== expectedRental) issues.push(`${label}.unavailablePolicy.rental must be ${expectedRental}`);
  if (!["use-alternative", "disable-capability", "continue-degraded"].includes(policy.execution)) issues.push(`${label}.unavailablePolicy.execution is invalid`);
}

function validatePack(pack, issues) {
  const required = new Set(["schemaVersion", "kind", "experiencePackId", "releaseId", "ownerRef", "version", "baseCompatibility", "itemIds", "evidenceReceiptIds", "mcpRequirements", "containsBasePackageMaterial", "contentHash", "visibility", "status"]);
  const data = strictObject(pack, required, new Set([...required, "createdAt", "releasedAt", "withdrawnAt"]), "pack", issues);
  if (data.schemaVersion !== "agentlas.experience-pack.v1") issues.push("pack.schemaVersion is unsupported");
  if (data.kind !== "agentlas-experience-pack") issues.push("pack.kind is unsupported");
  for (const key of ["experiencePackId", "releaseId", "ownerRef"]) checkId(data[key], `pack.${key}`, issues);
  if (typeof data.version !== "string" || data.version.length > 64 || !SEMVER_RE.test(data.version)) issues.push("pack.version must be semantic version");
  const base = strictObject(data.baseCompatibility, new Set(["agentDefinitionId", "compatibleBaseReleaseIds"]), new Set(["agentDefinitionId", "compatibleBaseReleaseIds"]), "pack.baseCompatibility", issues);
  checkId(base.agentDefinitionId, "pack.baseCompatibility.agentDefinitionId", issues);
  checkStringList(base.compatibleBaseReleaseIds, "pack.baseCompatibility.compatibleBaseReleaseIds", 1, 64, issues, { ids: true });
  checkStringList(data.itemIds, "pack.itemIds", data.status === "active" ? 1 : 0, MAX_STORED_ITEMS, issues, { ids: true });
  checkStringList(data.evidenceReceiptIds, "pack.evidenceReceiptIds", 0, MAX_SOURCE_ATTESTATIONS, issues, { ids: true });
  if (!Array.isArray(data.mcpRequirements) || data.mcpRequirements.length > MAX_MCP_REQUIREMENTS) issues.push(`pack.mcpRequirements must contain at most ${MAX_MCP_REQUIREMENTS} requirements`);
  else data.mcpRequirements.forEach((row, index) => validateMcpRequirement(row, `pack.mcpRequirements[${index}]`, issues));
  if (data.containsBasePackageMaterial !== false) issues.push("pack.containsBasePackageMaterial must be false");
  checkHash(data.contentHash, "pack.contentHash", issues);
  if (!["private", "unlisted", "public"].includes(data.visibility)) issues.push("pack.visibility is invalid");
  if (!["draft", "active", "suspended", "withdrawn", "deleted"].includes(data.status)) issues.push("pack.status is invalid");
  if (data.createdAt != null) checkIso(data.createdAt, "pack.createdAt", issues);
  if (Object.prototype.hasOwnProperty.call(data, "releasedAt")) checkIso(data.releasedAt, "pack.releasedAt", issues, true);
  if (Object.prototype.hasOwnProperty.call(data, "withdrawnAt")) checkIso(data.withdrawnAt, "pack.withdrawnAt", issues, true);
}

function validateItem(item, index, issues) {
  const label = `items[${index}]`;
  const required = new Set(["schemaVersion", "kind", "experienceItemId", "experiencePackId", "experiencePackReleaseId", "type", "summary", "instructions", "taskSignatures", "environmentConstraints", "evidenceReceiptIds", "supersedesItemIds", "confidence", "status", "privacyScope"]);
  const data = strictObject(item, required, new Set([...required, "createdAt"]), label, issues);
  if (data.schemaVersion !== "agentlas.experience-item.v1") issues.push(`${label}.schemaVersion is unsupported`);
  if (data.kind !== "agentlas-experience-item") issues.push(`${label}.kind is unsupported`);
  for (const key of ["experienceItemId", "experiencePackId", "experiencePackReleaseId"]) checkId(data[key], `${label}.${key}`, issues);
  if (!["procedure", "failure-recovery", "environment-gotcha", "tool-affordance", "warning", "supersedes"].includes(data.type)) issues.push(`${label}.type is invalid`);
  checkString(data.summary, `${label}.summary`, 1, 320, issues);
  if (!Array.isArray(data.instructions) || data.instructions.length < 1 || data.instructions.length > MAX_INSTRUCTIONS_PER_ITEM) issues.push(`${label}.instructions must contain 1..${MAX_INSTRUCTIONS_PER_ITEM} values`);
  else data.instructions.forEach((step, stepIndex) => checkString(step, `${label}.instructions[${stepIndex}]`, 1, 600, issues));
  checkStringList(data.taskSignatures, `${label}.taskSignatures`, 1, MAX_TASK_SIGNATURES_PER_ITEM, issues, { ids: true });
  const environmentConstraints = checkStringList(data.environmentConstraints, `${label}.environmentConstraints`, 0, 32, issues);
  environmentConstraints.forEach((constraint, constraintIndex) => {
    if (constraint.length > 240) issues.push(`${label}.environmentConstraints[${constraintIndex}] must be at most 240 characters`);
  });
  checkStringList(data.evidenceReceiptIds, `${label}.evidenceReceiptIds`, 1, MAX_EVIDENCE_REFS_PER_ITEM, issues, { ids: true });
  checkStringList(data.supersedesItemIds, `${label}.supersedesItemIds`, 0, MAX_STORED_ITEMS, issues, { ids: true });
  if (typeof data.confidence !== "number" || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) issues.push(`${label}.confidence must be 0..1`);
  if (!["candidate", "promoted", "deprecated", "rejected"].includes(data.status)) issues.push(`${label}.status is invalid`);
  if (!["private", "public-safe"].includes(data.privacyScope)) issues.push(`${label}.privacyScope is invalid`);
  if (data.createdAt != null) checkIso(data.createdAt, `${label}.createdAt`, issues);
}

function metadataString(value) {
  return HASH_RE.test(value) || BUNDLE_ID_RE.test(value) || UPLOAD_ID_RE.test(value) || /^[a-z]{3}_[0-9a-f]{32,64}$/.test(value) || /^\d{4}-\d{2}-\d{2}T\S+$/.test(value);
}

function validateBundleSecurity(value, issues) {
  const strings = [];
  function walk(node, prefix = "") {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${prefix}[${index}]`));
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const next = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_KEYS.has(normalizedKey)) issues.push(`ExperienceBundle forbids executable/raw field ${next}`);
        walk(child, next);
      }
      return;
    }
    if (typeof node === "string") strings.push(node);
  }
  walk(value);
  const nonMetadata = strings.filter((text) => !metadataString(text));
  const checks = [
    [SECRET_PATTERNS, strings, "secret or credential value"],
    [PII_PATTERNS, nonMetadata, "personal/customer identifier"],
    [LOCAL_PATH_PATTERNS, strings, "absolute local path or file URL"],
    [RAW_INTERACTION_PATTERNS, strings, "raw prompt, transcript, or base package marker"],
    [PROMPT_INJECTION_PATTERNS, strings, "prompt-injection instruction"],
    [BASE_PACKAGE_PATTERNS, strings, "base package material"],
  ];
  for (const [patterns, candidates, label] of checks) {
    if (patterns.some((pattern) => candidates.some((candidate) => pattern.test(candidate)))) issues.push(`ExperienceBundle contains ${label}`);
  }
  if (nonMetadata.some((text) => OPAQUE_BLOB_RE.test(text))) issues.push("ExperienceBundle contains a long opaque encoded blob");
}

/**
 * Value-free privacy classification used before a successful run can become a
 * local Operational Experience candidate. It deliberately returns only codes;
 * unsafe source text is never copied into an intake receipt or bundle.
 */
function portableExperienceSafetyIssues(text) {
  const variants = [String(text || "")];
  let current = variants[0];
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    } catch { break; }
  }
  const codes = [];
  const hit = (patterns, code) => {
    if (patterns.some((pattern) => variants.some((value) => pattern.test(value)))) codes.push(code);
  };
  hit(SECRET_PATTERNS, "secret-or-credential");
  hit(PII_PATTERNS, "personal-or-customer-identifier");
  hit(LOCAL_PATH_PATTERNS, "local-path");
  hit(RAW_INTERACTION_PATTERNS, "raw-prompt-or-transcript");
  hit(PROMPT_INJECTION_PATTERNS, "prompt-injection-material");
  hit(BASE_PACKAGE_PATTERNS, "base-package-material");
  if (variants.some((value) => PUBLIC_URL_RE.test(value))) codes.push("url");
  if (variants.some((value) => CUSTOMER_DATA_RE.test(value))) codes.push("customer-data");
  if (variants.some((value) => OPAQUE_BLOB_RE.test(value))) codes.push("opaque-blob");
  return [...new Set(codes)].sort(compareCodePoints);
}

function validateExperienceBundle(payload) {
  const value = normalizeExperienceBundle(payload);
  const issues = [];
  const required = new Set(["schemaVersion", "kind", "bundleId", "bundleHash", "requestedVisibility", "pack", "items", "sourceAttestations", "privacy"]);
  strictObject(value, required, required, "ExperienceBundle", issues);
  if (value.schemaVersion !== BUNDLE_SCHEMA) issues.push(`schemaVersion must equal ${BUNDLE_SCHEMA}`);
  if (value.kind !== "agentlas-experience-bundle") issues.push("kind must equal agentlas-experience-bundle");
  if (!["private", "unlisted", "public"].includes(value.requestedVisibility)) issues.push("requestedVisibility is invalid");
  validatePack(value.pack, issues);

  let items = value.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_STORED_ITEMS) {
    issues.push(`items must contain 1..${MAX_STORED_ITEMS} items`);
    items = [];
  }
  const itemIds = [];
  const evidenceIds = [];
  items.forEach((item, index) => {
    validateItem(item, index, issues);
    if (typeof item.experienceItemId === "string") itemIds.push(item.experienceItemId);
    if (item.experiencePackId !== value.pack?.experiencePackId) issues.push(`items[${index}].experiencePackId does not match pack`);
    if (item.experiencePackReleaseId !== value.pack?.releaseId) issues.push(`items[${index}].experiencePackReleaseId does not match pack release`);
    if (Array.isArray(item.evidenceReceiptIds)) evidenceIds.push(...item.evidenceReceiptIds.filter((entry) => typeof entry === "string"));
  });
  if (new Set(itemIds).size !== itemIds.length) issues.push("items must have unique experienceItemId values");
  if (canonicalJson(value.pack?.itemIds || []) !== canonicalJson(sortedUnique(itemIds))) issues.push("pack.itemIds must exactly equal submitted item ids");
  if (canonicalJson(value.pack?.evidenceReceiptIds || []) !== canonicalJson(sortedUnique(evidenceIds))) issues.push("pack.evidenceReceiptIds must exactly equal item evidence ids");

  let attestations = value.sourceAttestations;
  if (!Array.isArray(attestations) || attestations.length > MAX_SOURCE_ATTESTATIONS) {
    issues.push(`sourceAttestations must contain at most ${MAX_SOURCE_ATTESTATIONS} entries`);
    attestations = [];
  }
  const attestationFields = new Set(["kind", "experienceItemId", "evidenceHash"]);
  attestations.forEach((row, index) => {
    const data = strictObject(row, attestationFields, attestationFields, `sourceAttestations[${index}]`, issues);
    if (data.kind !== "user-attested") issues.push(`sourceAttestations[${index}].kind must be user-attested`);
    if (!itemIds.includes(data.experienceItemId)) issues.push(`sourceAttestations[${index}] references missing item`);
    checkHash(data.evidenceHash, `sourceAttestations[${index}].evidenceHash`, issues);
  });

  const privacyFields = new Set(["basePackageMaterialIncluded", "rawPromptIncluded", "rawTranscriptIncluded", "rawLocalPathsIncluded", "credentialValuesIncluded"]);
  const privacy = strictObject(value.privacy, privacyFields, privacyFields, "privacy", issues);
  for (const flag of privacyFields) if (privacy[flag] !== false) issues.push(`privacy.${flag} must be false`);
  validateBundleSecurity(value, issues);

  const canonicalBytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (canonicalBytes > MAX_BUNDLE_CANONICAL_BYTES) issues.push(`canonical ExperienceBundle exceeds ${MAX_BUNDLE_CANONICAL_BYTES} bytes`);
  let expectedPackHash = null;
  let expectedBundleHash = null;
  try {
    expectedPackHash = experiencePackContentHash(value);
    expectedBundleHash = experienceBundleHash(value);
    if (value.pack?.contentHash !== expectedPackHash) issues.push("pack.contentHash does not match canonical Experience content");
    if (value.bundleHash !== expectedBundleHash) issues.push("bundleHash does not match canonical bundle content");
    const expectedId = `exb_${expectedBundleHash.slice(7, 55)}`;
    if (value.bundleId !== expectedId || !BUNDLE_ID_RE.test(String(value.bundleId || ""))) issues.push("bundleId must be derived from bundleHash");
  } catch (error) {
    if (error instanceof ExperienceBundleValidationError) issues.push(...error.issues);
    else throw error;
  }
  if (issues.length) throw new ExperienceBundleValidationError(issues);
  return { bundle: value, canonicalJson: canonicalJson(value), canonicalBytes, expectedPackHash, expectedBundleHash, expectedBundleId: experienceBundleId(value) };
}

function readBundleFile(filePath, cwd = process.cwd()) {
  const absolute = path.resolve(cwd, filePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Experience bundle must be a regular file; symlinks are forbidden");
  if (stat.size < 1 || stat.size > MAX_BUNDLE_FILE_BYTES) throw new Error(`Experience bundle file must be 1..${MAX_BUNDLE_FILE_BYTES} bytes`);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(absolute, "utf8")); } catch (error) { throw new Error(`Experience bundle is invalid JSON: ${error.message}`); }
  return { absolute, ...validateExperienceBundle(payload) };
}

function recoverPrivateAtomicTarget(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const backup = `${filePath}.previous`;
  if (!fsImpl.existsSync(backup)) return;
  const backupStat = fsImpl.lstatSync(backup);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw new Error("private atomic backup is unsafe");
  if (fsImpl.existsSync(filePath)) {
    const targetStat = fsImpl.lstatSync(filePath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("private atomic target is unsafe");
    fsImpl.rmSync(backup, { force: true });
    return;
  }
  fsImpl.renameSync(backup, filePath);
}

function replacePrivateFileAtomic(temp, filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  recoverPrivateAtomicTarget(filePath, { fs: fsImpl });
  try {
    fsImpl.renameSync(temp, filePath);
    return;
  } catch (error) {
    if (platform !== "win32" || !["EEXIST", "EPERM", "EACCES"].includes(error?.code) || !fsImpl.existsSync(filePath)) throw error;
  }
  const backup = `${filePath}.previous`;
  fsImpl.renameSync(filePath, backup);
  try {
    fsImpl.renameSync(temp, filePath);
  } catch (error) {
    try {
      if (!fsImpl.existsSync(filePath) && fsImpl.existsSync(backup)) fsImpl.renameSync(backup, filePath);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
  try { fsImpl.rmSync(backup, { force: true }); } catch { /* target is committed; recover/cleanup on the next access */ }
}

function writePrivateJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on Windows */ }
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    replacePrivateFileAtomic(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
  }
}

function writePrivateTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    replacePrivateFileAtomic(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
  }
}

function readPrivateFileSnapshot(filePath) {
  recoverPrivateAtomicTarget(filePath);
  if (!fs.existsSync(filePath)) return { exists: false, bytes: null };
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("private transaction target is unsafe");
  return { exists: true, bytes: fs.readFileSync(filePath) };
}

function writePrivateBufferAtomic(filePath, bytes) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.rollback.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    replacePrivateFileAtomic(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
  }
}

function restorePrivateFileSnapshot(filePath, snapshot) {
  recoverPrivateAtomicTarget(filePath);
  if (snapshot.exists) {
    writePrivateBufferAtomic(filePath, snapshot.bytes);
    return;
  }
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("private rollback target is unsafe");
    fs.rmSync(filePath, { force: true });
  }
  try { fs.rmSync(`${filePath}.previous`, { force: true }); } catch { /* noop */ }
}

function exchangeStatePath(userDataDir) {
  return path.join(userDataDir, "terminal", "experience-exchange-v1.json");
}

function bundleStorePath(userDataDir, bundleId) {
  if (!BUNDLE_ID_RE.test(String(bundleId || ""))) throw new Error("invalid bundle id");
  return path.join(userDataDir, "terminal", "experience-bundles-v1", `${bundleId}.agentlas-experience.json`);
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA, updatedAt: null, bundles: [] };
}

function waitSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function withExchangeStateLock(userDataDir, action) {
  const stateFile = exchangeStatePath(userDataDir);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const lockFile = `${stateFile}.lock`;
  const deadline = Date.now() + EXCHANGE_LOCK_WAIT_MS;
  let descriptor = null;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Terminal Experience exchange lock is unsafe");
        if (Date.now() - stat.mtimeMs > EXCHANGE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("Terminal Experience exchange state is busy; retry the command");
      waitSync(25);
    }
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* noop */ }
    try { fs.unlinkSync(lockFile); } catch { /* stale recovery handles leftovers */ }
  }
}

function loadExchangeState(userDataDir) {
  const file = exchangeStatePath(userDataDir);
  recoverPrivateAtomicTarget(file);
  if (!fs.existsSync(file)) return emptyState();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new Error("Terminal Experience exchange state is unsafe or too large");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const allowed = new Set(["schemaVersion", "updatedAt", "bundles"]);
  const issues = [];
  strictObject(state, allowed, allowed, "exchange state", issues);
  if (state.schemaVersion !== STATE_SCHEMA || !Array.isArray(state.bundles)) issues.push("exchange state schema is invalid");
  if (state.updatedAt != null) checkIso(state.updatedAt, "exchange state.updatedAt", issues, true);
  if (state.bundles?.length > 2048) issues.push("exchange state has too many bundle records");
  for (const [index, row] of (state.bundles || []).entries()) {
    const required = new Set(["bundleId", "bundleHash", "experiencePackId", "experiencePackReleaseId", "agentDefinitionId", "compatibleBaseReleaseIds", "projectScopeHash", "storedAt", "remote"]);
    strictObject(row, required, required, `exchange state.bundles[${index}]`, issues);
    if (!BUNDLE_ID_RE.test(String(row.bundleId || ""))) issues.push(`exchange state.bundles[${index}].bundleId is invalid`);
    checkHash(row.bundleHash, `exchange state.bundles[${index}].bundleHash`, issues);
    for (const key of ["experiencePackId", "experiencePackReleaseId", "agentDefinitionId"]) checkId(row[key], `exchange state.bundles[${index}].${key}`, issues);
    checkStringList(row.compatibleBaseReleaseIds, `exchange state.bundles[${index}].compatibleBaseReleaseIds`, 1, 64, issues, { ids: true });
    checkHash(row.projectScopeHash, `exchange state.bundles[${index}].projectScopeHash`, issues);
    checkIso(row.storedAt, `exchange state.bundles[${index}].storedAt`, issues);
    if (row.remote != null) {
      const remoteLabel = `exchange state.bundles[${index}].remote`;
      if (typeof row.remote !== "object" || Array.isArray(row.remote)) issues.push(`${remoteLabel} is invalid`);
      else {
        const allowedRemote = new Set(["uploadId", "status", "requestedVisibility", "revision", "serverCheckedAt", "receipt", "baseResolution"]);
        strictObject(row.remote, new Set(["uploadId", "status", "requestedVisibility", "revision", "serverCheckedAt", "receipt"]), allowedRemote, remoteLabel, issues);
        if (!UPLOAD_ID_RE.test(String(row.remote.uploadId || ""))) issues.push(`${remoteLabel}.uploadId is invalid`);
        if (!/^rev_[0-9a-f]{32}$/.test(String(row.remote.revision || ""))) issues.push(`${remoteLabel}.revision is invalid`);
        checkIso(row.remote.serverCheckedAt, `${remoteLabel}.serverCheckedAt`, issues);
        try {
          const receipt = validateUploadReceipt(row.remote.receipt, null);
          if (receipt.uploadId !== row.remote.uploadId || receipt.revision !== row.remote.revision || receipt.status !== row.remote.status || receipt.requestedVisibility !== row.remote.requestedVisibility) {
            issues.push(`${remoteLabel} projection does not match its receipt`);
          }
        } catch (error) {
          issues.push(...(error.issues || [`${remoteLabel}.receipt is invalid`]));
        }
        if (row.remote.baseResolution != null) {
          const base = row.remote.baseResolution;
          const requiredBase = new Set(["schema", "cloudId", "slug", "agentDefinitionId", "agentReleaseId", "packageHash", "packageHashVersion"]);
          strictObject(base, requiredBase, requiredBase, `${remoteLabel}.baseResolution`, issues);
          if (base.schema !== BASE_RESOLUTION_SCHEMA) issues.push(`${remoteLabel}.baseResolution schema is invalid`);
          for (const key of ["cloudId", "agentDefinitionId", "agentReleaseId"]) checkId(base[key], `${remoteLabel}.baseResolution.${key}`, issues);
          if (typeof base.slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(base.slug)) issues.push(`${remoteLabel}.baseResolution.slug is invalid`);
          checkHash(base.packageHash, `${remoteLabel}.baseResolution.packageHash`, issues);
          if (!["path-sha256-v1", "path-sha256-executable-v2"].includes(base.packageHashVersion)) issues.push(`${remoteLabel}.baseResolution.packageHashVersion is invalid`);
        }
      }
    }
  }
  if (issues.length) throw new ExperienceBundleValidationError(issues);
  return state;
}

function saveExchangeState(userDataDir, state) {
  state.updatedAt = new Date().toISOString();
  writePrivateJsonAtomic(exchangeStatePath(userDataDir), state);
}

function projectScopeHash(cwd) {
  let resolved = path.resolve(cwd || process.cwd());
  try { resolved = fs.realpathSync.native(resolved); } catch { /* resolved path is still deterministic locally */ }
  return canonicalHash({ kind: "terminal-project-scope", path: resolved.normalize("NFC") });
}

function commitLocalBundleRecord(userDataDir, validation, options = {}) {
  const bundle = validation.bundle;
  return withExchangeStateLock(userDataDir, () => {
    const storedPath = bundleStorePath(userDataDir, bundle.bundleId);
    const statePath = exchangeStatePath(userDataDir);
    const storedSnapshot = readPrivateFileSnapshot(storedPath);
    const stateSnapshot = readPrivateFileSnapshot(statePath);
    const state = loadExchangeState(userDataDir);
    const now = new Date().toISOString();
    const previous = state.bundles.find((row) => row.bundleId === bundle.bundleId);
    const row = {
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      experiencePackId: bundle.pack.experiencePackId,
      experiencePackReleaseId: bundle.pack.releaseId,
      agentDefinitionId: bundle.pack.baseCompatibility.agentDefinitionId,
      compatibleBaseReleaseIds: [...bundle.pack.baseCompatibility.compatibleBaseReleaseIds],
      projectScopeHash: projectScopeHash(options.cwd),
      storedAt: now,
      remote: Object.prototype.hasOwnProperty.call(options, "remote") ? options.remote : previous?.remote || null,
    };
    const index = state.bundles.findIndex((item) => item.bundleId === row.bundleId);
    if (index >= 0) state.bundles[index] = row;
    else state.bundles.push(row);
    try {
      writePrivateTextAtomic(storedPath, validation.canonicalJson);
      saveExchangeState(userDataDir, state);
      return row;
    } catch (error) {
      const rollbackErrors = [];
      for (const [filePath, snapshot] of [[storedPath, storedSnapshot], [statePath, stateSnapshot]]) {
        try { restorePrivateFileSnapshot(filePath, snapshot); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
      throw error;
    }
  });
}

function saveLocalBundle(userDataDir, validation, options = {}) {
  return commitLocalBundleRecord(userDataDir, validation, options);
}

function readStoredBundle(userDataDir, bundleId) {
  const file = bundleStorePath(userDataDir, bundleId);
  recoverPrivateAtomicTarget(file);
  return readBundleFile(file, "/");
}

function resolveBundleInput(userDataDir, sourceOrRef, cwd) {
  if (!sourceOrRef) throw new Error("an Experience bundle file or saved bundle id is required");
  if (BUNDLE_ID_RE.test(sourceOrRef)) return readStoredBundle(userDataDir, sourceOrRef);
  return readBundleFile(sourceOrRef, cwd);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (!token.startsWith("--")) { flags._.push(token); continue; }
    const equal = token.indexOf("=");
    if (equal > 2) { flags[token.slice(2, equal)] = token.slice(equal + 1); continue; }
    const key = token.slice(2);
    if (index + 1 < args.length && !String(args[index + 1]).startsWith("--")) flags[key] = String(args[++index]);
    else flags[key] = true;
  }
  return flags;
}

function idempotencyKeyForBundle(bundle, explicit, operation = "save") {
  const defaultDigest = crypto.createHash("sha256")
    .update(canonicalJson({ bundleHash: bundle.bundleHash, operation, requestedVisibility: bundle.requestedVisibility }), "utf8")
    .digest("hex");
  const key = explicit || `exb-${defaultDigest}`;
  if (!SAFE_IDEMPOTENCY_RE.test(key)) throw new Error("Idempotency-Key must be 8..200 safe ASCII characters");
  return key;
}

function idempotencyKeyHash(key) {
  return `sha256:${crypto.createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function trustedExperienceOrigin(rawValue, options = {}) {
  let parsed;
  try { parsed = new URL(String(rawValue || "https://agentlas.cloud")); }
  catch { throw new Error("Agentlas Experience Web origin is invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Agentlas Experience Web origin must not contain userinfo, path, query, or fragment");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const loopbackOptIn = options.allowLoopback === true || options.env?.AGENTLAS_EXPERIENCE_ALLOW_LOOPBACK === "1";
  if (loopback) {
    if (!loopbackOptIn || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Loopback Experience Web origin requires explicit AGENTLAS_EXPERIENCE_ALLOW_LOOPBACK=1 opt-in");
    }
  } else {
    if (parsed.protocol !== "https:" || !OFFICIAL_EXPERIENCE_CLOUD_HOSTS.has(hostname) || (parsed.port && parsed.port !== "443")) {
      throw new Error("Authenticated Experience exchange is restricted to an explicitly approved HTTPS Agentlas origin");
    }
  }
  return parsed.origin;
}

function parseResponseJson(response, label) {
  try { return JSON.parse(response.text || "null"); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function responseError(response, label) {
  let data = null;
  try { data = JSON.parse(response.text || "null"); } catch { /* generic below */ }
  const serverCode = [data?.errorCode, data?.code, data?.error]
    .find((value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value));
  const detail = typeof data?.message === "string"
    ? data.message
    : typeof data?.error === "string"
      ? data.error
      : "";
  const error = new Error(`${label} failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  error.status = response.status;
  error.code = serverCode || (response.status === 401 || response.status === 403 ? "authentication_refused" : "experience_exchange_failed");
  error.details = data;
  return error;
}

async function authenticatedContext(options, dryRun) {
  if (dryRun) return null;
  const configured = options.baseUrl || options.env?.AGENTLAS_WEB_BASE_URL || process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud";
  const root = trustedExperienceOrigin(configured, options);
  const getSessionCookie = options.getSessionCookie;
  const cookie = typeof getSessionCookie === "function" ? await getSessionCookie() : options.sessionCookie;
  if (!cookie) {
    const error = new Error("Agentlas Cloud login is required; no Experience request was sent");
    error.code = "authentication_required";
    throw error;
  }
  if (typeof cookie !== "string" || cookie.length > 4096 || !/^agentlas_session=[A-Za-z0-9._~+/=%-]{1,4070}$/.test(cookie)) {
    const error = new Error("Agentlas Cloud session cookie is malformed; no Experience request was sent");
    error.code = "invalid_session_cookie";
    throw error;
  }
  if (typeof options.fetchHub !== "function") throw new Error("authenticated Hub fetch boundary is unavailable");
  return { cookie, origin: root, base: `${root}/api/experience/v1` };
}

function validateBaseResolution(value, bundle, requestedDescriptor) {
  const required = new Set(["schema", "cloudId", "slug", "agentDefinitionId", "agentReleaseId", "packageHash", "packageHashVersion"]);
  const issues = [];
  const data = requiredObject(value, required, "ExperienceBaseResolution", issues);
  if (data.schema !== BASE_RESOLUTION_SCHEMA) issues.push("base resolution schema is invalid");
  for (const key of ["cloudId", "agentDefinitionId", "agentReleaseId"]) checkId(data[key], `base resolution.${key}`, issues);
  if (typeof data.slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(data.slug)) issues.push("base resolution.slug is invalid");
  checkHash(data.packageHash, "base resolution.packageHash", issues);
  if (!["path-sha256-v1", "path-sha256-executable-v2"].includes(data.packageHashVersion)) issues.push("base resolution.packageHashVersion is invalid");
  if (data.agentDefinitionId !== bundle.pack.baseCompatibility.agentDefinitionId || !bundle.pack.baseCompatibility.compatibleBaseReleaseIds.includes(data.agentReleaseId)) {
    issues.push("base resolution does not match the exact bundle base ids");
  }
  if (requestedDescriptor.cloudId && data.cloudId !== requestedDescriptor.cloudId) issues.push("base resolution.cloudId mismatches request");
  if (requestedDescriptor.slug && data.slug !== requestedDescriptor.slug) issues.push("base resolution.slug mismatches request");
  if (data.packageHash !== requestedDescriptor.packageHash) issues.push("base resolution.packageHash mismatches request");
  if (requestedDescriptor.packageHashVersion && data.packageHashVersion !== requestedDescriptor.packageHashVersion) issues.push("base resolution.packageHashVersion mismatches request");
  if (issues.length) throw new ExperienceBundleValidationError(issues);
  return {
    schema: data.schema,
    cloudId: data.cloudId,
    slug: data.slug,
    agentDefinitionId: data.agentDefinitionId,
    agentReleaseId: data.agentReleaseId,
    packageHash: data.packageHash,
    packageHashVersion: data.packageHashVersion,
  };
}

function normalizeBaseDescriptor(options, existing) {
  const descriptor = {
    ...(existing || {}),
    ...(options.baseDescriptor || {}),
  };
  const request = {
    ...(descriptor.slug ? { slug: String(descriptor.slug) } : {}),
    ...(descriptor.cloudId ? { cloudId: String(descriptor.cloudId) } : {}),
    packageHash: String(descriptor.packageHash || ""),
    ...(descriptor.packageHashVersion ? { packageHashVersion: String(descriptor.packageHashVersion) } : {}),
  };
  if (!request.slug && !request.cloudId) throw new Error("exact base preflight requires --base-slug or --base-cloud-id");
  if (!HASH_RE.test(request.packageHash)) throw new Error("exact base preflight requires --base-package-hash sha256:<64 hex>");
  if (request.packageHashVersion && !["path-sha256-v1", "path-sha256-executable-v2"].includes(request.packageHashVersion)) {
    throw new Error("--base-package-hash-version is invalid");
  }
  return request;
}

async function resolveBaseRelease(bundle, options, auth, existingDescriptor) {
  const descriptor = normalizeBaseDescriptor(options, existingDescriptor);
  const response = await options.fetchHub(`${auth.base}/base-releases/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookie, origin: auth.origin },
    body: JSON.stringify(descriptor),
  });
  if (!response.ok) throw responseError(response, "exact base release preflight");
  const body = parseResponseJson(response, "exact base release preflight");
  return validateBaseResolution(body.baseResolution || body, bundle, descriptor);
}

function validateUploadReceipt(receipt, bundle) {
  const required = new Set(["schema", "uploadId", "bundleId", "bundleHash", "experiencePackId", "experienceReleaseId", "ownerWorkspaceRef", "status", "requestedVisibility", "revision", "createdAt", "updatedAt"]);
  const issues = [];
  const data = requiredObject(receipt, required, "ExperienceUploadReceipt", issues);
  if (data.schema !== RECEIPT_SCHEMA) issues.push("ExperienceUploadReceipt schema is invalid");
  if (!UPLOAD_ID_RE.test(String(data.uploadId || ""))) issues.push("uploadId is invalid");
  if (!BUNDLE_ID_RE.test(String(data.bundleId || ""))) issues.push("receipt.bundleId is invalid");
  checkHash(data.bundleHash, "receipt.bundleHash", issues);
  for (const key of ["experiencePackId", "experienceReleaseId", "ownerWorkspaceRef"]) checkId(data[key], `receipt.${key}`, issues);
  if (!["draft-saved", "verification-requested", "verification-pending", "verified-private", "public-active", "conflict", "withdrawn", "rejected"].includes(data.status)) issues.push("receipt.status is invalid");
  if (!["private", "unlisted", "public"].includes(data.requestedVisibility)) issues.push("receipt.requestedVisibility is invalid");
  if (typeof data.revision !== "string" || !/^rev_[0-9a-f]{32}$/.test(data.revision)) issues.push("receipt.revision is invalid");
  checkIso(data.createdAt, "receipt.createdAt", issues);
  checkIso(data.updatedAt, "receipt.updatedAt", issues);
  if (data.errorCode != null && !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(data.errorCode)) issues.push("receipt.errorCode is invalid");
  if (bundle) {
    if (data.bundleId !== bundle.bundleId || data.bundleHash !== bundle.bundleHash || data.experiencePackId !== bundle.pack.experiencePackId || data.experienceReleaseId !== bundle.pack.releaseId || data.requestedVisibility !== bundle.requestedVisibility) {
      issues.push("server receipt does not match the submitted bundle");
    }
  }
  if (issues.length) throw new ExperienceBundleValidationError(issues);
  return {
    schema: data.schema,
    uploadId: data.uploadId,
    bundleId: data.bundleId,
    bundleHash: data.bundleHash,
    experiencePackId: data.experiencePackId,
    experienceReleaseId: data.experienceReleaseId,
    ownerWorkspaceRef: data.ownerWorkspaceRef,
    status: data.status,
    requestedVisibility: data.requestedVisibility,
    revision: data.revision,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    ...(data.errorCode != null ? { errorCode: data.errorCode } : {}),
  };
}

function remoteProjection(receipt, baseResolution = null, previousRemote = null) {
  return {
    uploadId: receipt.uploadId,
    status: receipt.status,
    requestedVisibility: receipt.requestedVisibility,
    revision: receipt.revision,
    serverCheckedAt: new Date().toISOString(),
    receipt,
    ...(baseResolution ? { baseResolution } : previousRemote?.baseResolution ? { baseResolution: previousRemote.baseResolution } : {}),
  };
}

function commitServerAcceptedBundle(userDataDir, validation, receipt, baseResolution, options = {}) {
  const bundle = validation.bundle;
  try {
    const state = loadExchangeState(userDataDir);
    const previous = state.bundles.find((row) => row.bundleId === bundle.bundleId);
    return commitLocalBundleRecord(userDataDir, validation, {
      cwd: options.cwd,
      remote: remoteProjection(receipt, baseResolution, previous?.remote || null),
    });
  } catch (error) {
    const stateError = new Error(
      `Experience was accepted by the server as ${receipt.uploadId}, but Terminal could not atomically commit the canonical bundle and authoritative receipt. ` +
      "The prior local bundle/state were restored; rerun the same command and Idempotency-Key to reconcile the same receipt.",
    );
    stateError.code = "AGENTLAS_EXPERIENCE_LOCAL_STATE_COMMIT_FAILED";
    stateError.receipt = receipt;
    stateError.bundleId = bundle.bundleId;
    stateError.cause = error;
    throw stateError;
  }
}

function persistRemoteReceipt(userDataDir, bundle, receipt, baseResolution = null) {
  try {
    return withExchangeStateLock(userDataDir, () => {
      const state = loadExchangeState(userDataDir);
      const row = state.bundles.find((item) => item.bundleId === bundle.bundleId);
      if (!row) throw new Error("local bundle record disappeared before receipt persistence");
      row.remote = remoteProjection(receipt, baseResolution, row.remote);
      saveExchangeState(userDataDir, state);
      return row;
    });
  } catch (error) {
    const stateError = new Error(
      `Experience was accepted by the server as ${receipt.uploadId}, but Terminal could not persist the authoritative receipt. ` +
      "Do not change the bundle or Idempotency-Key; rerun the same save/publish command to reconcile the same receipt.",
    );
    stateError.code = "AGENTLAS_EXPERIENCE_LOCAL_STATE_COMMIT_FAILED";
    stateError.receipt = receipt;
    stateError.bundleId = bundle.bundleId;
    stateError.cause = error;
    throw stateError;
  }
}

async function recoverLostUpload(bundle, idempotencyKey, options, auth, originalError) {
  const query = new URLSearchParams({ bundleId: bundle.bundleId });
  let response;
  try {
    response = await options.fetchHub(`${auth.base}/uploads?${query.toString()}`, {
      method: "GET",
      headers: { accept: "application/json", cookie: auth.cookie, origin: auth.origin, "Idempotency-Key": idempotencyKey },
    });
  } catch (recoveryError) {
    originalError.recoveryError = recoveryError;
    throw originalError;
  }
  if (!response.ok) {
    originalError.recoveryStatus = response.status;
    throw originalError;
  }
  const body = parseResponseJson(response, "lost upload recovery");
  const receipt = validateUploadReceipt(body.receipt, bundle);
  const etag = response.headers && typeof response.headers.get === "function" ? response.headers.get("etag") : null;
  if (etag !== `"${receipt.revision}"`) throw new Error("lost upload recovery ETag does not match the receipt revision");
  return { receipt, replayed: true, recovered: true };
}

async function publishBundle(validation, options = {}) {
  const originalBundle = validation.bundle;
  const requestedVisibility = options.operation === "save"
    ? "private"
    : String(options.requestedVisibility || originalBundle.requestedVisibility);
  if (options.operation === "publish" && !["unlisted", "public"].includes(requestedVisibility)) {
    throw new Error("experience publish requires requested visibility unlisted or public; use experience save for a private draft");
  }
  const bundle = normalizeExperienceBundle({ ...originalBundle, requestedVisibility });
  const normalizedValidation = validateExperienceBundle(bundle);
  const dryRun = options.dryRun === true;
  const operation = options.operation === "publish" ? "publish" : "save";
  const key = idempotencyKeyForBundle(bundle, options.idempotencyKey, operation);
  if (dryRun) {
    return { dryRun: true, networkUsed: false, bundleId: bundle.bundleId, bundleHash: bundle.bundleHash, requestedVisibility: bundle.requestedVisibility, publicActivation: false, evaluatorAuthority: false };
  }
  const auth = await authenticatedContext(options, false);
  const existingState = loadExchangeState(options.userDataDir);
  const existingRow = findStateRecord(existingState, bundle.bundleId);
  const exactBaseDescriptor = normalizeBaseDescriptor(options, existingRow?.remote?.baseResolution);
  // Preflight and server acceptance happen before the canonical local envelope
  // is changed. A failed promotion must leave the prior private file/state
  // byte-identical instead of pairing a public envelope with an old receipt.
  const baseRelease = await resolveBaseRelease(bundle, { ...options, baseDescriptor: exactBaseDescriptor }, auth, existingRow?.remote?.baseResolution);
  let response;
  try {
    response = await options.fetchHub(`${auth.base}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, origin: auth.origin, "Idempotency-Key": key, "If-None-Match": "*" },
      body: JSON.stringify({ bundle }),
    });
  } catch (error) {
    const recovered = await recoverLostUpload(bundle, key, options, auth, error);
    commitServerAcceptedBundle(options.userDataDir, normalizedValidation, recovered.receipt, baseRelease, { cwd: options.cwd });
    return { ...recovered, dryRun: false, networkUsed: true, baseRelease, publicActivation: false, evaluatorAuthority: false };
  }
  if (!response.ok) throw responseError(response, "Experience draft upload");
  const body = parseResponseJson(response, "Experience draft upload");
  if (typeof body.replayed !== "boolean" || (response.status === 201 && body.replayed !== false) || (response.status === 200 && body.replayed !== true)) {
    throw new Error("Experience upload returned an invalid replay marker");
  }
  const receipt = validateUploadReceipt(body.receipt, bundle);
  const expectedStatus = operation === "publish" ? "verification-requested" : "draft-saved";
  if (receipt.status !== expectedStatus) throw new Error(`Experience ${operation} receipt must be ${expectedStatus}, never ${receipt.status}`);
  const etag = response.headers && typeof response.headers.get === "function" ? response.headers.get("etag") : null;
  if (etag !== `"${receipt.revision}"`) throw new Error("Experience upload ETag does not match the exact receipt revision");
  commitServerAcceptedBundle(options.userDataDir, normalizedValidation, receipt, baseRelease, { cwd: options.cwd });
  return { receipt, replayed: body.replayed, recovered: false, dryRun: false, networkUsed: true, baseRelease, publicActivation: false, evaluatorAuthority: false };
}

function findStateRecord(state, ref) {
  const matches = state.bundles.filter((row) => [row.bundleId, row.bundleHash, row.experiencePackId, row.experiencePackReleaseId, row.remote?.uploadId].includes(ref));
  return matches.sort((a, b) => String(b.storedAt).localeCompare(String(a.storedAt)))[0] || null;
}

function verifyStoredBundleRow(userDataDir, row) {
  const validation = readStoredBundle(userDataDir, row.bundleId);
  const bundle = validation.bundle;
  const sameIdentity =
    bundle.bundleId === row.bundleId &&
    bundle.bundleHash === row.bundleHash &&
    bundle.pack.experiencePackId === row.experiencePackId &&
    bundle.pack.releaseId === row.experiencePackReleaseId &&
    bundle.pack.baseCompatibility.agentDefinitionId === row.agentDefinitionId &&
    canonicalJson(bundle.pack.baseCompatibility.compatibleBaseReleaseIds) === canonicalJson(row.compatibleBaseReleaseIds);
  if (!sameIdentity) throw new Error("stored Experience bundle identity does not match its private index");
  if (row.remote) {
    const receipt = validateUploadReceipt(row.remote.receipt, bundle);
    if (
      receipt.uploadId !== row.remote.uploadId ||
      receipt.status !== row.remote.status ||
      receipt.requestedVisibility !== row.remote.requestedVisibility ||
      receipt.revision !== row.remote.revision
    ) throw new Error("stored Experience server receipt projection drifted from its private index");
    if (row.remote.baseResolution) {
      const base = row.remote.baseResolution;
      if (
        base.agentDefinitionId !== row.agentDefinitionId ||
        !row.compatibleBaseReleaseIds.includes(base.agentReleaseId)
      ) throw new Error("stored Experience exact base resolution drifted from its private index");
    }
  }
  return validation;
}

function scopedStateRows(userDataDir, cwd) {
  const scope = projectScopeHash(cwd);
  return loadExchangeState(userDataDir).bundles
    .filter((row) => row.projectScopeHash === scope)
    .sort((a, b) => compareCodePoints(a.experiencePackReleaseId, b.experiencePackReleaseId) || compareCodePoints(a.bundleId, b.bundleId));
}

function resolveScopedStoredRecord(userDataDir, ref, cwd) {
  if (!ref) throw new Error("an exact Experience bundle, pack release, or upload reference is required");
  const matches = scopedStateRows(userDataDir, cwd)
    .filter((row) => [row.bundleId, row.bundleHash, row.experiencePackId, row.experiencePackReleaseId, row.remote?.uploadId].includes(ref));
  if (!matches.length) throw new Error(`no exact local Experience record exists for this project: ${ref}`);
  if (matches.length > 1) throw new Error(`Experience reference is ambiguous; use an exact release, bundle, or upload id: ${ref}`);
  return { row: matches[0], validation: verifyStoredBundleRow(userDataDir, matches[0]) };
}

function publicStoredBundleView(row, validation) {
  const bundle = validation.bundle;
  const itemStatusCounts = bundle.items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, { candidate: 0, promoted: 0, deprecated: 0, rejected: 0 });
  const remote = row.remote
    ? {
        uploadId: row.remote.uploadId,
        status: row.remote.status,
        requestedVisibility: row.remote.requestedVisibility,
        revision: row.remote.revision,
        serverCheckedAt: row.remote.serverCheckedAt,
        receiptPresent: true,
        receiptVerified: true,
        ...(row.remote.baseResolution ? { exactBaseAgentReleaseId: row.remote.baseResolution.agentReleaseId } : {}),
      }
    : null;
  return {
    schemaVersion: "agentlas.terminal-experience-local-view.v1",
    bundleId: row.bundleId,
    bundleHash: row.bundleHash,
    experiencePackId: row.experiencePackId,
    experiencePackReleaseId: row.experiencePackReleaseId,
    agentDefinitionId: row.agentDefinitionId,
    compatibleBaseReleaseIds: [...row.compatibleBaseReleaseIds],
    requestedVisibility: bundle.requestedVisibility,
    itemCount: bundle.items.length,
    itemStatusCounts,
    reviewState: itemStatusCounts.candidate > 0 && itemStatusCounts.promoted === 0 ? "candidate-review" : "curated",
    storedAt: row.storedAt,
    currentProjectOnly: true,
    localBundleVerified: true,
    remote,
    publicActivationClaimed: false,
    evaluatorAuthority: false,
  };
}

function listStoredExperienceBundles(userDataDir, cwd) {
  return scopedStateRows(userDataDir, cwd)
    .map((row) => publicStoredBundleView(row, verifyStoredBundleRow(userDataDir, row)));
}

function inspectStoredExperienceBundle(userDataDir, ref, cwd) {
  const { row, validation } = resolveScopedStoredRecord(userDataDir, ref, cwd);
  return publicStoredBundleView(row, validation);
}

function previewWithdrawUpload(ref, options = {}) {
  const { row, validation } = resolveScopedStoredRecord(options.userDataDir, ref, options.cwd);
  if (!row.remote?.uploadId || !row.remote?.revision || !row.remote?.receipt) {
    throw new Error("unpublish requires an exact locally observed server receipt; publish or run experience status first");
  }
  const receipt = validateUploadReceipt(row.remote.receipt, validation.bundle);
  if (receipt.status === "withdrawn") throw new Error("Experience upload is already withdrawn");
  return {
    schemaVersion: "agentlas.terminal-experience-unpublish-preview.v1",
    dryRun: true,
    action: "unpublish",
    bundleId: row.bundleId,
    experiencePackReleaseId: row.experiencePackReleaseId,
    uploadId: receipt.uploadId,
    currentStatus: receipt.status,
    ifMatchRevision: receipt.revision,
    networkUsed: false,
    localWriteUsed: false,
    serverReceiptPresent: true,
    authority: "local-observed-server-receipt",
    publicActivationClaimed: false,
  };
}

async function fetchUploadStatus(ref, options = {}) {
  const { row, validation } = resolveScopedStoredRecord(options.userDataDir, ref, options.cwd);
  const uploadId = row.remote?.uploadId;
  if (!uploadId) throw new Error("no exact server upload receipt is known for this local project bundle");
  const auth = await authenticatedContext(options, false);
  const response = await options.fetchHub(`${auth.base}/uploads/${encodeURIComponent(uploadId)}`, {
    method: "GET",
    headers: { accept: "application/json", cookie: auth.cookie, origin: auth.origin },
  });
  if (!response.ok) throw responseError(response, "Experience upload status");
  const body = parseResponseJson(response, "Experience upload status");
  const bundle = validation.bundle;
  const receipt = validateUploadReceipt(body.receipt, bundle);
  if (receipt.uploadId !== uploadId) throw new Error("status receipt id mismatch");
  const etag = response.headers && typeof response.headers.get === "function" ? response.headers.get("etag") : null;
  if (etag !== `"${receipt.revision}"`) throw new Error("status ETag does not match the exact receipt revision");
  persistRemoteReceipt(options.userDataDir, bundle, receipt);
  return { receipt, authoritative: "server", publicActivation: false, evaluatorAuthority: false };
}

function assertSafeExportTarget(filePath, overwrite) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error("Experience export output must not be a symbolic link");
  if (!stat.isFile()) throw new Error("Experience export output must be an ordinary file path");
  if (!overwrite) throw new Error("Experience export output already exists; pass --overwrite to replace that exact regular file");
}

function writePrivateExportAtomic(filePath, text, overwrite) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  assertSafeExportTarget(filePath, overwrite);
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.export.tmp`);
  try {
    fs.writeFileSync(temp, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (overwrite) {
      replacePrivateFileAtomic(temp, filePath);
    } else {
      // Same-directory hard-link publication is atomic and no-clobber: an
      // output created after the preflight causes EEXIST instead of overwrite.
      fs.linkSync(temp, filePath);
      fs.unlinkSync(temp);
    }
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
  }
}

async function fetchUploadExport(ref, options = {}) {
  const { row } = resolveScopedStoredRecord(options.userDataDir, ref, options.cwd);
  const uploadId = row.remote?.uploadId;
  if (!uploadId) throw new Error("export requires an exact locally observed server upload receipt");
  const requestedOutput = options.outputPath
    ? path.resolve(options.cwd || process.cwd(), options.outputPath)
    : row
      ? path.resolve(options.cwd || process.cwd(), `${row.bundleId}.agentlas-experience.json`)
      : null;
  if (requestedOutput) assertSafeExportTarget(requestedOutput, options.overwrite === true);
  const auth = await authenticatedContext(options, false);
  const response = await options.fetchHub(`${auth.base}/uploads/${encodeURIComponent(uploadId)}/export`, {
    method: "GET",
    headers: { accept: "application/json", cookie: auth.cookie, origin: auth.origin },
  });
  if (!response.ok) throw responseError(response, "Experience export");
  const body = parseResponseJson(response, "Experience export");
  const validation = validateExperienceBundle(body.bundle);
  const receipt = validateUploadReceipt(body.receipt, validation.bundle);
  if (receipt.uploadId !== uploadId) throw new Error("export receipt id mismatch");
  if (validation.bundle.pack.ownerRef !== receipt.ownerWorkspaceRef) throw new Error("export bundle ownerRef does not match the authenticated receipt owner");
  if (row && (validation.bundle.bundleId !== row.bundleId || validation.bundle.bundleHash !== row.bundleHash)) {
    throw new Error("exported Experience semantics do not match the exact local bundle identity");
  }
  const etag = response.headers && typeof response.headers.get === "function" ? response.headers.get("etag") : null;
  if (etag !== `"${receipt.revision}"`) throw new Error("export ETag does not match the exact receipt revision");
  const outputPath = requestedOutput || path.resolve(options.cwd || process.cwd(), `${validation.bundle.bundleId}.agentlas-experience.json`);
  assertSafeExportTarget(outputPath, options.overwrite === true);
  writePrivateExportAtomic(outputPath, validation.canonicalJson, options.overwrite === true);
  if (row) persistRemoteReceipt(options.userDataDir, validation.bundle, receipt);
  return {
    outputPath,
    bundleId: validation.bundle.bundleId,
    bundleHash: validation.bundle.bundleHash,
    canonicalBytes: validation.canonicalBytes,
    uploadId: receipt.uploadId,
    status: receipt.status,
    revision: receipt.revision,
    authoritative: "server",
  };
}

async function withdrawUpload(ref, options = {}) {
  const { row, validation } = resolveScopedStoredRecord(options.userDataDir, ref, options.cwd);
  const uploadId = row.remote?.uploadId;
  if (!uploadId) throw new Error("unpublish requires an exact locally observed server upload receipt");
  if (!row?.remote?.revision) throw new Error("withdraw requires the exact locally observed server revision; run experience status first");
  if (row.remote.status === "withdrawn") throw new Error("Experience upload is already withdrawn");
  const auth = await authenticatedContext(options, false);
  const response = await options.fetchHub(`${auth.base}/uploads/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    headers: { accept: "application/json", cookie: auth.cookie, origin: auth.origin, "If-Match": `"${row.remote.revision}"` },
  });
  if (!response.ok) {
    if (response.status === 412) {
      const body = parseResponseJson(response, "Experience withdrawal conflict");
      const current = body.current?.receipt || body.current || body.receipt;
      if (current) {
        const bundle = validation.bundle;
        const receipt = validateUploadReceipt(current, bundle);
        persistRemoteReceipt(options.userDataDir, bundle, receipt);
        const error = new Error("Experience withdrawal revision is stale; current server receipt was reconciled locally. Review status and retry.");
        error.code = "experience_revision_conflict";
        error.status = 412;
        error.current = receipt;
        throw error;
      }
    }
    throw responseError(response, "Experience withdrawal (server support may be unavailable)");
  }
  const body = parseResponseJson(response, "Experience withdrawal");
  const bundle = validation.bundle;
  const receipt = validateUploadReceipt(body.receipt || body, bundle);
  if (receipt.uploadId !== uploadId || receipt.status !== "withdrawn") throw new Error("withdrawal did not return the exact withdrawn server receipt");
  const etag = response.headers && typeof response.headers.get === "function" ? response.headers.get("etag") : null;
  if (etag !== `"${receipt.revision}"`) throw new Error("withdrawal ETag does not match the new server revision");
  if (row) {
    persistRemoteReceipt(options.userDataDir, bundle, receipt);
  }
  return { receipt, authoritative: "server", publicActivation: false };
}

function normalizedTaxonomyAtom(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
}

function canonicalSourceTaskId(value) {
  const normalized = normalizedTaxonomyAtom(value);
  return normalized.startsWith(CANONICAL_TASK_PREFIX) && CANONICAL_TASK_ID_SET.has(normalized) ? normalized : null;
}

function canonicalTaskId(value) {
  const normalized = normalizedTaxonomyAtom(value);
  const source = canonicalSourceTaskId(normalized);
  if (source) return source;
  const id = `${CANONICAL_TASK_PREFIX}${normalized}`;
  return CANONICAL_TASK_ID_SET.has(id) ? id : null;
}

function isCanonicalTaskId(value) {
  return typeof value === "string" && CANONICAL_TASK_ID_SET.has(value);
}

function deriveCanonicalTaskClasses(_prompt, options = {}) {
  const declaredRaw = options.declaredTaskClasses ?? options.declaredTaskClass;
  if (declaredRaw != null && (Array.isArray(declaredRaw) ? declaredRaw.length : String(declaredRaw).trim())) {
    const declared = (Array.isArray(declaredRaw) ? declaredRaw : [declaredRaw]).map(String);
    const taskIds = [...new Set(declared.map(canonicalTaskId).filter(Boolean))];
    const invalidDeclared = declared.filter((value) => !canonicalTaskId(value));
    return {
      taskIds: CANONICAL_TASK_IDS.filter((id) => taskIds.includes(id)),
      source: "declared-task-class",
      matchedTaskClasses: CANONICAL_TASK_IDS.filter((id) => taskIds.includes(id)),
      invalidDeclaredCount: invalidDeclared.length,
    };
  }
  return { taskIds: [], source: "unresolved", matchedTaskClasses: [], invalidDeclaredCount: 0 };
}

/**
 * Meaning-aware task classification. An explicit declared class is accepted as
 * user/project data. Otherwise only the connected model may decide from the full
 * request. No regex, keyword list, glossary, or default class substitutes for a
 * missing or invalid model judgment.
 */
async function resolveCanonicalTaskClasses(prompt, options = {}) {
  const declaredRaw = options.declaredTaskClasses ?? options.declaredTaskClass;
  if (declaredRaw != null && (Array.isArray(declaredRaw) ? declaredRaw.length : String(declaredRaw).trim())) {
    return deriveCanonicalTaskClasses(prompt, options);
  }
  const judgment = require("./agentlas-judgment.cjs");
  if (!judgment.hasJudgmentRunner()) {
    return { taskIds: [], source: "model-unavailable", matchedTaskClasses: [], invalidDeclaredCount: 0 };
  }
  const verdict = await judgment.judgeLabels({
    kind: "experience-task-class",
    question:
      "Which kinds of work does this request actually involve? Judge the user's real task, not words that merely appear.",
    labels: CANONICAL_TASK_SLUGS,
    input: String(prompt || ""),
    guidance:
      "Return a label only when that kind of work is genuinely part of the request. A word inside an " +
      "unrelated compound or a different sense of the word does not count. Return an empty list for " +
      "content with no identifiable task (hashes, ids, random strings).",
    signal: options.signal,
  });
  if (verdict.source !== "llm") {
    return { taskIds: [], source: "model-unavailable", matchedTaskClasses: [], invalidDeclaredCount: 0 };
  }
  const taskIds = CANONICAL_TASK_IDS.filter((id) =>
    verdict.labels.some((slug) => id === `${CANONICAL_TASK_PREFIX}${slug}`));
  return {
    taskIds,
    source: "model-judgment",
    matchedTaskClasses: taskIds,
    invalidDeclaredCount: 0,
    ...(verdict.reason ? { judgmentReason: verdict.reason } : {}),
  };
}

function parseEnvironmentConstraint(value) {
  const normalized = normalizedTaxonomyAtom(value);
  const contract = EXPERIENCE_TAXONOMY_V1.environment;
  if (normalized.startsWith(contract.osPrefix)) {
    const selected = normalized.slice(contract.osPrefix.length);
    return CANONICAL_OS_VALUES.has(selected) ? { dimension: "os", value: selected } : null;
  }
  if (normalized.startsWith(contract.archPrefix)) {
    const selected = normalized.slice(contract.archPrefix.length);
    return CANONICAL_ARCH_VALUES.has(selected) ? { dimension: "arch", value: selected } : null;
  }
  if (normalized.startsWith(contract.runtimePrefix)) {
    const selected = normalized.slice(contract.runtimePrefix.length);
    return CANONICAL_RUNTIME_RE.test(selected) ? { dimension: "runtime", value: selected } : null;
  }
  return null;
}

function isCanonicalEnvironmentTag(value) {
  return Boolean(parseEnvironmentConstraint(value));
}

function defaultEnvironmentTags(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const platformCandidate = normalizedTaxonomyAtom(platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform);
  const archCandidate = normalizedTaxonomyAtom(arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch);
  const runtimeCandidate = normalizedTaxonomyAtom(typeof options.runtime === "string" ? options.runtime : typeof options.runtimeTag === "string" ? options.runtimeTag : "terminal");
  const platformName = CANONICAL_OS_VALUES.has(platformCandidate) ? platformCandidate : "unknown";
  const archName = CANONICAL_ARCH_VALUES.has(archCandidate) ? archCandidate : "unknown";
  const runtimeName = CANONICAL_RUNTIME_RE.test(runtimeCandidate) ? runtimeCandidate : "unknown";
  return [
    `${EXPERIENCE_TAXONOMY_V1.environment.osPrefix}${platformName}`,
    `${EXPERIENCE_TAXONOMY_V1.environment.archPrefix}${archName}`,
    `${EXPERIENCE_TAXONOMY_V1.environment.runtimePrefix}${runtimeName}`,
  ];
}

function environmentConstraintsMatch(constraints, environment) {
  const actual = {
    os: normalizedTaxonomyAtom(environment?.os),
    arch: normalizedTaxonomyAtom(environment?.arch),
    runtime: normalizedTaxonomyAtom(environment?.runtime),
  };
  if (!CANONICAL_OS_VALUES.has(actual.os) || !CANONICAL_ARCH_VALUES.has(actual.arch) || !CANONICAL_RUNTIME_RE.test(actual.runtime)) return false;
  if (actual.os === "unknown" || actual.arch === "unknown" || actual.runtime === "unknown") return false;
  return (constraints || []).every((raw) => {
    const parsed = parseEnvironmentConstraint(raw);
    return Boolean(parsed && actual[parsed.dimension] === parsed.value);
  });
}

function selectApplicablePortableItems(input = {}) {
  const profile = new Set([input.taskClass, ...(input.capabilityTags || [])].map(canonicalTaskId).filter(Boolean));
  if (!profile.size) return [];
  const eligible = (input.items || []).filter((item) => {
    if (!item || ["deprecated", "rejected"].includes(item.status)) return false;
    if (!(item.taskSignatures || []).map(canonicalSourceTaskId).filter(Boolean).some((task) => profile.has(task))) return false;
    return environmentConstraintsMatch(item.environmentConstraints || [], input.environment || {});
  });
  const superseded = new Set(eligible.flatMap((item) => item.supersedesItemIds || []));
  return eligible
    .filter((item) => typeof item.experienceItemId === "string" && !superseded.has(item.experienceItemId))
    .map((item) => item.experienceItemId);
}

function readExactLocalBaseMarker(agentRoot, expectedSlug = null) {
  if (!agentRoot) return { marker: null, reason: "exact-local-base-marker-unavailable" };
  const file = path.join(path.resolve(agentRoot), ".agentlas-cloud-package.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
      return { marker: null, reason: "exact-local-base-marker-unsafe" };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const slug = String(raw.slug || expectedSlug || "").trim();
    const packageHashRaw = String(raw.packageHash || "").replace(/^sha256:/i, "").toLowerCase();
    const packageHashVersion = String(raw.packageHashVersion || "");
    const cloudId = raw.cloudId == null ? null : String(raw.cloudId);
    if (
      !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(slug) ||
      (expectedSlug && slug !== expectedSlug) ||
      !/^[a-f0-9]{64}$/.test(packageHashRaw) ||
      !["path-sha256-v1", "path-sha256-executable-v2"].includes(packageHashVersion) ||
      (cloudId && !ID_RE.test(cloudId))
    ) return { marker: null, reason: "exact-local-base-marker-invalid" };
    return {
      marker: {
        slug,
        cloudId,
        packageHash: `sha256:${packageHashRaw}`,
        packageHashVersion,
      },
      reason: null,
    };
  } catch (error) {
    return {
      marker: null,
      reason: error?.code === "ENOENT" ? "exact-local-base-marker-unavailable" : "exact-local-base-marker-invalid",
    };
  }
}

function exactTaskSignatureInPrompt(signature, prompt, options = {}) {
  if (!isCanonicalTaskId(signature)) return false;
  return deriveCanonicalTaskClasses(prompt, options).taskIds.includes(signature);
}

/**
 * Resolve normal Terminal runs without fuzzy identity or semantic guessing.
 * Automatic retrieval additionally needs one exact Experience release selected
 * by an authoritative loadout. Merely saving/uploading a compatible bundle is
 * never attachment consent.
 */
function resolveRuntimeExperienceForAgent(options = {}) {
  const requested = options.requested || {};
  if (requested.disabled === true) {
    return { disabled: true, observableReason: "disabled-by-user", resolution: "skipped" };
  }
  const environmentTags = defaultEnvironmentTags(options);
  if (environmentTags.some((tag) => tag.endsWith("/unknown"))) {
    return { disabled: true, observableReason: "runtime-environment-unknown", resolution: "skipped" };
  }
  if (Array.isArray(requested.environmentTags) && requested.environmentTags.length) {
    const declaredEnvironment = [...new Set(requested.environmentTags.map(String).filter(Boolean))];
    const exactDefault = declaredEnvironment.length === environmentTags.length && declaredEnvironment.every((tag) => environmentTags.includes(tag));
    if (!declaredEnvironment.every(isCanonicalEnvironmentTag)) {
      return { disabled: true, observableReason: "legacy-environment-constraint-not-runtime-activatable", resolution: "skipped" };
    }
    if (!exactDefault) {
      return { disabled: true, observableReason: "declared-environment-does-not-match-runtime", resolution: "skipped" };
    }
  }
  const explicitBase = String(requested.baseAgentReleaseId || "");
  const explicitSignatures = [...new Set((requested.taskSignatures || []).map(String).filter(Boolean))];
  const explicitPackReleases = [...new Set((requested.experiencePackReleaseIds || []).map(String).filter(Boolean))];
  if (explicitBase || explicitSignatures.length || requested.agentDefinitionId || explicitPackReleases.length) {
    if (!ID_RE.test(explicitBase) || !explicitSignatures.length || explicitPackReleases.length !== 1 || !ID_RE.test(explicitPackReleases[0])) {
      return { disabled: true, observableReason: "incomplete-explicit-experience-binding", resolution: "skipped" };
    }
    if (explicitSignatures.some((item) => !isCanonicalTaskId(item))) {
      return { disabled: true, observableReason: "legacy-task-signature-not-runtime-activatable", resolution: "skipped" };
    }
    return {
      disabled: false,
      baseAgentReleaseId: explicitBase,
      ...(requested.agentDefinitionId && ID_RE.test(String(requested.agentDefinitionId)) ? { agentDefinitionId: String(requested.agentDefinitionId) } : {}),
      experiencePackReleaseIds: explicitPackReleases,
      taskSignatures: explicitSignatures,
      environmentTags,
      resolution: "explicit-exact",
    };
  }
  const agent = options.agent;
  if (!agent || agent.builtin || !agent.slug) {
    return { disabled: true, observableReason: agent?.builtin ? "builtin-agent-has-no-owned-experience-base" : "no-exact-agent-base", resolution: "skipped" };
  }
  const local = readExactLocalBaseMarker(options.agentRoot, agent.slug);
  if (!local.marker) return { disabled: true, observableReason: local.reason, resolution: "skipped" };
  const attachedPackReleases = [...new Set(
    (requested.attachedExperiencePackReleaseIds || []).map(String).filter(Boolean),
  )];
  if (attachedPackReleases.length !== 1 || !ID_RE.test(attachedPackReleases[0])) {
    return { disabled: true, observableReason: "explicit-experience-attachment-required", resolution: "skipped" };
  }
  let state;
  try { state = loadExchangeState(options.userDataDir); }
  catch { return { disabled: true, observableReason: "local-experience-state-invalid", resolution: "skipped" }; }
  const scopeHash = projectScopeHash(options.cwd);
  const matchingRows = state.bundles.filter((row) => {
    const base = row.remote?.baseResolution;
    return attachedPackReleases.includes(row.experiencePackReleaseId) &&
      row.projectScopeHash === scopeHash && base &&
      base.slug === local.marker.slug &&
      (!local.marker.cloudId || base.cloudId === local.marker.cloudId) &&
      base.packageHash === local.marker.packageHash &&
      base.packageHashVersion === local.marker.packageHashVersion &&
      base.agentDefinitionId === row.agentDefinitionId &&
      row.compatibleBaseReleaseIds.includes(base.agentReleaseId);
  });
  if (!matchingRows.length) {
    return { disabled: true, observableReason: "exact-local-base-release-unavailable", resolution: "skipped" };
  }
  const baseKeys = new Set(matchingRows.map((row) => {
    const base = row.remote.baseResolution;
    return `${base.agentDefinitionId}\0${base.agentReleaseId}\0${base.packageHash}`;
  }));
  if (baseKeys.size !== 1) {
    return { disabled: true, observableReason: "ambiguous-exact-base-release", resolution: "skipped" };
  }
  const base = matchingRows[0].remote.baseResolution;
  const taskClassResolution = deriveCanonicalTaskClasses(options.prompt, {
    declaredTaskClasses: requested.declaredTaskClasses ?? options.declaredTaskClasses ?? options.declaredTaskClass,
  });
  if (taskClassResolution.invalidDeclaredCount) {
    return { disabled: true, observableReason: "invalid-declared-task-class", resolution: "skipped" };
  }
  if (!taskClassResolution.taskIds.length) {
    return { disabled: true, observableReason: "canonical-task-class-unresolved", resolution: "skipped" };
  }
  const environment = new Set(environmentTags);
  const classifiedTasks = new Set(taskClassResolution.taskIds);
  const taskSignatures = new Set();
  let sawPromotedItem = false;
  let sawCanonicalSignature = false;
  let sawMatchingCanonicalTask = false;
  let sawLegacyEnvironmentForMatch = false;
  let sawCanonicalEnvironmentMismatch = false;
  for (const row of matchingRows) {
    let bundle;
    try { bundle = readStoredBundle(options.userDataDir, row.bundleId).bundle; }
    catch { continue; }
    for (const item of bundle.items) {
      if (item.status !== "promoted") continue;
      sawPromotedItem = true;
      const canonicalSignatures = item.taskSignatures.filter(isCanonicalTaskId);
      if (canonicalSignatures.length) sawCanonicalSignature = true;
      const matchedSignatures = canonicalSignatures.filter((signature) => classifiedTasks.has(signature));
      if (!matchedSignatures.length) continue;
      sawMatchingCanonicalTask = true;
      if (!item.environmentConstraints.every(isCanonicalEnvironmentTag)) {
        sawLegacyEnvironmentForMatch = true;
        continue;
      }
      if (!item.environmentConstraints.every((constraint) => environment.has(constraint))) {
        sawCanonicalEnvironmentMismatch = true;
        continue;
      }
      for (const signature of matchedSignatures) taskSignatures.add(signature);
    }
  }
  if (!taskSignatures.size) {
    const observableReason = sawPromotedItem && !sawCanonicalSignature
      ? "legacy-task-signature-not-auto-activatable"
      : sawMatchingCanonicalTask && sawLegacyEnvironmentForMatch
        ? "legacy-environment-constraint-not-auto-activatable"
        : sawMatchingCanonicalTask && sawCanonicalEnvironmentMismatch
          ? "canonical-environment-constraint-mismatch"
          : "canonical-task-signature-unavailable";
    return {
      disabled: true,
      observableReason,
      resolution: "skipped",
      taskClassResolution,
    };
  }
  return {
    disabled: false,
    baseAgentReleaseId: base.agentReleaseId,
    agentDefinitionId: base.agentDefinitionId,
    experiencePackReleaseIds: attachedPackReleases,
    taskSignatures: [...taskSignatures].sort(compareCodePoints),
    environmentTags,
    resolution: "automatic-exact",
    taskClassResolution,
  };
}

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 3);
}

function buildLocalExperienceAdvisory(options = {}) {
  const empty = { text: "", itemIds: [], estimatedTokens: 0, authority: "local-advisory", serverRentalResolutionReceiptPresent: false };
  if (!options.userDataDir || !options.cwd || !ID_RE.test(String(options.baseAgentReleaseId || ""))) return empty;
  const experiencePackReleaseIds = new Set(
    (options.experiencePackReleaseIds || []).map(String).filter((value) => ID_RE.test(value)),
  );
  if (experiencePackReleaseIds.size !== 1) return empty;
  const taskSignatures = new Set((options.taskSignatures || []).map(String).filter(isCanonicalTaskId));
  if (!taskSignatures.size) return empty;
  const resolvedEnvironmentTags = (options.environmentTags || defaultEnvironmentTags(options)).map(String).filter(isCanonicalEnvironmentTag);
  if (resolvedEnvironmentTags.some((tag) => tag.endsWith("/unknown"))) return empty;
  const environmentTags = new Set(resolvedEnvironmentTags);
  const state = loadExchangeState(options.userDataDir);
  const projectHash = projectScopeHash(options.cwd);
  const candidates = [];
  for (const row of state.bundles) {
    if (
      !experiencePackReleaseIds.has(row.experiencePackReleaseId) ||
      row.projectScopeHash !== projectHash ||
      !row.compatibleBaseReleaseIds.includes(options.baseAgentReleaseId)
    ) continue;
    if (options.agentDefinitionId && row.agentDefinitionId !== options.agentDefinitionId) continue;
    let validation;
    try { validation = readStoredBundle(options.userDataDir, row.bundleId); } catch { continue; }
    for (const item of validation.bundle.items) {
      if (item.status !== "promoted") continue;
      if (!item.taskSignatures.some((signature) => taskSignatures.has(signature))) continue;
      if (!item.environmentConstraints.every(isCanonicalEnvironmentTag)) continue;
      if (!item.environmentConstraints.every((constraint) => environmentTags.has(constraint))) continue;
      candidates.push(item);
    }
  }
  candidates.sort((a, b) => Number(b.confidence) - Number(a.confidence) || compareCodePoints(a.experienceItemId, b.experienceItemId));
  const header = "[AGENTLAS_LOCAL_EXPERIENCE_ADVISORY v1] NO SERVER RENTAL-RESOLUTION RECEIPT. Local user-attested procedures only; not evaluator-verified and not reputation evidence.";
  const reservedTokens = Number.isInteger(options.reservedTokens)
    ? Math.max(0, Math.min(EXPERIENCE_RETRIEVAL_MAX_TOKENS, options.reservedTokens))
    : 0;
  const dynamicTokenBudget = Math.max(0, EXPERIENCE_RETRIEVAL_MAX_TOKENS - reservedTokens);
  if (estimateTokens(header) > dynamicTokenBudget) return empty;
  let text = header;
  const itemIds = [];
  for (const item of candidates) {
    if (itemIds.length >= EXPERIENCE_RETRIEVAL_MAX_ITEMS || itemIds.includes(item.experienceItemId)) continue;
    const line = `\n- [${item.experienceItemId}] ${item.summary}\n  Steps: ${item.instructions.join(" | ")}`;
    const next = `${text}${line}`;
    if (estimateTokens(next) > dynamicTokenBudget) continue;
    text = next;
    itemIds.push(item.experienceItemId);
  }
  if (!itemIds.length) return empty;
  return { text, itemIds, estimatedTokens: estimateTokens(text), authority: "local-advisory", serverRentalResolutionReceiptPresent: false };
}

function augmentRuntimeSystemWithLocalExperience(systemPrompt, options = {}) {
  const context = buildLocalExperienceAdvisory(options);
  return {
    systemPrompt: context.text ? `${String(systemPrompt || "")}\n\n${context.text}` : String(systemPrompt || ""),
    experienceContext: context,
  };
}

function renderValidation(validation) {
  return [
    `Portable Experience valid: ${validation.bundle.bundleId}`,
    `pack: ${validation.bundle.pack.experiencePackId}@${validation.bundle.pack.version}`,
    `items: ${validation.bundle.items.length} / ${MAX_STORED_ITEMS} · canonical bytes: ${validation.canonicalBytes} / ${MAX_BUNDLE_CANONICAL_BYTES}`,
    "Privacy scan: passed · base package/raw prompt/transcript/path/credential material: absent",
    "Authority: local deterministic validation only; no server receipt, evaluator, reputation, Variant, or public activation.",
  ].join("\n");
}

function renderPublish(result) {
  if (result.dryRun) return `DRY RUN · ${result.bundleId} validated · network used: no · server state unchanged · public activation: not performed`;
  return [
    `Server-authoritative Experience upload receipt: ${result.receipt.uploadId}`,
    `state: ${result.receipt.status} · requested visibility: ${result.receipt.requestedVisibility}`,
    `idempotency: ${result.replayed ? "same receipt replayed" : "first accepted receipt"}${result.recovered ? " · recovered after lost response" : ""}`,
    "Public activation/evaluator verification/reputation: NOT performed or claimed.",
  ].join("\n");
}

function publicUploadReceipt(receipt) {
  return {
    schema: receipt.schema,
    uploadId: receipt.uploadId,
    bundleId: receipt.bundleId,
    bundleHash: receipt.bundleHash,
    experiencePackId: receipt.experiencePackId,
    experienceReleaseId: receipt.experienceReleaseId,
    status: receipt.status,
    requestedVisibility: receipt.requestedVisibility,
    revision: receipt.revision,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
  };
}

function publicCommandExchangeResult(result) {
  return {
    ...(result.receipt ? { receipt: publicUploadReceipt(result.receipt) } : {}),
    ...(BUNDLE_ID_RE.test(String(result.bundleId || "")) ? { bundleId: result.bundleId } : {}),
    ...(HASH_RE.test(String(result.bundleHash || "")) ? { bundleHash: result.bundleHash } : {}),
    ...(["private", "unlisted", "public"].includes(result.requestedVisibility) ? { requestedVisibility: result.requestedVisibility } : {}),
    ...(typeof result.replayed === "boolean" ? { replayed: result.replayed } : {}),
    ...(typeof result.recovered === "boolean" ? { recovered: result.recovered } : {}),
    ...(typeof result.dryRun === "boolean" ? { dryRun: result.dryRun } : {}),
    ...(typeof result.networkUsed === "boolean" ? { networkUsed: result.networkUsed } : {}),
    ...(typeof result.authoritative === "string" ? { authoritative: result.authoritative } : {}),
    publicActivation: false,
    evaluatorAuthority: false,
  };
}

function baseDescriptorFromFlags(flags) {
  return {
    ...(flags["base-slug"] ? { slug: flags["base-slug"] } : {}),
    ...(flags["base-cloud-id"] ? { cloudId: flags["base-cloud-id"] } : {}),
    ...(flags["base-package-hash"] ? { packageHash: flags["base-package-hash"] } : {}),
    ...(flags["base-package-hash-version"] ? { packageHashVersion: flags["base-package-hash-version"] } : {}),
  };
}

async function cmdExperienceExchange(options = {}) {
  const args = options.args || [];
  const sub = args[0] || "list";
  const flags = parseFlags(args.slice(1));
  const emit = options.out || console.log;
  if (!options.userDataDir) throw new Error("Terminal userData path is required");

  if (sub === "help" || sub === "--help" || sub === "-h") {
    const help = [
      "agentlas experience list",
      "agentlas experience inspect <exact-release-id|bundle-id|upload-id>",
      "agentlas experience validate <bundle.agentlas-experience.json>",
      "agentlas experience save <bundle> --base-cloud-id <id>|--base-slug <slug> --base-package-hash sha256:<hash>",
      "agentlas experience publish <bundle> --visibility unlisted|public --base-cloud-id <id>|--base-slug <slug> --base-package-hash sha256:<hash>",
      "agentlas experience status <bundle-id|upload-id>",
      "agentlas experience unpublish <exact-release-id|bundle-id|upload-id> [--dry-run]",
      "agentlas experience withdraw <bundle-id|upload-id>",
      "agentlas experience export <bundle-id|upload-id> [--out file] [--overwrite]",
      "Options: --dry-run (zero network/write), --idempotency-key <safe-key>, save --local-only",
      "Legacy pack-only local intents: legacy-list|legacy-inspect|legacy-publish|legacy-unpublish",
      "publish requests verification only; Terminal never claims evaluator verification or public activation.",
    ].join("\n");
    emit(help);
    return { help: true };
  }

  if (["legacy-list", "legacy-inspect", "legacy-publish", "legacy-unpublish"].includes(sub)) {
    if (typeof options.legacyCommand !== "function") throw new Error("legacy local-intent Experience handler is unavailable");
    const mapped = sub.slice("legacy-".length);
    return options.legacyCommand({ ...options, args: [mapped, ...args.slice(1)] });
  }
  if (sub === "list" || sub === "ls") {
    if (flags._.length) throw new Error("usage: agentlas experience list [--json]");
    const bundles = listStoredExperienceBundles(options.userDataDir, options.cwd);
    const result = {
      schemaVersion: "agentlas.terminal-experience-local-list.v1",
      currentProjectOnly: true,
      networkUsed: false,
      bundles,
    };
    const lines = bundles.length
      ? ["LOCAL PORTABLE EXPERIENCE BUNDLES · current project only · no network", ...bundles.map((bundle) =>
          `- ${bundle.experiencePackId}@${bundle.experiencePackReleaseId} · ${bundle.itemCount} item(s) · ${bundle.reviewState} · Hub: ${bundle.remote ? `${bundle.remote.status} (${bundle.remote.uploadId})` : "not submitted"}`)]
      : ["No Portable Experience Bundles are stored for this project.", "Hub was not contacted."];
    emit(flags.json ? JSON.stringify(result, null, 2) : lines.join("\n"));
    return result;
  }
  if (sub === "inspect" || sub === "show") {
    const ref = flags._[0];
    if (!ref || flags._.length !== 1) throw new Error("usage: agentlas experience inspect <exact-release-id|bundle-id|upload-id>");
    const bundle = inspectStoredExperienceBundle(options.userDataDir, ref, options.cwd);
    const result = { ...bundle, networkUsed: false };
    emit(flags.json ? JSON.stringify(result, null, 2) : [
      `${bundle.experiencePackId}@${bundle.experiencePackReleaseId}`,
      `bundle: ${bundle.bundleId} · ${bundle.itemCount} item(s) · local integrity: verified`,
      `review state: ${bundle.reviewState} · candidates ${bundle.itemStatusCounts.candidate} · promoted ${bundle.itemStatusCounts.promoted}`,
      `compatible base releases: ${bundle.compatibleBaseReleaseIds.join(", ")}`,
      bundle.remote
        ? `Hub receipt: ${bundle.remote.status} · ${bundle.remote.uploadId} · exact revision ${bundle.remote.revision}`
        : "Hub receipt: none · not submitted",
      "Owner/account, local path, raw content, prompt, transcript, and credentials are intentionally omitted.",
      "Public activation/evaluator authority: not claimed.",
    ].join("\n"));
    return result;
  }
  if (sub === "validate") {
    const validation = readBundleFile(flags._[0], options.cwd);
    const result = { valid: true, bundleId: validation.bundle.bundleId, bundleHash: validation.bundle.bundleHash, packContentHash: validation.bundle.pack.contentHash, items: validation.bundle.items.length, canonicalBytes: validation.canonicalBytes, networkUsed: false, authority: "local-validation" };
    emit(flags.json ? JSON.stringify(result, null, 2) : renderValidation(validation));
    return result;
  }
  if (sub === "save") {
    const validation = readBundleFile(flags._[0], options.cwd);
    if (flags["local-only"] === true) {
      if (flags["dry-run"] === true) {
        const result = { dryRun: true, saved: false, networkUsed: false, bundleId: validation.bundle.bundleId };
        emit(flags.json ? JSON.stringify(result, null, 2) : `DRY RUN · ${validation.bundle.bundleId} validated · no file saved · network used: no`);
        return result;
      }
      const row = saveLocalBundle(options.userDataDir, validation, { cwd: options.cwd });
      const result = { saved: true, localOnly: true, networkUsed: false, bundleId: row.bundleId, projectScopeHash: row.projectScopeHash, serverReceiptPresent: false };
      emit(flags.json ? JSON.stringify(result, null, 2) : `Local 0600 Experience bundle saved: ${row.bundleId}\nHub: not contacted · server receipt: none · public activation: none`);
      return result;
    }
    const result = await publishBundle(validation, {
      ...options,
      operation: "save",
      dryRun: flags["dry-run"] === true,
      idempotencyKey: flags["idempotency-key"] || null,
      baseDescriptor: baseDescriptorFromFlags(flags),
    });
    emit(flags.json ? JSON.stringify(publicCommandExchangeResult(result), null, 2) : renderPublish(result));
    return result;
  }
  if (sub === "publish") {
    const source = flags._[0];
    const validation = resolveBundleInput(options.userDataDir, source, options.cwd);
    const result = await publishBundle(validation, {
      ...options,
      operation: "publish",
      requestedVisibility: flags.visibility || validation.bundle.requestedVisibility,
      dryRun: flags["dry-run"] === true,
      idempotencyKey: flags["idempotency-key"] || null,
      baseDescriptor: baseDescriptorFromFlags(flags),
    });
    emit(flags.json ? JSON.stringify(publicCommandExchangeResult(result), null, 2) : renderPublish(result));
    return result;
  }
  if (sub === "status") {
    const result = await fetchUploadStatus(flags._[0], options);
    emit(flags.json ? JSON.stringify(publicCommandExchangeResult(result), null, 2) : `Server-authoritative status: ${result.receipt.status} · ${result.receipt.uploadId}\nrequested visibility: ${result.receipt.requestedVisibility} · Terminal did not assert public activation/evaluator reputation`);
    return result;
  }
  if (sub === "export") {
    const result = await fetchUploadExport(flags._[0], {
      ...options,
      outputPath: typeof flags.out === "string" ? flags.out : null,
      overwrite: flags.overwrite === true,
    });
    // Intentionally omit owner/account fields and bundle content from stdout.
    emit(flags.json ? JSON.stringify(result, null, 2) : `Experience exported: ${result.outputPath}\nbundle hash: ${result.bundleHash}`);
    return result;
  }
  if (sub === "withdraw" || sub === "unpublish") {
    if (!flags._[0] || flags._.length !== 1) throw new Error("usage: agentlas experience unpublish <exact-release-id|bundle-id|upload-id> [--dry-run]");
    if (flags["dry-run"] === true) {
      const result = previewWithdrawUpload(flags._[0], options);
      emit(flags.json ? JSON.stringify(result, null, 2) : `DRY RUN · exact upload ${result.uploadId} at ${result.ifMatchRevision}\nnetwork/write used: no · server state unchanged · no new receipt`);
      return result;
    }
    const result = await withdrawUpload(flags._[0], options);
    emit(flags.json ? JSON.stringify(publicCommandExchangeResult(result), null, 2) : `Server-authoritative unpublication: ${result.receipt.uploadId} · withdrawn\nExisting receipts/history remain; no public activation claim.`);
    return result;
  }
  throw new Error("unknown experience subcommand (list|inspect|validate|save|publish|status|export|unpublish|withdraw; legacy: legacy-list|legacy-inspect|legacy-publish|legacy-unpublish)");
}

module.exports = {
  BUNDLE_SCHEMA,
  RECEIPT_SCHEMA,
  MAX_BUNDLE_CANONICAL_BYTES,
  MAX_STORED_ITEMS,
  EXPERIENCE_RETRIEVAL_MAX_ITEMS,
  EXPERIENCE_RETRIEVAL_MAX_TOKENS,
  EXPERIENCE_TAXONOMY_V1,
  EXPERIENCE_TAXONOMY_CHECKSUM,
  CANONICAL_TASK_PREFIX,
  CANONICAL_ENV_PREFIX,
  CANONICAL_TASK_SLUGS,
  CANONICAL_TASK_IDS,
  ExperienceBundleValidationError,
  canonicalJson,
  canonicalHash,
  normalizeExperienceBundle,
  experiencePackContentPayload,
  experiencePackContentHash,
  experienceBundleHashPayload,
  experienceBundleHash,
  experienceBundleId,
  validateExperienceBundle,
  validateUploadReceipt,
  readBundleFile,
  recoverPrivateAtomicTarget,
  replacePrivateFileAtomic,
  exchangeStatePath,
  bundleStorePath,
  loadExchangeState,
  withExchangeStateLock,
  saveLocalBundle,
  commitServerAcceptedBundle,
  readStoredBundle,
  verifyStoredBundleRow,
  scopedStateRows,
  resolveScopedStoredRecord,
  listStoredExperienceBundles,
  inspectStoredExperienceBundle,
  previewWithdrawUpload,
  publicUploadReceipt,
  publicCommandExchangeResult,
  projectScopeHash,
  idempotencyKeyForBundle,
  idempotencyKeyHash,
  trustedExperienceOrigin,
  publishBundle,
  fetchUploadStatus,
  fetchUploadExport,
  withdrawUpload,
  defaultEnvironmentTags,
  loadExperienceTaxonomyContract,
  validateExperienceTaxonomyContract,
  canonicalSourceTaskId,
  canonicalTaskId,
  isCanonicalTaskId,
  parseEnvironmentConstraint,
  isCanonicalEnvironmentTag,
  environmentConstraintsMatch,
  selectApplicablePortableItems,
  deriveCanonicalTaskClasses,
  resolveCanonicalTaskClasses,
  readExactLocalBaseMarker,
  exactTaskSignatureInPrompt,
  resolveRuntimeExperienceForAgent,
  estimateTokens,
  buildLocalExperienceAdvisory,
  augmentRuntimeSystemWithLocalExperience,
  portableExperienceSafetyIssues,
  cmdExperienceExchange,
};
