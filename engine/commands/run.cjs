"use strict";
/*
 * run — 원샷 실행: agentlas run [agent] [prompt…]
 *   -p | --print          최종 답만 stdout에 (스트리밍 UI 없음)
 *   --runtime <kind>      claude-code | codex | gemini
 *   --model <id>          exact provider model id
 *   --effort <level>      none | minimal | low | medium | high | xhigh | max
 *   --tier <tier>         economy | balanced | frontier (requires --model)
 *   --permission <level>  read | write | full
 * 프롬프트가 없고 stdin이 TTY가 아니면 stdin을 읽는다.
 *
 * 첫 토큰이 정확한 에이전트이면 고급 직접 호출이다. 그 외 일반 실행은 현재 폴더에
 * 연결된 Desktop Work 프로젝트의 첫 에이전트를 컨트롤러로 사용한다. 프로젝트나
 * 컨트롤러가 불명확하면 다른 에이전트로 대체하지 않고 실행을 중단한다.
 * 런타임 사다리: 명시 핀 > 에이전트별 오버라이드(agent_runtime_overrides) >
 * model_roles[orchestrator] > active_runtime > detected (runtimes/overrides.cjs).
 */
const { findAgent } = require("../agents/registry.cjs");
const {
  resolveRuntimeForAgent,
  unavailableOverrideNote,
  unavailableRoleNote,
} = require("../runtimes/overrides.cjs");
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("../ui/renderer.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { EFFORTS, TIERS } = require("../agentlas-workload-routing.cjs");
const { projectCwd } = require("../project/paths.cjs");
const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");
const { resolveProjectController, withProjectControllerContext } = require("../project/controller.cjs");

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}

function parseArgs(args) {
  const out = {
    print: false,
    runtime: null,
    model: null,
    effort: null,
    tier: null,
    permission: null,
    rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--runtime") out.runtime = args[++i];
    else if (a === "--model") out.model = args[++i];
    else if (a === "--effort") out.effort = args[++i];
    else if (a === "--tier") out.tier = args[++i];
    else if (a === "--permission") out.permission = args[++i];
    else out.rest.push(a);
  }
  return out;
}

async function runOnce(ctx, args) {
  const parsed = parseArgs(args);
  // 플래그 검증은 모델을 부르기 전에. normalize는 알 수 없는 값을 read로 fail-closed
  // 강등하는데, 조용히 강등하면 full을 요청한 사용자가 read로 도는 걸 모른다.
  if (parsed.permission && !["read", "write", "full"].includes(String(parsed.permission))) {
    ctx.err(`unknown --permission ${parsed.permission} (use: read | write | full)`);
    return 1;
  }
  if (parsed.effort && !EFFORTS.includes(String(parsed.effort))) {
    ctx.err(`unknown --effort ${parsed.effort} (use: ${EFFORTS.join(" | ")})`);
    return 1;
  }
  if (parsed.tier && !TIERS.includes(String(parsed.tier))) {
    ctx.err(`unknown --tier ${parsed.tier} (use: ${TIERS.join(" | ")})`);
    return 1;
  }
  if (parsed.tier && !parsed.model) {
    ctx.err("--tier requires --model: Terminal never guesses a provider model id from a cost tier");
    return 1;
  }
  const db = ctx.db();

  let agent = null;
  let promptParts = parsed.rest;
  if (parsed.rest.length) {
    const candidate = findAgent(db, parsed.rest[0]);
    if (candidate) {
      agent = candidate;
      promptParts = parsed.rest.slice(1);
    }
  }
  let prompt = promptParts.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
  if (!prompt) {
    ctx.err("Usage: agentlas run [agent] [prompt]  (reads stdin if no prompt)");
    return 1;
  }

  const cwd = projectCwd();
  if (!agent) {
    try {
      const resolved = resolveProjectController(db, cwd);
      agent = withProjectControllerContext(resolved.controller, resolved.project);
      ctx.err(ctx.uiInstance.c.dim(
        ctx.lang === "ko"
          ? `프로젝트: ${resolved.project.name} · 컨트롤러: ${agent.name}`
          : `Project: ${resolved.project.name} · Controller: ${agent.nameEn || agent.name}`,
      ));
    } catch (e) {
      ctx.err(String((e && e.message) || e));
      return 1;
    }
  }

  // 프로젝트 컨트롤러 또는 명시 에이전트의 런타임을 확정한다.
  let runtime;
  try {
    runtime = resolveRuntimeForAgent({
      db,
      prefs: ctx.prefs,
      explicit: parsed.runtime,
      model: parsed.model,
      effort: parsed.effort,
      role: "orchestrator",
      agentId: agent.id,
    });
    if (parsed.tier) runtime.modelTier = parsed.tier;
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }

  // 에이전트가 확정된 뒤 에이전트별 오버라이드를 포함한 전체 사다리를 다시 해석한다.
  // 명시 runtime/model/effort 핀은 항상 최상단이라 에이전트 기본값보다 우선한다.
  if (agent && agent.id) {
    try {
      const layered = resolveRuntimeForAgent({
        db,
        prefs: ctx.prefs,
        explicit: parsed.runtime,
        model: parsed.model,
        effort: parsed.effort,
        role: "orchestrator",
        agentId: agent.id,
      });
      if (layered.unavailableOverride) ctx.err(ctx.uiInstance.c.dim(unavailableOverrideNote(layered, ctx.lang)));
      if (layered.unavailableRoleSelection) ctx.err(ctx.uiInstance.c.dim(unavailableRoleNote(layered, ctx.lang)));
      if (parsed.tier) layered.modelTier = parsed.tier;
      runtime = layered;
    } catch (e) {
      ctx.err(String((e && e.message) || e));
      return 1;
    }
  }

  const permission = permissions.normalize(parsed.permission || (ctx.prefs && ctx.prefs.permission) || "write");
  try {
    ensureTerminalProjectForExecutionCli(db, cwd, permission, "terminal-run");
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  const orch = new Orchestrator({ db, lang: ctx.lang });
  const session = orch.spawn({
    agent,
    runtime,
    permission,
    cwd,
    title: prompt.slice(0, 60),
  });

  let renderer = null;
  if (!parsed.print) {
    renderer = new Renderer(ctx.uiInstance);
    renderer.attach(session, { replay: false });
    ctx.err(ctx.uiInstance.c.dim(
      `${agent.slug} · ${runtime.kind}${runtime.model ? ` · ${runtime.model}` : ""}${runtime.effort ? ` · ${runtime.effort}` : ""}`,
    ));
  }

  const res = await session.send(prompt);
  if (renderer) renderer.detach();

  if (parsed.print) {
    const finalText = (res && (res.finalText || res.text)) || "";
    if (finalText) process.stdout.write(finalText.trimEnd() + "\n");
  }
  if (session.status === "failed") {
    if (parsed.print && session.lastError) ctx.err(session.lastError);
    return 1;
  }
  return 0;
}

function run(ctx, args) {
  return runOnce(ctx, args);
}

module.exports = { run, parseArgs };
