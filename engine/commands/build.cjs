"use strict";
/*
 * build — 에이전트/팀 빌드·수리·패키징 (hep-build 라우트).
 *
 * v1 디스패처 검증 메모 (legacy-v1-engine-snapshot engine/agentlas.cjs ~13097):
 *   v1의 `agentlas build`는 hep-build 단순 패스스루가 아니라 터미널 소유
 *   빌더(terminalAssets.cmdBuild: 시스템 MCP 메타데이터 프리플라이트 → 1회
 *   동의 → Meta-Agent 실행)로 갔다. 그 프리플라이트/빌더 체인은 engine/mcp/*
 *   와 빌더 서브시스템 소유라 이 클러스터의 범위 밖이다.
 *   v2의 이 파일은 v1 도움말이 계약으로 명시한 표면 —
 *   `build "<request>" … (hep-build)` — 즉 Agentlas OS hep-build 라우트를
 *   그대로 노출한다. 터미널 소유 MCP-동의 빌더가 v2에 재구축되면 그 모듈이
 *   이 명령을 대체(또는 선행)해야 한다.
 *
 * v1 인자 가드 그대로:
 *   - help 토큰 → usage 출력, exit 0
 *   - 무인자   → usage 실패, exit 1 (요청 문자열이 라우터로 새는 것 방지)
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("build", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("build", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-build", ...args]);
}

module.exports = { run };
