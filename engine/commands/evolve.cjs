"use strict";
/*
 * evolve — 데스크탑 트리거가 만든 성장 제안 검토·적용·되돌리기 (Phase 2/2+).
 *   agentlas evolve [list | apply <id> | revert <id>]
 * 로직은 복원된 계약 모듈 engine/agentlas-evolution.cjs 가 소유한다.
 * 적용/되돌리기 게이트는 타깃 파일 내용 해시(before_hash/after_hash)로만
 * 판정한다 — 이 콘텐츠 해시 게이트는 계약이므로 여기서 절대 우회하지 않는다.
 */
const { cmdEvolve } = require("../agentlas-evolution.cjs");
const { agentFolder } = require("../agents/files.cjs");

function run(ctx, args) {
  cmdEvolve({
    db: ctx.db(),
    args,
    out: ctx.out,
    fail: (msg) => { throw new Error(String(msg ?? "")); },
    agentFolder,
  });
  return 0;
}

module.exports = { run };
