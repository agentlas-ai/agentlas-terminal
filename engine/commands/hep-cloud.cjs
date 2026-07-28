"use strict";
/*
 * hep-cloud — 로그인한 오너의 Agent Cloud 에이전트만으로 임시 태스크포스 편성.
 *
 * WHY 이 파일이 따로 있는가 (2026-07-28 수리):
 *   COMMAND_ALIASES 가 `hep-cloud → cloud` 로 접혀 있었다. `cloud` 는 이름만 같은
 *   전혀 다른 명령 — 클라우드 자산 보관함(save|publish|package|list|restore|
 *   install|delete|field-test)이다. 그래서 `agentlas hep-cloud "<과제>"` 는
 *   과제를 서브커맨드로 읽고 `usage: agentlas cloud <save|…>` 를 뱉으며 exit 1 —
 *   hep-cloud 를 한 글자도 언급하지 않는 에러라 사용자에게 다음 수가 없었다.
 *   스코프(오너 Cloud 한정)를 실제로 지키는 표면은 Hephaestus 네이티브 런타임
 *   (`hephaestus hep-cloud`)뿐이므로 build/call/legacy-network 와 동일한
 *   패스스루 계약으로 그쪽에 넘긴다. 자산 보관함은 계속 `agentlas cloud …` 다.
 *
 * v1 인자 가드 그대로: help 토큰 → usage 0, 무인자 → usage 실패 exit 1.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("hep-cloud", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("hep-cloud", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-cloud", ...args]);
}

module.exports = { run };
