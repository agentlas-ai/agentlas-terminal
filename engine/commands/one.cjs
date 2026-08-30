"use strict";
/*
 * one — Agentlas One 축을 터미널에 연다.
 *
 * 배경(감사 2026-08-20): 터미널에는 One 축이 **아예 없었다**. commands/index 는
 * `one` 을 DESKTOP_ONLY_SURFACES 에 올려 "One 은 Desktop/Mobile 표면"이라고 선언했다.
 * 그런데 One 은 제품의 개인 에이전트 축이고 대화는 **공유 DB 에 이미 있다** — 터미널만
 * 그 대화를 못 봤다. 그래서 이 명령은 새 개념을 만들지 않는다:
 *
 *   · One = 빌트인 에이전트 `builtin-agentlas-one` (데스크탑 architecture/manifest.ts)
 *   · One 소유 대화 = chats.origin_surface = 'one'
 *   · 실행 = 터미널의 기존 세션 경로(sessions/orchestrator + sessions/session)
 *
 * 러너를 손으로 재구현하지 않는다. 이 파일이 하는 일은 (1) One 신원을 정확히 고르고
 * (2) 이어 갈 One 대화를 고르거나 만들고 (3) 기존 세션을 그 chatId 로 띄우는 것뿐이다.
 *
 * 사용법
 *   agentlas one                       최근 One 대화를 이어서 대화형
 *   agentlas one "<프롬프트>"            한 턴 실행
 *   agentlas one --list                One 대화 목록
 *   agentlas one --new "<프롬프트>"      새 One 대화로 시작
 *   agentlas one --chat <id> "<p>"     특정 One 대화에 이어 붙임
 *   agentlas one -- "list 같은 옵션 모양의 프롬프트"
 *   공통: -p/--print · --runtime · --model · --effort · --permission
 */
const readline = require("node:readline");
const { rowToAgent } = require("../agents/registry.cjs");
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("../ui/renderer.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { EFFORTS } = require("../agentlas-workload-routing.cjs");
const { projectCwd } = require("../project/paths.cjs");
const { runWriteTransaction } = require("../core/db.cjs");
const store = require("../sessions/store.cjs");

/** 데스크탑 정본 신원(electron/architecture/manifest.ts + builtinAgentId). */
const ONE_AGENT_ID = "builtin-agentlas-one";
const ONE_AGENT_SLUG = "agentlas-one";
const ONE_ORIGIN_SURFACE = "one";

/**
 * One 신원을 공유 DB 에서 읽는다.
 *
 * findAgent() 를 쓰지 않는 이유: One 은 visibility='background' 라 listRoutableAgents 가
 * 걸러 낸다(설계). One 은 라우팅 후보가 아니라 **신원 행**이므로 직접 읽는다.
 */
function resolveOneAgent(db) {
  const row = db.prepare("SELECT * FROM installed_agents WHERE id=?").get(ONE_AGENT_ID)
    || db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(ONE_AGENT_SLUG);
  return rowToAgent(row);
}

/**
 * One 페르소나의 정본은 데스크탑 계약이다. 벤더된 컴파일 매니페스트에서 읽을 수 있으면
 * 그것을 쓰고(항상 최신 계약), 없으면 그 사실을 사유로 돌려준다 — 조용히 다른 문장으로
 * 대체하지 않는다.
 */
function desktopOnePersona() {
  try {
    const { findCoreRoot } = require("../core/desktop-core.cjs");
    const root = findCoreRoot();
    if (!root) return { prompt: null, source: null, reason: "no Desktop core is available on this machine" };
    const path = require("node:path");
    const manifest = require(path.join(root, "electron", "architecture", "manifest.js"));
    const def = (manifest.BUILTIN_AGENTS || []).find((agent) => agent.slug === ONE_AGENT_SLUG);
    if (!def || !def.systemPrompt) {
      return { prompt: null, source: null, reason: "the Desktop core on this machine predates the Agentlas One built-in" };
    }
    return { prompt: def.systemPrompt, source: "desktop-core", reason: null };
  } catch (error) {
    return { prompt: null, source: null, reason: `Desktop core manifest unreadable: ${(error && error.message) || error}` };
  }
}

function chatsHaveOriginSurface(db) {
  return db.prepare("PRAGMA table_info(chats)").all().some((column) => column.name === "origin_surface");
}

/** One 소유 대화 목록(최근 순). origin_surface 열이 없는 구형 DB 는 에이전트 소유로 폴백. */
function listOneChats(db, limit = 20) {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 200));
  if (chatsHaveOriginSurface(db)) {
    return db.prepare(
      "SELECT id, title, updated_at, origin_surface FROM chats " +
      "WHERE origin_surface = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?",
    ).all(ONE_ORIGIN_SURFACE, bounded);
  }
  return db.prepare(
    "SELECT id, title, updated_at FROM chats WHERE agent_id IN (?, ?) AND (kind IS NULL OR kind <> 'division') " +
    "ORDER BY updated_at DESC, rowid DESC LIMIT ?",
  ).all(ONE_AGENT_ID, ONE_AGENT_SLUG, bounded);
}

