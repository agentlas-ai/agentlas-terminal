"use strict";
/*
 * Context inspector for the terminal (docs/2026-10-13-native-harness/20 §4-6).
 *
 * The SAME agentlas.context-snapshot.v1 the Desktop builds (electron/harness/context-inspect.ts): what the last
 * model request of a chat carried, item by item, read from the model-call ledger rows (run_events,
 * kind='model_call_ledger') in the shared SQLite. Reading never calls a model, logs in, compacts or ends a session.
 *
 * Rules (identical to the Desktop snapshot):
 *  - one view: last_request. Unknown is `null` / "unavailable" — never 0.
 *  - cached input is its own number; the gap between the provider total and the attributed items is
 *    `unattributedTokens` (the native row), never spread over items.
 *  - capacity comes from the model catalog the product ships (vendored shared/models.js + runtime/model-catalog.js); without it there is no ratio.
 *
 * The terminal's own turns write one ledger row per turn through recordTerminalModelCall (engine/sessions/session.cjs):
 * a native CLI keeps its blocks inside the provider session, so every block is unknown and only the provider-observed
 * usage is recorded (Desktop's resumed-CLI shape).
 * Drift guard: test/context-inspect-contract.cjs runs both builders on shared fixtures when a Desktop dist exists.
 */

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { userDataDir } = require("./core/paths.cjs");
const requestIdOf = p => `${typeof p.callRef === "string" ? p.callRef : "model-call:unknown"}:${count(p.attemptIndex) ?? 1}`;
const snapshotIdOf = (runId, requestId, ts) => `ctxsnap_${crypto.createHash("sha256").update(`${runId}\u0000${requestId}\u0000${ts}`).digest("hex").slice(0, 16)}`;
const retainedFields = new Set(["instructionsTokens", "toolsTokens", "hostContextTokens"]);
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Resolve the owned root once, then reject symlinked store/shard/leaf paths before any content read. */
function openOriginal(digest) {
  let fd;
  try {
    if (!digest || !/^[a-f0-9]{16}$/.test(digest)) return null;
    const root = path.join(fs.realpathSync(userDataDir()), "context-originals");
    const shard = path.join(root, digest.slice(0, 2));
    const parents = [];
    for (const directory of [root, shard]) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) return null;
      parents.push([directory, stat]);
    }
    const file = path.join(shard, `${digest}.txt`);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(2 * 1024 * 1024) || fs.realpathSync(file) !== file) return null;
    // POSIX has O_NOFOLLOW. Other hosts still verify the opened descriptor and every path before reading;
    // those checks are a portable fallback, not a claim of native Windows race acceptance.
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = { fd, file, parents, stat };
    if (!originalStillCurrent(opened)) { fs.closeSync(fd); return null; }
    return opened;
  } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* retain original error semantics */ } return null; }
}

function originalStillCurrent(opened) {
  try {
    for (const [directory, before] of opened.parents) {
      const current = fs.lstatSync(directory, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(before, current)
        || fs.realpathSync(directory) !== directory) return false;
    }
    const leaf = fs.lstatSync(opened.file, { bigint: true });
    const descriptor = fs.fstatSync(opened.fd, { bigint: true });
    return !leaf.isSymbolicLink() && leaf.isFile() && fs.realpathSync(opened.file) === opened.file
      && descriptor.isFile() && sameObject(opened.stat, leaf) && sameObject(opened.stat, descriptor)
      && descriptor.size === opened.stat.size && descriptor.mtimeNs === opened.stat.mtimeNs && descriptor.ctimeNs === opened.stat.ctimeNs;
  } catch { return false; }
}

/** The exact retained original, or null for missing, escaped, replaced or modified bytes. Never throws. */
function readOriginal(digest) {
  const opened = openOriginal(digest);
  if (!opened) return null;
  try {
    const text = fs.readFileSync(opened.fd, "utf8");
    return originalStillCurrent(opened) && BigInt(Buffer.byteLength(text, "utf8")) === opened.stat.size
      && crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) === digest ? text : null;
  } catch { return null; }
  finally { try { fs.closeSync(opened.fd); } catch { /* read remains best effort */ } }
}

