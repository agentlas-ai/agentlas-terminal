"use strict";
/*
 * variant — 로컬 자문 variant 해소 프리뷰.
 *   agentlas variant resolve [candidates.json] [--base-release <id>] [--prefer <id>] [--json]
 * 로직은 engine/experience/variant.cjs (v1 cmdVariant 이식) 가 소유한다.
 * 결정 어휘 selected|fallback|base-only|error 는 계약 — 변경 금지.
 * decision=error 는 v1과 동일하게 exit 2 로 끝난다(0/1과 구분되는 자문 오류).
 */
const { userDataDir } = require("../core/paths.cjs");
const { cmdVariant } = require("../experience/variant.cjs");

function run(ctx, args) {
  let code = 0;
  // The dispatcher consumes global output flags before invoking a command.
  // Preserve the legacy variant parser's JSON switch at this boundary so the
  // command cannot fall back to a human error/usage stream when callers use
  // the common `--json` contract.
  const commandArgs = ctx.output?.format === "json" && !args.includes("--json")
    ? [...args, "--json"]
    : args;
  cmdVariant({
    db: ctx.db(),
    args: commandArgs,
    userDataDir: userDataDir(),
    cwd: process.cwd(),
    out: ctx.out,
    setExitCode: (value) => { code = value; },
  });
  return code;
}

module.exports = { run };
