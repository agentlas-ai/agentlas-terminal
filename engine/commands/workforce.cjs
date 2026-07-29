"use strict";
/*
 * commands/workforce — `agentlas workforce|network|taskforce <request>`.
 *
 * v1 모놀리스 디스패치(legacy-v1-engine-snapshot, engine/agentlas.cjs 13149행)의 포팅:
 *   case workforce/network/taskforce → workforce().cmdWorkforce(db, rest,
 *     runtimeOverride, { cwd, projectPath, permission })
 *
 * 라우팅 불변식: 이 표면은 Agent Workforce Ontology 전용 fail-closed 경로다.
 * 어휘 라우터/hep-network 로 조용히 폴백하지 않는다. legacy-network 는 v1에서
 * parity().cmdHep(["hep-network", ...]) 호환 탈출구였는데, 그 parity 모듈이 아직
 * v2에 없으므로 정직 정지로 안내만 한다(가짜 성공 금지).
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
    case "legacy-network": {
      // v1의 명시적 호환 탈출구(parity cmdHep → hep-network)는 아직 v2에 없다.
      // 조용히 workforce 로 대체 실행하지 않는다 — 두 경로는 라우팅 권한 모델이 다르다.
      ctx.err(
        "'legacy-network' (hep-network compatibility) is not wired into the v2 engine yet.\n" +
        "Use `agentlas workforce <request>` for the fail-closed Agent Workforce Ontology route,\n" +
        "or the v1 build: git tag legacy-v1-engine-snapshot.",
      );
      return 1;
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