/** A regular original exists in the owned store; contents are verified only when requested. */
function hasOriginal(digest) {
  const opened = openOriginal(digest);
  if (!opened) return false;
  try { fs.closeSync(opened.fd); } catch { return false; }
  return true;
}
const SCHEMA = "agentlas.context-snapshot.v1";
const LEDGER_KIND = "model_call_ledger";
/** electron/runtime/session-generation.ts GENERATION_CONTEXT_RATIO. */
const GENERATION_CONTEXT_RATIO = 0.8;
/** electron/runtime/session-generation.ts RUNTIME_PROVIDER. */
const RUNTIME_PROVIDER = Object.freeze({
  "claude-code": "anthropic", codex: "openai", antigravity: "google", grok: "xai", kimi: "kimi", cursor: "cursor",
  // Terminal's own names for the Google runtimes (kinds.cjs: agy = Desktop antigravity; gemini CLI).
  agy: "google", gemini: "google",
});

/** Ledger block field → inspector category, in display order (same order as the Desktop). */
const BLOCKS = Object.freeze([
  ["instructionsTokens", "system_prompt"],
  ["toolsTokens", "tools"],
  ["hostContextTokens", "agentlas_instructions"],
  ["historyTokens", "messages"],
  ["toolExchangeTokens", "tool_exchanges"],
  ["attachmentsTokens", "attachments"],
  ["ownerTextTokens", "current_input"],
  ["framingTokens", "framing"],
]);

const LABELS = Object.freeze({
  system_prompt: { ko: "시스템", en: "System" },
  tools: { ko: "도구", en: "Tools" },
  agentlas_instructions: { ko: "실행 지침", en: "Instructions" },
  messages: { ko: "대화", en: "Messages" },
  tool_exchanges: { ko: "도구 결과", en: "Tool results" },
  attachments: { ko: "첨부", en: "Attachments" },
  current_input: { ko: "이번 입력", en: "Input" },
  framing: { ko: "형식", en: "Framing" },
  unattributed: { ko: "네이티브", en: "Native" },
  overAttributed: { ko: "추정 차이", en: "Estimate gap" },
});

const count = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

let modelsModule;
function models() {
  if (modelsModule !== undefined) return modelsModule;
  try {
    modelsModule = require("./vendor/desktop-core/dist/shared/models.js");
    // The Desktop wires its model catalog (shipped snapshot + cached models.dev) as the window resolver at startup;
    // the same vendored module does it here, so both surfaces read the same window for a model.
    try { require("./vendor/desktop-core/dist/electron/runtime/model-catalog.js").installModelCatalogResolver(); } catch { /* table only */ }
  } catch { modelsModule = null; }
  return modelsModule;
}

/** The model's window as the shipped table knows it; null when unknown (never a guess). */
function runtimeContextWindow(kind, model) {
  const m = models();
  if (!m || typeof m.resolveEffectiveContextWindow !== "function") return null;
  for (const backend of [kind, RUNTIME_PROVIDER[kind]].filter(Boolean)) {
    try {
      const window = m.resolveEffectiveContextWindow(backend, model, false).contextWindow;
      if (window) return window;
    } catch { /* next candidate */ }
  }
  return null;
}

function emptySnapshot() {
  return {
    schemaVersion: SCHEMA, view: "last_request", status: "no_request",
    capacity: { tokens: null, source: "unavailable" }, input: { tokens: null, measurement: "unavailable" },
    rotationAtTokens: null, usedRatio: null, items: [], unattributedTokens: null,
  };
}

