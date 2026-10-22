"use strict";
/*
 * runtimes/acp-driver — kimi · grok · cursor 를 위한 ACP 드라이버 (PRD 2026-08-15 T-2).
 *
 * 세 번째 손코딩이 아니다. Desktop 이 만든 공용 ACP 러너(electron/runtime/acp.js)를 벤더 코어에서
 * 그대로 로드해 쓴다 — 데스크탑·터미널이 같은 파일 하나로 같은 런타임을 같은 품질로 돈다.
 * (터미널이 손으로 미러링해 온 native-host 4종과 달리 드리프트가 구조적으로 없다.)
 *
 * 벤더 코어에 acp.js 가 없으면(옛 코어) — 종전 그대로 "드라이버 없음"으로 정직하게 거부한다.
 * 조용히 다른 런타임으로 넘어가지 않는다.
 */
const { loadCoreAcpRuntime } = require("../core/desktop-core.cjs");
const permissions = require("../agentlas-permissions.cjs");

// 정본(runtimes/kinds.cjs)의 ACP 3종에서 파생 — resolve.cjs의 ACP_CLI_KINDS와 같은 원소.
const ACP_KINDS = new Set(require("./kinds.cjs").ACP_CLI_KINDS);
const ACP_HISTORY_MAX_ENTRIES = 40;
const ACP_HISTORY_MAX_BYTES = 512 * 1024;
const ACP_HISTORY_MAX_ENTRY_BYTES = 64 * 1024;

function boundedHistoryText(value, maxBytes) {
  const text = String(value || "");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  let bounded = encoded.subarray(0, maxBytes).toString("utf8");
  // A byte cut in the middle of a multibyte code point can decode to U+FFFD,
  // whose three bytes would otherwise make the decoded value exceed maxBytes.
  while (Buffer.byteLength(bounded, "utf8") > maxBytes) bounded = bounded.slice(0, -1);
  return bounded;
}

/*
 * Provider history is supplied by the local chat store, where old rows may be
 * larger than the ACP request budget. Keep the newest messages, retain their
 * original order, and cap both message count and UTF-8 text bytes before the
 * request is serialized by the provider runner.
 */
function boundedAcpHistory(history) {
  if (!Array.isArray(history)) return [];
  const bounded = [];
  let totalBytes = 0;
  for (let index = history.length - 1;
    index >= 0 && bounded.length < ACP_HISTORY_MAX_ENTRIES && totalBytes < ACP_HISTORY_MAX_BYTES;
    index -= 1) {
    const entry = history[index];
    const remainingBytes = ACP_HISTORY_MAX_BYTES - totalBytes;
    const text = boundedHistoryText(
      entry && (entry.text ?? entry.content),
      Math.min(ACP_HISTORY_MAX_ENTRY_BYTES, remainingBytes),
    );
    bounded.unshift({
      role: entry && entry.role === "assistant" ? "assistant" : "user",
      text,
    });
    totalBytes += Buffer.byteLength(text, "utf8");
  }
  return bounded;
}

// Contract tests replace the core loader (a fake runner module); production always loads the vendored core.
let coreLoaderOverride = null;

/** 이 머신에서 ACP 드라이버를 쓸 수 있는가. { ok, reason?, module? } */
function acpDriverAvailability() {
  const loaded = coreLoaderOverride ? coreLoaderOverride() : loadCoreAcpRuntime();
  if (!loaded) return { ok: false, reason: "desktop core not available (run `agentlas doctor`)" };
  if (loaded.error) return { ok: false, reason: loaded.error.message };
  if (!loaded.module || typeof loaded.module.createAcpRunner !== "function") {
    return { ok: false, reason: "desktop core exposes no createAcpRunner" };
  }
  return { ok: true, module: loaded.module };
}

function acpSpecFor(kind, mod) {
  const spec = mod.ACP_AGENTS && mod.ACP_AGENTS[kind];
  return spec || null;
}

