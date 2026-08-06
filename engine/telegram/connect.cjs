"use strict";
/*
 * telegram/connect — 터미널 독립 Telegram 연결 (2026-08-06).
 *
 * 배경(오너): 데스크탑에서 쉽게 되는데 터미널이 왜 안 되냐. 확인해 보니
 * 데스크탑 electron/telegram/connect.ts(2193줄)의 대부분은 Electron이 BotFather
 * **브라우저 창을 자동 조종**해 봇을 자동 생성하는 편의 로직이다. 실제 연결
 * 코어는 순수 HTTPS(api.telegram.org)이고 Electron이 필요 없다:
 *   verifyBotToken(getMe) → 바인딩 저장 → getUpdates 폴링으로 방 귀속 → sendMessage.
 * 그 코어만 이식한다. 봇 토큰은 사용자가 @BotFather로 만들어 stdin으로 준다
 * (비밀은 argv 금지 — 히스토리·ps 노출). 저장은 0600 파일(standalone Node에서
 * keytar는 macOS 키체인에 막혀 멈추므로 — creds.cjs 계약과 동일).
 *
 * 데스크탑과 같은 telegram_bindings 테이블·같은 페어링 규칙을 쓴다(공유 스키마).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");

const TELEGRAM_REQUEST_TIMEOUT_MS = 20_000;

/** 순수 HTTPS. fetch 주입 가능(테스트). */
async function telegramApi(token, method, payload, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("this runtime has no fetch");
  const longPoll = method === "getUpdates" && typeof payload.timeout === "number" ? Math.max(0, payload.timeout) : 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Telegram ${method} timed out`)), TELEGRAM_REQUEST_TIMEOUT_MS + longPoll * 1000);
  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok !== true) {
      throw new Error((json && json.description) || `Telegram ${method} failed (${res.status})`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyBotToken(token, opts) {
  const me = await telegramApi(token, "getMe", {}, opts);
  if (!me || !me.is_bot) throw new Error("that token does not belong to a Telegram bot");
  return me;
}

// ── 토큰 비밀 저장 (0600 파일) ─────────────────────────────────────────────
function tokenDir() {
  const dir = path.join(userDataDir(), "telegram");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function tokenFile(id) { return path.join(tokenDir(), `${id}.token`); }
function saveToken(id, token) { fs.writeFileSync(tokenFile(id), token, { encoding: "utf8", mode: 0o600 }); }
function readToken(id) {
  try { return fs.readFileSync(tokenFile(id), "utf8").trim() || null; } catch { return null; }
}
function deleteToken(id) { try { fs.rmSync(tokenFile(id)); } catch { /* gone */ } }
function tokenFingerprint(token) { return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24); }

// ── 바인딩 ─────────────────────────────────────────────────────────────────
function listBindings(db) {
  try { return db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all(); } catch { return []; }
}
function getBinding(db, id) {
  try { return db.prepare("SELECT * FROM telegram_bindings WHERE id=?").get(id) || null; } catch { return null; }
}

/** 봇 토큰으로 바인딩을 만든다(방 미페어링). 반환: {id, botUsername}. */
async function startConnection(db, targetKind, targetId, token, opts) {
  const me = await verifyBotToken(token, opts);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  runWriteTransaction(db, () => {
    db.prepare(
      "INSERT INTO telegram_bindings (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status, enabled, token_saved, token_fingerprint, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,'waiting_for_chat',1,1,?,?,?)",
    ).run(id, targetKind, targetId, me.id, me.username || null, me.first_name || null, tokenFingerprint(token), now, now);
  });
  saveToken(id, token);
  // 남은 웹훅이 있으면 getUpdates가 막히므로 제거(있어도 무해).
  await telegramApi(token, "deleteWebhook", { drop_pending_updates: false }, opts).catch(() => null);
  return { id, botUsername: me.username || null };
}

/**
 * getUpdates 폴링으로 첫 private 메시지의 chat을 이 바인딩에 귀속한다.
 * 보안: 데스크탑과 같은 규칙 — 미페어링·enabled·waiting_for_chat 인 신선 바인딩
 * (30분 이내)에만, private 채팅만. 반환: 페어링된 바인딩 또는 null(시간초과).
 */
async function pairByPolling(db, id, { timeoutMs = 120_000, opts, onWait } = {}) {
  const token = readToken(id);
  if (!token) throw new Error("no stored token for this binding");
  const deadline = Date.now() + timeoutMs;
  let offset = (getBinding(db, id) || {}).last_update_id || 0;
  while (Date.now() < deadline) {
    if (typeof onWait === "function") onWait();
    let updates;
    try {
      updates = await telegramApi(token, "getUpdates", { offset: offset + 1, timeout: 25, allowed_updates: ["message"] }, opts);
    } catch { updates = []; }
    for (const update of updates || []) {
      if (typeof update.update_id === "number") offset = Math.max(offset, update.update_id);
      const message = update.message;
      if (!message || !message.chat || message.chat.type !== "private") continue;
      // 신선 미페어링 바인딩인지 재확인(경합 방지) 후 귀속.
      const row = getBinding(db, id);
      if (!row || row.telegram_chat_id || row.status !== "waiting_for_chat") continue;
      const createdAt = Date.parse(row.created_at);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) throw new Error("pairing window expired (30 min) — reconnect");
      const now = new Date().toISOString();
      const title = message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || message.chat.username || String(message.chat.id);
      runWriteTransaction(db, () => {
        db.prepare("UPDATE telegram_bindings SET telegram_chat_id=?, telegram_chat_title=?, status='chat_paired', last_update_id=?, updated_at=? WHERE id=?")
          .run(String(message.chat.id), title, offset, now, id);
      });
      return getBinding(db, id);
    }
    if (offset) {
      runWriteTransaction(db, () => {
        db.prepare("UPDATE telegram_bindings SET last_update_id=MAX(last_update_id,?), updated_at=? WHERE id=?").run(offset, new Date().toISOString(), id);
      });
    }
  }
  return null;
}

/** 페어링된 방에 확인 메시지를 보낸다. */
async function sendTest(db, id, text, opts) {
  const row = getBinding(db, id);
  if (!row) throw new Error("binding not found");
  if (!row.telegram_chat_id) throw new Error("this binding is not paired to a chat yet");
  const token = readToken(id);
  if (!token) throw new Error("no stored token for this binding");
  await telegramApi(token, "sendMessage", { chat_id: row.telegram_chat_id, text }, opts);
  return true;
}

function removeBinding(db, id) {
  runWriteTransaction(db, () => {
    db.prepare("DELETE FROM telegram_bindings WHERE id=?").run(id);
  });
  deleteToken(id);
}

module.exports = {
  telegramApi, verifyBotToken,
  startConnection, pairByPolling, sendTest, removeBinding,
  listBindings, getBinding,
  saveToken, readToken, deleteToken, tokenFingerprint,
};
