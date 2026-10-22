"use strict";
/*
 * sessions/sink — native-host의 ui 인터페이스를 "이벤트"로 변환하는 싱크.
 *
 * 세션은 터미널에 직접 그리지 않는다. 모든 런타임 출력은 타입드 이벤트로
 * 세션 링버퍼에 쌓이고, 렌더러(REPL)가 "활성 세션"의 이벤트만 실시간으로
 * 그린다 — 이것이 오르카식 멀티세션의 기반이다(백그라운드 세션 전환 시
 * 버퍼 테일 재생 + 라이브 구독).
 *
 * 구현 인터페이스(native-host가 호출): status, warn, error, line, tool,
 * toolResult, streamStart, streamDelta, streamEnd, applyTaskTool,
 * applyTaskResult, c(팔레트 — 렌더러가 색을 정하므로 여기선 무색 passthrough), t(i18n).
 */
const i18n = require("../agentlas-i18n.cjs");
const { redactToolText } = require("../tool-result-redaction.cjs");
const { createToolOutcomeTally } = require("./turn-outcome.cjs");

const NOOP_PALETTE = new Proxy({}, { get: () => (s) => String(s) });
const STATUS_TEXT_MAX = 8 * 1024;
const EVENT_TEXT_MAX = 64 * 1024;
const TOOL_NAME_MAX = 256;
const TOOL_SUMMARY_MAX = 16 * 1024;
const TASK_TOOL_INPUTS = new Set(["todowrite", "write_todos", "taskcreate", "taskupdate"]);
const TASK_TOOL_RESULTS = new Set(["taskcreate", "taskupdate", "tasklist"]);
const TASK_RECORD_KEYS = new Set([
  "id", "taskId", "content", "subject", "description", "text", "title", "activeForm", "status", "completed",
]);

function taskScalar(key, value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const max = key === "id" || key === "taskId" ? 256 : key === "status" ? 64 : 2_000;
  return Array.from(value).slice(0, max).join("");
}

function taskRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (!TASK_RECORD_KEYS.has(key)) continue;
    const safe = taskScalar(key, child);
    if (safe !== undefined) projected[key] = safe;
  }
  return projected;
}

function taskPayload(value) {
  if (Array.isArray(value)) return value.map(taskRecord).filter(Boolean).slice(0, 500);
  const projected = taskRecord(value);
  if (!projected) return null;
  for (const key of ["todos", "items", "tasks"]) {
    if (Array.isArray(value[key])) projected[key] = value[key].map(taskRecord).filter(Boolean).slice(0, 500);
  }
  if (value.task && typeof value.task === "object" && !Array.isArray(value.task)) {
    projected.task = taskRecord(value.task);
  }
  return projected;
}

// A result reaches the sink as text, or as the object a structured executor (codex mcp_tool_call) reports.
function outcomeText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  try { return JSON.stringify(value); } catch { return undefined; }
}

function boundedText(value, max, suffix = "… [truncated]") {
  const text = String(value || "");
  if (text.length <= max) return text;
  const keep = Math.max(0, max - suffix.length);
  return text.slice(0, keep) + suffix;
}

class EventSink {
  constructor({ lang = "en", onEvent, onPrivateEvidence } = {}) {
    this.lang = lang;
    this.t = (key, ...args) => i18n.t(this.lang, key, ...args);
    this.c = NOOP_PALETTE;
    this._onEvent = onEvent || (() => {});
    this._onPrivateEvidence = onPrivateEvidence || (() => {});
    this._streamOpen = false;
    // How this turn's tool calls came back, counted from the same tool()/toolResult() calls every executor already makes
    // (sessions/turn-outcome.cjs); the session reads it once the turn ended and clears it at the next turn's start.
    this._toolOutcomes = createToolOutcomeTally();
  }

  toolOutcomes() { return this._toolOutcomes.summary(); }
  resetToolOutcomes() { this._toolOutcomes.reset(); }
  // A tool-ish event of a kind the executor's driver draws no row for (claude server_tool_use / mcp_tool_use blocks, a codex
  // web_search, a plan update). Nothing is emitted: the person sees no row, but the turn did use a tool, and a blank reply behind
  // one is not "the model produced nothing at all" (sessions/turn-outcome.cjs blankReplyKind).
  noteToolActivity() { this._toolOutcomes.noteUnclassified(); }

