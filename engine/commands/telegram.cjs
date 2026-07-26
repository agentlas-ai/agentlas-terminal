"use strict";
/* telegram — 바인딩 현황 (읽기 전용). 페어링·봇 발급은 Desktop Connect 소관. */

function run(ctx) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  let rows;
  try {
    rows = db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all();
  } catch {
    rows = [];
  }
  if (!rows.length) {
    ctx.out(ko
      ? "Telegram 연결이 없습니다. Desktop Connect에서 기기를 연결하세요."
      : "No Telegram bindings. Pair devices from Desktop Connect.");
    return 0;
  }
  for (const r of rows) {
    const bot = r.bot_username ? "@" + r.bot_username : "(bot not set)";
    const chat = r.telegram_chat_title || r.telegram_chat_id || "(chat not connected)";
    const status = r.status || (r.telegram_chat_id ? "paired" : "pending");
    ctx.out(`${String(r.id).slice(0, 8)}  ${r.target_kind}:${String(r.target_id).slice(0, 20).padEnd(21)} ${String(bot).padEnd(24)} ${String(chat).slice(0, 28).padEnd(29)} ${status}`);
  }
  ctx.out("");
  ctx.out(ctx.ui.dim(ko
    ? "연결과 봇 발급은 Desktop Connect에서 수행하며, 이 명령은 상태만 보여줍니다."
    : "Pairing and bot issuance happen in Desktop Connect; this command only shows status."));
  return 0;
}

module.exports = { run };
