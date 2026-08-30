"use strict";
/*
 * hep — 전체 Hephaestus 네이티브 패스스루 (v1 cmdHep 이식).
 *
 * v1 디스패처 계약 그대로:
 *   - `agentlas hep` (무인자)      → HEP_USAGE 출력, exit 0
 *   - `agentlas hep help|--help`   → 짧은 usage 한 줄, exit 0
 *     (v1 사전 가드: 리터럴 --help가 Hub/Cloud 라우팅 쿼리로 새는 것을 막는
 *      로컬·무네트워크 처리 — MCP 키워드 선택 사고 계열의 방어선이다.)
 *   - 그 외                        → runHephaestusInteractive 인자 그대로 전달,
 *                                    자식 exit code 반환. 런타임 부재 = 정직 정지 1.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.length === 1 && isHelpToken(args[0])) {
    ctx.out(usageFor("hep", ctx.lang));
    return 0;
  }
  return create(ctx).cmdHep(args);
}

module.exports = { run };
