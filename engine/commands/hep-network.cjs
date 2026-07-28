"use strict";
/*
 * hep-network — 등록된 Local + 오너 Cloud + 공개 Hub 를 연합해 임시 태스크포스 편성.
 *
 * WHY 이 파일이 따로 있는가 (2026-07-28 수리):
 *   COMMAND_ALIASES 가 `hep-network → workforce` 로 접혀 있었다. hep-local/hep-cloud/
 *   hep-hub 와 정확히 같은 결함이다 — 별칭은 이름만 바꿔주고 스코프는 어디에도
 *   전달하지 않는다. 터미널 workforce(cmdWorkforce)는 callHubTool 로
 *   AGENTLAS_MCP_BASE_URL(기본 https://agentlas.cloud/api/mcp/v1)을 직접 치고
 *   `{workOrder}` 만 보낸다(engine/agentlas-workforce.cjs:3043). 그 서버는
 *   sourceScope 가 없으면 "hub" 로 기본값을 잡는다
 *   (agentlas/AgentsAtlas/app/src/lib/mcp/workforce.ts:228). 결과:
 *
 *     - 로컬 에이전트와 오너 Cloud 에이전트는 후보 집합에 들어간 적이 없다.
 *     - 그런데 영수증의 로스터 핀은 전부 source:"hub" 로 기록된다
 *       (engine/workforce/deps.cjs). "네트워크 전량을 봤다" 로 읽힌다.
 *
 *   연합(federation)은 Core 가 소유한다: 세 소스 메뉴를 각각 받아 출처·계보를
 *   증명하고 하나의 CandidateSet 으로 합친 뒤, 선택은 호스트 LLM 이 한다. 터미널이
 *   Hub 를 직접 치는 경로에는 그 계층이 통째로 없다. 그래서 build/call/hep-local
 *   과 동일한 패스스루 계약으로 Hephaestus 네이티브 표면에 넘긴다.
 *
 *   `agentlas workforce` 자체는 남겨둔다 — 공개 Hub 스태핑을 그 이름으로 명시해
 *   부르는 것은 정직한 사용이다. 이름이 소스 스코프를 약속하는 hep-* 만 옮긴다.
 *
 * v1 인자 가드 그대로: help 토큰 → usage 0, 무인자 → usage 실패 exit 1
 * (요청 문자열 없는 호출이 자연어 라우팅으로 새는 것 방지).
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.some(isHelpToken)) {
    ctx.out(usageFor("hep-network", ctx.lang));
    return 0;
  }
  if (!args.length) {
    ctx.err("✖ " + usageFor("hep-network", ctx.lang));
    return 1;
  }
  return create(ctx).cmdHep(["hep-network", ...args]);
}

module.exports = { run };
