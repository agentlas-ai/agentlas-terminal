"use strict";
/* native — 네이티브 CLI 문맥 파일 명시 생성: agentlas native prepare <agent> */
const { findAgent } = require("../agents/registry.cjs");
const { agentFolder, ensureNativeFiles } = require("../agents/files.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const sub = String(args[0] || "help");
  const query = args[1];
  if (sub === "help" || sub === "--help" || sub === "-h") {
    if (args.length > 1) {
      ctx.err(ko ? "사용법: agentlas native help" : "usage: agentlas native help");
      return 1;
    }
    // SELF_HELP_COMMANDS 계약: --help 는 스텁이 아니라 실제 안내여야 한다 —
    // 무엇이 만들어지고 언제 필요한지까지 말한다.
    ctx.out(ko
      ? [
        "agentlas native — 네이티브 CLI 문맥 파일 관리",
        "  native prepare <에이전트>   에이전트 폴더에 CLAUDE.md·AGENTS.md 등",
        "                             네이티브 CLI 문맥 파일을 명시적으로 생성",
        "",
        "  보통은 실행 시 자동 준비됩니다. 파일을 직접 확인·수정하고 싶을 때 쓰세요.",
        "  에이전트 이름은 agentlas list 에서 확인합니다.",
      ].join("\n")
      : [
        "agentlas native — native CLI context files",
        "  native prepare <agent>     explicitly create the native CLI context files",
        "                             (CLAUDE.md, AGENTS.md, …) in the agent folder",
        "",
        "  Normally these are prepared automatically on run. Use this when you want",
        "  to inspect or edit the files directly. Find agent names via: agentlas list",
      ].join("\n"));
    return 0;
  }
  if (sub !== "prepare" || !query || args.length !== 2) {
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
