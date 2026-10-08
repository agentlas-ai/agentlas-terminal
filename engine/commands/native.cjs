"use strict";
/* native — 네이티브 CLI 문맥 파일 명시 생성: agentlas native prepare <agent> */
const { findAgent } = require("../agents/registry.cjs");

async function run(ctx, args) {
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
        "                             네이티브 CLI 문맥 파일 변경안을 준비",
        "",
        "  변경안만 준비합니다. 실제 파일 적용에는 검토와 승인이 필요합니다.",
        "  에이전트 이름은 agentlas list 에서 확인합니다.",
      ].join("\n")
      : [
        "agentlas native — native CLI context files",
        "  native prepare <agent>     prepare changes to native CLI context files",
        "                             (CLAUDE.md, AGENTS.md, …) in the agent folder",
        "",
        "  This prepares a file-change proposal for review. Owner approval is required",
        "  before applying it. Find agent names via: agentlas list",
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
  const service = require("../agent-workspace.cjs").workspaceService();
  const workspace = await service.getAgentWorkspace(agent.id);
  if (!workspace.canonicalEntry) throw new Error("agent_instruction_entry_required");
  const entry = await service.readAgentWorkspaceFile(agent.id, workspace.canonicalEntry);
  const expected = workspace.files.find((file) => file.path === workspace.canonicalEntry);
  if (!expected || entry.binary || entry.blobHash !== expected.blobHash) throw new Error("agent_revision_changed: refresh the file proposal");
  const sys = entry.content;
  const changes = ["system-prompt.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]
    .filter((name) => !workspace.files.some((file) => file.path === name))
    .map((name) => ({ path: name, afterContent: sys.endsWith("\n") ? sys : sys + "\n" }));
  if (!changes.length) { ctx.out(ko ? "변경 없음" : "No changes"); return 0; }
  const result = await service.prepareAgentWorkspaceProposal({
    agentId: agent.id, changes, expectedBaseTreeDigest: workspace.treeDigest, summary: "Prepare native instruction files",
  });
  ctx.out(JSON.stringify(result, null, 2));
  ctx.out(ko ? "실제 파일 변경안을 Agent Workspace에서 검토하고 승인하세요." : "Review and approve the actual file diff in Agent Workspace.");

  return 0;
}

module.exports = { run };