/** Build the snapshot from one ledger payload. */
function snapshotFromLedger(row, options = {}) {
  const p = row.payload || {};
  const items = BLOCKS.map(([field, category]) => {
    const tokens = count(p[field]);
    return { category, tokens, measurement: tokens === null ? "unavailable" : "host_estimated" };
  });
  const attributed = items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const observed = p.usageStatus === "observed" ? count(p.observedInput) : null;
  const estimated = count(p.sentTokensEst) ?? count(p.wholeRequestEstimate);
  const input = observed !== null
    ? { tokens: observed, measurement: "provider_reported", ...(count(p.observedCachedInput) !== null ? { cachedTokens: count(p.observedCachedInput) } : {}) }
    : estimated !== null && estimated > 0
      ? { tokens: estimated, measurement: "host_estimated" }
      : { tokens: null, measurement: "unavailable" };
  const runtimeKind = typeof p.runtimeKind === "string" ? p.runtimeKind : "unknown";
  const model = typeof p.model === "string" ? p.model : null;
  // The window the runtime reported for that request (a local server's loaded window, the ACP size) wins over the catalog.
  const reported = count(p.contextWindowObserved);
  const window = reported ?? (options.windowFor || runtimeContextWindow)(runtimeKind, model);
  // Both directions (Desktop context-inspect.ts, notyet NH18): provider above the attributed items, or below them.
  const difference = observed !== null ? observed - attributed : null;
  const requestId = requestIdOf(p), snapshotId = snapshotIdOf(row.runId, requestId, row.ts);
  const occurrences = BLOCKS.map(([field, category], index) => {
    const base = field.replace(/Tokens$/, ""), digest = typeof p[`${base}Digest`] === "string" ? p[`${base}Digest`] : undefined;
    const bytes = count(p[`${base}Bytes`]) ?? undefined, tokens = items[index].tokens;
    const original = tokens === null ? "provider_held" : field === "framingTokens" ? "derived"
      : !retainedFields.has(field) ? "elsewhere" : digest && (options.retained || hasOriginal)(digest) ? "retained" : "not_retained";
    return { occurrenceId: `${snapshotId}:${base}`, category, tokens, measurement: items[index].measurement,
      ...(digest ? { digest } : {}), ...(bytes !== undefined ? { bytes } : {}), original };
  });
  return {
    schemaVersion: SCHEMA,
    view: "last_request",
    status: "observed",
    requestId, snapshotId,
    request: {
      runId: row.runId, callRef: typeof p.callRef === "string" ? p.callRef : "", ts: row.ts, runtimeKind, model,
      role: typeof p.role === "string" ? p.role : "unscoped", mode: typeof p.mode === "string" ? p.mode : "unknown",
      attempt: count(p.attemptIndex) ?? 1,
    },
    capacity: reported ? { tokens: reported, source: "runtime-reported" } : window ? { tokens: window, source: "model-catalog" } : { tokens: null, source: "unavailable" },
    input,
    ...(count(p.observedOutput) !== null ? { outputTokens: count(p.observedOutput) } : {}),
    rotationAtTokens: window ? Math.floor(window * GENERATION_CONTEXT_RATIO) : null,
    usedRatio: window && input.tokens !== null ? Math.min(1, input.tokens / window) : null,
    items, occurrences,
    measuredBy: { estimate: "host-block-estimate", tokenizerRevision: typeof p.tokenizerRevision === "string" ? p.tokenizerRevision : null, observedAt: row.ts },
    unattributedTokens: difference !== null && difference > 0 ? difference : null,
    overAttributedTokens: difference !== null && difference < 0 ? -difference : null,
    aggregate: { providerTokens: observed, attributedTokens: attributed, differenceTokens: difference,
      direction: difference === null ? "unknown" : difference > 0 ? "provider_higher" : difference < 0 ? "attributed_higher" : "equal" },
    ...(count(p.toolsCount) !== null ? { toolsCount: count(p.toolsCount) } : {}),
  };
}

/**
 * The chat's last main-role request; falls back to the newest request of any role (same pick as the Desktop).
 * Reads the indexed (chat_id, kind, ts) rows only.
 */
