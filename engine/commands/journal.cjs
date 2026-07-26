"use strict";
/*
 * journal — Stormbreaker 런 저널 (status|verify|repair|gate).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas journal <sub…>` → cmdHep(["stormbreaker", "journal", ...rest])
 *
 * v1 가드 그대로:
 *   - help 토큰 → usage, exit 0
 *   - `journal status`에 --run-id/--journal 둘 다 없으면 → usage 실패 exit 1
 *     (대상 없는 status가 네이티브에서 모호하게 도는 것 방지)
 *   - 무인자는 v1처럼 가드 없이 패스스루 — 네이티브 usage가 나온다.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("journal", ctx.lang));
    return 0;
  }
  if (
    args[0] === "status"
    && !args.slice(1).some((value) => value === "--run-id" || value === "--journal")
  ) {
    ctx.err("✖ " + usageFor("journal", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["stormbreaker", "journal", ...args]);
}

module.exports = { run };
