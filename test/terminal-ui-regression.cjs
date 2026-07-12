#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { Ui, stripAnsi } = require("../engine/agentlas-ui.cjs");
const { buildComposerFrame, createComposer, visWidth } = require("../engine/agentlas-composer.cjs");
const { runNativeTurn } = require("../engine/agentlas-native-host.cjs");
const terminalInput = require("../engine/agentlas-input.cjs");
const banner = require("../engine/agentlas-banner.cjs");
const { makeStyleGuard } = require("../engine/agentlas-repl.cjs");

function palette() {
  const id = (value) => String(value);
  return { faint: id, emerald: id, text: id, paw: id, amber: id, blue: id, dim: id, inverse: id };
}

function captureStream({ tty = false, columns = 88 } = {}) {
  let value = "";
  return {
    isTTY: tty,
    columns,
    write(chunk) { value += String(chunk); return true; },
    value() { return value; },
  };
}

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  setRawMode(value) { this.isRaw = Boolean(value); }
  resume() {}
}

function plainTerminal(value) {
  // SGR + cursor movement/erase sequences; the remaining text is enough for hierarchy assertions.
  return stripAnsi(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function virtualScreen(value) {
  const input = stripAnsi(value);
  const rows = [[]];
  let row = 0;
  let col = 0;
  const ensure = () => { while (rows.length <= row) rows.push([]); };
  for (let index = 0; index < input.length; ) {
    if (input[index] === "\x1b" && input[index + 1] === "[") {
      const match = /^\x1b\[([0-9]*)([AJ])/.exec(input.slice(index));
      if (match) {
        const amount = Number(match[1] || (match[2] === "A" ? 1 : 0));
        if (match[2] === "A") row = Math.max(0, row - amount);
        if (match[2] === "J") {
          rows[row] = rows[row].slice(0, col);
          rows.length = row + 1;
        }
        index += match[0].length;
        continue;
      }
    }
    const ch = input[index++];
    if (ch === "\r") { col = 0; continue; }
    if (ch === "\n") { row++; col = 0; ensure(); continue; }
    ensure();
    rows[row][col++] = ch;
  }
  return rows.map((line) => line.join("").replace(/\s+$/g, "")).join("\n").replace(/\n+$/g, "");
}

function testComposerHierarchy() {
  const state = { buf: "북마크 동기화 상태 확인", cur: 13, scroll: 0, suggest: [], suggestSel: 0 };
  const frame = buildComposerFrame(state, {
    glyph: "›",
    permission: "write",
    permissionLabel: "읽기 + 쓰기",
    status: "codex · 자동 라우팅 · / 명령 · ↑↓ history",
  }, palette(), 76);

  assert.equal(frame.lines.length, 4);
  assert.match(frame.lines[0], /^─{76}$/);
  assert.equal(frame.lines[1], "› 북마크 동기화 상태 확인");
  assert.match(frame.lines[2], /^─{76}$/);
  assert.match(frame.lines[3], /^◆ 읽기 \+ 쓰기  ·  codex/);
  assert.ok(visWidth(frame.lines[3]) <= 76, "status bar must not wrap and break redraw coordinates");
  assert.doesNotMatch(frame.lines.join("\n"), /[╭╮│╰╯]/, "composer must use the reference line hierarchy, not a large card");
  assert.equal(frame.curCol, 25, "Hangul cursor position must use terminal cell width");

  const warning = buildComposerFrame({ buf: "", cur: 0, scroll: 0, suggest: [], suggestSel: 0 }, {
    lang: "ko",
    permission: "write",
    confirmation: "무제한 권한은 승인과 샌드박스를 우회합니다 — 5초 안에 Shift-Tab을 다시 눌러 확인",
    confirmationTone: "danger",
  }, palette(), 48);
  for (const line of warning.lines) assert.ok(visWidth(line) <= 48, "permission warning must not wrap and corrupt redraw rows");

  // 연결 LLM 사용량 표시줄 — ctx.usage가 있으면 상태줄 아래 한 줄로 항상 렌더된다.
  const withUsage = buildComposerFrame({ buf: "", cur: 0, scroll: 0, suggest: [], suggestSel: 0 }, {
    lang: "ko",
    permission: "write",
    permissionLabel: "읽기 + 쓰기",
    status: "claude-code · 자동 라우팅",
    usage: "토큰  claude 12.3k→4.5k · codex 0 · gemini 0",
  }, palette(), 76);
  assert.equal(withUsage.lines.length, 5, "usage bar must add exactly one line under the status line");
  assert.match(withUsage.lines[4], /토큰 {2}claude 12\.3k→4\.5k · codex 0 · gemini 0/);
  for (const line of withUsage.lines) assert.ok(visWidth(line) <= 76, "usage bar must never overflow the box width");
  const usageFn = buildComposerFrame({ buf: "", cur: 0, scroll: 0, suggest: [], suggestSel: 0 }, {
    permission: "write",
    usage: () => "tokens  claude 1.0k→200",
  }, palette(), 76);
  assert.match(usageFn.lines[usageFn.lines.length - 1], /tokens {2}claude 1\.0k→200/, "usage may be a live getter");
}

function testCompactLocalizedStartup() {
  const stream = captureStream({ columns: 100 });
  const ui = new Ui({ color: false, lang: "ko", stream });
  banner.renderBanner({
    ui,
    version: "0.5.5-test",
    runtimeLabel: "codex",
    subjectLabel: null,
    permission: "write",
    cwd: "/tmp/project",
  });
  const output = stream.value();
  assert.match(output, /AGENTLAS.*v0\.5\.5-test.*Agent OS 터미널/);
  assert.match(output, /codex.*자동 라우팅.*작업 공간 쓰기/);
  assert.match(output, /Shift-Tab 권한/);
  assert.equal(output.trim().split("\n").length, 3, "startup chrome must stay compact");
  assert.doesNotMatch(output, /[╭╮│╰╯]/, "startup must not render the old oversized status card");
  assert.doesNotMatch(output, /████/, "startup must not render the six-row wordmark");

  const statusStream = captureStream({ columns: 48 });
  const statusUi = new Ui({ color: false, lang: "ko", stream: statusStream });
  banner.renderStatus({
    ui: statusUi,
    runtimeLabel: "Codex 0.144.1",
    subjectLabel: "자동 라우팅 에이전트",
    permission: "write",
    cwd: "/tmp/아주-긴-프로젝트-폴더",
  });
  for (const line of statusStream.value().split("\n")) {
    assert.ok(visWidth(line) <= 48, `localized /status line overflowed: ${line}`);
  }
}

function testCompactToolActivity() {
  const stream = captureStream({ columns: 96 });
  const ui = new Ui({ color: false, lang: "ko", stream });
  ui.tool(
    "Bash",
    "cd /Users/mason/Documents/Agentlas_F && python3 -m pytest tests -q && git status --short && npm run smoke",
  );
  ui.toolResult(["collecting...", "tests/test_sync.py .....", "5 passed in 17.8s"].join("\n"), true);
  const output = stream.value();
  assert.match(output, /● Bash  python3 -m pytest tests -q  ·  3 steps/);
  assert.match(output, /└ ✓ 5 passed in 17\.8s/);
  assert.match(output, /3 output lines/);
  assert.doesNotMatch(output, /\/Users\/mason\/Documents/, "redundant cwd must not dominate the activity line");
  assert.doesNotMatch(output, /tests\/test_sync\.py \.{5}/, "successful raw output should be summarized, not dumped");

  const pathToken = `ocm_${"example-not-a-real-token-123456789"}`;
  const secretStream = captureStream({ columns: 120 });
  const secretUi = new Ui({ color: false, lang: "ko", stream: secretStream });
  secretUi.tool("Bash", `curl https://opencrab.sh/api/mcp/${pathToken}`);
  assert.doesNotMatch(secretStream.value(), new RegExp(pathToken), "URL-embedded MCP credentials must never reach terminal activity output");
  assert.match(secretStream.value(), /opencrab\.sh\/api\/mcp\/\[redacted\]/);

  const explicit = captureStream({ columns: 96 });
  const explicitUi = new Ui({ color: false, lang: "ko", stream: explicit });
  explicitUi.tool("$ ls");
  explicitUi.toolResult("one.txt\ntwo.txt", true, { verbose: true });
  assert.match(explicit.value(), /one\.txt\n    two\.txt/, "explicit !shell output must remain inspectable");

  const narrow = captureStream({ columns: 48 });
  const narrowUi = new Ui({ color: false, lang: "ko", stream: narrow });
  narrowUi.tool("Bash", "한국어로 매우 긴 실행 명령을 작성하고 여러 디렉터리를 순회한 뒤 테스트를 수행합니다");
  narrowUi.toolResult("검증 결과: 한국어로 작성된 아주 긴 성공 결과 문장이 터미널 오른쪽 경계를 넘어가면 안 됩니다 SUCCESS", true);
  for (const line of narrow.value().trimEnd().split("\n")) {
    assert.ok(visWidth(line) <= 48, `48-column activity line overflowed (${visWidth(line)} cells): ${line}`);
  }
}

function testPersistentTurnFooter() {
  const stream = captureStream({ tty: true, columns: 84 });
  const ui = new Ui({ color: false, lang: "ko", stream });
  ui.beginTurn({ permission: "write", permissionLabel: "읽기 + 쓰기", status: "codex · 자동 라우팅", usage: () => "토큰  codex 2.0k→800" });
  ui.status("Codex로 생각 중");
  ui.tool("Read", "/Users/mason/Documents/Agentlas_F/README.md");
  ui.toolResult("first\nsecond\nthird", true);
  ui.streamStart(true);
  ui.write("최종 답변\n");
  ui.streamEnd();
  const afterFirstEnd = stream.value();
  const screen = virtualScreen(afterFirstEnd);
  assert.equal((screen.match(/^─+$/gm) || []).length, 2, "footer redraws must leave exactly two separators on screen");
  assert.equal((screen.match(/^›$/gm) || []).length, 1, "footer redraws must leave one composer anchor on screen");
  assert.match(screen, /● Read/);
  assert.match(screen, /최종 답변/);
  ui.streamEnd();
  assert.equal(stream.value(), afterFirstEnd, "a duplicate runtime streamEnd must not append a second footer");
  ui.endTurn();
  const output = plainTerminal(stream.value());
  assert.match(output, /› /, "the input anchor must remain visible during a turn");
  assert.match(output, /Codex로 생각 중/);
  assert.match(output, /ctrl-c로 중단/);
  assert.match(output, /읽기 \+ 쓰기/);
  assert.match(output, /● Read/);
  assert.match(output, /└ ✓ 3 lines read/);
  assert.match(output, /토큰 {2}codex 2\.0k→800/, "usage bar must stay visible in the persistent turn footer");
}

function testRuntimeTaskPanelAndCtrlT() {
  const input = new FakeInput();
  const stream = captureStream({ tty: true, columns: 92 });
  const ui = new Ui({ color: false, lang: "ko", stream, input });
  let interrupted = 0;
  ui.beginTurn({ permission: "write", permissionLabel: "작업 공간 쓰기", status: "codex", onInterrupt: () => { interrupted++; } });
  assert.equal(input.isRaw, true, "active turns need raw mode so macOS Ctrl-T is a key, not SIGINFO");

  ui.tool("Bash", "npm test");
  assert.equal(ui._turnTasks.length, 0, "ordinary tool activity must never be fabricated into a task plan");
  ui.applyTaskTool("TodoWrite", {
    todos: [
      { content: "CHECKLIST_GHOST_SENTINEL", activeForm: "CHECKLIST_GHOST_SENTINEL", status: "in_progress" },
      { content: "권한 회귀 테스트", status: "completed" },
      { content: "릴리스 확인", status: "pending" },
    ],
  }, "todo-1");
  assert.deepEqual(ui._turnTasks.map((task) => task.status), ["in_progress", "completed", "pending"]);
  assert.match(virtualScreen(stream.value()), /CHECKLIST_GHOST_SENTINEL/);
  const expandedRows = ui._footerDrawnRows;

  input.emit("keypress", "\x14", { ctrl: true, name: "t" });
  assert.equal(ui._tasksExpanded, false);
  assert.ok(ui._footerDrawnRows < expandedRows, "collapsed task surface must use fewer footer rows");
  assert.doesNotMatch(virtualScreen(stream.value()), /CHECKLIST_GHOST_SENTINEL/, "old task rows must be erased without ghosts");
  input.emit("keypress", "\x14", { ctrl: true, name: "t" });
  assert.equal(ui._tasksExpanded, true);
  input.emit("keypress", "\x03", { ctrl: true, name: "c" });
  assert.equal(interrupted, 1, "raw-mode Ctrl-C must still interrupt the active turn");

  ui.endTurn();
  assert.equal(input.isRaw, false, "turn cleanup must restore prior terminal raw mode");
}

function testCrossRuntimeTaskNormalization() {
  const stream = captureStream({ tty: false });
  const ui = new Ui({ color: false, lang: "en", stream });
  ui.applyTaskTool("write_todos", { todos: [{ description: "Gemini task", status: "in_progress" }] }, "g-1");
  assert.deepEqual(ui._turnTasks.map((task) => [task.label, task.status]), [["Gemini task", "in_progress"]]);
  ui.replaceTasks({ type: "todo_list", items: [{ text: "Codex task", completed: true }] }, "codex");
  assert.deepEqual(ui._turnTasks.map((task) => [task.label, task.status]), [["Codex task", "completed"]]);
  ui.applyTaskTool("TaskCreate", { subject: "Claude created task" }, "toolu-create-1");
  ui.applyTaskResult("TaskCreate", { task: { id: "1", subject: "Claude created task", status: "pending" } }, "toolu-create-1");
  ui.applyTaskTool("TaskUpdate", { taskId: "1", subject: "Claude created task", status: "in_progress" }, "toolu-update-1");
  assert.deepEqual(ui._turnTasks.at(-1), {
    id: "1",
    label: "Claude created task",
    status: "in_progress",
    source: "taskupdate",
  });
  const beforeGeneric = ui._turnTasks.map((task) => ({ ...task }));
  ui.applyTaskResult("Read", { id: "generic-1", title: "not a task" }, "toolu-read-1");
  assert.deepEqual(ui._turnTasks, beforeGeneric, "generic JSON tool results must never become fabricated tasks");
  ui.applyTaskResult("TaskList", { tasks: [] }, "toolu-list-empty");
  assert.deepEqual(ui._turnTasks, [], "an explicit empty TaskList must clear stale runtime tasks");
}

async function testShiftTabKeyboardAndLocalizedPalette() {
  const input = new FakeInput();
  const stream = captureStream({ tty: true, columns: 88 });
  const ui = new Ui({ color: false, lang: "ko", stream, input });
  const composer = createComposer({ ui, input, stream, loadHistory: () => [], saveHistory: () => {} });
  let cycles = 0;
  let cancels = 0;
  const pending = composer.read({
    lang: "ko",
    permission: "write",
    permissionLabel: "작업 공간 쓰기",
    onCyclePermission: () => {
      cycles++;
      return { permission: "write", permissionLabel: "작업 공간 쓰기", confirmation: "무제한 권한 확인 필요", confirmationTone: "danger" };
    },
    onPermissionCycleCancel: () => { cancels++; return { confirmation: null, confirmationTone: null }; },
  });
  input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
  assert.equal(cycles, 1, "Shift-Tab must reach the permission cycle handler");
  assert.match(plainTerminal(stream.value()), /! 무제한 권한 확인 필요/, "full escalation warning must be prominent, not a green success");
  input.emit("keypress", "", { name: "left" });
  assert.equal(cancels, 1, "a no-op navigation key must still disarm full escalation");
  assert.doesNotMatch(virtualScreen(stream.value()), /무제한 권한 확인 필요/, "disarmed full warning must be erased immediately");
  input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
  assert.equal(cycles, 2);
  input.emit("keypress", "x", { name: "x" });
  assert.equal(cancels, 2, "any non-Shift-Tab key must cancel an armed escalation");
  input.emit("keypress", "\r", { name: "return" });
  await pending;

  const koEntries = terminalInput.slashCommandEntries("ko");
  assert.equal(koEntries.filter((entry) => entry.command === "/install").length, 1, "command palette must dedupe /install");
  assert.match(koEntries.find((entry) => entry.command === "/help").description, /명령/);
  assert.doesNotMatch(koEntries.find((entry) => entry.command === "/help").description, /단축키 보기$/);
  const bareSlashRows = terminalInput.slashCommandSuggestions("/", 12, "ko");
  assert.ok(bareSlashRows.length > 0, "bare / must open the command palette instead of being treated as filesystem root");
  const paletteText = terminalInput.renderSlashPalette(bareSlashRows, 0, { lang: "ko", columns: 48 });
  assert.ok(paletteText.length > 0, "localized command palette must render content");
  for (const line of paletteText.split("\n")) assert.ok(visWidth(line) <= 48, `localized palette line overflowed: ${line}`);
  const careerRows = terminalInput.slashCommandSuggestions("/career", 12, "ko");
  const careerIndex = careerRows.findIndex((entry) => entry.examples?.length);
  assert.ok(careerIndex >= 0, "career palette fixture must include examples");
  const careerPalette = terminalInput.renderSlashPalette(careerRows, careerIndex, { lang: "ko", columns: 48 });
  for (const line of careerPalette.split("\n")) assert.ok(visWidth(line) <= 48, `localized examples line overflowed: ${line}`);
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
  kill() { return true; }
  finish() {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", 0));
  }
}

async function testCodexEventRendering() {
  const child = new FakeChild();
  const stream = captureStream({ columns: 100 });
  const ui = new Ui({ color: false, lang: "ko", stream });
  const guardedUi = makeStyleGuard(ui);
  const run = runNativeTurn({
    kind: "codex",
    bin: "fake-codex",
    prompt: "검증해",
    systemPrompt: "system",
    cwd: process.cwd(),
    permission: "read",
    session: {},
    env: {},
    prepareRuntimeEnv: false,
    ui: guardedUi,
    spawn: () => child,
    timeoutConfig: { idleMs: 1_000, totalMs: 2_000, killGraceMs: 20 },
  });

  setImmediate(() => {
    const events = [
      { type: "thread.started", thread_id: "thread-test" },
      { type: "turn.started" },
      { type: "item.updated", item: { id: "todo-1", type: "todo_list", items: [{ text: "Codex emitted task", completed: false }] } },
      { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "cd /tmp/project && npm test && git status --short" } },
      { type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "cd /tmp/project && npm test && git status --short", aggregated_output: "suite a\nsuite b\n12 passed in 2.3s", exit_code: 0 } },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "검증 완료" } },
      { type: "turn.completed", usage: { input_tokens: 120, output_tokens: 30 } },
    ];
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    child.finish();
  });

  const result = await run;
  const output = stream.value();
  assert.equal(result.text, "검증 완료");
  assert.match(output, /● Bash  npm test  ·  2 steps/);
  assert.match(output, /└ ✓ 12 passed in 2\.3s/);
  assert.doesNotMatch(output, /suite a\nsuite b/, "Codex event rendering must use the compact activity summary");
  assert.deepEqual(ui._turnTasks.map((task) => [task.label, task.status]), [["Codex emitted task", "pending"]]);
}

