"use strict";
/* cd — 에이전트의 로컬 폴더 경로만 출력 (읽기 전용; cd "$(agentlas cd <agent>)" 용). */
const { findAgent } = require("../agents/registry.cjs");
const { agentFolder } = require("../agents/files.cjs");

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
  // 경로 조회 전용 — cd "$(agentlas cd seo)" 가 소스 패키지를 변형/재분류하면 안 된다.
  ctx.out(agentFolder(agent));
  return 0;
}

module.exports = { run };
