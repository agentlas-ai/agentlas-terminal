"use strict";
/*
 * hep-hub — 공개 Agentlas Hub 에이전트만으로 임시 태스크포스 편성.
 *
 * WHY 이 파일이 따로 있는가 (2026-07-28 수리):
 *   COMMAND_ALIASES 가 `hep-hub → search` 로 접혀 있었다. search 는 스태핑이 아니라
 *   마켓플레이스 디렉터리 나열이고(그마저 Cloud+Hub 혼합 표면이다), 실행은 하지
 *   않는다. 그래서 `agentlas hep-hub "<과제>"` 는 과제를 검색어로 읽고 슬러그
 *   목록만 찍은 뒤 exit 0 — 아무것도 실행하지 않고 성공한 척했다(가짜 성공 금지).
 *   공개 Hub 한정 스태핑을 실제로 수행하는 표면은 Hephaestus 네이티브 런타임
 *   (`hephaestus hep-hub`)이므로 그쪽에 그대로 넘긴다. 후보만 보고 싶으면
 *   기존 `agentlas search`(=hep-search)가 그대로 남아 있다.
 *
 * v1 인자 가드 그대로: help 토큰 → usage 0, 무인자 → usage 실패 exit 1.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("hep-hub", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("hep-hub", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-hub", ...args]);
}

module.exports = { run };
