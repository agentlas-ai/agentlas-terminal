"use strict";
/*
 * ui/repl — v2 REPL (Claude Code 방식 + 오르카 멀티세션).
 *
 * 원칙:
 *  - 실행 경로는 orchestrator 하나. 포그라운드 턴도 세션이다.
 *  - 화면은 활성 세션 하나만 스트리밍(Renderer). 백그라운드 턴 종료는 한 줄 notice.
 *  - 실행 중 입력: 텍스트는 다음 턴 스티어링 큐로, ctrl-c는 현재 턴 중단.
 *
 * 세션 조종(오르카):
 *  /spawn <agent> [task]   백그라운드 서브세션 생성(+실행)
 *  /sessions · /tree       세션 표 / 부모-자식 트리
 *  /s <n> · /switch <n>    활성 세션 전환 (tail 재생 + 라이브 구독)
 *  /steer <n> <msg>        해당 세션 다음 턴 큐잉
 *  /kill <n> · /rm <n>     턴 중단 / 세션 제거
 *  /broadcast <msg>        전 세션에 동일 지시
 */
const readline = require("node:readline");
const { renderBanner, readVersion } = require("../agentlas-banner.cjs");
const { Orchestrator, maxParallel } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("./renderer.cjs");
const { findAgent, listAgents } = require("../agents/registry.cjs");
const { resolveRuntime, NoRuntimeError } = require("../runtimes/resolve.cjs");
const permissions = require("../agentlas-permissions.cjs");

const DEFAULT_AGENT_SLUG = "agentlas-orchestrator";

function pickDefaultAgent(db) {
  const visible = listAgents(db);
  if (visible.length) return visible[0];
  const builtin = findAgent(db, DEFAULT_AGENT_SLUG);
  if (builtin) return builtin;
  return null;
}

