"use strict";
/* chat — 에이전트 지정 REPL 진입 별칭: agentlas chat <agent> (= agentlas <agent>) */
function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (!args[0]) {
    ctx.err(ko ? "사용법: agentlas chat <agent>" : "Usage: agentlas chat <agent>");
    return 1;
  }
  const { startRepl } = require("../ui/repl.cjs");
  return startRepl(ctx, { agent: args[0] });
}
module.exports = { run };
