"use strict";
/*
 * build — 에이전트를 로컬에서 빌드·설치한다 (독립, 2026-08-06 재작성).
 *
 * 이전: `build "<req>"`는 Hephaestus 네이티브 hep-build 패스스루였고, 그 네이티브는
 * "Open Claude Code or Codex with the plugin, then /hep-build"라는 스텁만 냈다 —
 * 플러그인을 강제해 오너 원칙(데스크탑/플러그인은 공유하되 전제 아님)을 어겼다.
 *
 * 지금: 터미널 자체 런타임으로 로컬 빌더(agents/builder.cjs)를 `run`과 같은
 * 실행 인프라(Orchestrator 세션)로 돌려 import 가능한 폴더를 만들고, 성공하면
 * 자동 설치한다. 폴더는 남으므로 자동 설치가 실패해도 `agentlas import`로 복구 가능.
 */
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("../ui/renderer.cjs");
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { projectCwd } = require("../project/paths.cjs");
const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");
const { ensureBuilderAgent, parseBuiltFolder } = require("../agents/builder.cjs");
const { importLocalFolder } = require("../agents/import-local.cjs");
const path = require("node:path");
const fs = require("node:fs");

function usage(ko) {
  return ko
    ? "사용법: agentlas build \"<만들고 싶은 에이전트>\"  [--runtime <kind>] [--print]"
    : "Usage: agentlas build \"<the agent you want>\"  [--runtime <kind>] [--print]";
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (args.some((a) => a === "--help" || a === "-h" || a === "help")) { ctx.out(usage(ko)); return 0; }

  // --runtime/--print 만 벗겨내고 나머지는 요청 문장.
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--runtime" && args[i + 1]) { flags.runtime = args[++i]; continue; }
    if (args[i] === "--print" || args[i] === "-p") { flags.print = true; continue; }
    rest.push(args[i]);
  }
  const request = rest.join(" ").trim();
  if (!request) { ctx.err("✖ " + usage(ko)); return 1; }

  const db = ctx.db();
  const cwd = projectCwd();
  const agent = ensureBuilderAgent(db);

  let runtime;
  try {
    runtime = resolveRuntimeForAgent({
      db, prefs: ctx.prefs, explicit: flags.runtime, role: "orchestrator", agentId: agent.id,
    });
  } catch (e) {
    // no_runtime 등 정직 정지 그대로.
    ctx.err(String((e && e.message) || e));
    return 1;
  }

  // 빌더는 파일을 써야 한다 — write 권한으로 실행한다(현재 폴더에 패키지 생성).
  const permission = permissions.normalize("write");
  try { ensureTerminalProjectForExecutionCli(db, cwd, permission, "terminal-build"); } catch { /* 프로젝트 없어도 빌드는 됨 */ }

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const session = orch.spawn({ agent, runtime, permission, cwd, title: `build: ${request.slice(0, 48)}` });

  let renderer = null;
  if (!flags.print) {
    renderer = new Renderer(ctx.uiInstance);
    renderer.attach(session, { replay: false });
    ctx.err(ctx.uiInstance.c.dim(`${agent.slug} · ${runtime.kind}${runtime.model ? ` · ${runtime.model}` : ""}`));
  }

  const res = await session.send(request);
  if (renderer) renderer.detach();
  const finalText = (res && (res.finalText || res.text)) || "";
  if (flags.print && finalText) process.stdout.write(finalText.trimEnd() + "\n");

  if (session.status === "failed") {
    if (session.lastError) ctx.err(session.lastError);
    return 1;
  }

  // 빌더가 `BUILT: <folder>`를 남겼으면 자동 설치한다.
  const built = parseBuiltFolder(finalText);
  if (!built) {
    ctx.out(ctx.uiInstance.c.dim(ko
      ? "빌드 산출물 위치를 확정하지 못했습니다. 만들어진 폴더를 확인해 `agentlas import <폴더>`로 설치하세요."
      : "Could not confirm the built folder. Check the created folder and install it with `agentlas import <folder>`."));
    return 0;
  }
  const builtPath = path.isAbsolute(built) ? built : path.join(cwd, built);
  if (!fs.existsSync(builtPath)) {
    ctx.out(ctx.uiInstance.c.dim(ko
      ? `빌더가 알린 폴더가 없습니다: ${built}. 만들어진 폴더를 확인해 \`agentlas import\`로 설치하세요.`
      : `The reported folder does not exist: ${built}. Check the created folder and install it with \`agentlas import\`.`));
    return 0;
  }
  try {
    const imported = importLocalFolder(db, builtPath);
    ctx.out(`${ctx.uiInstance.c.green("✓")} ${ko ? "설치됨" : "installed"}: ${imported.slug} — ${imported.name}`);
    ctx.out(ctx.uiInstance.c.dim(ko
      ? `실행: agentlas run ${imported.slug} "<할 일>"`
      : `Run it: agentlas run ${imported.slug} "<task>"`));
    return 0;
  } catch (e) {
    ctx.out(ctx.uiInstance.c.dim(ko
      ? `자동 설치 실패(${String((e && e.message) || e)}). 폴더는 남아 있습니다: ${builtPath}. \`agentlas import ${builtPath}\`로 설치하세요.`
      : `Auto-install failed (${String((e && e.message) || e)}). The folder remains at ${builtPath}. Install with \`agentlas import ${builtPath}\`.`));
    return 0;
  }
}

module.exports = { run };
