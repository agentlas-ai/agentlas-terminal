#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { Ui, stripAnsi } = require("../engine/agentlas-ui.cjs");
const { buildComposerFrame, createComposer, visWidth, splitWidth, wrapWidth } = require("../engine/agentlas-composer.cjs");
const { runNativeTurn } = require("../engine/agentlas-native-host.cjs");
const terminalInput = require("../engine/agentlas-input.cjs");
const terminalConfig = require("../engine/agentlas-config.cjs");
const i18n = require("../engine/agentlas-i18n.cjs");
const banner = require("../engine/agentlas-banner.cjs");
const { makeMemoryGuard, makeStyleGuard, sanitizeShellDisplay } = require("../engine/agentlas-repl.cjs");
const { formatTopLevelRows, localizedTopLevelUsage } = require("../engine/agentlas.cjs");

function palette() {
  const id = (value) => String(value);
  return { faint: id, emerald: id, text: id, paw: id, amber: id, blue: id, dim: id, inverse: id };
}

function testLocalizedTopLevelRuntimeErrors() {
  assert.equal(
    i18n.t("ko", "runtimeUnknown", "future"),
    "알 수 없는 런타임: future (claude-code|codex|gemini)",
  );
  assert.match(i18n.t("ko", "runtimeUnavailable"), /^사용 가능한 런타임이 없습니다\./);
}

