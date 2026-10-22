"use strict";
/*
 * sessions/generation — the common native-session generation contract for Terminal sessions (native-harness NH12).
 *
 * Same meaning as Desktop runtime/session-generation.ts + runtime/agent-context.ts, without depending on the Desktop
 * daemon: the chat (chat_messages) is the logical journal, the chat_runtime_sessions row of (chat, kind, agent) is the
 * native binding, a completed turn's saved provider id is its ACK, and a native session whose LAST model request reached
 * 80% of the model's own window gives way to the next generation, seeded from the journal (owner 2026-10-13: 80% of
 * the model's window, 1M models too, no fixed absolute thresholds, nothing on screen).
 *
 * A model, prompt or agent-revision change is not a new conversation. The binding identity is runtime kind + agent
 * (+ the declared vendor limits below); changed instructions reach a resumed session as one "current version" block,
 * and a fresh generation is seeded from the journal instead of starting with nothing.
 *
 * Declared vendor limits (each with its reason, not a blanket rule):
 *  - ACP (kimi/grok/cursor/github-copilot-cli): the permission mode is chosen at session/new, so it is part of the
 *    binding; the resumed session does not get the system text again (the runner sends only the turn prompt).
 *  - codex: `codex exec resume` keeps the developer instructions the thread started with (measured 0.162.1), and
 *    `turn.completed.usage` is thread-cumulative, not the last request — the 80% rule runs as the CLI's own compaction
 *    at 80% of W (`model_auto_compact_token_limit`, same as Desktop codex exec).
 *  - agy: resumed by `--conversation <id>` (agy 1.4.0; the Desktop antigravity contract). The conversation keeps the
 *    system text it started with, so changed instructions ride the turn context, and it belongs to the model that made
 *    it. A conversation agy can no longer find is reported as session_not_found and the binding moves on (session.cjs).
 *  - gemini: the Terminal adapter has no resume flag, and a conversation belongs to the model that made it — every turn
 *    is a host replay of the journal within the window budget (the stateless-API meaning).
 */
const crypto = require("node:crypto");
const path = require("node:path");

const GENERATION_CONTEXT_RATIO = 0.8;
const BINDING_PREFIX = "term.native.v3";

const ACP_KINDS = new Set(require("../runtimes/kinds.cjs").ACP_CLI_KINDS);
/** Kinds whose provider session the Terminal adapter resumes by id. */
const NATIVE_RESUME_KINDS = new Set(["claude-code", "codex", "agy", ...ACP_KINDS]);
/** Kinds the Terminal adapter cannot resume: the journal is replayed into every turn. */
const HOST_REPLAY_KINDS = new Set(["gemini"]);
/** A conversation belongs to the model that produced it. */
const MODEL_OWNED_KINDS = new Set(["gemini", "agy"]);
/** A resumed session keeps the system text it started with; changed instructions ride the turn context. */
const INSTRUCTIONS_FIXED_AT_START_KINDS = new Set(["codex", "agy", ...ACP_KINDS]);

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

/** The native binding identity: runtime kind + agent, plus the declared vendor limits. Never the prompt or revision. */
function bindingIdentity({ kind, model, agentId, permission }) {
  const parts = ["agentlas-terminal-native-binding.v3", String(kind || ""), String(agentId || "")];
  if (MODEL_OWNED_KINDS.has(kind)) parts.push(`model:${String(model || "")}`);
  if (ACP_KINDS.has(kind)) parts.push(`permission:${String(permission || "")}`);
  return sha256(parts.join("\0"));
}

/** chat_runtime_sessions.fingerprint value: identity, generation and the instructions version the session received. */
function encodeBinding({ identity, generation, instructionsDigest }) {
  const gen = Number.isSafeInteger(generation) && generation > 0 ? generation : 1;
  const instr = /^[a-f0-9]{16,64}$/.test(String(instructionsDigest || "")) ? String(instructionsDigest).slice(0, 32) : "-";
  return `${BINDING_PREFIX}:${identity}:g${gen}:i${instr}`;
}

function decodeBinding(text) {
  const match = /^term\.native\.v3:([a-f0-9]{64}):g([0-9]{1,9}):i([a-f0-9]{16,64}|-)$/.exec(String(text || ""));
  if (!match) return null;
  return { identity: match[1], generation: Number(match[2]), instructionsDigest: match[3] === "-" ? null : match[3] };
}

/** Short version key of a session-stable prompt (what a resumed session already received). */
function instructionsDigest(stableText) {
  return String(stableText || "").trim() ? sha256(stableText).slice(0, 32) : null;
}

/** Desktop agent-context.ts instructionsBlockFor — the same frame. */
function instructionsBlock(stableText) {
  return `[Agent instructions, current version: replaces earlier ones]\n${stableText}\n[End agent instructions]`;
}

