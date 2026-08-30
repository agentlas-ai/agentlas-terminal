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
const TELEGRAM_TOKEN_MAX_BYTES = 1024;
const TELEGRAM_BINDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertTelegramBindingId(id) {
  const value = String(id || "");
  if (!TELEGRAM_BINDING_ID_RE.test(value)) throw new Error("invalid Telegram binding id");
  return value;
}

/** 순수 HTTPS. fetch 주입 가능(테스트). */
async function telegramApi(token, method, payload, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("this runtime has no fetch");
  const safeToken = String(token || "");
  const safeMethod = String(method || "");
  if (!safeToken || Buffer.byteLength(safeToken, "utf8") > TELEGRAM_TOKEN_MAX_BYTES || !/^[A-Za-z0-9:_-]+$/.test(safeToken)) {
    throw new Error("Telegram bot token has an unsafe format");
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(safeMethod)) throw new Error("Telegram API method is invalid");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Telegram API payload must be an object");
  const requestedLongPoll = safeMethod === "getUpdates" && Number.isFinite(Number(payload.timeout))
    ? Number(payload.timeout)
    : 0;
  const longPoll = Math.max(0, Math.min(50, requestedLongPoll));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Telegram ${safeMethod} timed out`)), TELEGRAM_REQUEST_TIMEOUT_MS + longPoll * 1000);
  try {
    const res = await doFetch(`https://api.telegram.org/bot${safeToken}/${safeMethod}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok !== true) {
      const raw = (json && json.description) || `Telegram ${safeMethod} failed (${res.status})`;
      const message = String(raw).replaceAll(safeToken, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);
      const error = new Error(message || `Telegram ${safeMethod} failed`);
      error.telegramStatus = Number(res.status) || null;
      throw error;
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
function tokenDir({ create = true } = {}) {
  const dir = path.join(userDataDir(), "telegram");
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) {
    if (error && error.code === "ENOENT" && !create) return dir;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Telegram token directory must be a real directory");
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}
function tokenFile(id, options) {
  const bindingId = assertTelegramBindingId(id);
  return path.join(tokenDir(options), `${bindingId}.token`);
}
function saveToken(id, token) {
  const file = tokenFile(id);
  const value = String(token || "");
  if (!value || Buffer.byteLength(value, "utf8") > TELEGRAM_TOKEN_MAX_BYTES || !/^[A-Za-z0-9:_-]+$/.test(value)) {
    throw new Error("Telegram bot token has an unsafe format");
  }
  let before = null;
  try {
    before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Telegram token target must be a regular private file");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (before) {
      const current = fs.lstatSync(file);
      if (
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs
      ) throw new Error("Telegram token target changed before replacement");
    } else {
      try {
        fs.lstatSync(file);
        throw new Error("Telegram token target appeared before replacement");
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (
        process.platform !== "win32" || !before ||
        !["EEXIST", "EPERM", "EACCES"].includes(error && error.code)
      ) throw error;
      const backup = `${file}.${process.pid}.${crypto.randomUUID()}.bak`;
      fs.renameSync(file, backup);
      try {
        fs.renameSync(temp, file);
      } catch (replaceError) {
        try { if (!fs.existsSync(file)) fs.renameSync(backup, file); } catch { /* leave recoverable backup */ }
        throw replaceError;
      }
      try { fs.rmSync(backup, { force: true }); } catch { /* committed target is authoritative */ }
    }
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}
function readToken(id) {
  const file = tokenFile(id, { create: false });
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size <= 0 || before.size > TELEGRAM_TOKEN_MAX_BYTES ||
      (process.platform !== "win32" && (before.mode & 0o077) !== 0)
    ) throw new Error("Telegram token file is unsafe");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Telegram token file changed while opening");
    }
    const token = fs.readFileSync(fd, "utf8").trim();
    if (!token || !/^[A-Za-z0-9:_-]+$/.test(token)) throw new Error("Telegram token file has an unsafe format");
    return token;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function deleteToken(id) {
  const file = tokenFile(id, { create: false });
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Telegram token target is unsafe");
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
function tokenFingerprint(token) { return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24); }

function readBindingToken(row) {
  if (!row) throw new Error("binding not found");
  const token = readToken(row.id);
  if (!token) throw new Error("no Terminal-owned token for this binding");
  if (row.token_fingerprint && tokenFingerprint(token) !== row.token_fingerprint) {
    throw new Error("stored Telegram token does not match the binding fingerprint");
  }
  return token;
}

// ── 바인딩 ─────────────────────────────────────────────────────────────────
function listBindings(db) {
  try { return db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all(); } catch { return []; }
}
function getBinding(db, id) {
  try { return db.prepare("SELECT * FROM telegram_bindings WHERE id=?").get(id) || null; } catch { return null; }
}

/** 봇 토큰으로 바인딩을 만든다(방 미페어링). 반환: {id, botUsername}. */
async function startConnection(db, targetKind, targetId, token, opts) {
  if (!new Set(["agent", "firm", "one"]).has(String(targetKind))) throw new Error("invalid Telegram binding target kind");
  if (typeof targetId !== "string" || !targetId.trim() || targetId.length > 512 || /[\u0000\r\n]/.test(targetId)) {
    throw new Error("invalid Telegram binding target id");
  }
  const me = await verifyBotToken(token, opts);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  runWriteTransaction(db, () => {
    db.prepare(
      "INSERT INTO telegram_bindings (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status, enabled, token_saved, token_fingerprint, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,'waiting_for_chat',1,0,?,?,?)",
    ).run(id, targetKind, targetId, me.id, me.username || null, me.first_name || null, tokenFingerprint(token), now, now);
  });
  try {
    saveToken(id, token);
    runWriteTransaction(db, () => {
      db.prepare("UPDATE telegram_bindings SET token_saved=1, updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    });
  } catch (error) {
    try { deleteToken(id); } catch { /* preserve the original storage failure */ }
    try {
      runWriteTransaction(db, () => db.prepare("DELETE FROM telegram_bindings WHERE id=?").run(id));
    } catch { /* preserve the original storage failure */ }
    throw error;
  }
  // 남은 웹훅이 있으면 getUpdates가 막히므로 제거(있어도 무해).
  await telegramApi(token, "deleteWebhook", { drop_pending_updates: false }, opts).catch(() => null);
  return { id, botUsername: me.username || null };
}

/**
 * getUpdates 폴링으로 `/start <bindingId>`를 보낸 private chat을 이 바인딩에 귀속한다.
 * 보안: 봇 이름을 발견한 제3자의 첫 메시지가 로컬 에이전트를 탈취하지 못하도록 정확한
 * 페어링 토큰을 요구한다. 최종 UPDATE도 미페어링·enabled·waiting 상태를 조건으로 삼아
 * 두 Terminal 프로세스가 같은 바인딩을 동시에 덮어쓰지 못하게 한다.
 */
async function pairByPolling(db, id, { timeoutMs = 120_000, opts, onWait } = {}) {
  assertTelegramBindingId(id);
  const initialRow = getBinding(db, id);
  if (!initialRow) throw new Error("binding not found");
  const token = readBindingToken(initialRow);
  const deadline = Date.now() + timeoutMs;
  let offset = Number.isSafeInteger(Number(initialRow.last_update_id)) && Number(initialRow.last_update_id) >= 0
    ? Number(initialRow.last_update_id)
    : 0;
  let lastApiError = null;
  while (Date.now() < deadline) {
    if (typeof onWait === "function") onWait();
    let updates;
    try {
      updates = await telegramApi(token, "getUpdates", { offset: offset + 1, timeout: 25, allowed_updates: ["message"] }, opts);
      if (!Array.isArray(updates)) throw new Error("Telegram getUpdates returned an invalid result");
      lastApiError = null;
    } catch (error) {
      lastApiError = error;
      updates = [];
    }
    for (const update of updates || []) {
      if (typeof update.update_id === "number") offset = Math.max(offset, update.update_id);
      const message = update.message;
      if (!message || !message.chat || message.chat.type !== "private") continue;
      const pairingToken = String(message.text || "").match(/^\/start(?:@\w+)?\s+(\S+)/i)?.[1] || "";
      if (pairingToken !== id) continue;
      // 신선 미페어링 바인딩인지 재확인(경합 방지) 후 귀속.
      const row = getBinding(db, id);
      if (!row || row.telegram_chat_id || row.status !== "waiting_for_chat") continue;
      const createdAt = Date.parse(row.created_at);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) throw new Error("pairing window expired (30 min) — reconnect");
      const now = new Date().toISOString();
      const title = message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || message.chat.username || String(message.chat.id);
      const claimed = runWriteTransaction(db, () => {
        return db.prepare(
          "UPDATE telegram_bindings SET telegram_chat_id=?, telegram_chat_title=?, status='chat_paired', last_update_id=?, updated_at=? " +
          "WHERE id=? AND telegram_chat_id IS NULL AND enabled=1 AND status='waiting_for_chat'",
        ).run(String(message.chat.id), title, offset, now, id).changes === 1;
      });
      if (claimed) return getBinding(db, id);
    }
    if (offset) {
      runWriteTransaction(db, () => {
        db.prepare("UPDATE telegram_bindings SET last_update_id=MAX(last_update_id,?), updated_at=? WHERE id=?").run(offset, new Date().toISOString(), id);
      });
    }
  }
  if (lastApiError) throw lastApiError;
  return null;
}

/** 페어링된 방에 확인 메시지를 보낸다. */
async function sendTest(db, id, text, opts) {
  assertTelegramBindingId(id);
  const row = getBinding(db, id);
  if (!row) throw new Error("binding not found");
  if (!row.telegram_chat_id) throw new Error("this binding is not paired to a chat yet");
  const token = readBindingToken(row);
  await telegramApi(token, "sendMessage", { chat_id: row.telegram_chat_id, text }, opts);
  return true;
}

function removeBinding(db, id) {
  const bindingId = assertTelegramBindingId(id);
  const row = getBinding(db, bindingId);
  if (!row) throw new Error("binding not found");
  const file = tokenFile(bindingId, { create: false });
  let tokenExists = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Telegram token target is unsafe");
    tokenExists = true;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (Number(row.token_saved) === 1 && !tokenExists) {
    throw new Error("this binding secret is not Terminal-owned; remove it from Agentlas Desktop so its keychain secret is cleaned up");
  }
  const tombstone = `${file}.${process.pid}.${crypto.randomUUID()}.delete`;
  if (tokenExists) fs.renameSync(file, tombstone);
  try {
    const removed = runWriteTransaction(db, () => {
      return db.prepare("DELETE FROM telegram_bindings WHERE id=?").run(bindingId).changes === 1;
    });
    if (!removed) throw new Error("binding disappeared before removal");
  } catch (error) {
    if (tokenExists) {
      try { if (!fs.existsSync(file)) fs.renameSync(tombstone, file); } catch { /* leave recoverable tombstone */ }
    }
    throw error;
  }
  if (tokenExists) fs.unlinkSync(tombstone);
  return true;
}

/*
 * 브라우저 조종으로 BotFather 토큰을 자동 포착 (2026-08-06).
 * 데스크탑 electron/telegram/connect.ts 의 readTelegramWebState 와 같은 방식:
 * 페이지 innerText 에서 봇 토큰 정규식을 읽는다. 데스크탑은 Electron
 * executeJavaScript, 여기서는 CDP Runtime.evaluate — 동형. 봇 생성(/newbot)은
 * 열린 Agentlas Chrome 에서 사용자가 하거나 이미 만든 봇을 열면 되고, 토큰은
 * 터미널이 페이지에서 직접 읽어 복붙을 없앤다.
 *
 * 반환: 포착한 토큰 문자열 또는 null(시간초과). 브라우저(CDP)가 없으면
 * cdp_unavailable 로 던진다 — 호출자가 수동 토큰 경로로 안내.
 */
const BOTFATHER_WEB_URL = "https://web.telegram.org/k/#@BotFather";
const TOKEN_RE_SRC = "\\b\\d{8,12}:[A-Za-z0-9_-]{30,}\\b";

async function captureBotTokenViaBrowser({ timeoutMs = 180_000, onWait } = {}) {
  const cdp = require("../browser/cdp.cjs");
  if (!(await cdp.cdpReady())) {
    const err = new Error("Agentlas browser (CDP) is not running");
    err.code = "cdp_unavailable";
    throw err;
  }
  const page = await cdp.attachPage({ selection: "new" });
  try {
    await page.navigate(BOTFATHER_WEB_URL, { waitMs: 2500 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof onWait === "function") onWait();
      // 페이지 텍스트에서 마지막 토큰을 읽는다(가장 최근 발급).
      let token = null;
      try {
        token = await page.evalExpr(
          "(document.body && document.body.innerText ? document.body.innerText : '').match(/" + TOKEN_RE_SRC + "/g)?.slice(-1)[0] || null",
        );
      } catch { token = null; }
      if (token) return token;
      await new Promise((r) => setTimeout(r, 1200));
    }
    return null;
  } finally {
    await page.close({ closeTarget: true });
  }
}

module.exports = {
  telegramApi, verifyBotToken,
  startConnection, pairByPolling, sendTest, removeBinding,
  listBindings, getBinding,
  saveToken, readToken, deleteToken, tokenFingerprint,
  captureBotTokenViaBrowser, BOTFATHER_WEB_URL,
};