async function testClaudeAndGeminiTaskEvents() {
  const claudeChild = new FakeChild();
  const claudeUi = new Ui({ color: false, lang: "ko", stream: captureStream() });
  const guardedClaudeUi = makeStyleGuard(claudeUi);
  const claudeRun = runNativeTurn({
    kind: "claude-code",
    bin: "fake-claude",
    prompt: "검증",
    systemPrompt: "system",
    cwd: process.cwd(),
    permission: "read",
    session: {},
    env: {},
    ui: guardedClaudeUi,
    spawn: () => claudeChild,
    timeoutConfig: { idleMs: 1_000, totalMs: 2_000, killGraceMs: 20 },
  });
  setImmediate(() => {
    const todos = JSON.stringify({ todos: [{ content: "Claude emitted task", activeForm: "Spinning Claude phrase", status: "in_progress" }] });
    const create = JSON.stringify({ subject: "Claude created task", description: "real task", activeForm: "Creating task" });
    const update = JSON.stringify({ taskId: "1", subject: "Claude created task", status: "in_progress" });
    const events = [
      { type: "system", subtype: "init", session_id: "claude-test" },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "TodoWrite" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: todos } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-create", name: "TaskCreate" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: create } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-create", content: "Task #1 created successfully: Claude created task" }] },
        toolUseResult: { task: { id: "1", subject: "Claude created task", status: "pending" } },
      },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continuing" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-update", name: "TaskUpdate" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: update } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 2 } },
      { type: "result", result: "done", duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    for (const event of events) claudeChild.stdout.write(JSON.stringify(event) + "\n");
    claudeChild.finish();
  });
  await claudeRun;
  assert.deepEqual(claudeUi._turnTasks.map((task) => [task.id, task.label, task.status]), [
    ["todowrite:0", "Claude emitted task", "in_progress"],
    ["1", "Claude created task", "in_progress"],
  ], "guarded live path must correlate TaskCreate tool result id with later TaskUpdate without duplicates");

  const geminiChild = new FakeChild();
  const geminiUi = new Ui({ color: false, lang: "en", stream: captureStream() });
  const guardedGeminiUi = makeStyleGuard(geminiUi);
  const geminiRun = runNativeTurn({
    kind: "gemini",
    bin: "fake-gemini",
    prompt: "verify",
    systemPrompt: "system",
    cwd: process.cwd(),
    permission: "read",
    session: {},
    env: {},
    ui: guardedGeminiUi,
    spawn: () => geminiChild,
    timeoutConfig: { idleMs: 1_000, totalMs: 2_000, killGraceMs: 20 },
  });
  setImmediate(() => {
    const events = [
      { type: "init", session_id: "gemini-test" },
      { type: "tool_use", tool_id: "g-1", tool_name: "write_todos", parameters: { todos: [{ description: "Gemini emitted task", status: "pending" }] } },
      { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1, duration_ms: 1 } },
    ];
    for (const event of events) geminiChild.stdout.write(JSON.stringify(event) + "\n");
    geminiChild.finish();
  });
  await geminiRun;
  assert.deepEqual(geminiUi._turnTasks.map((task) => [task.label, task.status]), [["Gemini emitted task", "pending"]]);
}

async function main() {
  testComposerHierarchy();
  testCompactLocalizedStartup();
  testCompactToolActivity();
  testPersistentTurnFooter();
  testRuntimeTaskPanelAndCtrlT();
  testCrossRuntimeTaskNormalization();
  await testShiftTabKeyboardAndLocalizedPalette();
  await testCodexEventRendering();
  await testClaudeAndGeminiTaskEvents();
  console.log("terminal-ui-regression: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