/*
 * ── session/request_permission → the shared capability rules ────────────────────────────────────────────────
 * Terminal registered no arbiter, so the core's default answered every ACP permission request and a stored deny rule
 * was ignored on write runs (native-harness audit 31, A3 C4.4). The arbiter now answers from the same table and the
 * same precedence as Terminal's own tool gate (agentlas-permissions.cjs decideCapability):
 *   stored deny → deny · stored allow → allow · full → allow · non-mutating → allow · write → allow ·
 *   read + mutating with no rule → deny (Terminal has no live approval card; Desktop asks or, unattended, denies).
 * Every allow is "allow_once": a session-wide grant lets the agent skip the next request, so a deny rule written
 * later would never be consulted. Plan-mode mutations are already denied by the core wrapper.
 */
const permissionContexts = new Map(); // chatId → { db, ui, refs }
let lastPermissionContext = null;
let installedArbiterModule = null;
let coreRulesDbProvider = null; // the full core's own store handle (loadDesktopCore → getDb)
let readOnlyRulesDb = null;

/** Rule source when no Terminal turn context carries a DB (graph runs, core-driven tool loops). */
function fallbackRulesDb() {
  if (typeof coreRulesDbProvider === "function") {
    try { const db = coreRulesDbProvider(); if (db) return db; } catch { /* fall through to the read-only store */ }
  }
  if (readOnlyRulesDb) return readOnlyRulesDb;
  try {
    const file = process.env.AGENTLAS_STORE_PATH || require("../core/paths.cjs").dbPath();
    if (!require("node:fs").existsSync(file)) return null;
    readOnlyRulesDb = require("../core/db.cjs").openRaw(file, { readOnly: true });
    return readOnlyRulesDb;
  } catch {
    return null;
  }
}

function terminalPermissionDecision(db, ask) {
  const verdict = permissions.decideCapability(db || null, {
    kind: ask && ask.kind,
    tool: ask && ask.tool,
    detail: ask && ask.detail,
    agentId: ask && ask.agentId,
    chatId: ask && ask.chatId,
    mutating: !!(ask && ask.mutating),
    permission: ask && ask.permission,
  });
  return verdict.decision === "allow" ? "allow_once" : "deny";
}

function permissionContextFor(chatId) {
  return (chatId && permissionContexts.get(String(chatId))) || lastPermissionContext;
}

async function terminalPermissionArbiter(ask) {
  const context = permissionContextFor(ask && ask.chatId);
  let decision = "deny";
  try { decision = terminalPermissionDecision((context && context.db) || fallbackRulesDb(), ask); }
  catch { decision = "deny"; } // a rule read that fails never becomes an allow
  if (decision === "deny" && context && context.ui && typeof context.ui.warn === "function") {
    const tool = String((ask && (ask.tool || ask.kind)) || "tool").slice(0, 120);
    const level = permissions.normalize(ask && ask.permission);
    try {
      context.ui.warn(`ACP permission denied: ${tool} (${level} run; a stored capability rule or the read boundary refused it — change it with /permission or the saved rule).`);
    } catch { /* a display failure never changes the decision */ }
  }
  return decision;
}

function installTerminalPermissionArbiter(mod) {
  if (installedArbiterModule === mod) return;
  if (typeof mod.setAcpPermissionArbiter !== "function") return;
  mod.setAcpPermissionArbiter(terminalPermissionArbiter);
  installedArbiterModule = mod;
}

/**
 * A fully loaded core (graph runs) asks the same registry for ACP and host-loop tool permissions; install the
 * Terminal arbiter there too, with the core's own store as the rule source. Without a DB it answers exactly as the
 * core default does (read + mutating → deny, otherwise allow once).
 */
function installTerminalPermissionArbiterInCore(core) {
  try {
    const approval = core && typeof core.require === "function" ? core.require("runtime/tool-approval") : null;
    if (!approval || typeof approval.setRuntimeToolPermissionArbiter !== "function") return false;
    if (typeof core.getDb === "function") coreRulesDbProvider = core.getDb;
    approval.setRuntimeToolPermissionArbiter(terminalPermissionArbiter);
    return true;
  } catch {
    return false;
  }
}

