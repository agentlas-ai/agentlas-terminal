"use strict";
/*
 * sessions/turn-outcome — a turn that ended normally with NO reply text is not a finished turn when either (1) every tool call it
 * made failed or came back as an empty collection (Desktop H2, Finance 1008 pilot 2026-10-21; the contract is Desktop
 * shared/turn-settlement.ts toolResultIsEmptyCollection / createToolOutcomeTally / endedWithoutAnswerAfterUnusableTools,
 * agentlas_desktop commit 248ec2093), or (2) it made no tool call at all and showed no sign of tool use: the model's empty answer
 * (Desktop settleNormalEnd outcome `empty`).
 *
 * Before this, such a turn ended `done` with `turn-end ok:true text:""`: a blank screen, exit 0, no reason (the interactive
 * Terminal draws nothing for a returned failure at all, so the person could not even tell it from a slow answer). A tool-only
 * turn whose tools worked still ends done (the work happened through its tools); only "nothing came back from any call"
 * is the model's empty answer behind tools that gave nothing.
 *
 * The facts are the ones the session's event sink already sees from every executor (claude-code, codex, antigravity, gemini,
 * the ACP agents grok / cursor / github-copilot-cli / kimi, and the API loops): `tool()` starts a call, `toolResult(text, ok)`
 * ends one, and `noteToolActivity()` marks a tool-ish event whose kind the driver draws no row for (a codex web_search, a claude
 * server_tool_use): "no tool seen" is not "no tool ran", so rule (2) needs every one of those to be absent.
 * Pure: no I/O, no clock, no words are read — a result is judged by its parsed structure and its ok flag only.
 */

/** The machine code of the failure the session reports (errorCode); same value as Desktop EMPTY_AFTER_UNUSABLE_TOOLS_CODE. */
const EMPTY_AFTER_UNUSABLE_TOOLS_CODE = "empty_after_unusable_tools";
/**
 * The machine code of a turn the executor ended normally with no reply text AND no tool activity of any kind: the model's empty
 * answer. Desktop types it `empty` with no host code (every runner reports it itself); the Terminal's native drivers did not, so the
 * session does and names it (errorKind `empty`, this errorCode).
 */
const EMPTY_ANSWER_CODE = "empty_answer";

const EMPTY_COLLECTION_TEXT_MAX = 8192;
const EMPTY_COLLECTION_DEPTH = 2;
const TOOL_COUNT_LIMIT = 4096;

function isEmptyCollectionValue(value, depth) {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  // An MCP text envelope ({ content: [{ type: "text", text }], isError?, structuredContent? }): every text block is an empty collection.
  if (Array.isArray(value.content) && depth < EMPTY_COLLECTION_DEPTH) {
    const envelope = keys.every((key) => key === "content" || key === "isError" || key === "structuredContent");
    if (envelope && value.isError !== true && value.content.length > 0 && value.content.every((block) => {
      const entry = block && typeof block === "object" ? block : null;
      return entry !== null && entry.type === "text" && toolResultIsEmptyCollection(entry.text, depth + 1);
    })) {
      return value.structuredContent === undefined || value.structuredContent === null
        || isEmptyCollectionValue(value.structuredContent, depth + 1);
    }
  }
  // An object whose every value is null or an empty array, with at least one empty array ({"items":[]}).
  let emptyArray = false;
  for (const key of keys) {
    const entry = value[key];
    if (Array.isArray(entry) && entry.length === 0) emptyArray = true;
    else if (entry !== null) return false;
  }
  return emptyArray;
}

/**
 * Whether a tool result is, structurally, a collection with nothing in it: `[]`, `{"items":[]}`, or an MCP text envelope
 * holding only such text. Parsed data only, never words. Quiet successes are NOT empty: an empty string, "ok", `{}`, `0`,
 * `{"ok":true}` (a write, a shell command that prints nothing). Bounded: longer text is never parsed.
 */
function toolResultIsEmptyCollection(result, depth = 0) {
  if (typeof result !== "string") return false;
  const text = result.trim();
  if (text.length < 2 || text.length > EMPTY_COLLECTION_TEXT_MAX || (text[0] !== "[" && text[0] !== "{")) return false;
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  return isEmptyCollectionValue(value, depth);
}

/**
 * The tally of one turn's tool calls as the sink sees them. The Terminal's tool events carry no call id, so calls are
 * counted: `start()` for each `tool()`, `complete({ ok, text })` for each `toolResult()`. A completion is `unusable` when it
 * failed (ok === false) or came back as an empty collection, `usable` otherwise; `pending` is what was started and never
 * completed. Past the count limit the tally reports one usable call, so a very large turn is never judged on a partial count.
 */