async function startRepl(ctx, opts = {}) {
  const en = ctx.lang === "en";
  const ui = ctx.uiInstance;
  const db = ctx.db();

  try {
    process.stdout.write(renderBanner({ version: readVersion(), lang: ctx.lang }) + "\n");
  } catch {
    ctx.out(`agentlas ${readVersion()}`);
  }

  // 첫 실행 온보딩 (언어 → 런타임 → 권한). setup 명령으로 언제든 재실행 가능.
  if (!ctx.prefs.onboarded && process.stdin.isTTY) {
    const wizardRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const { runWizard } = require("../commands/setup.cjs");
      const result = await runWizard(ctx, wizardRl);
      if (result) {
        if (result.lang) { ctx.prefs.language = result.lang; }
        if (result.permission) ctx.prefs.permission = result.permission;
        if (result.runtime) ctx.prefs.runtime = result.runtime;
        ctx.prefs.onboarded = !!result.onboarded;
      }
    } catch { /* 온보딩 실패는 REPL 진입을 막지 않는다 */ } finally {
      wizardRl.close();
    }
  }

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const renderer = new Renderer(ui);
  let permission = permissions.normalize(opts.permission || (ctx.prefs && ctx.prefs.permission) || "write");
  let runtimeOverride = opts.runtime || null;

  const resolveRt = () => resolveRuntime({ db, prefs: ctx.prefs, explicit: runtimeOverride });

  const ensureMainSession = (agentToken) => {
    const agent = agentToken ? findAgent(db, agentToken) : (orch.active() ? orch.active().agent : pickDefaultAgent(db));
    if (!agent) {
      throw new Error(en
        ? (agentToken ? `agent not found: ${agentToken}` : "no installed agent (agentlas search/install first)")
        : (agentToken ? `에이전트를 찾을 수 없음: ${agentToken}` : "설치된 에이전트가 없습니다 (agentlas search/install 먼저)"));
    }
    const active = orch.active();
    if (active && active.agent.id === agent.id) return active;
    const session = orch.spawn({ agent, runtime: resolveRt(), permission, cwd: process.cwd(), activate: true });
    renderer.attach(session, { replay: false });
    return session;
  };

  ctx.out(ui.c.dim(en
    ? `v2 engine · runtime auto · permission ${permission} · parallel ≤${maxParallel()} — /help, /sessions, /quit`
    : `v2 엔진 · 런타임 auto · 권한 ${permission} · 동시 ≤${maxParallel()} — /help, /sessions, /quit`));

  if (opts.agent) {
    try {
      const session = ensureMainSession(opts.agent);
      ctx.out(ui.c.dim(`agent: ${session.agent.slug} · ${session.runtime.kind}`));
    } catch (e) {
      ctx.err(String((e && e.message) || e));
    }
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const PROMPT = "› ";
    const prompt = () => {
      if (!renderer.session || !renderer.session.isBusy()) {
        rl.setPrompt(PROMPT);
        rl.prompt();
      }
    };

    orch.on("notice", ({ text, ok }) => {
      ui.ensureNl();
      ui.line((ok ? ui.c.emerald("◆ ") : ui.c.amber("◆ ")) + ui.c.dim(text));
      prompt();
    });

    let sigints = 0;
    rl.on("SIGINT", () => {
      const active = orch.active();
      if (active && active.isBusy()) {
        active.kill();
        ui.ensureNl();
        ui.line(ui.c.dim(en ? "(turn interrupted)" : "(턴 중단됨)"));
        sigints = 0;
        prompt();
        return;
      }
      sigints += 1;
      if (sigints >= 2) { rl.close(); return; }
      ui.line(ui.c.dim(en ? "(ctrl-c again to quit)" : "(한 번 더 ctrl-c 하면 종료)"));
      prompt();
    });

    const runForeground = (session, text) => {
      const p = orch.sendTo(session.key, text);
      if (p && typeof p.then === "function") {
        p.then(() => prompt(), (e) => { ui.error(String((e && e.message) || e)); prompt(); });
      }
    };

    rl.on("line", (line) => {
      sigints = 0;
      const input = line.trim();
      if (!input) { prompt(); return; }

      if (input.startsWith("/")) {
        try {
          const quit = handleSlash(ctx, input.slice(1), { orch, renderer, ensureMainSession, resolveRt, setPermission: (p) => { permission = p; }, getPermission: () => permission, setRuntime: (r) => { runtimeOverride = r; } });
          if (quit === "quit") { rl.close(); return; }
        } catch (e) {
          ui.error(String((e && e.message) || e));
        }
        prompt();
        return;
      }

      if (input.startsWith("!")) {
        // 셸 실행은 v2에서 아직 미배선 — 조용히 프롬프트로 삼키지 않는다.
        ui.line(ui.c.dim(en ? "!shell is not wired in v2 yet" : "!셸 실행은 v2에서 아직 미배선입니다"));
        prompt();
        return;
      }

      let session;
      try {
        session = orch.active() || ensureMainSession(null);
        if (!renderer.session) renderer.attach(session, { replay: false });
      } catch (e) {
        ui.error(String((e && e.message) || e));
        prompt();
        return;
      }

      if (session.isBusy()) {
        // 실행 중 타이핑 = 스티어링(다음 턴 큐)
        session.send(input);
        return;
      }
      try {
        runForeground(session, input);
      } catch (e) {
        ui.error(String((e && e.message) || e));
        prompt();
      }
    });

    rl.on("close", () => {
      renderer.detach();
      orch.shutdown();
      ui.ensureNl();
      resolve(0);
    });

    prompt();
  });
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function statusGlyph(ui, row) {
  if (row.busy) return ui.c.emerald("●");
  if (row.status === "failed") return ui.c.amber("✗");
  if (row.status === "killed") return ui.c.dim("■");
  if (row.status === "done") return ui.c.dim("✓");
  return ui.c.dim("○");
}

function printSessions(ctx, orch) {
  const ui = ctx.uiInstance;
  const rows = orch.list();
  if (!rows.length) {
    ctx.out(ui.c.dim(ctx.lang === "en" ? "no sessions yet — type a task or /spawn <agent> <task>" : "세션 없음 — 작업을 입력하거나 /spawn <agent> <task>"));
    return;
  }
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    const mark = r.active ? ui.c.paw("▸") : " ";
    const queued = r.queued ? ui.c.dim(` +${r.queued}q`) : "";
    const elapsed = r.busy ? ui.c.dim(` ${fmtElapsed(r.elapsedMs)}`) : "";
    ctx.out(` ${mark} ${statusGlyph(ui, r)} ${ui.c.bold(r.key.padEnd(4))}${indent}${ui.c.paw(r.agent.padEnd(20))}${elapsed}${queued} ${ui.c.dim(r.lastLine || r.status)}`);
  }
}

