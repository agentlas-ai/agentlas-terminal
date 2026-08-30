"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GOVERNANCE_SCHEMA_VERSION = "agentlas.memory-governance.v1";
const RECEIPT_SCHEMA_VERSION = "agentlas.memory-episode-receipt.v1";
const DECISION_SCHEMA_VERSION = "agentlas.memory-curator-decision.v1";
const DEFAULT_EVENTS_HEADING = "## Memory Events";
const MAX_CANDIDATES = 32;
const MAX_CANDIDATE_CHARS = 900;
const MAX_OBSERVATION_CHARS = 320;
const PENDING_REUSE_MS = 24 * 60 * 60 * 1000;
const MAX_MIRROR_BYTES = 16 * 1024 * 1024;
const LOG_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

const MEMORY_KINDS = new Set([
  "fact",
  "decision",
  "preference",
  "risk",
  "procedure",
  "hypothesis",
  "evidence",
  "deprecation",
  "conflict",
]);
const FINAL_SCOPES = new Set(["user_global", "team", "agent", "project", "session", "discard"]);
const SEMANTIC_DISPOSITIONS = new Set(["retain", "session", "discard", "review"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

const { SECRET_PATTERNS } = require("./agentlas-secret-patterns.cjs");
const { runWriteTransaction } = require("./agentlas-sqlite-policy.cjs");
const permissions = require("./agentlas-permissions.cjs");
const ABSOLUTE_PATH_PATTERNS = [
  /(?:^|[\s("'`])~\/[A-Za-z0-9._-]/,
  /(?:^|[\s("'`])\/(?:Users|home|private|var|tmp|opt|etc|Volumes|Applications|System|Library)\//,
  /(?:^|[\s("'`])[A-Za-z]:[\\/][^\s]/,
  /(?:^|[\s("'`])\\\\[^\\\s]+\\[^\s]/,
];
const TRANSCRIPT_BODY_PATTERNS = [
  /(?:^|\n)\s*(?:system|user|assistant|developer)\s*:\s*\S/i,
  /<\/?(?:system|user|assistant|developer)(?:>|\s)/i,
  /\b(?:raw prompt|full prompt|transcript body|verbatim transcript)\b/i,
];

const CURATOR_SYSTEM_PROMPT = [
  "You are the Agentlas Memory Curator for one completed turn.",
  "You have no tools and must return one JSON object only.",
  "For every eligible candidate, choose disposition retain|session|discard|review and scope user_global|team|agent|project|session|discard.",
  "Be conservative: retain only durable facts, decisions, preferences, risks, or reusable procedures; never retain transient narration or unsupported claims.",
  "Candidates marked eligible=false must be discarded. Do not quote or rewrite candidate content in the response.",
  "Return: {\"schema_version\":\"agentlas.memory-curator.v1\",\"decisions\":[{\"candidate_id\":\"...\",\"disposition\":\"...\",\"scope\":\"...\",\"reason_code\":\"short_machine_code\"}]}",
  "Your decision is advisory; deterministic privacy, secret, permission, and owner gates have final authority.",
].join("\n");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value == null ? "" : value), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePermission(value) {
  return permissions.normalize(value, "read");
}

function projectKey(projectPath) {
  if (!projectPath) return null;
  try {
    return `project:${sha256(path.resolve(String(projectPath))).slice(0, 24)}`;
  } catch {
    return null;
  }
}

function ownerKey(agentId) {
  const value = String(agentId || "").trim();
  return value ? `owner:${sha256(value).slice(0, 24)}` : null;
}

function hasSecret(value) {
  const text = String(value || "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function hasAbsolutePath(value) {
  const text = String(value || "");
  return ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

function hasTranscriptBody(value) {
  const text = String(value || "");
  return TRANSCRIPT_BODY_PATTERNS.some((pattern) => pattern.test(text));
}

function contentGateReasons(value, options = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  const reasons = [];
  if (!text && !options.allowEmpty) reasons.push("empty_content");
  if (text.length > (options.maxChars || MAX_CANDIDATE_CHARS)) reasons.push("content_too_long");
  if (text.split(/\r?\n/).length > 8) reasons.push("too_many_lines");
  if (hasSecret(text)) reasons.push("secret_detected");
  if (hasAbsolutePath(text)) reasons.push("absolute_path_detected");
  if (hasTranscriptBody(text)) reasons.push("transcript_body_detected");
  return [...new Set(reasons)];
}

function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  const aliases = {
    user: "user_global",
    global: "user_global",
    user_identity: "user_global",
    user_global: "user_global",
    team_memory: "team",
    agent_team: "team",
    team: "team",
    agent_repo: "agent",
    agent: "agent",
    project: "project",
    session: "session",
    discard: "discard",
  };
  return aliases[scope] || "session";
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return MEMORY_KINDS.has(kind) ? kind : "fact";
}

function normalizeConfidence(value) {
  const confidence = String(value || "").trim().toLowerCase();
  return CONFIDENCE_LEVELS.has(confidence) ? confidence : "medium";
}

function normalizeOutcome(value) {
  const outcome = String(value || "").trim().toLowerCase();
  if (["completed", "succeeded", "failed", "cancelled"].includes(outcome)) return outcome;
  return "completed";
}

/*
 * 2026-08-20: ownerPolicyFromPrompt(단어장 — remember/전역 등 regex AND) 제거.
 * 전역 메모리 쓰기 권한을 부여하는 길은 둘뿐이다:
 *   1) 호스트가 넘긴 구조화 플래그(beginTurn input.ownerPolicy) — 기계 표식이 우선.
 *   2) 판정기(agentlas-judgment) 경유 — resolveGlobalWriteAuthorization.
 * 판정 불가면 부여하지 않는다(fail-closed). 단어장은 어떤 언어도 다 못 세는 데다,
 * 제3언어의 명시적 요청을 영구히 거부하고 우연한 단어 일치로 권한을 넓혔다.
 */
function normalizeOwnerPolicy(value) {
  return { globalWriteAuthorized: Boolean(value && value.globalWriteAuthorized === true) };
}

async function resolveGlobalWriteAuthorization(prompt, options = {}) {
  const text = String(prompt || "").trim();
  if (!text) return { authorized: false, source: "unavailable" };
  // 호스트가 판정 함수를 주입할 수 있다(세션이 자기 연결 런타임으로 감쌈).
  if (typeof options.judge === "function") {
    try {
      const judged = await options.judge(text);
      return judged && judged.source === "llm"
        ? { authorized: judged.authorized === true, source: "llm" }
        : { authorized: false, source: "unavailable" };
    } catch {
      return { authorized: false, source: "unavailable" };
    }
  }
  let judgment;
  try {
    judgment = options.judgment || require("./agentlas-judgment.cjs");
  } catch {
    return { authorized: false, source: "unavailable" };
  }
  if (!judgment.hasJudgmentRunner()) return { authorized: false, source: "unavailable" };
  const verdict = await judgment.judgeLabels({
    kind: "terminal-memory-global-write",
    question:
      "Does this request EXPLICITLY ask to save or remember something as a GLOBAL memory that applies across all projects (user profile / account-wide), rather than only this project, session, or task?",
    labels: ["authorize_global_memory_write"],
    input: text,
    multi: false,
    guidance:
      "Authorize only an explicit, unambiguous request to persist a memory globally, in any language. Ordinary task prompts, project-scoped notes, or incidental mentions of memory do NOT authorize. When uncertain, select nothing.",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (verdict.source !== "llm") return { authorized: false, source: "unavailable" };
  return { authorized: verdict.labels.includes("authorize_global_memory_write"), source: "llm" };
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

// 커넥션당 1회. 이전에는 `beginTurn`/`listScopedTimeline` 이 부를 때마다, 즉 **매 턴**
// 공유 DB 에 테이블 4개 + 인덱스 5개 DDL 과 `UPDATE … stale` 을 날렸다. 전부
// IF NOT EXISTS 라 결과는 멱등이지만 쓰기 락을 잡는 것은 매번이었고, 데스크탑
// 마이그레이션과 겹치면 15초 busy_timeout 을 소진했다(2026-07-28).
const { ensureOnce } = require("./core/schema-ensure.cjs");

function ensureGovernanceSchema(db) {
  return ensureOnce(db, "terminal_memory.schema", (conn) => ensureGovernanceSchemaOnce(conn));
}

function ensureGovernanceSchemaOnce(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_memory_turn_intents (
      turn_id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      context_key TEXT NOT NULL,
      permission TEXT NOT NULL,
      project_key TEXT,
      owner_key TEXT,
      owner_policy_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_memory_intent_pending
      ON terminal_memory_turn_intents(request_fingerprint, status, started_at);
    UPDATE terminal_memory_turn_intents
      SET status='stale'
      WHERE status IN ('pending','curating') AND rowid NOT IN (
        SELECT MAX(rowid) FROM terminal_memory_turn_intents
        WHERE status IN ('pending','curating') GROUP BY request_fingerprint
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_memory_one_pending_request
      ON terminal_memory_turn_intents(request_fingerprint)
      WHERE status IN ('pending','curating');
    CREATE TABLE IF NOT EXISTS terminal_memory_episode_receipts (
      turn_id TEXT PRIMARY KEY,
      ticket_json TEXT NOT NULL,
      project_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminal_memory_curator_decisions (
      decision_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      semantic_disposition TEXT NOT NULL,
      semantic_scope TEXT NOT NULL,
      final_disposition TEXT NOT NULL,
      final_scope TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_memory_decisions_turn
      ON terminal_memory_curator_decisions(turn_id);
    CREATE TABLE IF NOT EXISTS terminal_memory_scope_timeline (
      event_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      project_key TEXT,
      owner_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_memory_timeline_project
      ON terminal_memory_scope_timeline(project_key, lane, created_at);
    CREATE INDEX IF NOT EXISTS idx_terminal_memory_timeline_owner
      ON terminal_memory_scope_timeline(owner_key, lane, created_at);
  `);
}

function validTurnId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(id) ? id : null;
}

function beginTurn(db, input = {}) {
  ensureGovernanceSchema(db);
  const permission = normalizePermission(input.permission);
  const pKey = projectKey(input.projectPath);
  const oKey = ownerKey(input.agentId);
  const explicitTurnId = validTurnId(input.stableTurnId);
  // 시작 시점 정책은 호스트 구조화 플래그만 반영한다(없으면 fail-closed false).
  // 판정 경유 승격은 completeTurn에서, 실제로 user_global 후보가 나왔을 때만 1회 수행된다.
  const policy = normalizeOwnerPolicy(input.ownerPolicy);
  const conversationDigest = sha256(input.conversationRef || "none");
  const priorDigest = sha256(input.priorContextDigest || input.priorContext || "none");
  const contextKey = sha256(stableJson({
    project_key: pKey,
    owner_key: oKey,
    conversation_digest: conversationDigest,
    prior_digest: priorDigest,
    surface: String(input.surface || "terminal-turn").slice(0, 64),
  }));
  const baseRequestFingerprintPayload = {
    schema: GOVERNANCE_SCHEMA_VERSION,
    context_key: contextKey,
    prompt_digest: sha256(input.prompt || ""),
    permission,
  };
  const legacyRequestFingerprint = sha256(stableJson(baseRequestFingerprintPayload));
  // A host-authored id distinguishes two intentional user turns that happen
  // to have identical text/context. Reusing that same id still converges.
  const requestFingerprint = explicitTurnId
    ? sha256(stableJson({ ...baseRequestFingerprintPayload, stable_turn_id: explicitTurnId }))
    : legacyRequestFingerprint;
  const now = new Date().toISOString();

  const result = runWriteTransaction(db, () => {
    if (explicitTurnId) {
      const existing = db.prepare("SELECT * FROM terminal_memory_turn_intents WHERE turn_id=?").get(explicitTurnId);
      // Accept the pre-v1 host fingerprint for an in-flight turn created
      // before this distinction was introduced; all new rows use the bound id.
      if (existing && ![requestFingerprint, legacyRequestFingerprint].includes(existing.request_fingerprint)) {
        throw new Error("stable memory turn id is already bound to a different request fingerprint");
      }
      if (existing) return { row: existing, reused: true };
    } else {
      const candidates = db.prepare(
        "SELECT * FROM terminal_memory_turn_intents WHERE request_fingerprint=? AND status IN ('pending','curating') ORDER BY started_at DESC LIMIT 8",
      ).all(requestFingerprint);
      const reusable = candidates.find((row) => {
        const started = Date.parse(row.started_at || "");
        return Number.isFinite(started) && Date.now() - started <= PENDING_REUSE_MS;
      });
      if (reusable) return { row: reusable, reused: true };
      for (const stale of candidates) {
        db.prepare("UPDATE terminal_memory_turn_intents SET status='stale' WHERE turn_id=? AND status IN ('pending','curating')")
          .run(stale.turn_id);
      }
    }

    const turnId = explicitTurnId || `terminal-turn:${crypto.randomUUID()}`;
    db.prepare(
      "INSERT OR IGNORE INTO terminal_memory_turn_intents (turn_id,request_fingerprint,context_key,permission,project_key,owner_key,owner_policy_json,status,started_at) VALUES (?,?,?,?,?,?,?,'pending',?)",
    ).run(turnId, requestFingerprint, contextKey, permission, pKey, oKey, JSON.stringify(policy), now);
    const inserted = db.prepare("SELECT * FROM terminal_memory_turn_intents WHERE turn_id=?").get(turnId);
    if (!inserted) {
      const concurrent = db.prepare(
        "SELECT * FROM terminal_memory_turn_intents WHERE request_fingerprint=? AND status IN ('pending','curating') ORDER BY started_at DESC LIMIT 1",
      ).get(requestFingerprint);
      if (concurrent) return { row: concurrent, reused: true };
      throw new Error("memory turn intent could not be persisted");
    }
    return {
      row: inserted,
      reused: false,
    };
  });
  let storedPolicy = policy;
  try { storedPolicy = JSON.parse(result.row.owner_policy_json || "{}"); } catch { /* use current safe policy */ }
  return {
    turnId: result.row.turn_id,
    requestFingerprint: result.row.request_fingerprint,
    contextKey: result.row.context_key,
    permission: result.row.permission,
    projectKey: result.row.project_key || null,
    ownerKey: result.row.owner_key || null,
    ownerPolicy: storedPolicy,
    reused: result.reused,
  };
}

function extractJson(text) {
  const value = String(text || "").trim();
  const candidates = [];
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  if (value) candidates.push(value);
  const firstObject = value.indexOf("{");
  const lastObject = value.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(value.slice(firstObject, lastObject + 1));
  const firstArray = value.indexOf("[");
  const lastArray = value.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(value.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  return null;
}

function normalizeObservation(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, MAX_OBSERVATION_CHARS) : "";
  const reasons = contentGateReasons(summary, { allowEmpty: true, maxChars: MAX_OBSERVATION_CHARS });
  return {
    outcome: normalizeOutcome(value.outcome),
    summary: reasons.length ? "" : summary,
    safe: reasons.length === 0,
    reasonCodes: reasons,
  };
}

function normalizeCandidates(rawCandidates, turnId) {
  if (!Array.isArray(rawCandidates)) return [];
  return rawCandidates.slice(0, MAX_CANDIDATES).map((raw, index) => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const content = typeof value.content === "string" ? value.content.trim().slice(0, MAX_CANDIDATE_CHARS + 1) : "";
    const preGateReasons = contentGateReasons(content);
    if (String(value.sensitivity || "").toLowerCase() === "secret") preGateReasons.push("declared_secret");
    const contentDigest = `sha256:${sha256(content)}`;
    return {
      id: `candidate:${sha256(`${turnId}:${index}:${contentDigest}`).slice(0, 24)}`,
      index,
      kind: normalizeKind(value.memory_kind || value.kind),
      content,
      contentDigest,
      suggestedScope: normalizeScope(value.suggested_scope || value.scope),
      confidence: normalizeConfidence(value.confidence),
      preGateReasons: [...new Set(preGateReasons)],
    };
  });
}

function requestCopyDetected(value, normalizedRequest) {
  const content = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!content || !normalizedRequest) return false;
  return content === normalizedRequest || (
    content.length >= 40 && normalizedRequest.length >= 40 &&
    (normalizedRequest.includes(content) || content.includes(normalizedRequest))
  );
}

function applyRequestPrivacyGate(parsed, requestText) {
  const request = String(requestText || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!request) return parsed;
  if (requestCopyDetected(parsed.observation?.summary, request)) {
    parsed.observation.summary = "";
    parsed.observation.safe = false;
    parsed.observation.reasonCodes = [...new Set([
      ...(parsed.observation.reasonCodes || []),
      "raw_prompt_copy_detected",
    ])];
  }
  for (const candidate of parsed.candidates) {
    if (requestCopyDetected(candidate.content, request)) {
      candidate.preGateReasons = [...new Set([...candidate.preGateReasons, "raw_prompt_copy_detected"])];
    }
  }
  return parsed;
}

function blockUnboundCandidates(candidates, reason) {
  for (const candidate of candidates) {
    candidate.preGateReasons = [...new Set([...candidate.preGateReasons, reason])];
  }
  return candidates;
}

function parseMainOutput(text, turnId, heading = DEFAULT_EVENTS_HEADING) {
  const source = String(text || "");
  const index = source.lastIndexOf(heading);
  if (index < 0) {
    return {
      cleaned: source.trim(),
      parseStatus: "missing",
      observation: normalizeObservation(null),
      candidates: [],
      declaredTurnId: null,
    };
  }
  const cleaned = source.slice(0, index).trim();
  const tail = source.slice(index + heading.length);
  const parsed = extractJson(tail);
  if (!parsed) {
    return {
      cleaned,
      parseStatus: "malformed",
      observation: normalizeObservation(null),
      candidates: [],
      declaredTurnId: null,
    };
  }

  if (Array.isArray(parsed)) {
    const candidates = normalizeCandidates(parsed, turnId);
    return {
      cleaned,
      parseStatus: "legacy_array",
      observation: normalizeObservation(null),
      candidates: blockUnboundCandidates(candidates, "legacy_envelope_unbound"),
      declaredTurnId: null,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      cleaned,
      parseStatus: "malformed",
      observation: normalizeObservation(null),
      candidates: [],
      declaredTurnId: null,
    };
  }
  const declaredTurnId = validTurnId(parsed.turn_id || parsed.turnId);
  const hasObservation = parsed.observation && typeof parsed.observation === "object";
  const hasCandidates = Array.isArray(parsed.candidates);
  let parseStatus = hasObservation && hasCandidates ? "ok" : "partial";
  if (!declaredTurnId) parseStatus = "turn_id_missing";
  else if (declaredTurnId !== turnId) parseStatus = "turn_id_mismatch";
  const candidates = normalizeCandidates(hasCandidates ? parsed.candidates : [], turnId);
  if (parseStatus !== "ok") blockUnboundCandidates(candidates, `main_envelope_${parseStatus}`);
  return {
    cleaned,
    parseStatus,
    observation: normalizeObservation(parsed.observation),
    candidates,
    declaredTurnId,
  };
}

function buildCuratorPayload(turn, parsed, input = {}) {
  return {
    schema_version: "agentlas.memory-curator-input.v1",
    turn_id: turn.turnId,
    parse_status: parsed.parseStatus,
    // The permission frozen at beginTurn is authoritative. Completion input
    // can never upgrade a read-only turn into a durable write.
    permission: normalizePermission(turn.permission),
    context: {
      project_available: Boolean(turn.projectKey),
      agent_or_team_available: Boolean(turn.ownerKey),
      global_write_authorized: turn.ownerPolicy?.globalWriteAuthorized === true,
    },
    observation: {
      outcome: parsed.observation.outcome,
      summary: parsed.observation.safe ? parsed.observation.summary : "",
      safe: parsed.observation.safe,
    },
    candidates: parsed.candidates.map((candidate) => ({
      candidate_id: candidate.id,
      memory_kind: candidate.kind,
      content: candidate.preGateReasons.length ? undefined : candidate.content,
      content_digest: candidate.contentDigest,
      suggested_scope: candidate.suggestedScope,
      confidence: candidate.confidence,
      eligible: candidate.preGateReasons.length === 0,
      blocked_reason_codes: candidate.preGateReasons,
    })),
  };
}

function sanitizeReasonCode(value) {
  const reason = String(value || "semantic_decision").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return reason.slice(0, 64) || "semantic_decision";
}

function parseCuratorOutput(text, candidateIds) {
  const parsed = extractJson(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema_version !== "agentlas.memory-curator.v1" ||
    !Array.isArray(parsed.decisions)
  ) {
    return { status: "malformed", decisions: new Map() };
  }
  const allowedIds = new Set(candidateIds);
  const decisions = new Map();
  for (const raw of parsed.decisions) {
    if (!raw || typeof raw !== "object") continue;
    const candidateId = String(raw.candidate_id || raw.candidateId || "");
    if (!allowedIds.has(candidateId) || decisions.has(candidateId)) continue;
    const disposition = String(raw.disposition || "review").trim().toLowerCase();
    const scope = normalizeScope(raw.scope);
    decisions.set(candidateId, {
      candidateId,
      disposition: SEMANTIC_DISPOSITIONS.has(disposition) ? disposition : "review",
      scope: FINAL_SCOPES.has(scope) ? scope : "session",
      reasonCode: sanitizeReasonCode(raw.reason_code || raw.reasonCode),
    });
  }
  return { status: "ok", decisions };
}

function finalDecision(candidate, semantic, context) {
  const reasons = [...candidate.preGateReasons];
  const permission = normalizePermission(context.permission);
  const semanticDisposition = semantic?.disposition || "review";
  const semanticScope = semantic?.scope || "session";
  if (semantic?.reasonCode) reasons.push(semantic.reasonCode);

  if (permission === "read") {
    reasons.push("read_only_receipt");
    return finishDecision("receipt_only", "session", reasons);
  }
  if (context.curatorStatus !== "ok") {
    reasons.push(`curator_${context.curatorStatus}`);
    return finishDecision("review", "session", reasons);
  }
  if (candidate.preGateReasons.length) return finishDecision("discard", "discard", reasons);
  if (semanticDisposition !== "retain") {
    const finalScope = semanticDisposition === "session" ? "session" : semanticDisposition === "discard" ? "discard" : "session";
    return finishDecision(semanticDisposition, finalScope, reasons);
  }
  if (candidate.suggestedScope === "discard") {
    reasons.push("candidate_requested_discard");
    return finishDecision("discard", "discard", reasons);
  }
  if (!FINAL_SCOPES.has(semanticScope) || ["session", "discard"].includes(semanticScope)) {
    reasons.push("semantic_scope_not_durable");
    return finishDecision("session", "session", reasons);
  }
  if (!context.memoryStoreAvailable) {
    reasons.push("memory_store_unavailable");
    return finishDecision("review", "session", reasons);
  }
  if (semanticScope === "user_global") {
    if (context.ownerPolicy?.globalWriteAuthorized !== true) {
      reasons.push("owner_global_consent_required");
      return finishDecision("review", "session", reasons);
    }
    if (candidate.confidence !== "high" || !["fact", "decision", "preference", "procedure"].includes(candidate.kind)) {
      reasons.push("global_quality_gate");
      return finishDecision("review", "session", reasons);
    }
  }
  if (semanticScope === "project" && !context.projectKey) {
    reasons.push("project_scope_unavailable");
    return finishDecision("review", "session", reasons);
  }
  if (["team", "agent"].includes(semanticScope) && !context.ownerKey) {
    reasons.push("owner_scope_unavailable");
    return finishDecision("review", "session", reasons);
  }
  return finishDecision("retain", semanticScope, reasons);
}

function finishDecision(disposition, scope, reasons) {
  return {
    finalDisposition: disposition,
    finalScope: scope,
    reasonCodes: [...new Set(reasons.map(sanitizeReasonCode))],
  };
}

function storageScope(scope) {
  return {
    user_global: "user_identity",
    team: "team_memory",
    agent: "agent_repo",
    project: "project",
  }[scope] || null;
}

function decisionBatchFor(turnId, timestamp, projectKeyValue, parseStatus, curatorStatus, decisions) {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    id: `curator-decision:${turnId}`,
    turnId,
    timestamp,
    projectKey: projectKeyValue || null,
    parseStatus,
    curatorStatus,
    decisions: decisions.map((decision) => ({
      candidateId: decision.candidate.id,
      contentDigest: decision.candidate.contentDigest,
      semanticDisposition: decision.semanticDisposition,
      semanticScope: decision.semanticScope,
      finalDisposition: decision.finalDisposition,
      finalScope: decision.finalScope,
      reasonCodes: decision.reasonCodes,
    })),
  };
}

function ticketFor(turn, parsed, input, timestamp, curatorStatus, decisions, retainedCount) {
  const permission = normalizePermission(turn.permission);
  const outcome = normalizeOutcome(input.outcome || parsed.observation.outcome);
  const action = retainedCount > 0
    ? "promote"
    : ["failed", "cancelled"].includes(outcome) ||
        ["malformed", "missing", "partial", "turn_id_missing", "turn_id_mismatch", "legacy_array"].includes(parsed.parseStatus) ||
        curatorStatus !== "ok"
      ? "needs_review"
      : "discard";
  return {
    id: `memory-ticket:${turn.turnId}`,
    timestamp,
    sourceAgent: `terminal:${turn.ownerKey || "direct"}`,
    scope: turn.projectKey ? "project" : "session",
    trustLabel: "verified",
    summary: `episode receipt; outcome=${outcome}; parse=${parsed.parseStatus}; candidates=${parsed.candidates.length}; retained=${retainedCount}; permission=${permission}`,
    evidence: [
      `schema:${RECEIPT_SCHEMA_VERSION}`,
      `turn:${turn.turnId}`,
      `observation:sha256:${sha256(stableJson(parsed.observation))}`,
      `outcome:${outcome}`,
      `curator:${curatorStatus}`,
      `project:${turn.projectKey || "none"}`,
    ],
    action,
    status: "accepted",
  };
}

function assertSafeLogRecord(record) {
  const encoded = JSON.stringify(record);
  if (hasSecret(encoded) || hasAbsolutePath(encoded) || hasTranscriptBody(encoded)) {
    throw new Error("refusing to write an unsafe memory governance decision log");
  }
}

function appendJsonlOnce(filePath, record) {
  assertSafeLogRecord(record);
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_MIRROR_BYTES) return false;
  const lockPath = `${filePath}.lock`;
  let lockFd = null;
  for (let attempt = 0; attempt < 50 && lockFd == null; attempt += 1) {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") return false;
      try {
        const lockStat = fs.lstatSync(lockPath);
        if (lockStat.isFile() && !lockStat.isSymbolicLink() && Date.now() - lockStat.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* lock disappeared; retry */ }
      Atomics.wait(LOG_LOCK_WAIT, 0, 0, 20);
    }
  }
  if (lockFd == null) return false;
  try {
    stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_MIRROR_BYTES) return false;
    let current = "";
    try { current = fs.readFileSync(filePath, "utf8"); } catch { return false; }
    for (const line of current.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id === record.id) return true;
      } catch { /* preserve unrelated malformed local lines */ }
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows/ACL-only host */ }
    return true;
  } finally {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* a stale lock is recovered on the next turn */ }
  }
}

function mirrorCoreLogs(projectPathValue, ticket, decisionBatch, options = {}) {
  if (!projectPathValue) return { ticket: false, decisions: false };
  let root;
  try { root = fs.realpathSync(path.resolve(String(projectPathValue))); } catch { return { ticket: false, decisions: false }; }
  const memoryDir = options.memoryDir || ".agentlas";
  const stateDir = path.join(root, memoryDir);
  let state;
  try { state = fs.lstatSync(stateDir); } catch { return { ticket: false, decisions: false }; }
  if (!state.isDirectory() || state.isSymbolicLink()) return { ticket: false, decisions: false };
  const ticketPath = path.join(stateDir, options.ticketFile || "memory-tickets.jsonl");
  const decisionPath = path.join(stateDir, options.decisionFile || "curator-decisions.jsonl");
  // Core JSONL files are a best-effort projection of the authoritative DB
  // receipt. Filesystem trouble must not undo or crash a completed host turn.
  let ticketWritten = false;
  let decisionsWritten = false;
  try { ticketWritten = appendJsonlOnce(ticketPath, ticket); } catch { /* DB receipt remains authoritative */ }
  try { decisionsWritten = appendJsonlOnce(decisionPath, decisionBatch); } catch { /* DB receipt remains authoritative */ }
  return { ticket: ticketWritten, decisions: decisionsWritten };
}

function readExistingReceipt(db, turnId) {
  const row = db.prepare("SELECT ticket_json FROM terminal_memory_episode_receipts WHERE turn_id=?").get(turnId);
  if (!row) return null;
  try { return JSON.parse(row.ticket_json); } catch { return null; }
}

function readDecisionBatch(db, turnId, ticket, projectKeyValue = null) {
  const rows = db.prepare(
    "SELECT * FROM terminal_memory_curator_decisions WHERE turn_id=? ORDER BY candidate_id",
  ).all(turnId);
  const parseStatus = String(ticket?.summary || "").match(/(?:^|; )parse=([a-z0-9_-]+)/i)?.[1] || "replayed";
  const curatorStatus = (ticket?.evidence || []).map(String).find((value) => value.startsWith("curator:"))?.slice("curator:".length) || "replayed";
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    id: `curator-decision:${turnId}`,
    turnId,
    timestamp: ticket?.timestamp || new Date().toISOString(),
    projectKey: projectKeyValue,
    parseStatus,
    curatorStatus,
    decisions: rows.map((row) => ({
      candidateId: row.candidate_id,
      contentDigest: row.content_digest,
      semanticDisposition: row.semantic_disposition,
      semanticScope: row.semantic_scope,
      finalDisposition: row.final_disposition,
      finalScope: row.final_scope,
      reasonCodes: safeJsonArray(row.reason_codes_json),
    })),
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadTurnMemories(db, turnId) {
  if (!tableExists(db, "memory_entries")) return [];
  try {
    return db.prepare(
      "SELECT m.id,m.scope,m.kind,m.content,m.confidence,m.sensitivity,m.context_json FROM terminal_memory_scope_timeline t JOIN memory_entries m ON m.id=t.memory_id WHERE t.turn_id=? ORDER BY t.created_at,t.event_id",
    ).all(turnId);
  } catch {
    return [];
  }
}

async function completeTurn(db, input = {}) {
  ensureGovernanceSchema(db);
  const turnId = validTurnId(input.turnId);
  if (!turnId) throw new Error("memory governance completion requires an explicit stable turn id");
  const parsed = parseMainOutput(input.mainOutput, turnId, input.eventsHeading || DEFAULT_EVENTS_HEADING);
  // Runtime outcome is host evidence and overrides a model-authored claim.
  parsed.observation.outcome = normalizeOutcome(input.outcome || parsed.observation.outcome);
  applyRequestPrivacyGate(parsed, input.requestText);
  const intent = db.prepare("SELECT * FROM terminal_memory_turn_intents WHERE turn_id=?").get(turnId);
  if (!intent) throw new Error("memory governance completion has no matching turn intent");
  const turn = {
    turnId,
    permission: intent.permission,
    projectKey: intent.project_key || null,
    ownerKey: intent.owner_key || null,
    ownerPolicy: (() => { try { return JSON.parse(intent.owner_policy_json || "{}"); } catch { return {}; } })(),
  };
  const completionProjectKey = projectKey(input.projectPath);
  const completionOwnerKey = ownerKey(input.agentId);
  const projectContextMatches = completionProjectKey === turn.projectKey;
  const ownerContextMatches = completionOwnerKey === turn.ownerKey;
  if (!projectContextMatches) blockUnboundCandidates(parsed.candidates, "completion_project_context_mismatch");
  if (!ownerContextMatches) blockUnboundCandidates(parsed.candidates, "completion_owner_context_mismatch");
  const boundProjectPath = projectContextMatches ? (input.projectPath || null) : null;
  const boundAgentId = ownerContextMatches ? (input.agentId || null) : null;

  const existing = readExistingReceipt(db, turnId);
  if (existing) {
    const decisionBatch = readDecisionBatch(db, turnId, existing, turn.projectKey);
    if (normalizePermission(turn.permission) !== "read" && projectContextMatches && ownerContextMatches) {
      mirrorCoreLogs(boundProjectPath, existing, decisionBatch, input.coreFiles);
    }
    return {
      cleaned: parsed.cleaned,
      parseStatus: parsed.parseStatus,
      receipt: existing,
      decisionBatch,
      curatedMemories: loadTurnMemories(db, turnId),
      idempotentReplay: true,
      curatorInvoked: false,
    };
  }

  // 전역 쓰기 승격은 필요할 때만 1회 — 어떤 후보가 실제로 user_global 스코프를
  // 청했고, 시작 시점 정책(호스트 플래그)이 승인하지 않았을 때. 판정기(또는 호스트가
  // 주입한 judge)가 명시적 요청이라고 판정한 경우에만 켠다. 판정 불가 = 부여 안 함.
  if (
    turn.ownerPolicy?.globalWriteAuthorized !== true
    && normalizePermission(turn.permission) !== "read"
    && parsed.candidates.some(
      (candidate) => candidate.suggestedScope === "user_global" && candidate.preGateReasons.length === 0,
    )
  ) {
    const judged = await resolveGlobalWriteAuthorization(input.requestText, {
      judge: input.judgeGlobalAuthorization,
    });
    if (judged.authorized === true && judged.source === "llm") {
      turn.ownerPolicy = { ...turn.ownerPolicy, globalWriteAuthorized: true };
      try {
        db.prepare("UPDATE terminal_memory_turn_intents SET owner_policy_json=? WHERE turn_id=?")
          .run(JSON.stringify(turn.ownerPolicy), turnId);
      } catch { /* 감사 기록 실패가 이번 완결을 막지는 않는다 */ }
    }
  }

  const payload = buildCuratorPayload(turn, parsed, input);
  let curatorStatus = "unavailable";
  let semantic = { status: "unavailable", decisions: new Map() };
  if (typeof input.invokeCurator === "function") {
    try {
      const output = await input.invokeCurator(payload, CURATOR_SYSTEM_PROMPT);
      semantic = parseCuratorOutput(output, parsed.candidates.map((candidate) => candidate.id));
      curatorStatus = semantic.status;
    } catch {
      curatorStatus = "error";
      semantic = { status: "error", decisions: new Map() };
    }
  }

  const memoryStoreAvailable = tableExists(db, "memory_entries");
  const decisions = parsed.candidates.map((candidate) => {
    const semanticDecision = semantic.decisions.get(candidate.id) || null;
    const final = finalDecision(candidate, semanticDecision, {
      permission: turn.permission,
      curatorStatus,
      memoryStoreAvailable,
      projectKey: turn.projectKey,
      ownerKey: turn.ownerKey,
      ownerPolicy: turn.ownerPolicy,
    });
    return {
      candidate,
      semanticDisposition: semanticDecision?.disposition || "review",
      semanticScope: semanticDecision?.scope || "session",
      ...final,
    };
  });

  const timestamp = new Date().toISOString();
  let ticket = null;
  let retainedMemories = [];
  let decisionBatch = null;
  let replayedByRace = false;
  runWriteTransaction(db, () => {
    const raced = readExistingReceipt(db, turnId);
    if (raced) {
      ticket = raced;
      replayedByRace = true;
      retainedMemories = loadTurnMemories(db, turnId);
      decisionBatch = readDecisionBatch(db, turnId, raced, turn.projectKey);
      return;
    }

    for (const decision of decisions) {
      if (decision.finalDisposition !== "retain") continue;
      const candidate = decision.candidate;
      const dbScope = storageScope(decision.finalScope);
      if (!dbScope) continue;
      const scopedProjectId = decision.finalScope === "user_global" ? null : turn.projectKey;
      const scopedProjectPath = decision.finalScope === "user_global" ? null : boundProjectPath;
      /*
       * ★팀 공유 기억에는 주인이 없다 (2026-08-26)
       *
       * 이 엔진은 데스크탑과 **같은 SQLite 파일의 같은 `memory_entries` 표**를 쓴다
       * (engine/core/paths.cjs — 같은 userData 공유가 제품 계약이다). 그런데 같은 "팀 공유"
       * 결정을 데스크탑은 `agent_id = NULL` 로, 여기서는 `agent_id = <agentId>` 로 넣고
       * 있었다. 한 표에 두 관례가 섞이면 ① 같은 사실이 주인 다른 두 줄로 남아 중복 제거가
       * 갈리고 ② 정리기가 그 줄을 개인 기억으로 오인한다.
       *
       * 정본은 데스크탑 쪽이다 — 팀 공유는 조직도가 바뀌어도 남아야 하므로 특정 에이전트에
       * 매이지 않는다. 데스크탑의 같은 규칙: shared/memory-ownership.ts `memoryOwnerAgentId`
       * (`agt_team_` 낙인이거나 신원이 없으면 개인 칸이 없다).
       */
      const scopedAgentId = decision.finalScope === "agent" ? boundAgentId : null;
      let memoryId = null;
      try {
        const duplicate = db.prepare(
          "SELECT id FROM memory_entries WHERE scope=? AND kind=? AND lower(trim(content))=? AND superseded_at IS NULL AND (project_path IS ? OR project_path=?) AND (agent_id IS ? OR agent_id=?) LIMIT 1",
        ).get(dbScope, candidate.kind, candidate.content.toLowerCase(), scopedProjectPath, scopedProjectPath, scopedAgentId, scopedAgentId);
        memoryId = duplicate && duplicate.id;
        if (memoryId) decision.reasonCodes = [...new Set([...decision.reasonCodes, "deduplicated"])];
      } catch { /* deterministic id below still prevents replay duplicates */ }
      if (!memoryId) {
        memoryId = `memory:${sha256(`${turnId}:${candidate.id}:${decision.finalScope}`).slice(0, 32)}`;
        const safeContext = {
          governance_schema: GOVERNANCE_SCHEMA_VERSION,
          turn_id: turnId,
          candidate_id: candidate.id,
          project_key: turn.projectKey,
          lane: decision.finalScope,
          observation_digest: `sha256:${sha256(stableJson(parsed.observation))}`,
        };
        db.prepare(
          "INSERT OR IGNORE INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,context_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
        ).run(
          memoryId,
          dbScope,
          candidate.kind,
          candidate.content,
          scopedProjectId,
          scopedProjectPath,
          scopedAgentId,
          null,
          candidate.confidence,
          "internal",
          JSON.stringify([`memory-ticket:${turnId}`, candidate.id]),
          JSON.stringify(safeContext),
          timestamp,
        );
      }
      const lane = decision.finalScope;
      const timelineId = `timeline:${sha256(`${turnId}:${candidate.id}:${memoryId}:${lane}`).slice(0, 32)}`;
      db.prepare(
        "INSERT OR IGNORE INTO terminal_memory_scope_timeline (event_id,turn_id,memory_id,lane,project_key,owner_key,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(
        timelineId,
        turnId,
        memoryId,
        lane,
        lane === "global" || lane === "user_global" ? null : turn.projectKey,
        ["team", "agent"].includes(lane) ? turn.ownerKey : null,
        timestamp,
      );
      const row = db.prepare(
        "SELECT id,scope,kind,content,confidence,sensitivity,context_json FROM memory_entries WHERE id=?",
      ).get(memoryId);
      if (row && !retainedMemories.some((item) => item.id === row.id)) retainedMemories.push(row);
    }

    for (const decision of decisions) {
      db.prepare(
        "INSERT OR IGNORE INTO terminal_memory_curator_decisions (decision_id,turn_id,candidate_id,content_digest,semantic_disposition,semantic_scope,final_disposition,final_scope,reason_codes_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        `decision:${sha256(`${turnId}:${decision.candidate.id}`).slice(0, 32)}`,
        turnId,
        decision.candidate.id,
        decision.candidate.contentDigest,
        decision.semanticDisposition,
        decision.semanticScope,
        decision.finalDisposition,
        decision.finalScope,
        JSON.stringify(decision.reasonCodes),
        timestamp,
      );
    }

    ticket = ticketFor(turn, parsed, input, timestamp, curatorStatus, decisions, retainedMemories.length);
    decisionBatch = decisionBatchFor(turnId, timestamp, turn.projectKey, parsed.parseStatus, curatorStatus, decisions);
    assertSafeLogRecord(ticket);
    assertSafeLogRecord(decisionBatch);
    db.prepare(
      "INSERT INTO terminal_memory_episode_receipts (turn_id,ticket_json,project_key,created_at) VALUES (?,?,?,?)",
    ).run(turnId, JSON.stringify(ticket), turn.projectKey, timestamp);
    db.prepare(
      "UPDATE terminal_memory_turn_intents SET status='completed', completed_at=? WHERE turn_id=?",
    ).run(timestamp, turnId);
  });

  if (normalizePermission(turn.permission) !== "read" && projectContextMatches && ownerContextMatches) {
    mirrorCoreLogs(boundProjectPath, ticket, decisionBatch, input.coreFiles);
  }
  return {
    cleaned: parsed.cleaned,
    parseStatus: parsed.parseStatus,
    receipt: ticket,
    decisionBatch,
    curatedMemories: retainedMemories,
    idempotentReplay: replayedByRace,
    curatorInvoked: typeof input.invokeCurator === "function",
    curatorStatus,
  };
}

function listScopedTimeline(db, input = {}) {
  ensureGovernanceSchema(db);
  if (!tableExists(db, "memory_entries")) return [];
  const pKey = projectKey(input.projectPath);
  const oKey = ownerKey(input.agentId);
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  try {
    return db.prepare(`
      SELECT m.id,m.scope,m.kind,m.content,m.confidence,m.sensitivity,m.context_json,
             t.lane,t.project_key,t.owner_key,t.created_at
      FROM terminal_memory_scope_timeline t
      JOIN memory_entries m ON m.id=t.memory_id
      WHERE m.superseded_at IS NULL AND (
        t.lane='user_global'
        OR (t.lane='project' AND t.project_key=?)
        OR (t.lane IN ('team','agent') AND t.owner_key=? AND (t.project_key IS NULL OR t.project_key=?))
      )
      ORDER BY t.created_at DESC,t.event_id DESC
      LIMIT ?
    `).all(pKey, oKey, pKey, limit);
  } catch {
    return [];
  }
}

module.exports = {
  GOVERNANCE_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  DECISION_SCHEMA_VERSION,
  DEFAULT_EVENTS_HEADING,
  CURATOR_SYSTEM_PROMPT,
  ensureGovernanceSchema,
  normalizeOwnerPolicy,
  resolveGlobalWriteAuthorization,
  projectKey,
  ownerKey,
  contentGateReasons,
  beginTurn,
  parseMainOutput,
  buildCuratorPayload,
  parseCuratorOutput,
  completeTurn,
  listScopedTimeline,
  mirrorCoreLogs,
  hasSecret,
  hasAbsolutePath,
  hasTranscriptBody,
};
