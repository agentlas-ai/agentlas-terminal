"use strict";
/*
 * mcp/inventory — 시스템 전역 MCP 레지스트리 인벤토리 + 프로젝트 MCP 정책.
 *
 * 경계(v1 계약 그대로):
 *  - 발견은 Agentlas가 신뢰하는 시스템 전역 레지스트리(mcp_servers) 메타데이터만
 *    읽는다. 실행/연결/다운로드/서버정의 복사는 절대 하지 않는다.
 *  - 자격증명 "값"은 결코 다루지 않는다 — 키 이름 존재 여부만 관찰한다.
 *  - 패키지/카탈로그 콘텐츠는 실행 재료를 공급할 수 없다: 실행 필드는 항상
 *    신뢰 레지스트리 행에서 다시 읽는다(materialize/readApproved).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir: defaultUserDataDir } = require("../core/paths.cjs");
const {
  hasSensitiveRuntimeArgument,
  mcpRuntimeHome,
  normalizeCredentialKeyNames,
} = require("../agentlas-mcp-env.cjs");
const {
  ID_RE,
  ENV_RE,
  UNSAFE_TEXT_PATTERNS,
  assertObject,
  assertExactKeys,
  assertId,
  assertUniqueIds,
  assertSafeText,
  safeCatalogId,
  safeDisplayName,
  readJsonFile,
  parseRuntimeServerArgs,
} = require("./contract.cjs");

// MCP 정책의 contextBudget 상한(동결). 정책 파일이 이보다 큰 예산을 선언하면 거부.
const TOKEN_BUDGET = Object.freeze({
  coreMemoryMaxTokens: 150,
  experienceRetrievalMaxTokens: 800,
  experienceRetrievalMaxItems: 8,
});

function resolvedMcpUserDataDir(value) {
  return typeof value === "string" && value.trim() ? value : defaultUserDataDir();
}

const MCP_REQUIREMENT_REQUIRED = [
  "schemaVersion", "kind", "requirementId", "catalogId", "reason", "capabilities",
  "required", "requiresKey", "priority", "permissions", "alternatives", "unavailablePolicy",
];
const MCP_REQUIREMENT_ALLOWED = new Set([...MCP_REQUIREMENT_REQUIRED, "credentialMetadata"]);

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
  let value;
  try { ({ value } = readJsonFile(file, "MCP policy")); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  return validateMcpPolicy(value);
}

/**
 * 관찰 가능한 자격증명 "키 이름"만 수집한다(값은 절대 읽어 반환하지 않는다).
 * 소스: 프로세스 env + userData/credentials.env + ~/.agentlas/credentials.env.
 */
function readCredentialNames(userDataDir, env = process.env) {
  const resolvedUserDataDir = resolvedMcpUserDataDir(userDataDir);
  const names = new Set(Object.keys(env || {}).filter((key) => ENV_RE.test(key) && env[key]));
  const files = [
    path.join(resolvedUserDataDir, "credentials.env"),
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

function collectSystemMcpInventory(db, options = {}) {
  let rows = [];
  let registryStatus = "complete";
  try {
    rows = db.prepare("SELECT id, catalog_id, name, name_en, transport, env_keys_json, enabled FROM mcp_servers ORDER BY installed_at ASC LIMIT 1025").all();
  } catch {
    // 읽을 수 없는 레지스트리는 "읽었더니 비어 있음"과 다른 사실이다.
    // 둘 다 empty-MCP로 fail-closed하지만, 사용자 플랜에는 원인을 보존한다.
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
  const credentialNames = readCredentialNames(options.userDataDir, options.env || process.env);
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
    // 실행/지문 재료는 공개 투영(JSON.stringify)에 절대 실리지 않도록 non-enumerable.
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

/**
 * 신뢰 시스템 전역 레지스트리 행 → 실행 가능한 서버 오브젝트.
 * 안전하지 않은 행(비-stdio, 민감 인자, 잘못된 자격 메타데이터)은 null로 fail-closed.
 * consentFingerprint는 "무엇에 동의했는가"의 정확한 지문 — 명령/인자/키이름이
 * 하나라도 바뀌면 기존 동의가 무효가 되는 근거다.
 */
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
      value: mcpRuntimeHome(resolvedMcpUserDataDir(options.userDataDir), `${catalogId}\u0000${row.id}`),
      enumerable: false,
    });
  }
  return server;
}

/**
 * Post-consent only. 정확한 신뢰 시스템 전역 행을 실행 필드까지 다시 읽는다.
 * 패키지/카탈로그 콘텐츠는 이 재료를 공급할 수 없다. 동의 후 자격 메타데이터가
 * 넓어졌다면(지문 불일치) 실행 전에 실패해야 한다.
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

module.exports = {
  TOKEN_BUDGET,
  validateCredentialMetadata,
  validateMcpRequirement,
  validateMcpPolicy,
  loadProjectMcpPolicy,
  readCredentialNames,
  collectSystemMcpInventory,
  materializeTrustedSystemMcpServer,
  readApprovedSystemMcpServer,
};
