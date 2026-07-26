"use strict";
/*
 * netadmin — 로컬 에이전트 네트워크 관리 (init|status|reindex|bench|add-source).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas netadmin <sub…>` → cmdHep(["network", ...rest])
 *   (Hephaestus의 `network` 서브커맨드가 로컬 네트워크 admin이다.
 *    터미널의 `agentlas network`는 Workforce Ontology 경로로 따로 살고,
 *    netadmin이 그 이름 충돌을 피해 admin 표면만 노출한다.)
 *
 * v1 가드 그대로:
 *   - help 토큰 → usage, exit 0
 *   - 첫 인자가 init|status|reindex|bench|add-source 밖 → usage 실패 exit 1
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

const NETADMIN_SUBCOMMANDS = ["init", "status", "reindex", "bench", "add-source"];

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("netadmin", ctx.lang));
    return 0;
  }
  if (!NETADMIN_SUBCOMMANDS.includes(args[0])) {
    ctx.err("✖ " + usageFor("netadmin", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["network", ...args]);
}

module.exports = { run };
