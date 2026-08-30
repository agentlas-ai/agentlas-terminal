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
 * Write-capable first contact now runs the canonical Core project bootstrap
 * for the exact current folder. Read-only execution remains passive.
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

/** `--runtime <kind>` 만 명령 자체 플래그로 벗겨낸다. 나머지는 cmdStorm 이 파싱. */
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

function validateStormArgs(args) {
  const seen = new Set();
  let passthrough = false;
  let hasGoal = false;
  for (const raw of args) {
    const token = String(raw);
    if (passthrough) { hasGoal = true; continue; }
    if (token === "--") { passthrough = true; continue; }
    if (token === "--research" || token === "--research-evidence") {
      if (seen.has("research")) return { error: "duplicate option: --research", hasGoal };
      seen.add("research");
    } else if (token === "--background") {
      if (seen.has("background")) return { error: "duplicate option: --background", hasGoal };
      seen.add("background");
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
  const validation = validateStormArgs(rest);
  if (validation.error) { ctx.err(validation.error); return 1; }
  // usage 경로(목표 텍스트 없음)는 SQLite를 열 이유가 없다.
  if (!validation.hasGoal) {
    ctx.err("usage: agentlas storm <goal>  [--research] [--background] [--runtime <kind>]");
    return 1;
  }
  const db = ctx.db();
  const cwd = projectCwd();
  const permission = resolvePermission(ctx);
  const projectPath = ensureTerminalProjectForExecutionCli(db, cwd, permission, "terminal-storm") || cwd;
  const storm = require("../storm/storm.cjs").create(buildStormDeps(ctx));
  const r = await storm.cmdStorm(db, rest, runtimeOverride, {
    cwd,
    projectPath,
    permission,
  });
  return r && r.ok ? 0 : 1;
}

module.exports = { run, splitRuntimeOverride, validateStormArgs };
