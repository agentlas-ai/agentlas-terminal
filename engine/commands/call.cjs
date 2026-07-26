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
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("call", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("call", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-call", ...args]);
}

module.exports = { run };