function createToolOutcomeTally() {
  let started = 0, unusable = 0, usable = 0, unclassified = 0, overflow = false;
  return {
    start() {
      if (started >= TOOL_COUNT_LIMIT) { overflow = true; return; }
      started += 1;
    },
    complete(report) {
      if (unusable + usable >= TOOL_COUNT_LIMIT) { overflow = true; return; }
      const ok = !report || report.ok !== false;
      if (!ok || toolResultIsEmptyCollection(report && report.text)) unusable += 1; else usable += 1;
    },
    /**
     * A tool-ish event the executor's driver draws no row for (a server-side web search, an MCP connector call, an item kind the
     * host does not render). It cannot be judged failed or empty - so a turn that has one is never "every tool call failed" - but
     * it proves the model used a tool, so a blank reply behind it is not a model that produced nothing at all.
     */
    noteUnclassified() { if (unclassified < TOOL_COUNT_LIMIT) unclassified += 1; else overflow = true; },
    summary() {
      const completed = unusable + usable;
      return {
        unusable, usable: usable + (overflow ? 1 : 0), pending: Math.max(0, started - completed), started, unclassified,
        // Every sign of tool use the sink was told about, drawn or not; 0 only when the turn showed none at all.
        activity: started + completed + unclassified + (overflow ? 1 : 0),
      };
    },
    reset() { started = 0; unusable = 0; usable = 0; unclassified = 0; overflow = false; },
  };
}

/**
 * A turn that ended normally with no reply text after tool calls, none of which gave anything back: at least one call, every
 * call started has an unusable outcome, none usable, none still pending. `reportedToolCalls` is an executor's own count when
 * it has one (the ACP runner's `toolCalls`); an executor that reports more calls than the sink saw outcomes for is never judged.
 * Facts only.
 */
function endedWithoutAnswerAfterUnusableTools(facts) {
  const text = facts && typeof facts.text === "string" ? facts.text : "";
  if (text.trim()) return false;
  const outcomes = facts && facts.outcomes ? facts.outcomes : { unusable: 0, usable: 0, pending: 0 };
  if (!(outcomes.unusable >= 1) || outcomes.usable !== 0 || outcomes.pending !== 0) return false;
  // A tool call the driver drew no row for could be a working one: "every tool call failed" is then not a fact.
  if (outcomes.unclassified > 0) return false;
  const reported = facts.reportedToolCalls;
  if (reported !== undefined && reported !== null) {
    if (typeof reported !== "number" || !Number.isSafeInteger(reported) || reported < 1 || outcomes.unusable < reported) return false;
  }
  return true;
}

/**
 * A turn that ended normally with no reply text and NO sign of tool use at all: nothing drawn, nothing counted, nothing noted
 * (`outcomes.activity` is exactly 0) and the executor reports no call of its own. "No tool seen" is not enough - a driver that
 * draws no row for a tool kind notes it as unclassified activity - so a summary without the `activity` field, or one that
 * reports any, is never judged. Facts only.
 */
function endedWithoutAnswerOrToolActivity(facts) {
  const text = facts && typeof facts.text === "string" ? facts.text : "";
  if (text.trim()) return false;
  const outcomes = facts && facts.outcomes ? facts.outcomes : null;
  if (!outcomes || outcomes.activity !== 0) return false;
  const reported = facts.reportedToolCalls;
  if (reported !== undefined && reported !== null && reported !== 0) return false;
  return true;
}

/**
 * A turn an executor ALREADY typed as the model's empty answer - antigravity (agyEmptyRunFailure) and the ACP core's `empty` -
 * and that the sink's own facts agree with: kind `empty`, no machine code of its own (a code names a narrower class and stays
 * the executor's), no text, no tool use of any kind. That executor says it in its own words (English only, or the raw
 * "ACP stopReason=end_turn") and nothing drew it in the interactive Terminal; the session adopts it as the same failure the other
 * executors get (one localized sentence, one code, one line). `facts.failure` is `{ kind, code }` of the executor's error.
 */
function executorTypedEmptyAnswer(facts) {
  const failure = facts && facts.failure;
  if (!failure || failure.kind !== "empty") return false;
  if (typeof failure.code === "string" && failure.code) return false;
  return endedWithoutAnswerOrToolActivity(facts);
}

/**
 * What a turn with no reply text is, from the facts alone: "tools_unusable" (every tool call failed or came back empty),
 * "no_tools" (the model produced neither text nor any tool call), or null (text present, or a tool worked, is pending, or ran
 * unclassified: the turn is not judged).
 */
function blankReplyKind(facts) {
  if (endedWithoutAnswerAfterUnusableTools(facts)) return "tools_unusable";
  if (endedWithoutAnswerOrToolActivity(facts)) return "no_tools";
  return null;
}

module.exports = {
  EMPTY_AFTER_UNUSABLE_TOOLS_CODE,
  EMPTY_ANSWER_CODE,
  toolResultIsEmptyCollection,
  createToolOutcomeTally,
  endedWithoutAnswerAfterUnusableTools,
  endedWithoutAnswerOrToolActivity,
  executorTypedEmptyAnswer,
  blankReplyKind,
};
