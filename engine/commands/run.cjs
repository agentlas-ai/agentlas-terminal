"use strict";
/*
 * run — 원샷 실행: agentlas run [agent] [prompt…]
 *   -p | --print          최종 답만 stdout에 (스트리밍 UI 없음)
 *   --runtime <kind>      claude-code | codex | gemini
 *   --permission <level>  read | write | full
 * 프롬프트가 없고 stdin이 TTY가 아니면 stdin을 읽는다.
 * 자동 라우팅(최적 에이전트 판정)은 v2 판정 배선 전까지 없다 — 첫 토큰이
 * 에이전트로 해석되지 않으면 기본 에이전트로 실행한다(조용한 오라우팅 금지,
 * 어떤 에이전트로 실행하는지 stderr에 명시).
 */
const { findAgent, listAgents } = require("../agents/registry.cjs");
const { resolveRuntime } = require("../runtimes/resolve.cjs");
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
  if (!agent) {
    const visible = listAgents(db);
    agent = visible[0] || findAgent(db, "agentlas-orchestrator");
    if (!agent) {
      ctx.err(ctx.lang === "en" ? "no installed agent (agentlas search/install first)" : "설치된 에이전트가 없습니다 (agentlas search/install 먼저)");
      return 1;
    }
    if (parsed.rest.length) {
      ctx.err(ctx.lang === "en"
        ? `(no agent match for '${parsed.rest[0]}' — running with ${agent.slug})`
        : `('${parsed.rest[0]}' 에 맞는 에이전트 없음 — ${agent.slug} 로 실행)`);
    }
  }

  let prompt = promptParts.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
  if (!prompt) {
    ctx.err("Usage: agentlas run [agent] [prompt]  (reads stdin if no prompt)");
    return 1;
  }

  let runtime;
  try {
    runtime = resolveRuntime({ db, prefs: ctx.prefs, explicit: parsed.runtime });
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
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
