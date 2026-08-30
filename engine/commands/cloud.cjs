"use strict";
/*
 * cloud — `agentlas cloud <sub> …`: Agent Cloud 자산 표면.
 * 기능 로직은 전부 cloud-assets/ 에 있다. 여기서는 위임 + 오류 → ctx.err + 1.
 */
const { runCloud } = require("../cloud-assets/commands.cjs");

async function run(ctx, args) {
  try {
    const commandArgs = ctx.output?.format === "json" && !args.includes("--json")
      ? [...args, "--json"]
      : args;
    return await runCloud(ctx, commandArgs);
  } catch (e) {
    if (typeof ctx.fail === "function") ctx.fail(e);
    else ctx.err(String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
