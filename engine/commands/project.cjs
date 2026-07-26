"use strict";
/*
 * project — 명시적 프로젝트 초기화/점검 (v1 monolith 13199–13223 포팅).
 *
 * 0.9.10 경계: `.agentlas/` 를 만드는 유일한 진입점은 `agentlas project init` 이다.
 * `project status` 는 완전 수동(파일 생성/DB visit 기록 없음)으로 검사만 한다.
 */
const { projectCwd } = require("../project/paths.cjs");
const {
  ensureTerminalProjectForExecutionCli,
  initializeTerminalProjectCli,
} = require("../project/state.cjs");

function run(ctx, args) {
  const action = String(args[0] || "status").toLowerCase();
  const cwd = projectCwd();
  const ko = ctx.lang === "ko";
  if (action === "status") {
    const active = ensureTerminalProjectForExecutionCli(ctx.db(), cwd, "read", "terminal-project-status");
    ctx.out(`${ko ? "프로젝트" : "project"}: ${cwd}`);
    ctx.out(`${ko ? "Agentlas 상태" : "Agentlas state"}: ${active
      ? (ko ? "초기화됨" : "initialized")
      : (ko ? "초기화되지 않음" : "not initialized")}`);
    if (!active) ctx.out(ko
      ? "비공개 .agentlas 상태와 로컬 제외 파일을 만들려면 `agentlas project init`을 실행하세요."
      : "Run `agentlas project init` to create private .agentlas state and update local ignore files.");
    return 0;
  }
  if (action === "init") {
    ctx.out(ko
      ? "비공개 Agentlas 프로젝트 상태를 초기화합니다. .agentlas/ 생성, .gitignore 갱신, 로컬 자격증명·서명 템플릿 추가가 포함될 수 있습니다."
      : "Initializing private Agentlas project state. This may create .agentlas/, update .gitignore, and add local credential/signing templates.");
    try {
      initializeTerminalProjectCli(ctx.db(), cwd);
    } catch (e) {
      // fail-closed: 프라이버시 경계(.gitignore/심볼릭 링크)를 보증 못 하면 생성 금지.
      ctx.err(String((e && e.message) || e));
      return 1;
    }
    ctx.out(`${ko ? "초기화됨" : "Initialized"}: ${cwd}`);
    return 0;
  }
  ctx.err("Usage: agentlas project [status|init]");
  return 1;
}

module.exports = { run };
