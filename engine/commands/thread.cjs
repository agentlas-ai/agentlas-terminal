"use strict";
/*
 * thread — the Desktop harness thread/turn read model in Terminal (docs/2026-10-13-native-harness/12 F3/F5):
 *   agentlas thread list [--limit N] [--json]
 *   agentlas thread read <chat-or-session> [--limit N] [--cursor <olderCursor>] [--before <iso>] [--json]
 *   agentlas thread status <chat-or-session> [--json]      (turn.status)
 * Same shared database and result shapes as Desktop's thread.list / thread.read / turn.status. Read-only.
 */
const view = require("../thread-view.cjs");

function usage(ctx, code = 1) {
  (code ? ctx.err : ctx.out)("Usage: agentlas thread <list|read <chat>|status <chat>> [--limit N] [--cursor <olderCursor>] [--before <iso>] [--json]");
  return code;
}

function take(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  const value = args[at + 1];
  args.splice(at, 2);
  return value ?? null;
}

async function run(ctx, rawArgs = []) {
  const args = rawArgs.slice();
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) return usage(ctx, args.length ? 0 : 1);
  const json = args.includes("--json") || ctx.output?.format === "json";
  for (let i = args.length - 1; i >= 0; i -= 1) if (args[i] === "--json") args.splice(i, 1);
  const limit = take(args, "--limit");
  const before = take(args, "--before");
  const cursor = take(args, "--cursor");
  const [sub, ref] = args;
  const db = ctx.db();
  let result;
  if (sub === "list") result = view.threadList(db, { limit });
  else if (sub === "read" && ref) result = view.threadRead(db, ref, { limit, before, cursor });
  else if (sub === "status" && ref) result = view.turnStatus(db, ref);
  else return usage(ctx);
  if (result.error) { ctx.err(`✖ ${result.error.message}`); return 1; }
  if (json) { ctx.out(JSON.stringify(result, null, 2)); return 0; }
  if (sub === "list") {
    for (const t of result.threads) ctx.out(`${t.threadId}  ${t.updatedAt ?? ""}  ${t.title}`);
    if (!result.threads.length) ctx.out(ctx.lang === "ko" ? "대화가 없습니다." : "No conversations.");
  } else if (sub === "read") {
    ctx.out(`# ${result.title} (${result.threadId})`);
    for (const item of result.items) ctx.out(`[${item.createdAt}] ${item.role}: ${item.text}`);
    if (result.olderCursor) ctx.out(`… --cursor ${result.olderCursor}`);
  } else {
    ctx.out(result.turn ? `${result.turn.status}  ${result.turn.runId}  ${result.turn.startedAt}${result.turn.finishedAt ? ` → ${result.turn.finishedAt}` : ""}`
      : (ctx.lang === "ko" ? "실행 기록이 없습니다." : "No run recorded."));
  }
  return 0;
}

module.exports = { run };
