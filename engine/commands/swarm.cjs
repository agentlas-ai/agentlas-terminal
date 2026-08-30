"use strict";
/*
 * commands/swarm — `agentlas swarm <goal> [--parallel N] [--runtime <kind>]`.
 *
 * v1 모놀리스 디스패치(legacy-v1-engine-snapshot, engine/agentlas.cjs 13079행)의 포팅:
 *   case "swarm" → parity().cmdSwarm(db, rest, runtimeOverride,
 *     { cwd, projectPath, permission })
 *
 * 워커 실행은 storm/swarm.cjs 를 통해 engine/workforce/capture.cjs 의 headless
 * 캡처로만 이뤄진다(제2의 스폰 경로 금지). 워커의 workload allocation은
 * agentlas-workload-routing 이 검증만 하고, 거부 시 fail-closed 다.
 * 런타임 부재는 resolveRuntime의 code="no_runtime" throw가 그대로 전파돼 exit 1.
 *
 * Write-capable first contact bootstraps the exact current project through Core.
 */
const { buildStormDeps } = require("../storm/deps.cjs");
const { projectCwd } = require("../workforce/capture.cjs");
const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");

function assertPermissionFlag(value) {
  if (value && !["read", "write", "full"].includes(String(value))) {
    throw new Error(`unknown --permission ${value} (use: read | write | full)`);
  }
}

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

/** `--runtime <kind>` 만 명령 자체 플래그로 벗겨낸다. 나머지는 cmdSwarm 이 파싱. */
function splitRuntimeOverride(args) {
  const rest = [];
  let runtimeOverride = null;
  let seen = false;
  let passthrough = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (passthrough) { rest.push(token); continue; }
    if (token === "--") { passthrough = true; rest.push(token); continue; }
    if (token === "--runtime" || token.startsWith("--runtime=")) {
      if (seen) throw new Error("duplicate option: --runtime");
      seen = true;
      const inline = token.startsWith("--runtime=");
      const value = inline ? token.slice(10) : args[++i];
      if (value === undefined || value === "" || (!inline && String(value).startsWith("--"))) {
        throw new Error("--runtime requires a value");
      }
      runtimeOverride = String(value);
      continue;
    }
    rest.push(token);
  }
  return { rest, runtimeOverride };
}

function validateSwarmArgs(args) {
  let seenParallel = false;
  let passthrough = false;
  let hasGoal = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (passthrough) { hasGoal = true; continue; }
    if (token === "--") { passthrough = true; continue; }
    if (token === "--parallel" || token === "-n" || token.startsWith("--parallel=")) {
      if (seenParallel) return { error: "duplicate option: --parallel", hasGoal };
      seenParallel = true;
      const inline = token.startsWith("--parallel=");
      const raw = inline ? token.slice(11) : args[++i];
      const value = Number(raw);
      if (raw === undefined || raw === "" || (!inline && String(raw).startsWith("--")) || !Number.isInteger(value) || value < 1) {
        return { error: "--parallel requires a positive integer (maximum 8)", hasGoal };
      }
    } else if (token.startsWith("-")) {
      return { error: `unknown option: ${token} (use -- before a goal token that starts with '-')`, hasGoal };
    } else hasGoal = true;
  }
  return { error: null, hasGoal };
}

async function run(ctx, args) {
  let parsed;
  try { parsed = splitRuntimeOverride(args); }
  catch (error) { ctx.err(String((error && error.message) || error)); return 1; }
  const { rest, runtimeOverride } = parsed;
  const validation = validateSwarmArgs(rest);
  if (validation.error) { ctx.err(validation.error); return 1; }
  // usage 경로(목표 텍스트 없음)는 SQLite를 열 이유가 없다 — cmdSwarm 의 플래그
  // (--parallel/-n <N>)만 있는 호출은 빈 목표다.
  if (!validation.hasGoal) {
    ctx.err("usage: agentlas swarm <goal>  [--parallel N] [--runtime <kind>]");
    return 1;
  }
  const db = ctx.db();
  const cwd = projectCwd();
  const permission = resolvePermission(ctx);
  const projectPath = ensureTerminalProjectForExecutionCli(db, cwd, permission, "terminal-swarm") || cwd;
  const swarm = require("../storm/swarm.cjs").create(buildStormDeps(ctx));
  const r = await swarm.cmdSwarm(db, rest, runtimeOverride, {
    cwd,
    projectPath,
    permission,
  });
  return r && r.ok ? 0 : 1;
}

module.exports = { run, splitRuntimeOverride, validateSwarmArgs };
