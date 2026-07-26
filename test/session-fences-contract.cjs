"use strict";
/*
 * 세션 펜스 프로토콜 계약 테스트 (오프라인 — fake spawn 주입, 실 CLI 불필요).
 *
 * Desktop runner(electron/mcp/client.ts)가 파싱하는 4개 숨은 펜스의 터미널 패리티 검증:
 *  1. cleanText 영속 — ## Memory Events / ## Delegate / ## Automation /
 *     <<agentlas-ask>> 블록이 chat_messages 에 남지 않는다.
 *  2. ## Delegate → division 자식 세션이 스폰되어 실제로 실행된다.
 *  3. ## Automation → automations 행 + 유효한 next_run_at (미래 시각).
 *  4. <<agentlas-ask>> → 세션 이벤트 {type:'ask', payload} 로 표면화.
 *  5. 메모리 이벤트는 curate 게이트를 통과한다 — write 권한만 durable 쓰기,
 *     read 권한은 영수증 이벤트만(memory_entries 행 없음, 자동화 등록도 거부).
 *  6. 오케스트레이터 동시 상한 초과 위임은 조용한 큐잉이 아니라 'delegate-refused'.
 */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-fences-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmp;
process.env.AGENTLAS_MAX_PARALLEL = "4";
// 명시 초기화된 프로젝트 경계(.agentlas 존재) — project 스코프 메모리 쓰기 허용 조건.
fs.mkdirSync(path.join(tmp, ".agentlas"), { recursive: true });

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
bootstrapDbIfMissing();

const { openDb, seedBuiltins } = require("../engine/core/db.cjs");
const { Orchestrator } = require("../engine/sessions/orchestrator.cjs");

const db = openDb();
seedBuiltins(db);
const agentRow = db.prepare("SELECT * FROM installed_agents LIMIT 1").get();
assert.ok(agentRow, "builtin agent seeded");
const agent = { id: agentRow.id, slug: agentRow.slug, name: agentRow.name, systemPrompt: agentRow.system_prompt };

