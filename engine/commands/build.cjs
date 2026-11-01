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
    ? "사용법: agentlas build \"<만들고 싶은 에이전트>\"  [--runtime <kind>] [--print] [-- <옵션처럼 시작하는 요청>]"
    : "Usage: agentlas build \"<the agent you want>\"  [--runtime <kind>] [--print] [-- <request starting like an option>]";
}

function buildError(message, code = "INVALID_ARGUMENT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reportBuildError(ctx, error) {
  // Shell owns its frame and rebinds err(), while its inherited fail() writes
  // directly to process stderr outside the TUI. Keep the notice inside it.
  if (ctx.surface === "shell" && typeof ctx.err === "function") ctx.err(error.message);
  else if (typeof ctx.fail === "function") ctx.fail(error);
  else ctx.err(error.message);
}

// Questions are untrusted model output. Keep both the terminal message and the
// machine-readable error bounded, and never turn a question into an answer.
const MAX_BUILD_QUESTION_EVENTS = 32;
const MAX_BUILD_QUESTIONS = 32;
const UNSAFE_TERMINAL_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
function boundedQuestionText(value, limit) {
  if (typeof value !== "string" || UNSAFE_TERMINAL_TEXT.test(value)) return null;
  const normalized = value.replace(/[\t\r\n]+/g, " ").trim();
  return normalized && normalized.length <= limit ? normalized : null;
}
function buildQuestion(payload) {
  if (!payload || typeof payload !== "object") return null;
  const question = boundedQuestionText(payload.question, 4000);
  const header = payload.header === undefined ? "" : boundedQuestionText(payload.header, 200);
  if (!question || header === null || !Array.isArray(payload.options) || payload.options.length > 8) return null;
  const options = [];
  for (const raw of payload.options) {
    const label = raw && boundedQuestionText(raw.label, 200);
    const description = raw && raw.description !== undefined ? boundedQuestionText(raw.description, 1000) : "";
    if (!label || description === null) return null;
    options.push({ label, ...(description ? { description } : {}) });
  }
  return { question, ...(header ? { header } : {}), options, multiSelect: payload.multiSelect === true };
}

function checkQuestionMarkers(result, observedKeys) {
  if (!result || typeof result.controlText !== "string") return "question_source_unavailable";
  const raw = result.controlText;
  if (!/agentlas-ask/i.test(raw)) return observedKeys.length ? "question_event_unverified" : null;
  if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) return "question_source_too_large";
  try {
    const { ASK_OPEN, repairAskOpenMarkers, extractAsks } = require("../sessions/fences.cjs");
    const repaired = repairAskOpenMarkers(raw);
    const starts = repaired.split(ASK_OPEN).length - 1;
    if (!starts && /<[^A-Za-z]{0,8}agentlas-ask/i.test(raw)) return "question_event_unverified";
    const parsed = extractAsks(repaired).asks;
    if (starts !== parsed.length || parsed.length !== observedKeys.length) return "question_event_unverified";
    for (let i = 0; i < parsed.length; i += 1) {
      const question = buildQuestion(parsed[i]);
      if (!question || JSON.stringify(question) !== observedKeys[i]) return "question_event_unverified";
    }
    return null;
  } catch {
    return "question_parse_failed";
  }
}