function handleSlash(ctx, cmdline, api) {
  const en = ctx.lang === "en";
  const ui = ctx.uiInstance;
  const { orch, renderer, ensureMainSession } = api;
  const [cmd, ...rest] = cmdline.split(/\s+/);
  const restStr = cmdline.slice(cmd.length).trim();

  switch (cmd) {
    case "quit": case "exit": return "quit";
    case "help": {
      require("../commands/help.cjs").run(ctx, rest);
      ctx.out("");
      ctx.out(ui.c.bold(en ? "In-REPL session control (Orca)" : "REPL 세션 조종 (오르카)"));
      ctx.out("  /spawn <agent> [task]   " + (en ? "start a background subagent session" : "백그라운드 서브에이전트 세션 시작"));
      ctx.out("  /sessions · /tree       " + (en ? "session table / tree" : "세션 표 / 트리"));
      ctx.out("  /s <n>                  " + (en ? "switch active session (tail replay + live)" : "활성 세션 전환 (tail 재생 + 라이브)"));
      ctx.out("  /steer <n> <msg>        " + (en ? "queue a steering message" : "스티어링 메시지 큐잉"));
      ctx.out("  /kill <n> · /rm <n>     " + (en ? "interrupt turn / remove session" : "턴 중단 / 세션 제거"));
      ctx.out("  /broadcast <msg>        " + (en ? "send to every session" : "모든 세션에 지시"));
      ctx.out("  /use <agent>            " + (en ? "switch the main session's agent" : "메인 세션 에이전트 교체"));
      ctx.out("  /runtime <kind> · /permission <level>");
      return;
    }
    case "agents": case "list": require("../commands/list.cjs").run(ctx, rest); return;
    case "chats": require("../commands/chats.cjs").run(ctx, rest); return;
    case "doctor": require("../commands/doctor.cjs").run(ctx, rest); return;
    case "mcp": require("../commands/mcp.cjs").run(ctx, rest); return;

    case "sessions": case "tree": printSessions(ctx, orch); return;

    case "s": case "switch": {
      const key = rest[0] && rest[0].startsWith("s") ? rest[0] : `s${rest[0]}`;
      const session = orch.setActive(key);
      renderer.attach(session, { replay: true });
      return;
    }

    case "spawn": {
      const agentToken = rest[0];
      if (!agentToken) throw new Error("Usage: /spawn <agent> [task]");
      const agent = findAgent(ctx.db(), agentToken);
      if (!agent) throw new Error((en ? "agent not found: " : "에이전트를 찾을 수 없음: ") + agentToken);
      const task = restStr.slice(agentToken.length).trim();
      const parent = orch.active();
      const session = orch.spawn({
        agent,
        runtime: parent ? parent.runtime : api.resolveRt(),
        permission: api.getPermission(),
        cwd: process.cwd(),
        parentKey: parent ? parent.key : null,
        activate: false,
        title: task ? `sub: ${task.slice(0, 60)}` : undefined,
      });
      if (task) orch.sendTo(session.key, task);
      ctx.out(ui.c.dim(`${session.key} ${agent.slug} ${task ? (en ? "started" : "시작됨") : (en ? "ready (use /steer)" : "대기 (—/steer 로 지시)")}`));
      return;
    }

    case "steer": {
      const key = rest[0] && rest[0].startsWith("s") ? rest[0] : `s${rest[0]}`;
      const msg = restStr.slice(rest[0].length).trim();
      if (!msg) throw new Error("Usage: /steer <n> <message>");
      orch.sendTo(key, msg);
      ctx.out(ui.c.dim(`→ ${key}`));
      return;
    }

    case "kill": {
      const key = rest[0] && rest[0].startsWith("s") ? rest[0] : `s${rest[0]}`;
      orch.kill(key);
      return;
    }
    case "rm": {
      const key = rest[0] && rest[0].startsWith("s") ? rest[0] : `s${rest[0]}`;
      orch.remove(key);
      const active = orch.active();
      if (active) renderer.attach(active, { replay: false });
      return;
    }

    case "broadcast": {
      if (!restStr) throw new Error("Usage: /broadcast <message>");
      const sent = orch.broadcast(restStr);
      ctx.out(ui.c.dim(`→ ${sent.join(", ") || "(none)"}`));
      return;
    }

    case "use": {
      if (!rest[0]) throw new Error("Usage: /use <agent>");
      const session = ensureMainSession(rest[0]);
      renderer.attach(session, { replay: false });
      ctx.out(ui.c.dim(`agent: ${session.agent.slug}`));
      return;
    }

    case "runtime": {
      if (!rest[0]) throw new Error("Usage: /runtime claude-code|codex|gemini");
      api.setRuntime(rest[0]);
      ctx.out(ui.c.dim(`runtime: ${rest[0]} (${en ? "applies to new sessions" : "새 세션부터 적용"})`));
      return;
    }
    case "permission": {
      const level = permissions.normalize(rest[0]);
      api.setPermission(level);
      ctx.out(ui.c.dim(`permission: ${level} (${en ? "applies to new sessions" : "새 세션부터 적용"})`));
      return;
    }

    default:
      ctx.out(ui.c.dim(en ? `unknown: /${cmd} (see /help)` : `알 수 없는 명령: /${cmd} (/help 참고)`));
  }
}

module.exports = { startRepl, printSessions };
