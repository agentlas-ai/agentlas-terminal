"use strict";
/*
 * connect — Telegram 등 플랫폼 연결 (hep-connect 라우트).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas connect <sub…>` → cmdHep(["hep-connect", ...rest])
 *   무인자 connect는 v1에서 fail이 아니라 usage 안내 후 exit 0이었다
 *   (topLevelCommandUsage("connect") 특례) — 그대로 보존.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken) || !args.length) {
    ctx.out(usageFor("connect", ctx.lang));
    return 0;
  }
  return create(ctx).cmdHep(["hep-connect", ...args]);
}

module.exports = { run };
