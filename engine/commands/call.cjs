"use strict";
/*
 * call — 지정한 Hub/Cloud 에이전트 호출·준비 (hep-call 라우트).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas call "a,b" "<맥락>"` → cmdHep(["hep-call", ...rest])
 *   무인자 → usage 실패 exit 1 (missingArgumentUsage 가드 — 슬러그 없는
 *   호출이 자연어 라우팅으로 새는 것 방지).
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.length === 1 && isHelpToken(args[0])) {
    ctx.out(usageFor("call", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("call", ctx.lang));
    return 1;
  }
  // 과금 사전 고지 — 가격은 서버가 청구 시 확정하므로 숫자를 지어내지 않는다.
  ctx.out(ctx.lang !== "en"
    ? "ℹ 공개 Hub 에이전트·팀 호출은 크레딧이 소모됩니다(활성 장기대여 중에는 0). 잔액 확인: agentlas billing"
    : "ℹ Public Hub agent/team calls consume credits (0 while a day-lease is active). Check balance: agentlas billing");
  return create(ctx).cmdHep(["hep-call", ...args]);
}

module.exports = { run };
