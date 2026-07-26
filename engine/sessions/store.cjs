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
    ).run(id, agentId, title || "New chat", now, now, kind, parentChatId, workingFolder);
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
    db.prepare("UPDATE chats SET title=?, updated_at=? WHERE id=?").run(String(title || "New chat").slice(0, 120), nowIso(), chatId);
  });
}

function chatHistory(db, chatId, limit = 40) {
  return db.prepare(
    "SELECT role, text, created_at FROM chat_messages WHERE chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(chatId, limit).reverse();
}

/*
 * CLI resume 세션 ID 영속화 — 데스크탑 chat_runtime_sessions와 동일 스키마
 * (chat_id, kind, session_id, fingerprint). fingerprint가 다르면 resume하지
 * 않는다 — 시스템 프롬프트가 바뀐 세션을 이어붙이면 지시가 오염된다.
 */
function loadRuntimeSession(db, chatId, kind, fingerprint) {
  try {
    const row = db.prepare("SELECT session_id, fingerprint FROM chat_runtime_sessions WHERE chat_id=? AND kind=?").get(chatId, kind);
    if (row && row.session_id && row.fingerprint === fingerprint) return { id: row.session_id };
  } catch { /* 테이블 부재 — resume 없이 진행 */ }
  return {};
}

function saveRuntimeSession(db, chatId, kind, session, fingerprint) {
  const sessionId = session && session.id ? String(session.id) : "";
  if (!sessionId) return;
  try {
    runWriteTransaction(db, () => {
      db.prepare(
        "INSERT INTO chat_runtime_sessions (chat_id, kind, session_id, fingerprint, updated_at) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(chat_id, kind) DO UPDATE SET session_id=excluded.session_id, fingerprint=excluded.fingerprint, updated_at=excluded.updated_at",
      ).run(chatId, kind, sessionId, fingerprint, nowIso());
    });
  } catch { /* 스키마가 다르면 resume만 포기 — 턴 자체는 유효 */ }
}

module.exports = { createChat, appendMessage, retitleChat, chatHistory, loadRuntimeSession, saveRuntimeSession, newId };
