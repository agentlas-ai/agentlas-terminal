"use strict";
/*
 * run — 원샷 실행: agentlas run [agent] [prompt…]
 *   -p | --print          최종 답만 stdout에 (스트리밍 UI 없음)
 *   --runtime <kind>      claude-code | codex | gemini
 *   --permission <level>  read | write | full
 * 프롬프트가 없고 stdin이 TTY가 아니면 stdin을 읽는다.
 *
 * 자동 라우팅(agents/router.cjs): 첫 토큰이 에이전트로 해석되지 않으면 호스트 LLM
 * 판정(resolveAutoRoute)이 최적 에이전트를 고른다 — 어휘 점수는 후보 모집 전용이다.
 * 판정 런타임이 없으면 기본 에이전트로 정직 폴백하되 note를 stderr에 반드시 출력한다
 * (조용한 오라우팅/폴백 금지 — 오너 결정).
 * 런타임 사다리: 명시(--runtime) > 에이전트별 오버라이드(agent_runtime_overrides) >
 * prefs > active_runtime > detected (runtimes/overrides.cjs).
 */
const { findAgent, listAgents } = require("../agents/registry.cjs");
const { resolveRuntime } = require("../runtimes/resolve.cjs");
const { resolveRuntimeForAgent, unavailableOverrideNote } = require("../runtimes/overrides.cjs");
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("../ui/renderer.cjs");
const permissions = require("../agentlas-permissions.cjs");

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf.trim()));
  });
}

function parseArgs(args) {
  const out = { print: false, runtime: null, permission: null, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--runtime") out.runtime = args[++i];
    else if (a === "--permission") out.permission = args[++i];
    else out.rest.push(a);
  }
  return out;
}

async function runOnce(ctx, args) {
  const parsed = parseArgs(args);
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

  // 기본 런타임을 먼저 확정한다 — 판정 러너(자동 라우팅)도 이 런타임을 쓴다.
  let runtime;
  try {
    runtime = resolveRuntime({ db, prefs: ctx.prefs, explicit: parsed.runtime });
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }

  if (!agent) {
    // 자동 라우팅 — 최종 픽은 호스트 LLM 판정. 판정 불가 시 기본 에이전트 정직 폴백 + note.
    const router = require("../agents/router.cjs");
    let choice = null;
    try {
      choice = await router.resolveAutoRoute(db, prompt, { lang: ctx.lang, runtime });
    } catch (e) {
      ctx.err(ctx.lang === "ko"
        ? `자동 라우팅 실패(${(e && e.message) || e}) — 기본 에이전트로 실행합니다`
        : `auto-routing failed (${(e && e.message) || e}) — running with the default agent`);
    }
    if (choice && choice.agent) {
      agent = choice.agent;
    } else {
      const visible = listAgents(db);
      agent = visible[0] || findAgent(db, "agentlas-orchestrator");
      if (!agent) {
        ctx.err(ctx.lang === "en" ? "no installed agent (agentlas search/install first)" : "설치된 에이전트가 없습니다 (agentlas search/install 먼저)");
        return 1;
      }
      // 직답 판정 — 페르소나 오염 없이 기본 에이전트 챗으로, 플레인 프롬프트로 답한다.
      if (choice && choice.direct) agent = { ...agent, systemPrompt: router.directSystemPrompt(ctx.lang) };
    }
    // 조용한 라우팅 금지 — 누가 왜 선택됐는지(또는 왜 판정을 못 했는지) 반드시 출력.
    if (choice && choice.note) ctx.err(ctx.uiInstance.c.dim(choice.note));
  }

  // 에이전트가 확정된 뒤 에이전트별 런타임 오버라이드를 얹는다(명시 --runtime이 항상 우선).
  if (!parsed.runtime && agent && agent.id) {
    try {
      const layered = resolveRuntimeForAgent({ db, prefs: ctx.prefs, explicit: null, agentId: agent.id });
      if (layered.unavailableOverride) ctx.err(ctx.uiInstance.c.dim(unavailableOverrideNote(layered, ctx.lang)));
      runtime = layered;
    } catch { /* 오버라이드 층 실패 → 이미 확정된 기본 런타임 유지 */ }
  }

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const session = orch.spawn({
    agent,
    runtime,
    permission: permissions.normalize(parsed.permission || (ctx.prefs && ctx.prefs.permission) || "write"),
    cwd: process.cwd(),
    title: prompt.slice(0, 60),
  });

  let renderer = null;
  if (!parsed.print) {
    renderer = new Renderer(ctx.uiInstance);
    renderer.attach(session, { replay: false });
    ctx.err(ctx.uiInstance.c.dim(`${agent.slug} · ${runtime.kind}`));
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
