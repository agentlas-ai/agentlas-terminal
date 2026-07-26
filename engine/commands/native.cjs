"use strict";
/* native — 네이티브 CLI 문맥 파일 명시 생성: agentlas native prepare <agent> */
const { findAgent } = require("../agents/registry.cjs");
const { agentFolder, ensureNativeFiles } = require("../agents/files.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const sub = String(args[0] || "help");
  const query = args[1];
  if (sub === "help" || sub === "--help" || sub === "-h") {
    ctx.out(ko
      ? "사용법: agentlas native prepare <에이전트>  ·  네이티브 CLI 문맥 파일을 명시적으로 생성"
      : "usage: agentlas native prepare <agent>  ·  explicitly create native CLI context files");
    return 0;
  }
  if (sub !== "prepare" || !query) {
    ctx.err(ko ? "사용법: agentlas native prepare <에이전트>" : "usage: agentlas native prepare <agent>");
    return 1;
  }
  const agent = findAgent(ctx.db(), query);
  if (!agent) {
    ctx.err(ko ? `에이전트를 찾지 못했습니다: ${query}` : `Agent not found: ${query}`);
    return 1;
  }
  const folder = agentFolder(agent);
  const created = ensureNativeFiles(agent, folder);
  ctx.out(`${ko ? "네이티브 CLI 문맥" : "Native CLI context"}: ${folder}`);
  ctx.out(created.length
    ? `${ko ? "생성됨" : "Created"}: ${created.join(", ")}`
    : (ko ? "변경 없음: 필요한 파일이 이미 있습니다." : "No changes: the context files already exist."));
  return 0;
}

module.exports = { run };
