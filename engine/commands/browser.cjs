"use strict";
/*
 * browser — 실제 브라우저 실행 하드포인트 (hep-browser 라우트).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas browser <url-or-query|sub…>` → cmdHep(["hep-browser", ...rest])
 *   v1은 browser에 무인자 가드가 없었다(missingArgumentUsage 미포함) —
 *   무인자도 hep-browser 패스스루로 넘어가 네이티브 usage가 나온다. 보존.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("browser", ctx.lang));
    return 0;
  }
  return create(ctx).cmdHep(["hep-browser", ...args]);
}

module.exports = { run };
