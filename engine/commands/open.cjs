"use strict";
/*
 * open — 기존 대화 재개: agentlas open <chat-id-prefix>
 * 해당 챗의 에이전트로 REPL을 열고 같은 chatId에 이어 쓴다
 * (CLI resume 세션도 chat_runtime_sessions에서 fingerprint 일치 시 복원).
 */
const { rowToAgent } = require("../agents/registry.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const prefix = String(args[0] || "").trim();
  if (!prefix) {
    ctx.err(ko ? "사용법: agentlas open <chat-id 앞부분>  (agentlas chats 로 목록)" : "Usage: agentlas open <chat-id-prefix>  (list with: agentlas chats)");
    return 1;
  }
  const db = ctx.db();
  const rows = db.prepare(
    "SELECT c.id, c.title, c.agent_id FROM chats c WHERE c.id LIKE ? AND c.archived_at IS NULL ORDER BY c.updated_at DESC LIMIT 2",
  ).all(prefix + "%");
  if (!rows.length) {
    ctx.err((ko ? "대화를 찾을 수 없음: " : "chat not found: ") + prefix);
    return 1;
  }
  if (rows.length > 1) {
    ctx.err(ko ? `모호합니다 — 더 긴 접두사를 쓰세요 (${rows.map((r) => r.id.slice(0, 8)).join(", ")})` : `Ambiguous — use a longer prefix (${rows.map((r) => r.id.slice(0, 8)).join(", ")})`);
    return 1;
  }
  const chat = rows[0];
  const agentRow = db.prepare("SELECT * FROM installed_agents WHERE id=?").get(chat.agent_id);
  if (!agentRow) {
    ctx.err(ko ? "이 대화의 에이전트가 더 이상 없습니다." : "The agent for this chat no longer exists.");
    return 1;
  }
  const { startRepl } = require("../ui/repl.cjs");
  ctx.out(ctx.ui.dim(`${ko ? "재개" : "resume"}: ${chat.title}`));
  return startRepl(ctx, { agent: rowToAgent(agentRow).slug, chatId: chat.id });
}

module.exports = { run };
