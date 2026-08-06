"use strict";
/* telegram — 바인딩 현황 (읽기 전용). 페어링·봇 발급은 아직 Desktop Connect 소관. */

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
    rows = db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all();
  } catch {
    rows = [];
  }
  if (!rows.length) {
    ctx.out(ko ? "Telegram 연결이 없습니다." : "No Telegram bindings.");
  } else {
    for (const r of rows) {
      const bot = r.bot_username ? "@" + r.bot_username : "(bot not set)";
      const chat = r.telegram_chat_title || r.telegram_chat_id || "(chat not connected)";
      const status = r.status || (r.telegram_chat_id ? "paired" : "pending");
      ctx.out(`${String(r.id).slice(0, 8)}  ${r.target_kind}:${String(r.target_id).slice(0, 20).padEnd(21)} ${String(bot).padEnd(24)} ${String(chat).slice(0, 28).padEnd(29)} ${status}`);
    }
    ctx.out("");
  }
  ctx.out(ctx.ui.dim(ko
    ? "봇 발급·페어링은 현재 Agentlas Desktop Connect에서 수행합니다. 이 명령은 바인딩 상태를 보여줍니다."
    : "Bot issuance and pairing currently happen in Agentlas Desktop Connect. This command shows binding status."));
  return 0;
}

function run(ctx) {
  return renderTelegram(ctx);
}

module.exports = { run, renderTelegram };
