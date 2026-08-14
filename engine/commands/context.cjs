"use strict";
/*
 * context — 의존성 컨텍스트 맵 패스스루 (v1 monolith 13224–13234 포팅).
 *
 * refresh|locate|refs|slice|impact|verify 를 Agentlas Core 런타임
 * (agentlas_cloud context …)에 그대로 넘긴다. v1은 Hephaestus parity 셸을 거쳤지만
 * 최종 실행 주체는 같은 Core CLI다 (engine/agentlas-core-harness.cjs 가 스폰).
 *
 * 정직 정지: Core 런타임(또는 Python 3.9+)이 없으면 가짜 맵을 만들지 않고
 * 무엇이 없는지 보고하며 exit 1 한다.
 */
const { projectCwd } = require("../project/paths.cjs");
const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");
const {
  CONTEXT_MAP_MIN_CORE_VERSION,
  CONTEXT_MAP_V3_RUNTIME_MARKERS,
  resolveCoreRuntimeRoot,
  resolvePython,
  spawnCoreModule,
} = require("../agentlas-core-harness.cjs");

const CONTEXT_SUBCOMMANDS = new Set(["refresh", "locate", "refs", "slice", "impact", "verify"]);

function usage(ctx) {
  ctx.err("Usage: agentlas context <refresh|locate|refs|slice|impact|verify> [args…] [--project <path>]");
  return 1;
}

function hasExplicitProjectArg(args) {
  return args.some((arg) => arg === "--project" || String(arg).startsWith("--project="));
}

async function run(ctx, args) {
  if (!args[0]) return usage(ctx);
  if (!CONTEXT_SUBCOMMANDS.has(String(args[0]))) return usage(ctx);
  const cwd = projectCwd();
  // 수동 검사만 — context 명령은 프로젝트를 초기화하지 않는다 (0.9.10 경계).
  ensureTerminalProjectForExecutionCli(ctx.db(), cwd, "read", "terminal-context");

  const coreRoot = resolveCoreRuntimeRoot(
    null,
    CONTEXT_MAP_V3_RUNTIME_MARKERS,
    { minVersion: CONTEXT_MAP_MIN_CORE_VERSION },
  );
  if (!coreRoot) {
    // 정직 정지: 맵을 지어내지 않는다.
    ctx.err(ctx.lang === "ko"
      ? `Agentlas Core 런타임(≥ ${CONTEXT_MAP_MIN_CORE_VERSION})을 찾지 못했습니다. 컨텍스트 맵은 Core가 소유하므로 여기서 대신 만들지 않습니다.`
      : `Agentlas Core runtime (>= ${CONTEXT_MAP_MIN_CORE_VERSION}) was not found. The context map is owned by Core; this command will not fabricate one.`);
    ctx.err(ctx.lang === "ko"
      ? "설치: Agentlas Desktop 최신 버전 또는 `hephaestus` 런타임(~/.agentlas/runtime/current)을 설치하세요."
      : "Install the latest Agentlas Desktop or the `hephaestus` runtime (~/.agentlas/runtime/current), then retry.");
    return 1;
  }
  if (!resolvePython()) {
    ctx.err(ctx.lang === "ko"
      ? "Python 3.9+ 를 찾지 못했습니다. Core 컨텍스트 맵 실행에 필요합니다."
      : "Python 3.9+ was not found; it is required to run the Core context map.");
    return 1;
  }

  const contextArgs = args.slice();
  if (!hasExplicitProjectArg(contextArgs)) {
    contextArgs.push("--project", cwd);
  }
  const child = spawnCoreModule("agentlas_cloud", ["context", ...contextArgs], { cwd, stdio: "inherit" }, coreRoot);
  if (!child) {
    ctx.err("Agentlas Core runtime or Python 3.9+ is unavailable.");
    return 1;
  }
  return await new Promise((resolve) => {
    child.on("error", (e) => { ctx.err(String((e && e.message) || e)); resolve(1); });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

module.exports = { run, CONTEXT_SUBCOMMANDS, hasExplicitProjectArg };
