"use strict";
/*
 * hep-local — 이 머신에 등록된 Local 에이전트만으로 임시 태스크포스 편성.
 *
 * WHY 이 파일이 따로 있는가 (2026-07-28 수리):
 *   COMMAND_ALIASES 가 `hep-local → workforce` 로 접혀 있었다. 터미널 workforce 는
 *   공개 Hub 메뉴로 스태핑하는 Agent Workforce Ontology 경로이고(엔드포인트:
 *   AGENTLAS_MCP_BASE_URL, search_candidates 스키마에 sourceScope 자체가 없음),
 *   cmdWorkforce 는 스코프 플래그를 받지 않는다. 즉 "등록된 로컬만" 이라고
 *   문서화된 명령이 조용히 Local+Cloud+공개 Hub 전체로 넓혀 실행됐다 —
 *   사용자가 의도하지 않은 Hub 크레딧 소모까지 포함해서. 스코프는 이름의 전부다.
 *   스코프를 지킬 수 있는 표면은 Hephaestus 네이티브 런타임(`hephaestus hep-local`)
 *   뿐이므로, build/call/legacy-network 와 동일한 패스스루 계약으로 그쪽에 넘긴다.
 *
 * v1 인자 가드 그대로: help 토큰 → usage 0, 무인자 → usage 실패 exit 1
 * (요청 문자열 없는 호출이 자연어 라우팅으로 새는 것 방지).
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("hep-local", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("hep-local", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-local", ...args]);
}

module.exports = { run };