const validJson = "CASE WHEN json_valid(payload_json) THEN payload_json END";
const sqlCount = (field, json = "p") => {
  const value = `json_extract(${json}, '$.${field}')`;
  return `CASE WHEN json_type(${json}, '$.${field}') IN ('integer', 'real') AND ${value} BETWEEN 0 AND 9007199254740991 AND ${value} = CAST(${value} AS INTEGER) THEN ${value} END`;
};
function parseLedgerRow(row) {
  try { const payload = JSON.parse(row.payloadJson);
    return payload !== null && typeof payload === "object" ? { runId: row.runId, ts: row.ts, payload } : null;
  } catch { return null; }
}
function inspectChat(db, chatId, options = {}) {
  const query = "SELECT run_id AS runId, ts, payload_json AS payloadJson FROM run_events WHERE chat_id = ? AND kind = ?";
  const parsed = db.prepare(query + " ORDER BY ts DESC, seq DESC, id DESC LIMIT 200").all(chatId, LEDGER_KIND).map(parseLedgerRow).filter(Boolean);
  let pick;
  if (options.requestId !== undefined) {
    const requestId = String(options.requestId), at = requestId.lastIndexOf(":"), attempt = Number(requestId.slice(at + 1));
    if (at < 1 || !Number.isSafeInteger(attempt) || attempt < 0 || String(attempt) !== requestId.slice(at + 1)) return emptySnapshot();
    const row = db.prepare(query + ` AND json_extract(${validJson}, '$.callRef') = ? AND COALESCE(${sqlCount("attemptIndex", validJson)}, 1) = ? ORDER BY ts DESC, seq DESC, id DESC LIMIT 1`)
      .get(chatId, LEDGER_KIND, requestId.slice(0, at), attempt);
    pick = row && parseLedgerRow(row);
  } else {
    const row = db.prepare(query + ` AND json_extract(${validJson}, '$.role') = 'main' ORDER BY ts DESC, seq DESC, id DESC LIMIT 1`).get(chatId, LEDGER_KIND);
    pick = (row && parseLedgerRow(row)) || parsed[0];
  }
  if (!pick) return emptySnapshot();
  const sessionCumulative = db.prepare(`WITH data AS (
    SELECT ${validJson} AS p FROM run_events WHERE chat_id = ? AND kind = ?
  ), meters AS (
    SELECT CASE WHEN json_extract(p, '$.usageStatus') = 'observed' THEN ${sqlCount("observedInput")} END AS input,
      ${sqlCount("observedOutput")} AS output, ${sqlCount("observedCachedInput")} AS cached
      FROM data WHERE p IS NOT NULL AND json_type(p) IN ('object', 'array')
  ) SELECT COUNT(*) AS requests, COALESCE(SUM(input), 0) AS inputTokens,
    COALESCE(SUM(CASE WHEN input IS NOT NULL THEN output END), 0) AS outputTokens,
    COALESCE(SUM(CASE WHEN input IS NOT NULL THEN cached END), 0) AS cachedTokens,
    COALESCE(SUM(CASE WHEN input IS NULL THEN 1 ELSE 0 END), 0) AS unmeasuredRequests FROM meters`).get(chatId, LEDGER_KIND);
  return { ...snapshotFromLedger(pick, options), views: { sessionCumulative }, requests: parsed.slice(0, 20).map(row => {
    const requestId = requestIdOf(row.payload), observed = row.payload.usageStatus === "observed" ? count(row.payload.observedInput) : null;
    const estimated = count(row.payload.sentTokensEst);
    return { requestId, snapshotId: snapshotIdOf(row.runId, requestId, row.ts), ts: row.ts,
      role: typeof row.payload.role === "string" ? row.payload.role : "unscoped", model: typeof row.payload.model === "string" ? row.payload.model : null,
      inputTokens: observed ?? estimated, measurement: observed !== null ? "provider_reported" : estimated !== null ? "host_estimated" : "unavailable" };
  }) };
}

function getContextSource(db, chatId, occurrenceId) {
  if (typeof occurrenceId !== "string") return { status: "unknown" };
  const at = occurrenceId.lastIndexOf(":"), wanted = occurrenceId.slice(0, at);
  if (!/^ctxsnap_[a-f0-9]{16}$/.test(wanted)) return { status: "unknown" };
  const rows = db.prepare("SELECT run_id AS runId, ts, payload_json AS payloadJson FROM run_events WHERE chat_id = ? AND kind = ? ORDER BY ts DESC, seq DESC, id DESC").iterate(chatId, LEDGER_KIND);
  for (const raw of rows) {
    const row = parseLedgerRow(raw); if (!row) continue;
    const requestId = requestIdOf(row.payload);
    if (snapshotIdOf(row.runId, requestId, row.ts) !== wanted) continue;
    const occurrence = snapshotFromLedger(row).occurrences.find(item => item.occurrenceId === occurrenceId);
    if (!occurrence) return { status: "unknown" };
    const { occurrenceId: _id, original, ...rest } = occurrence;
    if (original === "retained") {
      const text = readOriginal(occurrence.digest);
      return text !== null ? { status: "ok", occurrenceId, requestId, ...rest, original, text }
        : { status: "ok", occurrenceId, requestId, ...rest, original: "not_retained" };
    }
    return { status: "ok", occurrenceId, requestId, ...rest, original };
  }
  return { status: "unknown" };
}

