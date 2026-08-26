"use strict";
/*
 * sessions/store — chats/chat_messages 영속화 (데스크탑과 동일 테이블·어휘).
 * 메인 세션: kind='user'. 서브에이전트 세션: kind='division' + parent_chat_id
 * (데스크탑 division 서브챗과 같은 패턴 — 데스크탑 UI에서도 동일하게 보인다).
 */
const crypto = require("node:crypto");
const { runWriteTransaction } = require("../core/db.cjs");

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function createChat(db, { agentId, title, kind = "user", parentChatId = null, workingFolder = null }) {
  const id = newId();
  const now = nowIso();
  runWriteTransaction(db, () => {
    db.prepare(
      "INSERT INTO chats (id, agent_id, title, created_at, updated_at, kind, parent_chat_id, working_folder) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, agentId, title || "New project task", now, now, kind, parentChatId, workingFolder);
  });
  return id;
}

function appendMessage(db, chatId, role, text) {
  const id = newId();
  const now = nowIso();
  runWriteTransaction(db, () => {
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?,?,?,?,?)",
    ).run(id, chatId, role, String(text || ""), now);
    db.prepare("UPDATE chats SET updated_at=?, used_at=? WHERE id=?").run(now, now, chatId);
  });
  return id;
}

function retitleChat(db, chatId, title) {
  runWriteTransaction(db, () => {
    db.prepare("UPDATE chats SET title=?, updated_at=? WHERE id=?").run(String(title || "New project task").slice(0, 120), nowIso(), chatId);
  });
}

function chatHistory(db, chatId, limit = 40) {
  return db.prepare(
    "SELECT role, text, created_at FROM chat_messages WHERE chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(chatId, limit).reverse();
}

/*
 * CLI resume 세션 ID 영속화 — 데스크탑 `store/runtime-sessions.ts` 와 같은 키를 쓴다.
 *
 * ★키가 셋이다: (chat_id, kind, **agent_id**). 좌석-세션 전에는 둘이었고, 이 사본은
 * 둘로 남아 있었다. 그래서 `ON CONFLICT(chat_id, kind)` 가 실제 기본키와 맞지 않아
 * INSERT 가 예외를 냈고, 그 예외를 아래 catch 가 삼켰다 — **터미널의 resume 이 통째로
 * 사라진 채 아무 표시도 나지 않았다.** 매 턴이 새 세션으로 시작하니 사용자에게는
 * "말한 걸 자꾸 잊는다"로 보인다.
 *
 * 조용히 실패하는 catch 가 이 병을 몇 판이나 숨겼다. 이제 저장 성공 여부를 boolean 으로
 * 돌려주고, 실패는 한 줄 남긴다 — 턴 자체는 유효하므로 던지지는 않는다.
 *
 * fingerprint 가 다르면 resume 하지 않는다 — 시스템 프롬프트가 바뀐 세션을 이어붙이면
 * 지시가 오염된다.
 */
function normalizeRuntimeAgentId(agentId) {
  return typeof agentId === "string" ? agentId.trim() : "";
}

function loadRuntimeSession(db, chatId, kind, fingerprint, agentId) {
  const agent = normalizeRuntimeAgentId(agentId);
  try {
    const select = db.prepare(
      "SELECT session_id, fingerprint FROM chat_runtime_sessions WHERE chat_id=? AND kind=? AND agent_id=?",
    );
    let row = select.get(chatId, kind, agent);
    // v103 이전 행은 agent_id='' 로 이관돼 있다. 정확한 키에 없으면 그 행을 승계 후보로
    // 읽는다 — 다른 봇의 세션이면 바로 아래 지문 검증이 스스로 버린다(데스크탑과 동형).
    if (!row && agent !== "") row = select.get(chatId, kind, "");
    if (row && row.session_id && row.fingerprint === fingerprint) return { id: row.session_id };
  } catch { /* 테이블 부재(구형 DB) — resume 없이 진행 */ }
  return {};
}

function saveRuntimeSession(db, chatId, kind, session, fingerprint, agentId) {
  const sessionId = session && session.id ? String(session.id) : "";
  if (!sessionId) return false;
  const agent = normalizeRuntimeAgentId(agentId);
  try {
    runWriteTransaction(db, () => {
      db.prepare(
        "INSERT OR REPLACE INTO chat_runtime_sessions (chat_id, kind, agent_id, session_id, fingerprint, updated_at) VALUES (?,?,?,?,?,?)",
      ).run(chatId, kind, agent, sessionId, fingerprint, nowIso());
      // 레거시 행을 승계했다면 이제 새 키가 정본이다 — 같은 세션을 가리키는 '' 행을
      // 정리해 다음 점유자가 이 봇의 세션을 승계 후보로 오인하지 않게 한다.
      if (agent !== "") {
        db.prepare(
          "DELETE FROM chat_runtime_sessions WHERE chat_id=? AND kind=? AND agent_id='' AND session_id=?",
        ).run(chatId, kind, sessionId);
      }
    });
    return true;
  } catch (error) {
    // 턴 자체는 유효하므로 던지지 않는다. 다만 조용히 지나가지도 않는다 — 이 자리의
    // 침묵이 resume 유실을 여러 판 동안 숨겼다.
    if (process.env.AGENTLAS_DEBUG) {
      console.error(`[agentlas] resume session not persisted: ${error && error.message ? error.message : error}`);
    }
    return false;
  }
}

module.exports = { createChat, appendMessage, retitleChat, chatHistory, loadRuntimeSession, saveRuntimeSession, newId };