  _emit(type, data) {
    this._onEvent({ type, at: Date.now(), ...data });
  }

  status(text) { this._emit("status", { text: boundedText(text, STATUS_TEXT_MAX) }); }
  // `extra.failure` marks the line as the reason the turn failed (the renderer then tells the session it was said).
  warn(text, extra) { this._emit("warn", { text: boundedText(text, STATUS_TEXT_MAX), ...(extra && extra.failure === true ? { failure: true } : {}) }); }
  // Runtime/provider failures are recovery evidence, never presentation copy.
  // Session owns the recovery loop and may give this evidence to the controller;
  // Renderer must never receive it first.
  error(text) { this._onPrivateEvidence(boundedText(redactToolText(text).text, EVENT_TEXT_MAX)); }
  line(text) { this._emit("line", { text: boundedText(text, EVENT_TEXT_MAX) }); }
  tool(name, summary) {
    this._toolOutcomes.start();
    this._emit("tool", {
      name: boundedText(name || "tool", TOOL_NAME_MAX),
      summary: boundedText(summary, TOOL_SUMMARY_MAX),
    });
  }
  // G03: a tool result never enters the retained event ring or private evidence with a credential in it.
  // Redaction runs BEFORE the length bound (a cut could otherwise split a secret into an unmatched fragment).
  // The original is hashed in memory only; callers that already redacted pass options.redaction.
  toolResult(text, ok, options = {}) {
    // The outcome is judged on what the executor reported (its ok flag and the parsed shape of the text), not on the redacted copy.
    this._toolOutcomes.complete({ ok: ok !== false, text: outcomeText(text) });
    const given = options && options.redaction;
    const r = redactToolText(text);
    const redaction = given && given.redacted && !r.redacted
      ? { redacted: true, originalSha256: given.originalSha256, storedSha256: given.storedSha256 }
      : { redacted: r.redacted, originalSha256: r.originalSha256, storedSha256: r.storedSha256 };
    if (ok === false) {
      this._onPrivateEvidence(boundedText(r.text, EVENT_TEXT_MAX), redaction);
      return;
    }
    this._emit("tool-result", { text: boundedText(r.text, EVENT_TEXT_MAX), ok: true, ...redaction });
  }
  streamStart() {
    if (!this._streamOpen) { this._streamOpen = true; this._emit("stream-start", {}); }
  }
  streamDelta(text) {
    if (!this._streamOpen) this.streamStart();
    const value = String(text || "");
    if (!value) { this._emit("stream-delta", { text: "" }); return; }
    // Preserve live output byte-for-byte while ensuring no single retained
    // ring event can own an unbounded provider/MCP payload.
    for (let offset = 0; offset < value.length; offset += EVENT_TEXT_MAX) {
      this._emit("stream-delta", { text: value.slice(offset, offset + EVENT_TEXT_MAX) });
    }
  }
  streamEnd() {
    if (this._streamOpen) { this._streamOpen = false; this._emit("stream-end", {}); }
  }
  applyTaskTool(name, input, id) {
    const tool = String(name || "").toLowerCase();
    if (!TASK_TOOL_INPUTS.has(tool)) return;
    this._emit("task-tool", { name: tool, input: taskPayload(input), id: taskScalar("id", String(id || "")) });
  }
  applyTaskResult(name, result, id) {
    const tool = String(name || "").toLowerCase();
    if (!TASK_TOOL_RESULTS.has(tool)) return;
    this._emit("task-result", { name: tool, result: taskPayload(result), id: taskScalar("id", String(id || "")) });
  }
  info(text) { this._emit("line", { text: boundedText(text, EVENT_TEXT_MAX) }); }
  cost(usage) { this._emit("cost", { usage }); }
  stopSpinner() { /* 스피너는 렌더러 소관 — 이벤트 불필요 */ }
}

module.exports = { EventSink, taskPayload, boundedText, EVENT_TEXT_MAX };
