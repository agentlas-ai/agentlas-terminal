"use strict";
/*
 * project — 프로젝트 상태·초기화, 그리고 순서 팀 편성 (독립).
 *
 * 2026-08-06(오너 원칙): 데스크탑/플러그인은 산출물·설정을 공유할 뿐 선행 전제가
 * 아니다. 그래서 `project team`·`project use`로 터미널에서 직접 폴더를 프로젝트로
 * 연결하고 컨트롤러 팀을 정한다 — 이후 `run "<task>"`와 REPL 평문 입력이 데스크탑
 * 없이 동작한다. 프로젝트 쓰기는 engine/project/team.cjs가 소유(스키마 공유).
 */
const { projectCwd } = require("../project/paths.cjs");
const {
  ensureTerminalProjectForExecutionCli,
  initializeTerminalProjectCli,
} = require("../project/state.cjs");
const { connectProjectTeam } = require("../project/team.cjs");
const { resolveProjectController } = require("../project/controller.cjs");

function showStatus(ctx, cwd, ko) {
  const active = ensureTerminalProjectForExecutionCli(ctx.db(), cwd, "read", "terminal-project-status");
  ctx.out(`${ko ? "프로젝트 폴더" : "project"}: ${cwd}`);
  ctx.out(`${ko ? ".agentlas 상태" : "Agentlas state"}: ${active
    ? (ko ? "초기화됨" : "initialized")
    : (ko ? "초기화되지 않음" : "not initialized")}`);
  // 연결된 프로젝트 + 순서 팀(컨트롤러)을 보여준다 — 데스크탑 없이도 무엇이 실행될지.
  try {
    const resolved = resolveProjectController(ctx.db(), cwd);
    const pool = resolved.project?.agentPool || [];
    ctx.out(`${ko ? "연결된 프로젝트" : "connected project"}: ${resolved.project?.name || "—"}`);
    if (pool.length) {
      ctx.out(ko ? "순서 팀 (0번=컨트롤러):" : "ordered team (index 0 = controller):");
      pool.forEach((m, i) => ctx.out(`  ${i}. ${m.nameSnapshot}`));
    }
  } catch (e) {
    if (e && e.code === "project_not_connected") {
      ctx.out(ctx.ui.dim(ko
        ? "이 폴더는 아직 프로젝트에 연결되지 않았습니다. `agentlas project use <에이전트>`로 연결하세요."
        : "This folder is not connected to a project yet. Connect it with `agentlas project use <agent>`."));
    } else if (e && e.honestStop) {
      ctx.out(ctx.ui.dim(String(e.message)));
    }
    // 그 외 오류는 status를 막지 않는다.
  }
  return 0;
}

function reportTeam(ctx, result, ko) {
  ctx.out(`${ctx.ui.green("✓")} ${ko ? "프로젝트" : "project"} ${result.created ? (ko ? "생성" : "created") : (ko ? "갱신" : "updated")}: ${result.name}`);
  ctx.out(ko ? "순서 팀 (0번=컨트롤러):" : "ordered team (index 0 = controller):");
  result.team.forEach((m, i) => ctx.out(`  ${i}. ${m.nameSnapshot}`));
  ctx.out(ctx.ui.dim(ko
    ? "이제 이 폴더에서 바로 실행: agentlas run \"<할 일>\"  또는 REPL에서 그냥 문장을 치세요."
    : "Now run here directly: agentlas run \"<task>\"  or just type a sentence in the REPL."));
}

function run(ctx, args) {
  const action = String(args[0] || "status").toLowerCase();
  const cwd = projectCwd();
  const ko = ctx.lang === "ko";

  if (action === "status") return showStatus(ctx, cwd, ko);

  if (action === "init") {
    ctx.out(ko
      ? "비공개 Agentlas 프로젝트 상태를 초기화합니다. .agentlas/ 생성, .gitignore 갱신, 로컬 자격증명·서명 템플릿 추가가 포함될 수 있습니다."
      : "Initializing private Agentlas project state. This may create .agentlas/, update .gitignore, and add local credential/signing templates.");
    try {
      initializeTerminalProjectCli(ctx.db(), cwd);
    } catch (e) {
      ctx.err(String((e && e.message) || e));
      return 1;
    }
    ctx.out(`${ko ? "초기화됨" : "Initialized"}: ${cwd}`);
    return 0;
  }

  /*
   * project use <에이전트>            — 이 폴더를 프로젝트로 연결 + 단일 컨트롤러 팀
   * project team <에이전트> [<에이전트>...] — 순서 팀 편성 (0번=컨트롤러)
   * 둘 다 데스크탑 없이 동작한다.
   */
  if (action === "use" || action === "team") {
    const tokens = args.slice(1).filter((t) => t && !String(t).startsWith("-"));
    if (!tokens.length) {
      ctx.err(ko
        ? `사용법: agentlas project ${action} <에이전트> ${action === "team" ? "[<에이전트>...]" : ""}  ·  에이전트 목록: agentlas list`
        : `Usage: agentlas project ${action} <agent> ${action === "team" ? "[<agent>...]" : ""}  ·  list agents: agentlas list`);
      return 1;
    }
    try {
      const result = connectProjectTeam(ctx.db(), cwd, tokens, {});
      reportTeam(ctx, result, ko);
      return 0;
    } catch (e) {
      if (e && e.code === "team_agent_not_found") {
        ctx.err((ko ? "에이전트를 찾을 수 없습니다: " : "agent not found: ") + e.token);
        ctx.err(ctx.ui.dim(ko ? "설치된 에이전트: agentlas list" : "installed agents: agentlas list"));
        return 1;
      }
      ctx.err(String((e && e.message) || e));
      return 1;
    }
  }

  ctx.err(ko
    ? "사용법: agentlas project [status | init | use <에이전트> | team <에이전트>...]"
    : "Usage: agentlas project [status | init | use <agent> | team <agent>...]");
  return 1;
}

module.exports = { run };