const runtime = { kind: "claude-code", bin: "/nonexistent/claude-fake" };
const timeoutConfig = { idleMs: 5000, totalMs: 10000, killGraceMs: 100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake claude-code child: 호출 순서별 응답 시퀀스 방출 후 정상 종료 ──
function fakeSequenceSpawn(replies) {
  let call = 0;
  return function spawnFake() {
    const replyText = replies[Math.min(call, replies.length - 1)];
    call += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99999;
    child.kill = () => { child.emit("close", 143); return true; };
    setImmediate(() => {
      const lines = [
        { type: "system", subtype: "init", session_id: `sess-fence-${call}` },
        { type: "result", result: replyText, usage: { input_tokens: 10, output_tokens: 5 } },
      ];
      for (const l of lines) child.stdout.write(JSON.stringify(l) + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

const WRITE_MEMORY = "터미널 펜스 계약: write 권한 세션의 큐레이션 사실 기록";
const READ_MEMORY = "터미널 펜스 계약: read 권한 세션은 이 사실을 절대 쓰면 안 된다";

// 4개 펜스가 전부 들어간 fake 응답 (wire format = Desktop 그대로).
const FENCE_REPLY = [
  "결과 요약입니다.",
  "",
  "<<agentlas-ask>>",
  JSON.stringify({
    question: "어느 방향으로 진행할까요?",
    header: "Direction",
    multiSelect: false,
    options: [
      { label: "A안", description: "보수적 접근" },
      { label: "B안", description: "공격적 접근" },
    ],
  }),
  "<</agentlas-ask>>",
  "",
  "## Delegate",
  "```json",
  JSON.stringify({
    delegations: [{
      target: "researcher",
      brief: "핵심 조사 수행",
      allocation: { tier: "economy", effort: "low", phase: "delegate", rationale: "bounded verification", reasonCodes: ["bounded-scope"] },
    }],
  }),
  "```",
  "",
  "## Automation",
  "```json",
  JSON.stringify([{
    name: "daily-brief",
    prompt: "아침 브리핑 생성",
    schedule: { preset: "daily", time: "09:30", tz: "Asia/Seoul" },
  }]),
  "```",
  "",
  "## Memory Events",
  "```json",
  JSON.stringify([{
    memory_kind: "fact",
    content: WRITE_MEMORY,
    suggested_scope: "project",
    confidence: "high",
    sensitivity: "internal",
    evidence_refs: ["test:session-fences-contract"],
  }]),
  "```",
].join("\n");

const READ_REPLY = [
  "읽기 전용 결과입니다.",
  "",
  "## Automation",
  "```json",
  JSON.stringify([{ name: "read-auto", prompt: "이건 등록되면 안 된다", schedule: { preset: "daily", time: "08:00", tz: "Asia/Seoul" } }]),
  "```",
  "",
  "## Memory Events",
  "```json",
  JSON.stringify([{
    memory_kind: "fact",
    content: READ_MEMORY,
    suggested_scope: "project",
    confidence: "high",
    sensitivity: "internal",
    evidence_refs: ["test:session-fences-contract"],
  }]),
  "```",
].join("\n");

const DELEGATE_ONLY_REPLY = [
  "위임 시도 결과입니다.",
  "",
  "## Delegate",
  "```json",
  JSON.stringify({ delegations: [{ target: "helper", brief: "보조 작업" }] }),
  "```",
].join("\n");

(async () => {
  const orch = new Orchestrator({ db, lang: "ko" });

  /* ── 1~5(write): 4펜스 응답 한 턴 ───────────────────────────────────── */
  const main = orch.spawn({
    agent, runtime, permission: "write", cwd: tmp,
    spawnImpl: fakeSequenceSpawn([FENCE_REPLY, "서브 조사 완료."]),
    timeoutConfig,
  });
  await main.send("펜스 계약 테스트");
  assert.equal(main.status, "done", `main done (got ${main.status}: ${main.lastError})`);

  // 1. cleanText 영속 — 펜스는 chat_messages 에 남지 않는다.
  const msgs = db.prepare("SELECT role, text FROM chat_messages WHERE chat_id=? ORDER BY created_at").all(main.chatId);
  const assistantMsg = msgs.find((m) => m.role === "assistant");
  assert.ok(assistantMsg, "assistant message persisted");
  assert.equal(assistantMsg.text, "결과 요약입니다.", "cleanText persisted exactly");
  for (const marker of ["## Delegate", "## Automation", "## Memory Events", "<<agentlas-ask>>", "<</agentlas-ask>>"]) {
    assert.ok(!assistantMsg.text.includes(marker), `persisted text must not contain ${marker}`);
  }
  // 링버퍼 turn-end 표시 이벤트도 cleanText.
  const turnEnd = main.eventsTail().find((e) => e.type === "turn-end" && e.ok);
  assert.equal(turnEnd.text, "결과 요약입니다.", "turn-end event carries cleanText");

  // 4. ask 이벤트 표면화.
  const askEv = main.eventsTail().find((e) => e.type === "ask");
  assert.ok(askEv, "ask event emitted");
  assert.equal(askEv.payload.question, "어느 방향으로 진행할까요?");
  assert.equal(askEv.payload.options.length, 2);
  assert.equal(askEv.payload.options[0].label, "A안");

  // 2. delegate → division 자식 세션이 스폰되어 실행 완료.
  const spawnEv = main.eventsTail().find((e) => e.type === "delegate-spawned");
  assert.ok(spawnEv, "delegate-spawned event emitted");
  assert.equal(spawnEv.target, "researcher");
  assert.equal(spawnEv.allocation && spawnEv.allocation.tier, "economy", "AI-authored allocation normalized");
  const child = [...orch.sessions.values()].find((s) => s.parent === main);
  assert.ok(child, "delegate child session exists under parent");
  for (let i = 0; i < 300 && child.status !== "done"; i += 1) await sleep(10);
  assert.equal(child.status, "done", `delegate child ran to completion (got ${child.status}: ${child.lastError})`);
  const childChat = db.prepare("SELECT kind, parent_chat_id FROM chats WHERE id=?").get(child.chatId);
  assert.equal(childChat.kind, "division", "delegate child is a division chat");
  assert.equal(childChat.parent_chat_id, main.chatId);
  const childMsgs = db.prepare("SELECT role, text FROM chat_messages WHERE chat_id=? ORDER BY created_at").all(child.chatId);
  assert.equal(childMsgs.find((m) => m.role === "user").text, "핵심 조사 수행", "delegate brief became the child task");
  assert.equal(childMsgs.find((m) => m.role === "assistant").text, "서브 조사 완료.");

  // 3. automation 행 + 유효 next_run_at.
  const auto = db.prepare("SELECT * FROM automations WHERE name=?").get("daily-brief");
  assert.ok(auto, "automation row created");
  assert.equal(auto.schedule, "daily-09:30", "legacy mirror token stored (Desktop parity)");
  assert.equal(auto.timezone, "Asia/Seoul");
  assert.equal(auto.target_type, "agent");
  assert.equal(auto.target_id, agent.id, "automation bound to the session's agent");
  assert.equal(auto.enabled, 1);
  assert.ok(auto.next_run_at && Date.parse(auto.next_run_at) > Date.now(), `next_run_at valid future time (got ${auto.next_run_at})`);
  const autoEv = main.eventsTail().find((e) => e.type === "automation-registered");
  assert.ok(autoEv && autoEv.id === auto.id, "automation-registered receipt event");

  // 5(write). 메모리는 curate 게이트를 지나 durable 기록.
  const memRow = db.prepare("SELECT * FROM memory_entries WHERE content=?").get(WRITE_MEMORY);
  assert.ok(memRow, "write-permission memory written through curate gate");
  assert.equal(memRow.scope, "project");
  assert.equal(memRow.project_path, tmp);
  const memEv = main.eventsTail().find((e) => e.type === "memory-curated");
  assert.ok(memEv && memEv.candidates === 1 && memEv.written === 1, "memory-curated receipt (written=1)");

  /* ── 5(read): read 권한 턴은 durable 쓰기 없음 — 영수증만 ───────────── */
  const reader = orch.spawn({
    agent, runtime, permission: "read", cwd: tmp, activate: false,
    spawnImpl: fakeSequenceSpawn([READ_REPLY]),
    timeoutConfig,
  });
  await reader.send("읽기 전용 테스트");
  assert.equal(reader.status, "done");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content=?").get(READ_MEMORY).n,
    0,
    "read permission never writes memory_entries",
  );
  const readMemEv = reader.eventsTail().find((e) => e.type === "memory-curated");
  assert.ok(readMemEv && readMemEv.written === 0 && readMemEv.permission === "read", "read turn leaves receipt only");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM automations WHERE name=?").get("read-auto").n,
    0,
    "read permission cannot register automations",
  );
  const readAutoRefused = reader.eventsTail().find((e) => e.type === "automation-refused");
  assert.ok(readAutoRefused && /permission/.test(readAutoRefused.reason), "automation refusal is honest, not silent");
  // read 세션에서도 펜스는 표시 텍스트에서 제거된다.
  const readMsg = db.prepare("SELECT text FROM chat_messages WHERE chat_id=? AND role='assistant'").get(reader.chatId);
  assert.equal(readMsg.text, "읽기 전용 결과입니다.");

  /* ── 6: 동시 상한 초과 위임 = 정직한 거부 (조용한 큐잉 금지) ────────── */
  process.env.AGENTLAS_MAX_PARALLEL = "1";
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const blockerSpawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.pid = 99998;
    c.kill = () => { c.emit("close", 143); return true; };
    (async () => {
      c.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-blocker" }) + "\n");
      await gate;
      c.stdout.write(JSON.stringify({ type: "result", result: "blocker done" }) + "\n");
      c.stdout.end();
      c.stderr.end();
      setImmediate(() => c.emit("close", 0));
    })();
    return c;
  };
  const blocker = orch.spawn({ agent, runtime, permission: "read", cwd: tmp, activate: false, spawnImpl: blockerSpawn, timeoutConfig });
  const blockerTurn = blocker.send("점유 작업");
  await sleep(30);
  assert.equal(blocker.isBusy(), true, "blocker occupies the single parallel slot");

  const capSession = orch.spawn({
    agent, runtime, permission: "write", cwd: tmp, activate: false,
    spawnImpl: fakeSequenceSpawn([DELEGATE_ONLY_REPLY]),
    timeoutConfig,
  });
  await capSession.send("상한 테스트"); // orch.sendTo 대신 직접 send — 상한 판정은 위임 스폰 쪽에서 확인
  const refusedEv = capSession.eventsTail().find((e) => e.type === "delegate-refused");
  assert.ok(refusedEv, "over-cap delegation refused honestly");
  assert.match(refusedEv.reason, /parallel limit/);
  assert.ok(![...orch.sessions.values()].some((s) => s.parent === capSession), "no ghost child session queued");
  resolveGate();
  await blockerTurn;
  process.env.AGENTLAS_MAX_PARALLEL = "4";

  // 정리
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("session-fences-contract: OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
