"use strict";
/*
 * research — Research Engine (status|gather|search|read|plan).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas research <sub…>` → cmdHep(["research", ...rest])
 *   → runHephaestusInteractive가 research를 사람용 렌더러
 *     (runHephaestusResearch, --json 원본 모드 포함)로 넘긴다.
 *
 * v1 가드 그대로:
 *   - help 토큰 → 로컬 usage가 아니라 Hephaestus 네이티브 help 패스스루
 *     (v1: parity().cmdHep(null, ["research", ...rest]) 특례).
 *   - 첫 인자가 status|gather|search|read|plan 밖 → usage 실패 exit 1
 *     (자연어가 리서치 서브커맨드 자리로 새는 것 방지; ko 문구 v1 그대로).
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

const RESEARCH_SUBCOMMANDS = ["status", "gather", "search", "read", "plan"];

async function run(ctx, args) {
  const runtime = create(ctx);
  if (args.some(isHelpToken)) {
    return runtime.cmdHep(["research", ...args]);
  }
  if (!RESEARCH_SUBCOMMANDS.includes(args[0])) {
    ctx.err(
      "✖ " + (ctx.lang === "ko"
        ? "사용법: agentlas research <status|gather|search|read|plan> [인자]"
        : usageFor("research", ctx.lang)),
    );
    return 1;
  }
  return runtime.cmdHep(["research", ...args]);
}

module.exports = { run };
