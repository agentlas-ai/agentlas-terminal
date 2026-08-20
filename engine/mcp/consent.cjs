"use strict";
/*
 * mcp/consent — 1회(one-pass) 동의 프롬프트 + 동의 영수증 저장소 + 런타임 allowlist 해소.
 *
 * 계약(v1 그대로):
 *  - 동의 상태(<userData>/terminal/mcp-consents-v1.json)에는 정체성과 지문만 담는다.
 *    명령/인자/자격증명 등 실행 재료는 절대 저장하지 않는다.
 *  - "enabled" 레지스트리 행이라는 사실만으로는 ordinary turn에 attach할 권한이
 *    생기지 않는다 — 정확한 consentFingerprint가 일치하는 영수증이 있어야 한다.
 *  - 런타임 정의가 조금이라도 드리프트하면(명령/인자/키이름 변경) 지문이 갈리고
 *    기존 동의는 자동 무효가 된다. 손상된 동의 상태는 fail-closed(빈 목록).
 */
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_APPROVED_MCP_PER_BUILD,
  MAX_JSON_BYTES,
  ID_RE,
  assertExactKeys,
  assertId,
  assertIsoDateOrNull,
  safeCatalogId,
  writePrivateJsonAtomic,
  withPrivateStateLock,
  parseIdList,
} = require("./contract.cjs");
const { materializeTrustedSystemMcpServer, readApprovedSystemMcpServer } = require("./inventory.cjs");
const {
  MCP_PROBE_CONCURRENCY,
  MCP_PROBE_PER_SERVER_TIMEOUT_MS,
  MCP_PROBE_TOTAL_TIMEOUT_MS,
  probeSystemMcpServerConnection,
} = require("./probe.cjs");

const MCP_CONSENT_STATE_SCHEMA = "agentlas.terminal-mcp-consents.v1";
const MCP_CONSENT_RECEIPT_SCHEMA = "agentlas.terminal-mcp-consent.v1";

/*
 * ── 통합 능력 승인(데스크탑 capability_grants)과의 합류 ───────────────────────
 *
 * 이 파일의 v1 계약(지문 일치 영수증)은 그대로다. 그 **위에** 공유 능력 규칙이 얹힌다:
 *   · 규칙이 deny 면 영수증이 있어도 붙이지 않는다(영구 거부는 어디서도 뚫리지 않는다).
 *   · 규칙이 allow 면 다시 묻지 않는다(데스크탑에서 누른 "항상 허용"이 여기서도 항상).
 *   · 규칙이 없으면 종전대로 1회 동의 프롬프트가 돈다.
 * 터미널에서 "항상"을 고르면 같은 표에 써서 데스크탑에도 반영된다.
 *
 * MCP 서버를 붙이는 것은 외부 프로세스를 띄우는 일이라 능력 클래스는 execute 다.
 * 규칙 키는 `tool:mcp:<catalogId>` + 패턴 없음(그 서버 전체) — 데스크탑의 도구 규칙과
 * 같은 표·같은 판정 함수를 쓴다.
 */
const MCP_CAPABILITY_CLASS = "execute";

function mcpCapabilityQuery(catalogId) {
  return { capability: MCP_CAPABILITY_CLASS, tool: `mcp:${String(catalogId)}`, detail: String(catalogId) };
}

function capabilityGrantsModule() {
  return require("../core/capability-grants.cjs");
}

/**
 * 계획의 후보들을 공유 능력 규칙으로 미리 가른다.
 * @returns {{available:string[], preApproved:string[], denied:string[],
 *            grantsAvailable:boolean, fallbackReason:string|null}}
 *   grantsAvailable=false 는 표가 없는 구버전 공유 DB — 사유를 담아 돌려주고 기존 동작으로 간다.
 */
function partitionMcpConsentByCapabilityGrants(db, catalogIds) {
  const ids = [...new Set((catalogIds || []).map((id) => String(id)).filter(Boolean))];
  const grants = capabilityGrantsModule();
  if (!db || !grants.capabilityGrantsAvailable(db)) {
    return {
      available: ids,
      preApproved: [],
      denied: [],
      grantsAvailable: false,
      fallbackReason: db ? grants.UNAVAILABLE_REASON : null,
    };
  }
  const available = [];
  const preApproved = [];
  const denied = [];
  let fallbackReason = null;
  for (const id of ids) {
    let ruling;
    try {
      ruling = grants.readCapabilityDecision(db, mcpCapabilityQuery(id));
    } catch (error) {
      fallbackReason = `capability_grants read failed: ${(error && error.message) || error}`;
      available.push(id);
      continue;
    }
    if (!ruling.available) {
      fallbackReason = fallbackReason || ruling.reason;
      available.push(id);
    } else if (ruling.decision === "deny") denied.push(id);
    else if (ruling.decision === "allow") preApproved.push(id);
    else available.push(id);
  }
  return { available, preApproved, denied, grantsAvailable: true, fallbackReason };
}

