"use strict";
/*
 * thread-view — Desktop harness thread.list / thread.read / turn.status over the same shared chats, chat_messages and
 * run_events rows (docs/2026-10-13-native-harness/12 F3/F5: Terminal projection). Same result shapes as
 * agentlas_desktop/electron/harness/thread-service.ts; read-only (no model call, no session change).
 * Turn status follows Desktop's receipt rule (store/run-events.ts getInvocationRunReceipt): the newest invoke_started of
 * the chat, then its terminal kind. Terminal cannot see whether a Desktop process still runs an open turn, so a turn
 * with no terminal row reads "open", never "running".
 */
const { resolveChat } = require("./context-inspect.cjs");

const TEXT_LIMIT = 4000;
const TERMINAL_KINDS = ["invoke_waiting", "invoke_completed", "mcp_final", "invoke_cancelled", "invoke_interrupted", "invoke_failed", "invoke_threw", "mcp_error"];

function threadList(db, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = db.prepare(
    `SELECT id, title, agent_id AS agentId, project_id AS projectId, updated_at AS updatedAt FROM chats
      WHERE archived_at IS NULL AND kind = 'user' AND used_at IS NOT NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(n);
  return { threads: rows.map((row) => ({ threadId: row.id, title: row.title, agentId: row.agentId ?? null, projectId: row.projectId ?? null, updatedAt: row.updatedAt ?? null })) };
}

// Rows the Desktop store hides from every transcript (store/chats.ts LEGACY_FIRM_SYNTHESIS_MARKER): never written by the person.
const LEGACY_FIRM_SYNTHESIS_MARKER = "[Results from your team — synthesize into one final answer for the user]";

/** Opaque page cursor shared with Desktop thread.read: the oldest row of the page, id + createdAt. */
function encodeThreadCursor(row) {
  return `c1.${Buffer.from(JSON.stringify([row.id, row.createdAt]), "utf8").toString("base64url")}`;
}

function decodeThreadCursor(raw) {
  if (typeof raw !== "string" || !raw.startsWith("c1.") || raw.length > 2048) return null;
  try {
    const value = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && value[0] && typeof value[1] === "string" && value[1]
      ? { id: value[0], createdAt: value[1] } : null;
  } catch {
    return null;
  }
}

function threadRead(db, ref, { limit = 50, before = null, cursor = null } = {}) {
  const found = resolveChat(db, ref);
  if (found.error) return { error: found.error };
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const rawCursor = cursor || (typeof before === "string" && before.startsWith("c1.") ? before : null);
  const legacyBefore = !rawCursor && before ? before : null;
  let keyset = null;
  if (rawCursor) {
    keyset = decodeThreadCursor(rawCursor);
    if (!keyset) return { error: { code: "cursor_invalid", message: "Invalid cursor; pass olderCursor from the previous page." } };
    // Same rule as Desktop: a cursor whose row is gone is refused, never guessed into a position.
    const exists = db.prepare(
      "SELECT 1 FROM chat_messages WHERE chat_id = ? AND id = ? AND created_at = ? AND NOT (role = 'user' AND instr(text, ?) > 0)",
    ).get(found.chat.id, keyset.id, keyset.createdAt, LEGACY_FIRM_SYNTHESIS_MARKER);
    if (!exists) return { error: { code: "cursor_stale", message: "The cursor no longer matches this conversation; read the newest page again." } };
  }
  // Keyset order created_at DESC, rowid DESC (Desktop store order, store/chats.ts readChatMessageKeyset): rows saved in one
  // millisecond keep insertion order, never their random ids, and page exactly once. The cursor names its row; its rowid is read.
  const rows = db.prepare(
    `SELECT id, role, text, created_at AS createdAt FROM chat_messages
      WHERE chat_id = ? AND role != 'system' AND NOT (role = 'user' AND instr(text, ?) > 0)
        ${keyset ? "AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM chat_messages WHERE id = ?)))" : legacyBefore ? "AND created_at < ?" : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(found.chat.id, LEGACY_FIRM_SYNTHESIS_MARKER,
    ...(keyset ? [keyset.createdAt, keyset.createdAt, keyset.id] : legacyBefore ? [legacyBefore] : []), n + 1).reverse();
  const page = rows.slice(-n);
  const hasOlder = rows.length > page.length && page[0];
  return {
    threadId: found.chat.id, title: found.chat.title,
    items: page.map((row) => ({ id: row.id, role: row.role, createdAt: row.createdAt,
      text: row.text.length > TEXT_LIMIT ? `${row.text.slice(0, TEXT_LIMIT)}…` : row.text, truncated: row.text.length > TEXT_LIMIT })),
    olderCursor: hasOlder ? encodeThreadCursor(page[0]) : null,
    // Earlier contract; equal timestamps make it lossy, olderCursor is exact.
    olderBefore: hasOlder ? page[0].createdAt : null,
  };
}

function turnStatus(db, ref) {
  const found = resolveChat(db, ref);
  if (found.error) return { error: found.error };
  const start = db.prepare(
    "SELECT run_id AS runId, ts FROM run_events WHERE chat_id = ? AND kind = 'invoke_started' ORDER BY ts DESC LIMIT 1",
  ).get(found.chat.id);
  if (!start) return { threadId: found.chat.id, turn: null };
  const terminal = db.prepare(
    `SELECT kind, ts FROM run_events WHERE run_id = ? AND kind IN (${TERMINAL_KINDS.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT 1`,
  ).get(start.runId, ...TERMINAL_KINDS);
  const status = !terminal ? "open"
    : terminal.kind === "invoke_waiting" ? "waiting_input"
      : terminal.kind === "invoke_completed" || terminal.kind === "mcp_final" ? "completed"
        : terminal.kind === "invoke_cancelled" ? "cancelled"
          : terminal.kind === "invoke_interrupted" ? "interrupted" : "failed";
  return { threadId: found.chat.id, turn: { runId: start.runId, status, startedAt: start.ts, finishedAt: terminal ? terminal.ts : null } };
}

module.exports = { threadList, threadRead, turnStatus, encodeThreadCursor, decodeThreadCursor, TERMINAL_KINDS };
