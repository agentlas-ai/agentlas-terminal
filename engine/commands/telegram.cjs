"use strict";
/* telegram — 바인딩 현황 (읽기 전용). 페어링·봇 발급은 아직 Desktop Connect 소관. */

const {
  DEFAULT_OPTIONS,
  list: outputList,
  render,
  parseOutputFlags,
  displayWidth,
  terminalTextOf,
} = require("../cli-output.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

function withOutputFlags(ctx, args) {
  if (!args.some((arg) => OUTPUT_FLAGS.has(arg))) return { ctx, args };
  const parsed = parseOutputFlags(args);
  return {
    ctx: { ...ctx, output: { ...(ctx.output || DEFAULT_OPTIONS), ...parsed.options } },
    args: parsed.rest,
  };
}

function outputOptions(ctx) {
  return { ...DEFAULT_OPTIONS, ...(ctx.output || {}) };
}

function isMachineOutput(ctx) {
  const output = outputOptions(ctx);
  return output.quiet || output.format === "json" || output.format === "yaml";
}

/*
 * DB 값은 사용자가 설정할 수 있는 텍스트다. 표·로그·파이프 어느 경로로도
 * ANSI, 개행, C0/C1 제어문자가 흘러가면 안 되므로 구조화 전에 한 번 정리한다.
 * 길이도 고정해 손상된 DB 값이 터미널 출력을 무한히 키우지 못하게 한다.
 */
function safeCell(value, maxLength = 4096) {
  return terminalTextOf(value == null ? "" : value, maxLength);
}

function rowData(row) {
  const chatId = safeCell(row.telegram_chat_id, 512);
  return {
    id: safeCell(row.id, 256),
    targetKind: safeCell(row.target_kind, 256),
    targetId: safeCell(row.target_id, 1024),
    botUsername: safeCell(row.bot_username, 512),
    chatTitle: safeCell(row.telegram_chat_title, 4096),
    chatId,
    status: safeCell(row.status || (chatId ? "paired" : "pending"), 256),
  };
}

function padCell(value, width) {
  const text = safeCell(value, Math.max(1, width * 4));
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function truncateCell(value, width) {
  const text = safeCell(value, Math.max(1, width * 4));
  let result = "";
  let used = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result;
}

function telegramSchema(en) {
  return Object.freeze({
    idField: "id",
    columns: [
      { header: "id", field: "id" },
      { header: en ? "target" : "대상", field: (row) => `${row.targetKind}:${row.targetId}` },
      { header: en ? "bot" : "봇", field: (row) => row.botUsername ? `@${row.botUsername}` : "(bot not set)" },
      { header: en ? "chat" : "채팅", field: (row) => row.chatTitle || row.chatId || "(chat not connected)" },
      { header: en ? "status" : "상태", field: "status" },
    ],
    renderHuman(result) {
      const rows = Array.isArray(result.data) ? result.data : [];
      if (!rows.length) return en ? "No Telegram bindings." : "Telegram 연결이 없습니다.";
      return rows.map((row) => {
        const bot = row.botUsername ? `@${row.botUsername}` : "(bot not set)";
        const chat = row.chatTitle || row.chatId || "(chat not connected)";
        const target = `${truncateCell(row.targetKind, 64)}:${padCell(truncateCell(row.targetId, 20), 21)}`;
        return `${truncateCell(row.id, 8)}  ${target} ${padCell(truncateCell(bot, 24), 24)} ${padCell(truncateCell(chat, 28), 29)} ${truncateCell(row.status, 256)}`;
      }).join("\n") + "\n";
    },
  });
}

function emit(ctx, result) {
  if (typeof ctx.emit === "function") {
    ctx.emit(result);
    return;
  }
  const text = render(result, outputOptions(ctx));
  if (text) ctx.out(text);
}

/*
 * 바인딩 표를 그린다. connect.cjs 도 같은 표를 쓰도록 공용화(2026-08-06):
 * 예전 `connect telegram` 은 Hephaestus 플러그인으로 패스스루해 원시 라우터
 * JSON(hub_candidates)을 사용자에게 그대로 덤프했다 — build 스텁과 같은 계열.
 */
function renderTelegram(ctx) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  let rows;
  try {
    rows = db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all().map(rowData);
  } catch {
    rows = [];
  }
  const options = outputOptions(ctx);
  const result = outputList(rows, telegramSchema(!ko));
  if (isMachineOutput(ctx)) {
    emit(ctx, result);
    const note = ko
      ? "봇 발급·페어링은 현재 Agentlas Desktop Connect에서 수행합니다. 이 명령은 바인딩 상태를 보여줍니다."
      : "Bot issuance and pairing currently happen in Agentlas Desktop Connect. This command shows binding status.";
    if (typeof ctx.err === "function") ctx.err(options.noColor || !ctx.ui?.dim ? note : ctx.ui.dim(note));
    return 0;
  }
  emit(ctx, result);
  const note = ko
    ? "봇 발급·페어링은 현재 Agentlas Desktop Connect에서 수행합니다. 이 명령은 바인딩 상태를 보여줍니다."
    : "Bot issuance and pairing currently happen in Agentlas Desktop Connect. This command shows binding status.";
  ctx.out(options.noColor || !ctx.ui?.dim ? note : ctx.ui.dim(note));
  return 0;
}

function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  if (args.length) {
    const error = new Error("usage: agentlas telegram");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return renderTelegram(ctx);
}

module.exports = { run, renderTelegram };
