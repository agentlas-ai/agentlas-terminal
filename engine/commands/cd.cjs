"use strict";
/* cd — 에이전트의 로컬 폴더 경로만 출력 (읽기 전용; cd "$(agentlas cd <agent>)" 용). */
const { findAgent } = require("../agents/registry.cjs");
const { routeForAgent } = require("../agents/routes.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (!args[0]) {
    ctx.err(ko ? "사용법: agentlas cd <agent>" : "Usage: agentlas cd <agent>");
    return 1;
  }
  const agent = findAgent(ctx.db(), args[0]);
  if (!agent) {
    ctx.err((ko ? "에이전트를 찾을 수 없음: " : "agent not found: ") + args[0]);
    return 1;
  }
  const route = routeForAgent(agent.id);
  if (!route || !route.path) {
    ctx.err(ko
      ? `${agent.slug} 은(는) 로컬 폴더가 없습니다 (import된 에이전트만 폴더를 가집니다).`
      : `${agent.slug} has no local folder (only imported agents do).`);
    return 1;
  }
  ctx.out(route.path);
  return 0;
}

module.exports = { run };
