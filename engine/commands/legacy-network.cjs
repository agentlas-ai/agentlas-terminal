"use strict";
/*
 * legacy-network — 호환 전용 Hephaestus 네트워크 경로 (명시적 탈출구).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas legacy-network "<request>"` → cmdHep(["hep-network", ...rest])
 *
 * 오너 결정 배경: 기본 `network`/`workforce`는 host-LLM Agent Workforce
 * Ontology(fail-closed) 경로다. 구 Hephaestus hep-network 라우터는 이
 * "legacy-" 접두 명령으로만, 사용자가 이름으로 정확히 지목했을 때만 연다.
 * 절대 기본 경로의 폴백으로 쓰지 않는다.
 *
 * v1 가드 그대로: help 토큰 → usage 0, 무인자 → usage 실패 exit 1.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("legacy-network", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("legacy-network", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-network", ...args]);
}

module.exports = { run };