// Prefer the vendored Desktop modules (same file on both surfaces); the ports below keep the same constants for a core
// that predates them (desktop-core v19 has continuity.renderConversationContext but no session-generation.js).
function vendoredRuntimeModule(name) {
  try {
    const { findCoreRoot } = require("../core/desktop-core.cjs");
    const root = findCoreRoot();
    return root ? require(path.join(root, "electron", "runtime", name)) : null;
  } catch {
    return null;
  }
}

/** session-generation.ts decideGeneration. */
function decideGeneration(input) {
  const vendored = vendoredRuntimeModule("session-generation.js");
  if (vendored && typeof vendored.decideGeneration === "function") return vendored.decideGeneration(input);
  if (input.symptom) return { action: "new_generation", reason: input.symptom };
  const window = input.contextWindowTokens, last = input.lastInputTokens;
  if (!window || !Number.isFinite(window) || window <= 0 || last === null || last === undefined
    || !Number.isFinite(last) || last <= 0) return { action: "continue" };
  return last >= window * GENERATION_CONTEXT_RATIO ? { action: "new_generation", reason: "context_ratio" } : { action: "continue" };
}

/** continuity.ts cliHistoryBudgetForWindow (admission below the rotation point, minus an output reserve). */
const CLI_HISTORY_CONTEXT_TOKENS_UNKNOWN_WINDOW = 120_000;
function seedBudgetTokens(windowTokens) {
  const vendored = vendoredRuntimeModule("continuity.js");
  if (vendored && typeof vendored.cliHistoryBudgetForWindow === "function") {
    return vendored.cliHistoryBudgetForWindow(windowTokens).admissionTokens;
  }
  if (typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return CLI_HISTORY_CONTEXT_TOKENS_UNKNOWN_WINDOW;
  }
  const w = Math.floor(windowTokens);
  const reserve = Math.min(w, Math.min(32_768, Math.max(1_024, Math.floor(w * 0.1))));
  return Math.max(0, Math.floor(w * GENERATION_CONTEXT_RATIO) - reserve);
}

/** The 80%-of-W native compaction limit handed to a CLI that compacts by itself; undefined when W is unknown. */
function nativeCompactionLimit(windowTokens) {
  return typeof windowTokens === "number" && Number.isFinite(windowTokens) && windowTokens > 0
    ? Math.floor(windowTokens * GENERATION_CONTEXT_RATIO) : undefined;
}

function contextWindowTokens(kind, model) {
  try {
    return require("../context-inspect.cjs").runtimeContextWindow(kind, model);
  } catch {
    return null;
  }
}

/**
 * The journal seed for a fresh generation (or a host-replay turn): the Desktop continuity renderer when the core has it
 * (older turns fold into a digest only over budget), else whole newest rows within the same budget.
 */
function renderJournalSeed(history, locale, windowTokens) {
  const rows = (Array.isArray(history) ? history : []).filter((row) => row && String(row.text || "").trim());
  if (!rows.length) return "";
  const budget = seedBudgetTokens(windowTokens);
  const vendored = vendoredRuntimeModule("continuity.js");
  const entries = rows.map((row) => ({ role: row.role === "assistant" ? "assistant" : "user", text: String(row.text),
    ...(row.created_at || row.createdAt ? { createdAt: row.created_at || row.createdAt } : {}) }));
  if (vendored && typeof vendored.renderConversationContext === "function") {
    try { return vendored.renderConversationContext(entries, locale === "ko" ? "ko" : "en", budget).block; }
    catch { /* the plain renderer below keeps the same meaning */ }
  }
  const kept = [];
  let tokens = 0;
  for (const row of [...entries].reverse()) {
    const line = `${row.role === "user" ? (locale === "ko" ? "사용자" : "User") : (locale === "ko" ? "어시스턴트" : "Assistant")}: ${row.text}`;
    const cost = Math.ceil(Buffer.byteLength(line, "utf8") / 3);
    if (tokens + cost > budget) break;
    kept.unshift(line);
    tokens += cost;
  }
  if (!kept.length) return "";
  return [locale === "ko" ? "── 이전 대화 ──" : "── Previous turns ──",
    "transcript below = this live conversation; continue as the assistant from its start; never call it a previous session",
    "", kept.join("\n\n")].join("\n");
}

module.exports = {
  GENERATION_CONTEXT_RATIO,
  NATIVE_RESUME_KINDS,
  HOST_REPLAY_KINDS,
  MODEL_OWNED_KINDS,
  INSTRUCTIONS_FIXED_AT_START_KINDS,
  bindingIdentity,
  encodeBinding,
  decodeBinding,
  instructionsDigest,
  instructionsBlock,
  decideGeneration,
  seedBudgetTokens,
  nativeCompactionLimit,
  contextWindowTokens,
  renderJournalSeed,
};