/**
 * A chat reference: chat id, a unique id prefix (>= 6 chars) or a runtime session id. No reference → the most
 * recently used top-level chat. Returns { chat } or { error: { code, message, matches? } }.
 */
function resolveChat(db, ref) {
  const cols = "id, title, kind, COALESCE(used_at, updated_at) AS usedAt";
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) {
    const chat = db.prepare(`SELECT ${cols} FROM chats WHERE archived_at IS NULL AND kind = 'user' ORDER BY usedAt DESC LIMIT 1`).get();
    return chat ? { chat } : { error: { code: "no_chat", message: "no chat found in the shared database" } };
  }
  const exact = db.prepare(`SELECT ${cols} FROM chats WHERE id = ?`).get(text);
  if (exact) return { chat: exact };
  const bySession = db.prepare(
    `SELECT c.id AS id, c.title AS title, c.kind AS kind, COALESCE(c.used_at, c.updated_at) AS usedAt
       FROM chat_runtime_sessions s JOIN chats c ON c.id = s.chat_id WHERE s.session_id = ? LIMIT 2`,
  ).all(text);
  if (bySession.length === 1) return { chat: bySession[0] };
  if (text.length >= 6 && !/[%_\\]/.test(text)) {
    const byPrefix = db.prepare(`SELECT ${cols} FROM chats WHERE id LIKE ? ORDER BY usedAt DESC LIMIT 6`).all(`${text}%`);
    if (byPrefix.length === 1) return { chat: byPrefix[0] };
    if (byPrefix.length > 1) return { error: { code: "ambiguous_chat", message: `"${text}" matches several chats`, matches: byPrefix.map((c) => c.id) } };
  }
  return { error: { code: "chat_not_found", message: `chat or session not found: ${text}` } };
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

/** Human table: headline, then one row per category plus the native row; unavailable is "—". */
function renderTable(snapshot, { ko = false, chat } = {}) {
  const lines = [];
  const t = (en, kr) => (ko ? kr : en);
  if (chat) lines.push(`${t("chat", "대화")}  ${chat.id}${chat.title ? `  ${chat.title}` : ""}`);
  if (snapshot.status !== "observed") {
    lines.push(t("No model request recorded for this chat yet (nothing to inspect).", "이 대화에 기록된 모델 요청이 아직 없습니다."));
    return lines.join("\n");
  }
  const input = snapshot.input;
  const approx = input.measurement === "host_estimated" ? "~" : "";
  const cap = snapshot.capacity.tokens;
  const head = input.tokens === null ? "—" : `${approx}${formatTokens(input.tokens)}${cap ? ` / ${formatTokens(cap)}` : ""}`;
  const pct = snapshot.usedRatio === null ? "" : `  ${Math.round(snapshot.usedRatio * 100)}%`;
  lines.push(`${t("context", "컨텍스트")}  ${head}${pct}`);
  const note = input.measurement === "provider_reported" ? t("last request · provider", "최근 요청 · 공급자 집계")
    : input.measurement === "host_estimated" ? t("last request · estimate", "최근 요청 · 추정") : t("unavailable", "확인 불가");
  const req = snapshot.request;
  lines.push(`${note}${input.cachedTokens ? ` · ${t("cached", "캐시")} ${formatTokens(input.cachedTokens)}` : ""}`
    + `${req ? ` · ${req.runtimeKind}${req.model ? `/${req.model}` : ""}` : ""}`);
  if (snapshot.rotationAtTokens) lines.push(`${t("rotates at 80%", "80%에서 새 세대")}  ${formatTokens(snapshot.rotationAtTokens)}`);
  lines.push("");
  const rows = snapshot.items.map((item) => ({ key: item.category, tokens: item.tokens, measurement: item.measurement }));
  if (snapshot.unattributedTokens) rows.push({ key: "unattributed", tokens: snapshot.unattributedTokens, measurement: "provider_reported" });
  if (snapshot.overAttributedTokens) rows.push({ key: "overAttributed", tokens: snapshot.overAttributedTokens, measurement: "host_estimated", sign: "-" });
  const nameWidth = Math.max(...rows.map((row) => (ko ? LABELS[row.key].ko : LABELS[row.key].en).length), 8);
  for (const row of rows) {
    const name = ko ? LABELS[row.key].ko : LABELS[row.key].en;
    const value = row.tokens === null ? "—" : `${row.sign || ""}${row.measurement === "host_estimated" ? "~" : ""}${formatTokens(row.tokens)}`;
    lines.push(`${name.padEnd(nameWidth)}  ${value.padStart(8)}  ${row.measurement}`);
  }
  if (snapshot.toolsCount !== undefined) lines.push("", `${t("tools loaded", "도구")} ${snapshot.toolsCount}`);
  return lines.join("\n");
}