/**
 * One 대화를 만든다. origin_surface 열이 있으면 반드시 'one' 으로 찍는다 —
 * 이 한 칸이 데스크탑/모바일이 이 대화를 One 대화로 보는 유일한 근거다.
 * 열이 없는 구형 DB 에서는 만들되, 호출부가 그 사실을 사용자에게 알린다.
 */
function createOneChat(db, { agentId, title, workingFolder }) {
  if (!chatsHaveOriginSurface(db)) {
    return { chatId: store.createChat(db, { agentId, title, kind: "user", workingFolder }), originSurfaceStamped: false };
  }
  const id = store.newId();
  const now = new Date().toISOString();
  runWriteTransaction(db, () => {
    db.prepare(
      "INSERT INTO chats (id, agent_id, title, created_at, updated_at, kind, parent_chat_id, working_folder, origin_surface) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, agentId, title || "One", now, now, "user", null, workingFolder, ONE_ORIGIN_SURFACE);
  });
  return { chatId: id, originSurfaceStamped: true };
}

function parseArgs(args) {
  const out = { print: false, list: false, fresh: false, chatId: null, runtime: null, model: null, effort: null, permission: null, rest: [], error: null };
  const readValue = (index, flag) => {
    const value = args[index + 1];
    if (typeof value !== "string" || !value || value === "--" || value.startsWith("--")) {
      out.error = `${flag} requires a value`;
      return null;
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--list") out.list = true;
    else if (a === "--new") out.fresh = true;
    else if (["--chat", "--runtime", "--model", "--effort", "--permission"].includes(a)) {
      const value = readValue(i, a);
      if (value === null) break;
      if (a === "--chat") out.chatId = value;
      else if (a === "--runtime") out.runtime = value;
      else if (a === "--model") out.model = value;
      else if (a === "--effort") out.effort = value;
      else out.permission = value;
      i += 1;
    }
    else if (a.startsWith("-")) {
      out.error = `unknown option ${a}`;
      break;
    }
    else out.rest.push(a);
  }
  if (!out.error && out.list && (
    out.fresh || out.chatId || out.runtime || out.model || out.effort || out.permission || out.rest.length > 0
  )) {
    out.error = "--list cannot be combined with a prompt or execution options";
  }
  if (!out.error && out.fresh && out.chatId) {
    out.error = "--new cannot be combined with --chat";
  }
  return out;
}

function renderList(ctx, rows) {
  if (!rows.length) {
    ctx.out(ctx.lang === "ko"
      ? "One 대화가 아직 없습니다. `agentlas one \"<하고 싶은 일>\"` 로 시작하세요."
      : "No One conversations yet. Start one with: agentlas one \"<what you want>\"");
    return 0;
  }
  for (const row of rows) {
    const when = String(row.updated_at || "").slice(0, 16).replace("T", " ");
    ctx.out(`${row.id}  ${when}  ${String(row.title || "One").slice(0, 60)}`);
  }
  return 0;
}

async function runOne(ctx, args) {
  const parsed = parseArgs(args);
  if (parsed.error) {
    ctx.err(`invalid one arguments: ${parsed.error}`);
    return 1;
  }
  if (parsed.permission && !permissions.LEVELS.includes(String(parsed.permission))) {
    ctx.err(`unknown --permission ${parsed.permission} (use: ${permissions.LEVELS.join(" | ")})`);
    return 1;
  }
  if (parsed.effort && !EFFORTS.includes(String(parsed.effort))) {
    ctx.err(`unknown --effort ${parsed.effort} (use: ${EFFORTS.join(" | ")})`);
    return 1;
  }

  const db = ctx.db();
  const readChats = (limit) => {
    try {
      return listOneChats(db, limit);
    } catch (error) {
      ctx.err(`Could not read One conversations: ${String((error && error.message) || error)}`);
      return null;
    }
  };

  // 목록은 신원 행이 없어도 답할 수 있어야 한다 — 대화는 chats 에 있고, One 행은
  // 실행에만 필요하다. 조회를 실행 전제조건 뒤에 두면 "볼 수도 없는" 화면이 된다.
  if (parsed.list) {
    const rows = readChats(20);
    return rows ? renderList(ctx, rows) : 1;
  }

  let agent;
  try {
    agent = resolveOneAgent(db);
  } catch (error) {
    ctx.err(`Could not read the Agentlas One identity: ${String((error && error.message) || error)}`);
    return 1;
  }
  if (!agent) {
    ctx.err(
      "Agentlas One is not present in the shared database yet.\n" +
      "One is a built-in identity row (builtin-agentlas-one) seeded by the shared architecture.\n" +
      "Run `agentlas doctor`, or launch the Agentlas Desktop app once, then retry.",
    );
    return 1;
  }

  // 페르소나 정본은 데스크탑 계약. 읽을 수 있으면 그것을 쓰고, 못 읽으면 DB 행을 쓰되
  // **무엇을 못 읽었는지 말한다**(조용한 대체 금지).
  const persona = desktopOnePersona();
  if (persona.prompt) agent.systemPrompt = persona.prompt;
  else if (persona.reason) {
    ctx.err(ctx.uiInstance.c.dim(
      `One persona came from the shared database row, not the Desktop contract — ${persona.reason}`,
    ));
  }

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
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }

  const permission = permissions.normalize(parsed.permission || (ctx.prefs && ctx.prefs.permission) || "write");
  const cwd = projectCwd();
  const prompt = parsed.rest.join(" ").trim();

  // 이어 갈 대화 고르기 — 새 개념을 만들지 않고 기존 One 대화를 쓴다.
  let chatId = null;
  let created = false;
  if (parsed.chatId) {
    const rows = readChats(200);
    if (!rows) return 1;
    const row = rows.find((item) => item.id === parsed.chatId);
    if (!row) {
      ctx.err(`No One conversation with id ${parsed.chatId} (see: agentlas one --list)`);
      return 1;
    }
    chatId = row.id;
  } else if (!parsed.fresh) {
    const recent = readChats(1);
    if (!recent) return 1;
    if (recent.length) chatId = recent[0].id;
  }
  if (!chatId) {
    const result = createOneChat(db, {
      agentId: agent.id,
      title: prompt ? prompt.slice(0, 60) : "One",
      workingFolder: cwd,
    });
    chatId = result.chatId;
    created = true;
    if (!result.originSurfaceStamped) {
      ctx.err(ctx.uiInstance.c.dim(
        "This shared database has no chats.origin_surface column, so the conversation could not be stamped " +
        "as a One conversation. Desktop and Mobile will show it as a normal chat until the store is migrated.",
      ));
    }
  }

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const session = orch.spawn({ agent, runtime, permission, cwd, chatId, title: prompt ? prompt.slice(0, 60) : "One" });

  const interactive = !prompt;
  let renderer = null;
  if (!parsed.print) {
    renderer = new Renderer(ctx.uiInstance);
    renderer.attach(session, { replay: false });
    ctx.err(ctx.uiInstance.c.dim(
      `one · ${runtime.kind}${runtime.model ? ` · ${runtime.model}` : ""} · ${permission} · ` +
      `${created ? "new conversation" : "continuing"} ${chatId}`,
    ));
  }

  if (!interactive) {
    const res = await session.send(prompt);
    if (renderer) renderer.detach();
    if (parsed.print) {
      const finalText = (res && (res.finalText || res.text)) || "";
      if (finalText) process.stdout.write(finalText.trimEnd() + "\n");
      if (session.status === "failed" && session.lastError) ctx.err(session.lastError);
    }
    return session.status === "failed" ? 1 : 0;
  }

  // 대화형 — 답할 사람이 있는 자리에서만 연다. 파이프/자동화에서는 정직하게 멈춘다.
  if (!process.stdin.isTTY) {
    if (renderer) renderer.detach();
    ctx.err("Usage: agentlas one \"<prompt>\"   (interactive One needs a TTY)");
    return 1;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let failed = false;
  try {
    for (;;) {
      const line = await new Promise((resolve) => rl.question("one › ", resolve));
      const text = String(line || "").trim();
      if (!text) continue;
      if (/^(?:\/quit|\/exit|quit|exit)$/i.test(text)) break;
      await session.send(text);
      if (session.status === "failed") {
        failed = true;
        if (session.lastError) ctx.err(session.lastError);
      }
    }
  } finally {
    rl.close();
    if (renderer) renderer.detach();
  }
  return failed ? 1 : 0;
}

function run(ctx, args) {
  return runOne(ctx, args);
}

module.exports = {
  run,
  parseArgs,
  resolveOneAgent,
  listOneChats,
  createOneChat,
  desktopOnePersona,
  ONE_AGENT_ID,
  ONE_AGENT_SLUG,
  ONE_ORIGIN_SURFACE,
};
