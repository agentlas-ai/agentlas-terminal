"use strict";
/*
 * install — `agentlas install <slug>`: Hub 에이전트 소스 설치.
 * 기능 로직은 전부 hub/install.cjs에 있다. 여기서는 인자 검증 + 출력만.
 * 오류는 ctx.err로 출력하고 1을 반환한다 (모듈 안 process.exit 금지).
 */
const { installHubAgent } = require("../hub/install.cjs");

async function run(ctx, args) {
  const slug = (args[0] || "").trim();
  if (!slug) {
    ctx.err("usage: agentlas install <slug>");
    return 1;
  }
  let agent;
  try {
    agent = await installHubAgent(ctx.db(), slug);
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  ctx.out(`${ctx.ui.green("✓")} Hub installed ${ctx.ui.accent(agent.slug)} — ${agent.name}`);
  if (agent.localPath) ctx.out(ctx.ui.dim(`  files: ${agent.localPath}`));
  return 0;
}

module.exports = { run };