/** 터미널에서 고른 "항상"을 데스크탑과 같은 표에 남긴다. 표가 없으면 정직한 실패. */
function rememberMcpCapabilityGrant(db, catalogId, decision = "allow") {
  const grants = capabilityGrantsModule();
  return grants.recordCapabilityGrant(db, {
    capability: `tool:mcp:${String(catalogId)}`,
    pattern: null,
    decision: decision === "deny" ? "deny" : "allow",
    scope: "global",
    source: "terminal-mcp-consent",
  });
}

function mcpConsentStatePath(userDataDir) {
  return path.join(userDataDir, "terminal", "mcp-consents-v1.json");
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
  return withPrivateStateLock(mcpConsentStatePath(userDataDir), {
    unsafe: "Terminal MCP consent lock is unsafe",
    busy: "Terminal MCP consent state is busy; retry the command",
  }, action);
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
  // 영구 거부(deny)는 옛 동의 영수증을 이긴다 — 규칙이 영수증보다 위다.
  const partition = partitionMcpConsentByCapabilityGrants(
    db,
    state.receipts.map((receipt) => receipt.catalogId),
  );
  const denied = new Set(partition.denied);
  const servers = [];
  const seen = new Set();
  for (const receipt of state.receipts) {
    if (seen.has(receipt.catalogId) || denied.has(receipt.catalogId)) continue;
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
 * 답 한 줄을 해석한다. `always`/`a` 는 "전부 붙이고 **다시는 묻지 마라**" — 그 선택만
 * 공유 능력 규칙(capability_grants)에 영구 기록된다. y/n/ids 는 종전 그대로 1회 한정이다.
 */
function parseConsentAnswer(answer, availableIds) {
  const text = String(answer || "").trim();
  if (/^(?:a|always|항상)$/i.test(text)) return { ids: [...availableIds], always: true };
  if (/^(?:y|yes|all|전체)$/i.test(text)) return { ids: [...availableIds], always: false };
  if (!text || /^(?:n|no|none|없이|아니)$/i.test(text)) return { ids: [], always: false };
  const requested = parseIdList(text.replace(/^always\s+/i, ""));
  const allowed = new Set(availableIds);
  return { ids: requested.filter((id) => allowed.has(id)), always: /^always\s+/i.test(text) };
}

function normalizeConsentAnswer(answer, availableIds) {
  return parseConsentAnswer(answer, availableIds).ids;
}

function askMcpConsentOnce(plan, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stderr;
  /*
   * 공유 능력 규칙을 먼저 본다(오너 결정 2026-08-20):
   *   deny → 후보에서 제외하고 묻지 않는다.  allow → 묻지 않고 통과.
   * 남은 후보만 사람에게 묻는다. 규칙이 없으면 목록이 그대로라 종전 동작과 동일하다.
   */
  const partition = partitionMcpConsentByCapabilityGrants(options.db, plan.availableCatalogIds || []);
  const askable = partition.available;
  const preApproved = partition.preApproved;
  const notify = typeof options.onNotice === "function" ? options.onNotice : null;
  if (notify) {
    if (partition.denied.length) {
      notify(`MCP blocked by a shared capability rule (Desktop/Terminal): ${partition.denied.join(", ")}`);
    }
    if (preApproved.length) {
      notify(`MCP already allowed always (shared capability rule): ${preApproved.join(", ")}`);
    }
    if (partition.fallbackReason) notify(partition.fallbackReason);
  }
  // TTY가 아니면(파이프/자동화) 묻지 않는다 — 조용한 전체 승인 금지.
  // 이미 "항상 허용"된 것만은 사람에게 물을 필요가 없으므로 그대로 통과시킨다.
  if (!input.isTTY || !output.isTTY || !askable.length) return Promise.resolve([...preApproved]);
  const rl = readline.createInterface({ input, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(
      "Attach the available MCP recommendations? [y=once / a=always / n=none / comma-separated ids] ",
      (answer) => {
        rl.close();
        const parsed = parseConsentAnswer(answer, askable);
        if (parsed.always && parsed.ids.length && options.db) {
          for (const id of parsed.ids) {
            const written = rememberMcpCapabilityGrant(options.db, id, "allow");
            if (!written.ok && notify) notify(`"always" was not persisted for ${id}: ${written.reason}`);
          }
        } else if (parsed.always && parsed.ids.length && notify) {
          notify("\"always\" was not persisted: no shared database handle was given to the consent prompt.");
        }
        resolve([...new Set([...preApproved, ...parsed.ids])]);
      },
    );
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

module.exports = {
  MCP_CONSENT_STATE_SCHEMA,
  MCP_CONSENT_RECEIPT_SCHEMA,
  mcpConsentStatePath,
  loadMcpConsentState,
  persistMcpConsentReceipts,
  readConsentedSystemMcpServers,
  normalizeConsentAnswer,
  parseConsentAnswer,
  askMcpConsentOnce,
  resolveApprovedMcpRuntimeAllowlist,
  // 공유 능력 승인(데스크탑 capability_grants) 합류 표면.
  MCP_CAPABILITY_CLASS,
  mcpCapabilityQuery,
  partitionMcpConsentByCapabilityGrants,
  rememberMcpCapabilityGrant,
};
