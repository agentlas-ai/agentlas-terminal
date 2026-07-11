#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { Ui, stripAnsi } = require("../engine/agentlas-ui.cjs");
const { buildComposerFrame, visWidth } = require("../engine/agentlas-composer.cjs");
const { runNativeTurn } = require("../engine/agentlas-native-host.cjs");

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
  ui.beginTurn({ permission: "write", permissionLabel: "읽기 + 쓰기", status: "codex · 자동 라우팅" });
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
  const run = runNativeTurn({
    kind: "codex",
    bin: "fake-codex",
    prompt: "검증해",
    systemPrompt: "system",
    cwd: process.cwd(),
    permission: "read",
    session: {},
    env: {},
    ui,
    spawn: () => child,
    timeoutConfig: { idleMs: 1_000, totalMs: 2_000, killGraceMs: 20 },
  });

  setImmediate(() => {
    const events = [
      { type: "thread.started", thread_id: "thread-test" },
      { type: "turn.started" },
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
}

async function main() {
  testComposerHierarchy();
  testCompactToolActivity();
  testPersistentTurnFooter();
  await testCodexEventRendering();
  console.log("terminal-ui-regression: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
