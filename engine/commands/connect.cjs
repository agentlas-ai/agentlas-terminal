"use strict";
/*
 * connect — Telegram 등 플랫폼 연결 상태 (2026-08-06 로컬화).
 *
 * 이전: `connect <sub>` 는 Hephaestus 플러그인으로 패스스루(cmdHep(["hep-connect",…]))
 * 해서, `connect telegram` 이 라우터 원시 JSON(hub_candidates)을 사용자에게 그대로
 * 덤프했다 — build 스텁과 같은 계열의 결함. 플러그인을 강제하고, 사람에게 기계
 * 내부를 보여줬다.
 *
 * 지금: 로컬 telegram 바인딩 상태를 사람 표로 보여준다. 봇 발급·페어링(쓰기)은
 * 아직 Desktop Connect 소관이라 그 사실을 정직하게 고지한다 — 단, 원시 JSON은
 * 절대 내지 않는다.
 */
const { renderTelegram } = require("./telegram.cjs");

function usage(ko) {
  return ko
    ? "사용법: agentlas connect [status | telegram]"
    : "Usage: agentlas connect [status | telegram]";
}

async function run(ctx, args) {
  const sub = String(args[0] || "").toLowerCase();
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    ctx.out(usage(ctx.lang === "ko"));
    return 0;
  }
  if (sub === "status" || sub === "telegram") {
    return renderTelegram(ctx);
  }
  ctx.err(usage(ctx.lang === "ko"));
  return 1;
}

module.exports = { run };