function parseArgs(args) {
  const flags = { runtime: null, print: false };
  const rest = [];
  const seen = new Set();
  let passthrough = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (passthrough) { rest.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    if (token === "--print" || token === "-p") {
      if (seen.has("print")) throw new Error("duplicate option: --print");
      seen.add("print");
      flags.print = true;
      continue;
    }
    if (token === "--runtime" || token.startsWith("--runtime=")) {
      if (seen.has("runtime")) throw new Error("duplicate option: --runtime");
      seen.add("runtime");
      const inline = token.startsWith("--runtime=");
      const value = inline ? token.slice(10) : args[++i];
      if (value === undefined || value === "" || (!inline && String(value).startsWith("--"))) {
        throw new Error("--runtime requires a value");
      }
      flags.runtime = String(value);
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unknown option: ${token} (use -- before a request that starts with '-')`);
    }
    rest.push(token);
  }
  return { flags, rest };
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) { ctx.out(usage(ko)); return 0; }

  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) {
    const typed = error && typeof error === "object" && typeof error.code === "string"
      ? error
      : buildError(String((error && error.message) || error));
    if (typeof ctx.fail === "function") ctx.fail(typed);
    else ctx.err(String(typed.message || typed));
    return 1;
  }
  const { flags, rest } = parsed;
  const request = rest.join(" ").trim();
  if (!request) {
    const error = buildError("✖ " + usage(ko));
    if (typeof ctx.fail === "function") ctx.fail(error);
    else ctx.err(error.message);
    return 1;
  }

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
    const error = e && typeof e === "object" && typeof e.message === "string"
      ? e
      : buildError(String(e), "RUNTIME_RESOLUTION_FAILED");
    if (typeof error.code !== "string") error.code = "RUNTIME_RESOLUTION_FAILED";
    if (typeof ctx.fail === "function") ctx.fail(error);
    else ctx.err(error.message);
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
    if (typeof renderer._render === "function") {
      const render = renderer._render.bind(renderer);
      renderer._render = (event) => {
        if (!event) return;
        if (event.type !== "ask") return render(event);
        const question = buildQuestion(event.payload);
        if (question) return render({ ...event, payload: question });
      };
    }
    renderer.attach(session, { replay: false });
    ctx.err(ctx.uiInstance.c.dim(`${agent.slug} · ${runtime.kind}${runtime.model ? ` · ${runtime.model}` : ""}`));
  }

  const questions = [];
  const questionKeys = new Set();
  const observedKeys = [];
  let questionEvents = 0;
  let questionProblem = null;
  let res;
  try { res = await session.send(request); }
  finally {
    if (renderer) renderer.detach();
  }
  const finalText = (res && (res.finalText || res.text)) || "";
  if (flags.print && finalText) process.stdout.write(finalText.trimEnd() + "\n");

  if (session.status !== "done" || (res && res.error)) {
    // The renderer already drew the reason as its own line (session.lastErrorAnnounced): do not say it a second time.
    if (session.status === "failed" && session.lastErrorAnnounced) return 1;
    const error = session.lastError && typeof session.lastError === "object" && typeof session.lastError.message === "string"
      ? session.lastError
      : buildError(String(session.lastError || (res && res.error) || (session.status === "killed"
        ? (ko ? "빌드가 취소되었습니다." : "The build was cancelled.")
        : (ko ? "빌드 완료를 확인할 수 없습니다." : "The build session did not complete."))),
      session.status === "killed" ? "BUILD_CANCELLED" : "BUILD_FAILED");
    if (typeof error.code !== "string") error.code = "BUILD_FAILED";
    reportBuildError(ctx, error);
    return 1;
  }

  try {
    if (typeof session.eventsTail !== "function") throw new Error("question events unavailable");
    const events = session.eventsTail(2000);
    if (!Array.isArray(events)) throw new Error("question events unavailable");
    for (const event of events) {
      if (!event || event.type !== "ask") continue;
      questionEvents += 1;
      if (questionEvents > MAX_BUILD_QUESTION_EVENTS) { questionProblem = "question_event_limit"; break; }
      const question = buildQuestion(event.payload);
      if (!question) { questionProblem = "question_event_invalid"; continue; }
      const key = JSON.stringify(question);
      observedKeys.push(key);
      if (questionKeys.has(key)) continue;
      if (questions.length >= MAX_BUILD_QUESTIONS) { questionProblem = "question_limit"; break; }
      questionKeys.add(key);
      questions.push(question);
    }
  } catch {
    questionProblem = "question_events_unavailable";
  }
  questionProblem ||= checkQuestionMarkers(res, observedKeys);
  if (questionProblem) {
    const error = buildError(ko
      ? "질문 결과를 확인할 수 없어 터미널의 자동 설치를 실행하지 않았습니다. 빌더가 파일을 만들었을 수 있습니다. 요청을 확인하고 다시 실행하세요."
      : "The question result could not be verified, so Terminal did not run auto-import. The builder may have created files. Review the request and retry.",
    "BUILD_QUESTION_UNVERIFIED");
    error.details = { status: "unverified", reasonCode: questionProblem, executionStarted: true,
      automaticImportAttempted: false, automaticResumeAvailable: false };
    reportBuildError(ctx, error);
    return 1;
  }
  if (questions.length) {
    const rows = questions.flatMap((q, index) => [
      `${index + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}${q.multiSelect ? (ko ? " (복수 선택 가능)" : " (multiple selections allowed)") : ""}`,
      ...q.options.map((o, i) => `   ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
    ]);
    const summary = ko
      ? `NEEDS_INPUT: 질문 ${questions.length}개에 대한 답이 필요합니다. 터미널의 자동 설치는 실행하지 않았고, 빌더가 파일을 만들었을 수 있습니다. 현재 호출은 재개할 수 없으므로 답과 기존 요청을 함께 넣어 다시 실행해 주세요.`
      : `NEEDS_INPUT: ${questions.length} question(s) require answers. Terminal did not run auto-import; the builder may have created files. This invocation cannot resume. Re-run with the answers and the original request.`;
    const format = ctx.output && ctx.output.format;
    if (flags.print && (ctx.surface === "shell" || (format !== "json" && format !== "yaml"))) {
      for (const row of rows) ctx.err(row);
    }
    // The shared YAML error renderer omits details, so retain the full list in
    // its message. JSON carries the structured questions in details.
    const error = buildError(format === "yaml" && ctx.surface !== "shell" ? `${summary}\n${rows.join("\n")}` : summary,
      "BUILD_NEEDS_INPUT");
    error.details = { status: "needs_input", source: "session_event", questions, executionStarted: true,
      automaticImportAttempted: false, automaticResumeAvailable: false, originalRequestAutomaticallyRetained: false };
    reportBuildError(ctx, error);
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

module.exports = { run, parseArgs };