/**
 * One model_call_ledger row for a terminal turn's last request. Native CLIs report usage only: blocks stay unknown.
 * Input is the logical input: Anthropic raw input + cache read + cache creation; OpenAI-style input already includes
 * the cached part (cachedInput is then a subset, never added again). Never throws; returns whether a row was written.
 */
function recordTerminalModelCall(db, input) {
  try {
    if (!db || !input || !input.chatId) return false;
    const u = input.usage || {};
    const raw = count(u.input_tokens), out = count(u.output_tokens);
    const observed = raw !== null && out !== null;
    const window = count(input.contextWindowTokens);
    if (!observed && !window) return false;
    const cacheRead = count(u.cache_read_input_tokens), cacheWrite = count(u.cache_creation_input_tokens);
    const anthropic = input.runtimeKind === "claude-code";
    const observedInput = observed ? (anthropic ? raw + (cacheRead || 0) + (cacheWrite || 0) : raw) : null;
    const cached = anthropic ? cacheRead : count(u.cached_input_tokens);
    const crypto = require("node:crypto");
    const runId = String(input.runId || `terminal-${crypto.randomUUID()}`);
    const callRef = `terminal:${runId}`;
    const payload = {
      schemaVersion: "agentlas.model-call-ledger.v1", callRef, userTurnId: runId, attemptIndex: 1, attemptCount: 1,
      role: "main", roleSource: "scope", scoped: true, runtimeKind: String(input.runtimeKind || "unknown"),
      ...(input.model ? { model: String(input.model) } : {}), status: input.failed ? "failed" : "completed",
      durationMs: count(input.durationMs) ?? 0, payloadSource: "unknown", mode: input.resumed ? "resume" : "fresh",
      unknownBlocks: BLOCKS.map(([, category]) => category).join(","), usageStatus: observed ? "observed" : "unknown",
      ...(observed ? { observedInput, observedOutput: out, ...(cached !== null ? { observedCachedInput: cached } : {}) } : {}),
      ...(observed && anthropic && cacheWrite !== null ? { observedCacheCreationInput: cacheWrite } : {}),
      ...(observed && anthropic ? { observedRawInput: raw } : {}),
      ...(window ? { contextWindowObserved: window } : {}), host: "terminal",
    };
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_events'").get();
    if (!exists) return false;
    const res = db.prepare(`INSERT OR IGNORE INTO run_events (id,run_id,seq,ts,kind,chat_id,automation_id,node_id,agent_id,payload_json)
      SELECT ?,?,COALESCE(MAX(seq) + 1, 0),?,?,?,NULL,NULL,?,? FROM run_events WHERE run_id=?`).run(
      `${LEDGER_KIND}:${callRef}:1`, runId, new Date().toISOString(), LEDGER_KIND, input.chatId, input.agentId || null,
      JSON.stringify(payload), runId);
    return res.changes > 0;
  } catch {
    return false;
  }
}

module.exports = {
  SCHEMA, LEDGER_KIND, GENERATION_CONTEXT_RATIO, BLOCKS, LABELS,
  runtimeContextWindow, emptySnapshot, snapshotFromLedger, inspectChat, getContextSource, resolveChat, renderTable, formatTokens, recordTerminalModelCall,
};
