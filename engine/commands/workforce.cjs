"use strict";
/*
 * commands/workforce — `agentlas workforce|network|taskforce <request>`.
 *
 * v1 모놀리스 디스패치(legacy-v1-engine-snapshot, engine/agentlas.cjs 13149행)의 포팅:
 *   case workforce/network/taskforce → workforce().cmdWorkforce(db, rest,
 *     runtimeOverride, { cwd, projectPath, permission })
 *
 * 라우팅 불변식: 이 표면은 Agent Workforce Ontology 전용 fail-closed 경로다.
 * 어휘 라우터로 조용히 폴백하지 않는다.
 *
 * 스코프 고지(2026-08-05): cmdWorkforce 는 sourceScope 를 싣지 않고
 * AGENTLAS_MCP_BASE_URL 을 직접 친다. 서버는 sourceScope 부재를 "hub" 로 잡으므로
 * 이 명령이 실제로 보는 메뉴는 **공개 Hub 뿐**이다. 로컬·오너 Cloud 를 포함한
 * 연합 편성은 MCP 호스트의 /hep-network 가 한다 — 이 표면에는 그 계층이 없어서
 * hep-network/hep-local/hep-cloud/hep-hub/legacy-network 를 전부 삭제했다.
 *
 * Write-capable first contact bootstraps the exact current project through the
 * canonical Core merge-only boundary. Read-only inspection remains passive.
 */
const { workforceRuntime } = require("../workforce/deps.cjs");
const { projectCwd } = require("../workforce/capture.cjs");
const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");

function resolvePermission(ctx) {
  // v1 resolveTerminalPermission 포팅: 저장된 `full` 은 세션 한정 계약이라
  // persistent()가 fail-closed 로 강등한다.
  try {
    const policy = require("../agentlas-permissions.cjs");
    return policy.persistent(ctx && ctx.prefs && ctx.prefs.permission, "write");
  } catch {
    return "write";
  }
}

/** `--runtime <kind>` 만 명령 자체 플래그로 벗겨낸다. 나머지는 cmdWorkforce 가 파싱. */
function splitRuntimeOverride(args) {
  const rest = [];
  let runtimeOverride = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--runtime" && args[i + 1]) {
      runtimeOverride = String(args[++i]);
      continue;
    }
    rest.push(args[i]);
  }
  return { rest, runtimeOverride };
}

/**
 * command 별 디스패치. commands/index.cjs 는 명령 이름을 별도 인자로 넘기지 않으므로
 * run()이 기본 "workforce" 로 진입하고, 별칭 배선 시 이 dispatch 를 직접 쓴다.
 */
async function dispatch(ctx, command, args) {
  switch (command) {
    case "workforce":
    case "network":
    case "taskforce": {
      const { rest, runtimeOverride } = splitRuntimeOverride(args);
      // usage 경로(작업 텍스트 없음)는 SQLite를 열 이유가 없다 — cmdWorkforce 의
      // parseArgs 와 동일한 판정: 플래그가 아닌 토큰이 하나도 없으면 빈 작업이다.
      const hasTask = rest.some((token, i) =>
        !["--benchmark", "--json", "--parallel", "-n"].includes(String(token))
        && !(i > 0 && ["--parallel", "-n"].includes(String(rest[i - 1]))));
      if (!hasTask) {
        ctx.err("usage: agentlas workforce <task> [--parallel N] [--benchmark] [--json] [--runtime <kind>]");
        return 1;
      }
      const db = ctx.db();
      const cwd = projectCwd();
      const permission = resolvePermission(ctx);
      const projectPath = ensureTerminalProjectForExecutionCli(
        db,
        cwd,
        permission,
        `terminal-${command}`,
      ) || cwd;
      const runtime = workforceRuntime({ lang: ctx.lang, out: ctx.out });
      const result = await runtime.cmdWorkforce(db, rest, runtimeOverride, {
        cwd,
        projectPath,
        permission,
      });
      return result && result.ok ? 0 : 1;
    }
    /*
     * 소스 스코프 편성 4종 — 2026-08-05 네이티브 배선.
     *
     * 역사: 7/28에 "별칭이 스코프를 버린다"를 고치며 hep-*를 외부 CLI 패스스루로
     * 승격했는데, 그 CLI는 exit 3 + host_llm_required만 반환하는 스텁이었다(8/5
     * 삭제). 재조사 결과 편성의 세 조각(4,578줄 루프·로컬 Core MCP·주입 지점)이
     * 전부 이 머신에 있었고, 빠진 것은 배선뿐이었다. 이제 이 표면이 직접
     * 호스트다: 루프의 리더 LLM이 WorkOrder를 작성하고, 로컬 Core가 선언된
     * 스코프의 메뉴를 연합하며, 같은 LLM이 정확 릴리스를 고른다.
     *
     * 폴백 금지: 로컬 Core가 없으면 원격 Hub로 조용히 내려가지 않는다 — 이름이
     * 약속한 스코프가 거짓이 된다(7/28 결함의 재발). 정직 정지 + 설치 안내.
     */
    case "hep-network":
    case "hep-local":
    case "hep-cloud":
    case "hep-hub": {
      const sourceScope = command.slice(4); // network|local|cloud|hub
      const ko = ctx.lang !== "en";
      const { rest, runtimeOverride } = splitRuntimeOverride(args);
      const hasTask = rest.some((token, i) =>
        !["--benchmark", "--json", "--parallel", "-n"].includes(String(token))
        && !(i > 0 && ["--parallel", "-n"].includes(String(rest[i - 1]))));
      if (!hasTask) {
        ctx.err(`usage: agentlas ${command} "<task>" [--parallel N] [--json] [--runtime <kind>]`);
        return 1;
      }
      const { localCoreBin } = require("../hephaestus/local-core.cjs");
      if (!localCoreBin()) {
        ctx.err(ko
          ? `${sourceScope} 스코프 편성은 로컬 Agentlas-OS Core(hephaestus)가 연합을 소유합니다 — 설치되어 있지 않습니다.`
          : `${sourceScope}-scope staffing is federated by the local Agentlas-OS core (hephaestus), which is not installed.`);
        ctx.err(ko
          ? "설치: Agentlas 데스크탑 앱 또는 https://agentlas.cloud 안내를 따르세요. 공개 Hub 메뉴만이라면 지금도: agentlas workforce \"<요청>\""
          : "Install Agentlas-OS (Desktop app or https://agentlas.cloud). For the public Hub menu only, this works today: agentlas workforce \"<request>\"");
        return 1;
      }
      const db = ctx.db();
      const cwd = projectCwd();
      const permission = resolvePermission(ctx);
      const projectPath = ensureTerminalProjectForExecutionCli(db, cwd, permission, `terminal-${command}`) || cwd;
      const { createLocalCoreHubTool } = require("../workforce/local-core-transport.cjs");
      const { createLocalCoreWorkforceRuntime } = require("../workforce/deps.cjs");
      const transport = createLocalCoreHubTool({ sourceScope, projectDir: projectPath, cwd });
      try {
        const runtime = createLocalCoreWorkforceRuntime({ lang: ctx.lang, out: ctx.out }, transport);
        const result = await runtime.cmdWorkforce(db, rest, runtimeOverride, {
          cwd,
          projectPath,
          permission,
          sourceScope,
        });
        return result && result.ok ? 0 : 1;
      } finally {
        transport.close();
      }
    }
    default: {
      ctx.err(`unknown workforce command: ${command}`);
      return 1;
    }
  }
}

function run(ctx, args) {
  return dispatch(ctx, "workforce", args);
}

module.exports = { run, dispatch };
