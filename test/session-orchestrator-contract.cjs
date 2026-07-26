"use strict";
/*
 * 세션/오케스트레이터 계약 테스트 (실 CLI 불필요 — fake spawn 주입).
 * 검증:
 *  1. 세션 턴이 chats/chat_messages에 영속된다 (메인=kind 'user').
 *  2. 서브세션은 kind='division' + parent_chat_id (데스크탑 division 패턴).
 *  3. 스트림 이벤트가 링버퍼에 쌓이고 최종 텍스트/usage가 세션에 남는다.
 *  4. 실행 중 send()는 큐잉되어 턴 종료 후 이어 실행된다(스티어링).
 *  5. resume 세션 ID + fingerprint가 chat_runtime_sessions에 저장된다.
 *  6. 오케스트레이터 list()가 트리(depth)를 보고한다.
 */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-orch-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmp;

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
bootstrapDbIfMissing();

const { openDb, seedBuiltins } = require("../engine/core/db.cjs");
const { Orchestrator } = require("../engine/sessions/orchestrator.cjs");

const db = openDb();
seedBuiltins(db);
const agentRow = db.prepare("SELECT * FROM installed_agents LIMIT 1").get();
assert.ok(agentRow, "builtin agent seeded");
const agent = { id: agentRow.id, slug: agentRow.slug, name: agentRow.name, systemPrompt: agentRow.system_prompt };

// ── fake claude-code child: stream-json 라인 방출 후 정상 종료 ──
function fakeClaudeSpawn(replyText) {
  return function spawnFake() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99999;
    child.kill = () => { child.emit("close", 143); return true; };
    setImmediate(() => {
      const lines = [
        { type: "system", subtype: "init", session_id: "sess-fake-1" },
        { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: replyText } } },
        { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
        { type: "result", result: replyText, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001, duration_ms: 5 },
      ];
      for (const l of lines) child.stdout.write(JSON.stringify(l) + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

const runtime = { kind: "claude-code", bin: "/nonexistent/claude-fake" };
const timeoutConfig = { idleMs: 5000, totalMs: 10000, killGraceMs: 100 };

(async () => {
  const orch = new Orchestrator({ db, lang: "ko" });

  // 1+3+5: 메인 세션 한 턴
  const main = orch.spawn({
    agent, runtime, permission: "read", cwd: tmp,
    spawnImpl: fakeClaudeSpawn("안녕하세요, 결과입니다."),
    timeoutConfig,
  });
  const res = await main.send("테스트 프롬프트");
  assert.equal(main.status, "done", `main session done (got ${main.status}: ${main.lastError})`);
  assert.match((res.finalText || res.text), /결과입니다/);
  assert.ok(main.usage && main.usage.output_tokens === 5, "usage recorded");

  const chatRow = db.prepare("SELECT * FROM chats WHERE id=?").get(main.chatId);
  assert.equal(chatRow.kind, "user");
  const msgs = db.prepare("SELECT role, text FROM chat_messages WHERE chat_id=? ORDER BY created_at").all(main.chatId);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");

  const rt = db.prepare("SELECT session_id, fingerprint FROM chat_runtime_sessions WHERE chat_id=?").get(main.chatId);
  assert.ok(rt && rt.session_id === "sess-fake-1", "resume session persisted");
  assert.equal(rt.fingerprint, main.fingerprint);

  const streamEvents = main.eventsTail().filter((e) => e.type === "stream-delta");
  assert.ok(streamEvents.length >= 1, "stream events recorded");

  // 2+6: division 서브세션 + 트리
  const sub = orch.spawn({
    agent, runtime, permission: "read", cwd: tmp,
    parentKey: main.key, activate: false,
    spawnImpl: fakeClaudeSpawn("서브 결과."),
    timeoutConfig,
  });
  await sub.send("서브 작업");
  const subChat = db.prepare("SELECT kind, parent_chat_id FROM chats WHERE id=?").get(sub.chatId);
  assert.equal(subChat.kind, "division");
  assert.equal(subChat.parent_chat_id, main.chatId);

  const rows = orch.list();
  const subRow = rows.find((r) => r.key === sub.key);
  assert.equal(subRow.depth, 1, "subagent shown as child in tree");
  assert.equal(subRow.parentKey, main.key);

  // 4: 스티어링 큐 — 실행 중 send()가 큐에 쌓였다가 이어 실행
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  let turnCount = 0;
  const slowSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99998;
    child.kill = () => { child.emit("close", 143); return true; };
    turnCount += 1;
    const n = turnCount;
    (async () => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: `sess-slow-${n}` }) + "\n");
      if (n === 1) await gate; // 첫 턴은 스티어 큐잉 확인까지 대기
      child.stdout.write(JSON.stringify({ type: "result", result: `turn-${n}` }) + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    })();
    return child;
  };
  const steered = orch.spawn({
    agent, runtime, permission: "read", cwd: tmp, activate: false,
    spawnImpl: slowSpawn, timeoutConfig,
  });
  const firstTurn = steered.send("첫 지시");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(steered.isBusy(), true, "first turn running");
  steered.send("스티어링 지시");
  assert.equal(steered.queue.length, 1, "steer queued while busy");
  resolveGate();
  await firstTurn;
  assert.equal(steered.queue.length, 0, "queue drained");
  assert.equal(turnCount, 2, "steered message ran as follow-up turn");
  assert.equal(steered.status, "done");

  // 정리
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("session-orchestrator-contract: OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
