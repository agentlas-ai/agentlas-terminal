"use strict";
/*
 * commands/storm — `agentlas storm <goal> [--research] [--background] [--runtime <kind>]`.
 *
 * v1 모놀리스 디스패치(legacy-v1-engine-snapshot, engine/agentlas.cjs 13074행)의 포팅:
 *   case "storm" → parity().cmdStorm(db, rest, runtimeOverride,
 *     { cwd, projectPath, permission })
 *
 * 정직 정지 계약: Agentlas Core의 Goal+UltraCode 하네스가 없으면 storm/storm.cjs 가
 * stormbreaker-core-harness-unavailable 로 멈춘다 — 하네스의 로컬 모조 실행 금지.
 * 런타임 부재는 resolveRuntime의 code="no_runtime" throw가 그대로 전파돼 exit 1.
 *
 * projectPath 에 대한 정직한 메모: v1은 ensureTerminalProjectForExecutionCli(db,
 * cwd, permission, "terminal-storm")로 프로젝트 상태 머신을 돌려 활성 프로젝트
 * 경로를 만들었다. 그 프로젝트-상태 기계는 아직 v2로 포팅되지 않았다. storm/swarm 이
 * projectPath 를 쓰는 곳은 buildChildEnv 의 프로젝트 dotenv 스코핑뿐이고 부재 시
 * fail-closed 의존이 없다 — 그래서 여기서는 cwd 를 projectPath 로 넘긴다
 * (commands/workforce.cjs 와 동일한 결정·동일한 근거). 프로젝트-상태 모듈이 v2에
 * 착륙하면 이 자리를 그 결과로 교체한다.
 */
const { buildStormDeps } = require("../storm/deps.cjs");
const { projectCwd } = require("../workforce/capture.cjs");

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

/** `--runtime <kind>` 만 명령 자체 플래그로 벗겨낸다. 나머지는 cmdStorm 이 파싱. */
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

async function run(ctx, args) {
  const { rest, runtimeOverride } = splitRuntimeOverride(args);
  // usage 경로(목표 텍스트 없음)는 SQLite를 열 이유가 없다.
  if (!rest.some((token) => !["--research", "--research-evidence", "--background"].includes(String(token)))) {
    ctx.err("usage: agentlas storm <goal>  [--research] [--background] [--runtime <kind>]");
    return 1;
  }
  const db = ctx.db();
  const cwd = projectCwd();
  const permission = resolvePermission(ctx);
  const storm = require("../storm/storm.cjs").create(buildStormDeps(ctx));
  const r = await storm.cmdStorm(db, rest, runtimeOverride, {
    cwd,
    // v1 ensureTerminalProjectForExecutionCli 미포팅 — 위 파일 머리 주석 참조.
    projectPath: cwd,
    permission,
  });
  return r && r.ok ? 0 : 1;
}

module.exports = { run, splitRuntimeOverride };