function testLocalizedRuntimeFailureWiring() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-runtime-i18n-"));
  terminalConfig.updatePrefs(userData, {
    onboarded: true,
    lang: "ko",
    runtime: "claude-code",
    permission: "write",
  });
  const enginePath = path.resolve(__dirname, "../engine/agentlas.cjs");
  const worker = [
    `const terminal=require(${JSON.stringify(enginePath)});`,
    'terminal.resolveRuntime({prepare(){throw new Error("no database");}}, "future");',
  ].join("");
  const result = spawnSync(process.execPath, ["-e", worker], {
    encoding: "utf8",
    env: { ...process.env, AGENTLAS_USER_DATA_DIR: userData, NO_COLOR: "1" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "✖ 알 수 없는 런타임: future (claude-code|codex|gemini)\n");
  assert.doesNotMatch(result.stderr, /Unknown runtime:|First run:/);
  fs.rmSync(userData, { recursive: true, force: true });
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

function resizableStream({ columns = 88, rows = 24 } = {}) {
  const stream = new EventEmitter();
  let value = "";
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.write = (chunk) => { value += String(chunk); return true; };
  stream.value = () => value;
  return stream;
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
  return stripAnsi(value).replace(/\x1b[78]/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function virtualScreen(value) {
  const input = stripAnsi(value);
  const rows = [[]];
  let row = 0;
  let col = 0;
  let saved = null;
  const ensure = () => { while (rows.length <= row) rows.push([]); };
  for (let index = 0; index < input.length; ) {
    if (input[index] === "\x1b" && (input[index + 1] === "7" || input[index + 1] === "8")) {
      if (input[index + 1] === "7") saved = { row, col };
      if (input[index + 1] === "8" && saved) {
        row = saved.row;
        col = saved.col;
        ensure();
      }
      index += 2;
      continue;
    }
    if (input[index] === "\x1b" && input[index + 1] === "[") {
      const match = /^\x1b\[([0-9;]*)([AHJKrsu])/.exec(input.slice(index));
      if (match) {
        const amount = Number(match[1] || (match[2] === "A" ? 1 : 0));
        if (match[2] === "A") row = Math.max(0, row - amount);
        if (match[2] === "H") {
          const [targetRow = "1", targetCol = "1"] = match[1].split(";");
          row = Math.max(0, Number(targetRow || 1) - 1);
          col = Math.max(0, Number(targetCol || 1) - 1);
          ensure();
        }
        if (match[2] === "K") {
          rows[row] = [];
        }
        if (match[2] === "J") {
          rows[row] = rows[row].slice(0, col);
          rows.length = row + 1;
        }
        if (match[2] === "s") saved = { row, col };
        if (match[2] === "u" && saved) {
          row = saved.row;
          col = saved.col;
          ensure();
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

function testGraphemeAwareWidthWrapping() {
  const copy = "workspace + runtime temp writes; external MCP off";
  const lines = wrapWidth(copy, 18);
  assert.equal(lines.join(" "), copy);
  for (const line of lines) assert.ok(visWidth(line) <= 18, `wrapped line overflowed: ${line}`);

  const unicode = "가족 👨‍👩‍👧‍👦 작업 공간·임시 경로";
  const unicodeLines = wrapWidth(unicode, 12);
  assert.equal(unicodeLines.join(" "), unicode);
  assert.doesNotMatch(unicodeLines.join(""), /\uFFFD/, "wrapping must preserve complete grapheme clusters");
  for (const line of unicodeLines) assert.ok(visWidth(line) <= 12, `Unicode wrapped line overflowed: ${line}`);

  const longToken = wrapWidth("AGENTLAS_SESSION", 8);
  assert.equal(longToken.join(""), "AGENTLAS_SESSION");
  for (const line of longToken) assert.ok(visWidth(line) <= 8, `long token overflowed: ${line}`);

  const exact = "  +가족 👨‍👩‍👧‍👦  keeps  spacing";
  const exactLines = splitWidth(exact, 9);
  assert.equal(exactLines.join(""), exact, "hard display wrapping must preserve diff whitespace and graphemes byte-for-byte");
  for (const line of exactLines) assert.ok(visWidth(line) <= 9, `exact split line overflowed: ${line}`);
}

function testNarrowUiMessagesWrap() {
  for (const lang of ["en", "ko"]) {
    const stream = captureStream({ columns: 40 });
    const ui = new Ui({ color: false, lang, stream });
    ui.info(lang === "ko"
      ? "이미 충분히 compact 상태입니다 (123개 메시지)"
      : "context is already compact (123 messages)");
    ui.warn(lang === "ko"
      ? "알 수 없는 명령: /companies. / 를 입력하면 명령 목록이 열립니다."
      : "unknown command: /companies. Type / for the command list.");
    ui.error(lang === "ko"
      ? "에이전트 없음: 아주-긴-에이전트-식별자"
      : "no agent: a-very-long-agent-identifier");
    for (const line of stream.value().trimEnd().split("\n")) {
      assert.ok(visWidth(line) <= 40, `${lang} narrow UI message overflowed: ${line}`);
    }
    assert.match(stream.value(), /companies/, "wrapping must preserve the command that caused the warning");
  }
}

function testTopLevelTerminalWrappingAndUsageLocalization() {
  for (const width of [40, 80]) {
    const rows = formatTopLevelRows(
      "  storm <goal>  Agentlas Goal+UltraCode harness: plan → allocate → execute → verify [--research]",
      width,
    );
    assert.ok(rows.length > 1);
    for (const row of rows) assert.ok(visWidth(row) <= width, `top-level row overflowed at ${width}: ${row}`);
    assert.match(rows.slice(1).join("\n"), /↳/, "wrapped terminal information needs a visible continuation marker");
  }
  assert.match(localizedTopLevelUsage("automation", "ko"), /^사용법:/);
  assert.match(localizedTopLevelUsage("automation", "ko"), /\[인자\]/);
  assert.match(localizedTopLevelUsage("automation", "en"), /^usage:/);
  const tokenRows = formatTopLevelRows(
    "  install <slug>  install an agent from the Hub and keep cloud search readable",
    40,
  );
  assert.doesNotMatch(tokenRows.join("\n"), /cloud s\n.*earch/, "wrapping must not split an ordinary command token");
}

function testShellDisplayControlSanitization() {
  const safe = sanitizeShellDisplay(
    "\x1b[31mREADY\x1b[0m\rprogress\x1b[2J\x1b]0;spoofed\x07\nDONE\u0000",
  );
  assert.equal(safe, "READY\nprogress\nDONE");
  assert.doesNotMatch(safe, /\x1b|\u0000/, "shell output must not control or spoof Agentlas chrome");
}

function testQuotedCommandTokenization() {
  assert.deepEqual(
    terminalInput.tokenizeCommandLine('plan --query "Agentlas Terminal UI" --loadout safe'),
    ["plan", "--query", "Agentlas Terminal UI", "--loadout", "safe"],
  );
  assert.deepEqual(
    terminalInput.tokenizeCommandLine("read 'https://example.com/a b' --max-requests 1"),
    ["read", "https://example.com/a b", "--max-requests", "1"],
  );
  assert.deepEqual(terminalInput.tokenizeCommandLine('search ""'), ["search", ""]);
  assert.throws(() => terminalInput.tokenizeCommandLine('plan --query "unfinished'), /unclosed quote/);
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

  for (const lang of ["en", "ko"]) {
    const narrowStream = captureStream({ columns: 40 });
    const narrowUi = new Ui({ color: false, lang, stream: narrowStream });
    banner.renderBanner({
      ui: narrowUi,
      version: "0.9.8",
      runtimeLabel: "codex",
      subjectLabel: null,
      permission: "write",
      cwd: "/tmp/project",
    });
    for (const line of narrowStream.value().split("\n")) {
      assert.ok(visWidth(line) <= 40, `${lang} 40-column banner overflowed: ${line}`);
    }
    assert.match(narrowStream.value(), /Agent OS/, "narrow responsive banner must keep its product identity readable");
  }

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

function testMemoryGuardHidesCommentEnvelope() {
  const stream = captureStream({ columns: 100 });
  const ui = new Ui({ color: false, lang: "en", stream });
  const guard = makeMemoryGuard(makeStyleGuard(ui), "## Memory Events");
  guard.streamStart();
  for (const chunk of ["visible answer\n\n<!", "--\n## Memory", " Events\n```json\n{}\n```\n-->"]) {
    guard.streamDelta(chunk);
  }
  guard.streamEnd();
  assert.match(stream.value(), /visible answer/);
  assert.doesNotMatch(stream.value(), /<!--|Memory Events|```json/, "private memory envelope must never leak into live output");
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`history worker exited ${code}: ${stderr}`));
    });
  });
}

async function testConcurrentHistoryPersistenceAndRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-history-regression-"));
  const userData = path.join(root, "user");
  const scopeA = path.join(root, "project-a");
  const scopeB = path.join(root, "project-b");
  fs.mkdirSync(scopeA);
  fs.mkdirSync(scopeB);
  const inputModule = path.resolve(__dirname, "../engine/agentlas-input.cjs");
  const worker = [
    `const input=require(${JSON.stringify(inputModule)});`,
    "const ok=input.saveHistory([process.argv[1]], process.argv[2]);",
    "process.exit(ok ? 0 : 2);",
  ].join("");
  const children = [];
  for (let index = 0; index < 12; index++) {
    const scope = index % 2 ? scopeA : scopeB;
    const child = spawn(process.execPath, ["-e", worker, `entry-${index}`, scope], {
      env: { ...process.env, AGENTLAS_USER_DATA_DIR: userData },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(waitForChild(child));
  }
  await Promise.all(children);
  const file = path.join(userData, "cli-history.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.version, 2);
  assert.equal(document.entries.length, 12, "serialized read-merge-write must preserve every concurrent scope update");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const previousUserData = process.env.AGENTLAS_USER_DATA_DIR;
  process.env.AGENTLAS_USER_DATA_DIR = userData;
  assert.equal(terminalInput.loadHistory(scopeA).length, 6);
  assert.equal(terminalInput.loadHistory(scopeB).length, 6);

  fs.writeFileSync(file, "{\"version\":2", { mode: 0o600 });
  assert.equal(terminalInput.saveHistory(["recovered"], scopeA), true);
  const recovered = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(recovered.entries.some((entry) => entry.text === "recovered" && entry.cwd === scopeA));
  assert.ok(
    fs.readdirSync(userData).some((name) => name.startsWith("cli-history.json.corrupt-")),
    "malformed primary history must be quarantined before recovery",
  );

  const prefsDir = path.join(root, "prefs");
  const configModule = path.resolve(__dirname, "../engine/agentlas-config.cjs");
  const configWorker = [
    `const config=require(${JSON.stringify(configModule)});`,
    "const patch=JSON.parse(process.argv[2]);",
    "process.exit(config.updatePrefs(process.argv[1],patch) ? 0 : 2);",
  ].join("");
  await Promise.all([
    waitForChild(spawn(process.execPath, ["-e", configWorker, prefsDir, JSON.stringify({ autoStorm: true })], {
      stdio: ["ignore", "ignore", "pipe"],
    })),
    waitForChild(spawn(process.execPath, ["-e", configWorker, prefsDir, JSON.stringify({ autoNetwork: true })], {
      stdio: ["ignore", "ignore", "pipe"],
    })),
  ]);
  assert.deepEqual(
    { autoStorm: terminalConfig.loadPrefs(prefsDir).autoStorm, autoNetwork: terminalConfig.loadPrefs(prefsDir).autoNetwork },
    { autoStorm: true, autoNetwork: true },
    "concurrent preference patches must merge instead of acknowledging a lost update",
  );
  assert.equal(fs.statSync(terminalConfig.prefsPath(prefsDir)).mode & 0o777, 0o600);

  const helpDir = path.join(root, "help-only-user-data");
  fs.mkdirSync(helpDir);
  const launcher = path.resolve(__dirname, "../bin/agentlas.cjs");
  const helpCommands = [
    ["run", "--help"],
    ["login", "--help"],
    ["logout", "--help"],
    ["setup", "--help"],
    ["import", "--help"],
    ["experience", "validate", "--help"],
  ];
  await Promise.all(helpCommands.map((args) => waitForChild(spawn(process.execPath, [launcher, ...args], {
    env: { ...process.env, AGENTLAS_USER_DATA_DIR: helpDir },
    stdio: ["ignore", "ignore", "pipe"],
  }))));
  assert.deepEqual(
    fs.readdirSync(helpDir),
    [],
    "help must be handled before database bootstrap, runtime execution, auth, network, or onboarding",
  );

  if (previousUserData == null) delete process.env.AGENTLAS_USER_DATA_DIR;
  else process.env.AGENTLAS_USER_DATA_DIR = previousUserData;
  fs.rmSync(root, { recursive: true, force: true });
}

function testAppendOnlyTurnStatus() {
  const stream = captureStream({ tty: true, columns: 84 });
  const ui = new Ui({ color: false, lang: "ko", stream });
  ui.beginTurn({ permission: "write", permissionLabel: "읽기 + 쓰기", status: "codex · 자동 라우팅", usage: () => "토큰  codex 2.0k→800" });
  ui.status("Codex로 생각 중");
  ui.tool("Read", "/Users/mason/Documents/Agentlas_F/README.md");
  ui.toolResult("first\nsecond\nthird", true);
  ui.streamStart(true);
  ui.write("최종 답변\n");
  ui.streamEnd();
  ui.cost({ input_tokens: 4321, output_tokens: 876 });
  const afterFirstEnd = stream.value();
  assert.doesNotMatch(afterFirstEnd, /4321→876 tok/, "turn usage must not be duplicated as a transcript line");
  assert.doesNotMatch(afterFirstEnd, /\x1b\[[0-9;]*[HKr]|\x1b7|\x1b8/, "active turns must never reposition the cursor or reserve a scroll region");
  assert.match(afterFirstEnd, /● Read/);
  assert.match(afterFirstEnd, /최종 답변/);
  ui.streamEnd();
  assert.equal(stream.value(), afterFirstEnd, "a duplicate runtime streamEnd must not append output");
  ui.endTurn();
  const output = plainTerminal(stream.value());
  assert.match(output, /Codex로 생각 중/);
  assert.match(output, /Ctrl-C로 중단/);
  assert.equal((output.match(/Codex로 생각 중/g) || []).length, 1, "active status must be append-only and emitted once");
  assert.match(output, /● Read/);
  assert.match(output, /└ ✓ 3 lines read/);
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
  assert.doesNotMatch(plainTerminal(stream.value()), /CHECKLIST_GHOST_SENTINEL/, "task details start collapsed");

  input.emit("keypress", "\x14", { ctrl: true, name: "t" });
  assert.equal(ui._tasksExpanded, true);
  assert.match(plainTerminal(stream.value()), /CHECKLIST_GHOST_SENTINEL/);
  assert.equal(
    (plainTerminal(stream.value()).match(/CHECKLIST_GHOST_SENTINEL/g) || []).length,
    1,
    "Ctrl-T must append one task snapshot without repainting it",
  );
  input.emit("keypress", "\x14", { ctrl: true, name: "t" });
  assert.equal(ui._tasksExpanded, false);
  assert.equal(
    (plainTerminal(stream.value()).match(/CHECKLIST_GHOST_SENTINEL/g) || []).length,
    1,
    "hiding task details must preserve the immutable transcript without duplicating the snapshot",
  );
  assert.equal(
    (plainTerminal(stream.value()).match(/작업 상세를 숨겼습니다/g) || []).length,
    1,
    "hiding task details must append one truthful notice",
  );
  input.emit("keypress", "\x03", { ctrl: true, name: "c" });
  assert.equal(interrupted, 1, "raw-mode Ctrl-C must still interrupt the active turn");

  ui.endTurn();
  assert.equal(input.isRaw, false, "turn cleanup must restore prior terminal raw mode");
}

function testActiveTurnDoesNotRepaintOnResize() {
  const input = new FakeInput();
  const stream = resizableStream({ columns: 80, rows: 24 });
  const ui = new Ui({ color: false, lang: "en", stream, input });
  ui.beginTurn({ permission: "write", status: "Running shell…" });
  ui.status("Running shell");
  const before = stream.value().length;
  stream.columns = 40;
  stream.rows = 18;
  stream.emit("resize");
  const delta = stream.value().slice(before);
  assert.equal(delta, "", "active-turn resize must not repaint or mutate scrollback");
  assert.equal(stream.listenerCount("resize"), 0, "append-only active turns must not install a resize listener");
  ui.endTurn();
  assert.equal(stream.listenerCount("resize"), 0, "active-turn resize listener must be removed at turn end");
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
  const narrowPalette = terminalInput.renderSlashPalette(bareSlashRows, 0, { lang: "ko", columns: 40 });
  for (const line of narrowPalette.split("\n")) assert.ok(visWidth(line) <= 40, `40-column palette line overflowed: ${line}`);
  const careerRows = terminalInput.slashCommandSuggestions("/career", 12, "ko");
  const careerIndex = careerRows.findIndex((entry) => entry.examples?.length);
  assert.ok(careerIndex >= 0, "career palette fixture must include examples");
  const careerPalette = terminalInput.renderSlashPalette(careerRows, careerIndex, { lang: "ko", columns: 48 });
  for (const line of careerPalette.split("\n")) assert.ok(visWidth(line) <= 48, `localized examples line overflowed: ${line}`);
}

async function testComposerDoubleCtrlCExit() {
  const input = new FakeInput();
  const stream = captureStream({ tty: true, columns: 88 });
  const ui = new Ui({ color: false, lang: "ko", stream, input });
  const composer = createComposer({ ui, input, stream, loadHistory: () => [], saveHistory: () => {} });
  const pending = composer.read({ lang: "ko", permission: "write" });
  input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  assert.match(plainTerminal(stream.value()), /종료하려면 Ctrl-C를 한 번 더/);
  input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  assert.deepEqual(await pending, { exit: true }, "second idle Ctrl-C within the grace window must exit");
}

async function testComposerEscapePrefixedCtrlCClearsBuffer() {
  const input = new FakeInput();
  const stream = captureStream({ tty: true, columns: 80 });
  const ui = new Ui({ color: false, lang: "en", stream, input });
  const saved = [];
  const composer = createComposer({
    ui,
    input,
    stream,
    loadHistory: () => [],
    saveHistory: (history) => saved.push([...history]),
  });
  const pending = composer.read({
    lang: "en",
    permission: "read",
    suggest: (value) => value.startsWith("/per")
      ? [
          { command: "/permission", description: "permission level" },
          { command: "/permissions", description: "permission screen" },
        ]
      : [],
  });
  input.emit("keypress", "/per", { name: "/per", sequence: "/per" });
  input.emit("keypress", "\x1b[B", { name: "down", sequence: "\x1b[B" });
  input.emit("keypress", "\x1b[A", { name: "up", sequence: "\x1b[A" });
  // Actual macOS/tmux/Node behavior when Ctrl-C follows a lone Escape inside
  // the key decoder's prefix window: one meta event, not separate escape and
  // ctrl-c events.
  input.emit("keypress", "\x1b\x03", { name: "c", meta: true, ctrl: false, sequence: "\x1b\x03" });
  input.emit("keypress", "/permissions", { name: "/permissions", sequence: "/permissions" });
  input.emit("keypress", "\r", { name: "return", sequence: "\r" });
  assert.deepEqual(await pending, { value: "/permissions" });
  assert.deepEqual(saved.at(-1), ["/permissions"], "Escape-prefixed Ctrl-C must clear the prior slash selection");
}

async function testComposerBulkEditCoalescesRedraws() {
  const input = new FakeInput();
  const stream = captureStream({ tty: true, columns: 80 });
  const ui = new Ui({ color: false, lang: "en", stream, input });
  const composer = createComposer({ ui, input, stream, loadHistory: () => [], saveHistory: () => {} });
  const pending = composer.read({ lang: "en", permission: "write" });
  const beforePaste = stream.value().length;
  for (let index = 0; index < 512; index += 1) input.emit("keypress", "x", { name: "x" });
  await new Promise((resolve) => setImmediate(resolve));
  const pastedBytes = stream.value().length - beforePaste;
  assert.ok(pastedBytes < 5_000, `bulk paste should coalesce redraws, wrote ${pastedBytes} bytes`);

  const beforeDelete = stream.value().length;
  for (let index = 0; index < 512; index += 1) input.emit("keypress", "\x7f", { name: "backspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const deletedBytes = stream.value().length - beforeDelete;
  assert.ok(deletedBytes < 5_000, `bulk backspace should coalesce redraws, wrote ${deletedBytes} bytes`);
  input.emit("keypress", "\r", { name: "return" });
  assert.deepEqual(await pending, { value: "" });
}

async function testComposerRedrawsOnResize() {
  const input = new FakeInput();
  const stream = resizableStream({ columns: 80, rows: 24 });
  const ui = new Ui({ color: false, lang: "ko", stream, input });
  const composer = createComposer({ ui, input, stream, loadHistory: () => [], saveHistory: () => {} });
  const pending = composer.read({ lang: "ko", permission: "write", status: "codex · 자동 라우팅" });
  const before = stream.value().length;
  stream.columns = 40;
  stream.rows = 8;
  stream.emit("resize");
  await new Promise((resolve) => setImmediate(resolve));
  const resized = stream.value().slice(before);
  assert.ok(resized.length > 0, "resize must trigger a compositor write without waiting for a key");
  assert.match(plainTerminal(resized), /─{39}/, "resize repaint must use the new terminal width");
  input.emit("keypress", "\r", { name: "return" });
  assert.deepEqual(await pending, { value: "" });
  assert.equal(stream.listenerCount("resize"), 0, "completed reads must not leak resize listeners");
}

async function testComposerUnicodeGraphemeEditing() {
  assert.equal(visWidth("e\u0301"), 1, "combining mark must not add a terminal cell");
  assert.equal(visWidth("👨‍👩‍👧‍👦"), 2, "ZWJ emoji family must occupy one grapheme cell pair");
  assert.equal(visWidth("🇰🇷"), 2, "regional-indicator flag must occupy one grapheme cell pair");

  const runEdit = async (value, keys) => {
    const input = new FakeInput();
    const stream = captureStream({ tty: true, columns: 80 });
    const ui = new Ui({ color: false, lang: "en", stream, input });
    const composer = createComposer({ ui, input, stream, loadHistory: () => [], saveHistory: () => {} });
    const pending = composer.read({ lang: "en", permission: "write" });
    input.emit("keypress", value, { name: value });
    for (const [str, key] of keys) input.emit("keypress", str, key);
    input.emit("keypress", "\r", { name: "return" });
    return pending;
  };

  assert.deepEqual(
    await runEdit("/model 😀", [
      ["\x7f", { name: "backspace" }],
      ["OK", { name: "OK" }],
    ]),
    { value: "/model OK" },
    "Backspace must remove an emoji as one grapheme",
  );
  assert.deepEqual(
    await runEdit("/model A😀B", [
      ["", { name: "left" }],
      ["", { name: "left" }],
      ["X", { name: "x" }],
    ]),
    { value: "/model AX😀B" },
    "Left must never place the cursor inside a surrogate pair",
  );
  assert.deepEqual(
    await runEdit("/model 👨‍👩‍👧‍👦X", [
      ["", { name: "left" }],
      ["\x7f", { name: "backspace" }],
    ]),
    { value: "/model X" },
    "Backspace must remove a full ZWJ emoji cluster",
  );
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
  testLocalizedTopLevelRuntimeErrors();
  testLocalizedRuntimeFailureWiring();
  testComposerHierarchy();
  testGraphemeAwareWidthWrapping();
  testNarrowUiMessagesWrap();
  testTopLevelTerminalWrappingAndUsageLocalization();
  testShellDisplayControlSanitization();
  testQuotedCommandTokenization();
  testCompactLocalizedStartup();
  testCompactToolActivity();
  testMemoryGuardHidesCommentEnvelope();
  testAppendOnlyTurnStatus();
  testRuntimeTaskPanelAndCtrlT();
  testActiveTurnDoesNotRepaintOnResize();
  testCrossRuntimeTaskNormalization();
  await testShiftTabKeyboardAndLocalizedPalette();
  await testComposerDoubleCtrlCExit();
  await testComposerEscapePrefixedCtrlCClearsBuffer();
  await testComposerBulkEditCoalescesRedraws();
  await testComposerRedrawsOnResize();
  await testComposerUnicodeGraphemeEditing();
  await testCodexEventRendering();
  await testClaudeAndGeminiTaskEvents();
  await testConcurrentHistoryPersistenceAndRecovery();
  console.log("terminal-ui-regression: PASS");
}

main().then(() => {
  // Fake TTY/PipeWrap resources used by this regression can remain referenced
  // after every awaited assertion has completed. Exit only after main resolves
  // so the aggregate smoke runner does not hang at an already-passed suite.
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
