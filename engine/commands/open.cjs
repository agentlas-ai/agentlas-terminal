"use strict";
/*
 * open — 기존 대화 재개: agentlas open <chat-id-prefix>
 * 해당 챗의 에이전트로 REPL을 열고 같은 chatId에 이어 쓴다
 * (CLI resume 세션도 chat_runtime_sessions에서 fingerprint 일치 시 복원).
 */
const { rowToAgent, isPrivateWebOnlyAgentRow } = require("../agents/registry.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const prefix = String(args[0] || "").trim();
  if (!prefix) {
    ctx.err(ko ? "사용법: agentlas open <chat-id 앞부분>  (agentlas chats 로 목록)" : "Usage: agentlas open <chat-id-prefix>  (list with: agentlas chats)");
    return 1;
  }
  const db = ctx.db();
  // 사용자 표면은 kind='user' 챗만 연다 — 데스크탑 사용자 챗 목록과 동일 필터
  // (electron/store/chats.ts:86; 레거시 NULL=user 취급은 electron/store/db.ts:717).
  // 숨김 division 세션(자동화/본부 인프라)은 접두사를 알아도 재개 대상이 아니다.
  const rows = db.prepare(
    "SELECT c.id, c.title, c.agent_id FROM chats c WHERE c.id LIKE ? AND c.archived_at IS NULL AND (c.kind IS NULL OR c.kind = 'user') ORDER BY c.updated_at DESC LIMIT 2",
  ).all(prefix + "%");
  if (!rows.length) {
    ctx.err((ko ? "대화를 찾을 수 없음: " : "chat not found: ") + prefix);
    return 1;
  }
  if (rows.length > 1) {
    // 안내 접두사는 사용자가 입력한 것보다 반드시 길어야 한다 — chats 목록이
    // 8자를 찍으므로, 8자로 고정하면 8자 충돌 시 같은 문자열 두 개를 돌려주는
    // 막다른 길이 된다("더 긴 접두사"를 만들 방법이 없음).
    const hintLen = Math.max(8, prefix.length + 4);
    ctx.err(ko ? `모호합니다 — 더 긴 접두사를 쓰세요 (${rows.map((r) => r.id.slice(0, hintLen)).join(", ")})` : `Ambiguous — use a longer prefix (${rows.map((r) => r.id.slice(0, hintLen)).join(", ")})`);
    return 1;
  }
  const chat = rows[0];
  const agentRow = db.prepare("SELECT * FROM installed_agents WHERE id=?").get(chat.agent_id);
  if (!agentRow) {
    ctx.err(ko ? "이 대화의 에이전트가 더 이상 없습니다." : "The agent for this chat no longer exists.");
    return 1;
  }
  // registry 정책과 동일: 웹 전용(private) 에이전트는 챗 id를 알아도 터미널에서
  // 실행되면 안 된다 (hub/install.cjs 설치 게이트와 같은 문구).
  if (isPrivateWebOnlyAgentRow(agentRow)) {
    ctx.err("This web-only agent is not available in the Agentlas terminal.");
    return 1;
  }
  const { startRepl } = require("../ui/repl.cjs");
  ctx.out(ctx.ui.dim(`${ko ? "재개" : "resume"}: ${chat.title}`));
  return startRepl(ctx, { agent: rowToAgent(agentRow).slug, chatId: chat.id });
}

module.exports = { run };
