"use strict";
/*
 * memory — 레거시 마크다운 메모리 → 공유 agentlas.sqlite 이관 (Phase 1b).
 *   agentlas memory import <folder-or-file> --agent <agentId> [--apply]
 * 기본은 dry-run 프리뷰, --apply 일 때만 쓴다. 로직은 복원된 계약 모듈
 * engine/agentlas-memory-import.cjs 가 소유한다(여기서는 주입만).
 * v1의 fail(process.exit)은 v2에서 throw 로 바꿔 엔진이 stderr+exit 1 처리한다.
 */
const { cmdMemory } = require("../agentlas-memory-import.cjs");

function run(ctx, args) {
  cmdMemory({
    db: ctx.db(),
    args,
    out: ctx.out,
    fail: (msg) => { throw new Error(String(msg ?? "")); },
  });
  return 0;
}

module.exports = { run };