function enterPermissionContext(req) {
  const key = req.approvalChatId || req.chatId ? String(req.approvalChatId || req.chatId) : "";
  const context = { db: req.db || null, ui: req.ui || null, refs: 1 };
  const previous = key ? permissionContexts.get(key) : null;
  if (previous) { previous.refs += 1; previous.db = context.db || previous.db; previous.ui = context.ui || previous.ui; }
  else if (key) permissionContexts.set(key, context);
  const active = previous || context;
  lastPermissionContext = active;
  return () => {
    active.refs -= 1;
    if (key && active.refs <= 0 && permissionContexts.get(key) === active) permissionContexts.delete(key);
    if (lastPermissionContext === active && active.refs <= 0) lastPermissionContext = null;
  };
}

/**
 * native-host 계약으로 ACP 턴을 돈다.
 * req = { kind, bin, prompt, systemPrompt, cwd, permission, ui, env, signal, model, locale }
 * 반환: { text, session, usage, error, errorKind, errorSource }
 */
async function runAcpTurn(req) {
  const { kind, bin, ui } = req;
  const avail = acpDriverAvailability();
  if (!avail.ok) {
    return { text: "", session: req.session || {}, error: `runtime '${kind}' has no ACP driver here: ${avail.reason}`, errorKind: "unsupported", errorSource: "marker" };
  }
  const mod = avail.module;
  const spec = acpSpecFor(kind, mod);
  if (!spec) {
    return { text: "", session: req.session || {}, error: `runtime '${kind}' is not an ACP agent in this core`, errorKind: "unsupported", errorSource: "marker" };
  }
  installTerminalPermissionArbiter(mod);
  const runner = mod.createAcpRunner(spec);
  const permission = permissions.normalize(req.permission);
  let mcpConfigPath;
  try {
    // ACP runner consumes the same Claude-compatible MCP config shape as Desktop.
    // Reuse native-host's content-addressed, credential-isolating materializer so
    // Cursor/Grok/Kimi receive exactly the already-consented Terminal allowlist.
    const nativeHost = require("../agentlas-native-host.cjs");
    const allowedMcpServers = permission === "full"
      ? (req.mcpServers || [])
      : [];
    mcpConfigPath = nativeHost.cliMcpConfigPath(allowedMcpServers, {
      exactAllowlist: req.mcpAllowlistMode === "exact",
      env: req.env || process.env,
    }).file;
  } catch (error) {
    return {
      text: "",
      session: req.session || {},
      error: `ACP MCP configuration failed: ${error && error.message ? error.message : error}`,
      errorKind: "configuration",
      errorSource: "marker",
    };
  }
  const locale = req.locale === "ko" ? "ko" : "en";
  const leavePermissionContext = enterPermissionContext(req);
  let streaming = false;
  let lastText = "";
  const events = {
    onPartial: (full) => {
      const text = String(full || "");
      if (!streaming) { ui.streamStart(); streaming = true; }
      const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (delta) ui.streamDelta(delta);
    },
    onStatus: (status) => ui.status(status),
    onTool: (name, args, result, id, isError) => {
      ui.tool(name, args || "");
      // A failed call is always reported as a failure, even with no output text (the runner reports an empty `result`): the
      // sink counts how every call came back (sessions/turn-outcome.cjs) and a failure is private evidence, never drawn.
      if (result || isError) ui.toolResult(result || "", !isError);
    },
    onThinking: (phase) => { if (phase === "start") ui.status(locale === "ko" ? "생각 중..." : "thinking..."); },
    onNotice: (notice) => { if (notice && notice.message) ui.status(notice.message); },
  };
  try {
    const result = await runner({
      // Session-split prompt: the stable part is the session's system text, this turn's part (turn_id, recall) rides the
      // runner's turn context, so a loaded ACP session still gets each turn's binding.
      systemPrompt: req.systemPromptStable || req.systemPrompt || "",
      ...(req.systemPromptStable && req.turnContext ? { turnContext: req.turnContext } : {}),
      history: boundedAcpHistory(req.history),
      userPrompt: req.prompt || "",
      backendLabel: spec.label,
      locale,
      permission,
      runtimeSource: bin,
      cwd: req.cwd,
      env: req.env || process.env,
      signal: req.signal,
      mcpConfigPath,
      runtimeSessionId: (req.session && (req.session.id || req.session.acpSessionId)) || undefined,
      chatId: req.chatId,
      approvalChatId: req.chatId,
      agentId: req.agentId,
      sessionFingerprintSeed: req.sessionFingerprintSeed,
      unattended: req.unattended === true,
      ...(req.model ? { model: req.model } : {}),
      // Desktop RunnerRequest.effort: the shared runner owns the ACP effort channel (spawn flag / thought_level).
      ...(req.effort ? { effort: req.effort } : {}),
    }, events);
    if (streaming) ui.streamEnd();
    const session = {
      ...(req.session || {}),
      ...(result.sessionId ? { id: result.sessionId, acpSessionId: result.sessionId } : {}),
    };
    const delivery = result.turnDelivery === "not-dispatched" || result.turnDelivery === "not-accepted" || result.turnDelivery === "accepted"
      ? { turnDelivery: result.turnDelivery } : {};
    const appliedEffort = typeof result.appliedEffort === "string" ? result.appliedEffort : null;
    if (result.failure) {
      // The core's typed code and retry hint are the cause the owner and the recovery logic act on; keep them.
      return { text: result.text || "", session, usage: null, error: result.failure.message, errorKind: result.failure.kind,
        errorSource: result.failure.source,
        ...(typeof result.failure.providerCode === "string" ? { errorCode: result.failure.providerCode } : {}),
        ...(typeof result.failure.retryAfterHint === "string" ? { retryAfterHint: result.failure.retryAfterHint } : {}),
        ...delivery, appliedEffort };
    }
    // The runner's context meter (ACP usage_update used/size) feeds the common 80% generation rule (generation.cjs).
    const meter = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined);
    const contextInputTokens = meter(result.contextInputTokens), contextWindowTokens = meter(result.contextWindowTokens);
    // The runner's own count of this turn's tool calls (started or finished) when it ended with no text: a session that finds
    // fewer outcomes than calls never judges the turn (sessions/turn-outcome.cjs endedWithoutAnswerAfterUnusableTools).
    const toolCalls = Number.isSafeInteger(result.toolCalls) && result.toolCalls > 0 ? result.toolCalls : undefined;
    return { text: result.text || "", session, usage: null, error: null,
      ...(contextInputTokens ? { contextInputTokens } : {}), ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ownerControlTerminal: result.ownerControlTerminal === "completed" ? "completed" : "uncertain", ...delivery, appliedEffort };
  } catch (e) {
    if (streaming) ui.streamEnd();
    const message = e && e.message ? e.message : String(e);
    const detail = process.env.AGENTLAS_DEBUG && e && e.stack ? e.stack : message;
    // A typed pre-dispatch refusal thrown by the core (Desktop markRefusedBeforeDispatch) keeps its code and delivery.
    const code = e && typeof e.code === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(e.code) ? e.code : undefined;
    return { text: "", session: req.session || {}, usage: null, error: detail, errorKind: /abort/i.test(message) ? "cancelled" : "exit", errorSource: "marker",
      ...(code ? { errorCode: code } : {}),
      ...(e && e.turnDelivery === "not-dispatched" ? { turnDelivery: "not-dispatched" } : {}), appliedEffort: null };
  } finally {
    leavePermissionContext();
  }
}

module.exports = {
  ACP_KINDS,
  ACP_HISTORY_MAX_ENTRIES,
  ACP_HISTORY_MAX_BYTES,
  ACP_HISTORY_MAX_ENTRY_BYTES,
  boundedAcpHistory,
  acpDriverAvailability,
  acpSpecFor,
  runAcpTurn,
  terminalPermissionDecision,
  terminalPermissionArbiter,
  installTerminalPermissionArbiterInCore,
  _test: {
    setCoreLoader(loader) { coreLoaderOverride = typeof loader === "function" ? loader : null; installedArbiterModule = null; },
  },
};
