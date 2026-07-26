"use strict";
/*
 * firm 3-tier 위임 계약 테스트 (완전 오프라인 — fake spawn 주입).
 *
 * 검증:
 *  1. CEO PLAN 회신의 ## Delegate 펜스(브리프 2개) → 본부 2개가 CEO 세션의 자식으로
 *     실행된다 (chats kind='division' + parent_chat_id = CEO(회사) 챗).
 *  2. 각 본부 세션은 자기 브리프를 프롬프트로 받는다.
 *  3. SYNTHESIZE 턴이 본부 결과(+status 표기)를 받는다.
 *  4. 최종 답이 회사 챗(chat_messages)에 영속된다.
 *  5. 펜스가 없으면 PLAN 회신이 곧 최종 답 (본부 실행 없음).
 *  6. 본부 하나가 실패해도 격리되고, 종합에 status: failed 로 넘어가며 ok=false.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-firm-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmp;

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
bootstrapDbIfMissing();

const { openDb, seedBuiltins } = require("../engine/core/db.cjs");
const { Orchestrator } = require("../engine/sessions/orchestrator.cjs");
const { runFirmTurn, parseDelegationsLocal } = require("../engine/firms/orchestrate.cjs");
const { rowToAgent } = require("../engine/agents/registry.cjs");

const db = openDb();
seedBuiltins(db);

const now = new Date().toISOString();
function insertAgent(slug, name, systemPrompt) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,0,NULL,'visible')",
  ).run(id, slug, name, name, "", "", systemPrompt, now, "");
  return id;
}

const ceoId = insertAgent("firm-ceo-test", "Test CEO", "You are the CEO.");
const stratId = insertAgent("strategy-div-agent", "Strategy", "You are the strategy division.");
const engId = insertAgent("eng-div-agent", "Engineering", "You are the engineering division.");

function insertFirm(slug, orgChart) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, slug, "Test Firm", "Test Firm", "", "", "", ceoId, JSON.stringify(orgChart), now);
  return db.prepare("SELECT * FROM firms WHERE id=?").get(id);
}

const firm = insertFirm("firm-test", [
  { agentSlug: "firm-ceo-test", agentId: ceoId, role: "CEO", reportsTo: null },
  { agentSlug: "strategy-div-agent", agentId: stratId, role: "strategy", reportsTo: "firm-ceo-test" },
  { agentSlug: "eng-div-agent", agentId: engId, role: "engineering", reportsTo: "firm-ceo-test" },
]);
const ceoAgent = rowToAgent(db.prepare("SELECT * FROM installed_agents WHERE id=?").get(ceoId));

// ── fake claude-code child: stream-json 라인 방출 후 정상 종료 (args 캡처) ──
function fakeClaudeSpawn(replyFor, capture) {
  let call = 0;
  return function spawnFake(bin, args) {
    call += 1;
    const prompt = args[1]; // claudeArgs: ["-p", prompt, ...]
    if (capture) capture.push({ call, prompt });
    const replyText = replyFor(call, prompt);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 90000 + call;
    child.kill = () => { child.emit("close", 143); return true; };
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: `sess-${child.pid}` }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", result: replyText }) + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

const runtime = { kind: "claude-code", bin: "/nonexistent/claude-fake" };
const timeoutConfig = { idleMs: 5000, totalMs: 10000, killGraceMs: 100 };

const DELEGATE_REPLY = [
  "Plan: I'll split this between Strategy and Engineering.",
  "",
  "## Delegate",
  "```json",
  JSON.stringify({
    delegations: [
      { target: "Strategy", brief: "brief-strategy: outline the market plan" },
      { target: "Engineering", brief: "brief-eng: outline the build plan" },
    ],
  }),
  "```",
].join("\n");

(async () => {
  // 로컬 파서 자체 검증 (fences.cjs landing 전까지의 정본).
  const parsed = parseDelegationsLocal(DELEGATE_REPLY);
  assert.equal(parsed.delegations.length, 2);
  assert.equal(parsed.delegations[0].target, "Strategy");
  assert.ok(!parsed.cleanedText.includes("## Delegate"), "fence removed from cleaned text");

  // ── 시나리오 1: PLAN → DELEGATE(2 본부) → SYNTHESIZE ──
  const ceoCalls = [];
  const divisionCalls = { Strategy: [], Engineering: [] };
  const orch = new Orchestrator({ db, lang: "ko" });
  const events = [];
  const result = await runFirmTurn({
    db,
    orch,
    firm,
    ceoAgent,
    task: "신제품 출시 계획을 세워줘",
    runtime,
    permission: "read",
    cwd: tmp,
    timeoutConfig,
    onEvent: (ev) => events.push(ev.phase),
    spawnImplFor: ({ kind, role }) => {
      if (kind === "ceo") {
        return fakeClaudeSpawn((call) => (call === 1 ? DELEGATE_REPLY : "FINAL ANSWER"), ceoCalls);
      }
      return fakeClaudeSpawn(
        () => (role === "Strategy" ? "strategy-result-alpha" : "engineering-result-beta"),
        divisionCalls[role],
      );
    },
  });

  assert.equal(result.ok, true, "firm turn succeeded");
  assert.equal(result.text, "FINAL ANSWER");
  assert.equal(result.plan.delegations.length, 2, "CEO plan parsed two delegations");
  assert.equal(result.divisions.length, 2, "two divisions ran");

  // 1. 본부 세션 = kind='division' + parent_chat_id = 회사(CEO) 챗
  for (const d of result.divisions) {
    const chat = db.prepare("SELECT kind, parent_chat_id, agent_id FROM chats WHERE id=?").get(d.chatId);
    assert.equal(chat.kind, "division", `${d.role} chat is a division sub-chat`);
    assert.equal(chat.parent_chat_id, result.chatId, `${d.role} chat parented to the firm chat`);
  }
  const stratChat = db.prepare("SELECT agent_id FROM chats WHERE id=?").get(result.divisions.find((d) => d.role === "Strategy").chatId);
  assert.equal(stratChat.agent_id, stratId, "division chat bound to the real division agent");

  // 2. 각 본부는 자기 브리프를 받는다
  assert.equal(divisionCalls.Strategy.length, 1);
  assert.match(divisionCalls.Strategy[0].prompt, /^brief-strategy/);
  assert.equal(divisionCalls.Engineering.length, 1);
  assert.match(divisionCalls.Engineering[0].prompt, /^brief-eng/);

  // 3. SYNTHESIZE 턴이 본부 결과 + status 표기를 받는다
  assert.equal(ceoCalls.length, 2, "CEO ran exactly plan + synthesize");
  const synthPrompt = ceoCalls[1].prompt;
  assert.ok(synthPrompt.includes("strategy-result-alpha"), "synthesis sees strategy result");
  assert.ok(synthPrompt.includes("engineering-result-beta"), "synthesis sees engineering result");
  assert.ok(synthPrompt.includes("status: ok"), "results carry an explicit status");
  assert.ok(synthPrompt.includes('"status: failed" is an error message'), "conflict/failure synthesis guidance injected");

  // 4. 최종 답이 회사 챗에 영속된다
  const msgs = db.prepare("SELECT role, text FROM chat_messages WHERE chat_id=? ORDER BY created_at, rowid").all(result.chatId);
  assert.equal(msgs.filter((m) => m.role === "assistant").pop().text, "FINAL ANSWER", "final answer persisted to the firm chat");
  assert.equal(msgs.filter((m) => m.role === "user").length, 2, "plan + synthesize user turns persisted");
  assert.deepEqual(events, ["plan", "delegate", "division-done", "division-done", "synthesize", "final"]);
  orch.shutdown();

  // ── 시나리오 2: 펜스 없음 → PLAN 회신이 곧 최종 답, 본부 실행 없음 ──
  const orch2 = new Orchestrator({ db, lang: "ko" });
  const soloDivCalls = { Strategy: [], Engineering: [] };
  const solo = await runFirmTurn({
    db,
    orch: orch2,
    firm,
    ceoAgent,
    task: "회사 소개 한 줄 써줘",
    runtime,
    permission: "read",
    cwd: tmp,
    timeoutConfig,
    spawnImplFor: ({ kind, role }) => (kind === "ceo"
      ? fakeClaudeSpawn(() => "SOLO ANSWER — no delegation needed")
      : fakeClaudeSpawn(() => "should-not-run", soloDivCalls[role])),
  });
  assert.equal(solo.ok, true);
  assert.match(solo.text, /^SOLO ANSWER/);
  assert.equal(solo.divisions.length, 0, "no division ran without a Delegate fence");
  assert.equal(soloDivCalls.Strategy.length + soloDivCalls.Engineering.length, 0);
  orch2.shutdown();

  // ── 시나리오 3: 본부 하나 실패 → 격리 + status: failed + 전체 ok=false ──
  const orch3 = new Orchestrator({ db, lang: "ko" });
  const failCeoCalls = [];
  const failing = await runFirmTurn({
    db,
    orch: orch3,
    firm,
    ceoAgent,
    task: "리스크 점검해줘",
    runtime,
    permission: "read",
    cwd: tmp,
    timeoutConfig,
    spawnImplFor: ({ kind, role }) => {
      if (kind === "ceo") return fakeClaudeSpawn((call) => (call === 1 ? DELEGATE_REPLY : "PARTIAL FINAL"), failCeoCalls);
      if (role === "Strategy") return fakeClaudeSpawn(() => "strategy-ok-result");
      // Engineering 본부는 비정상 종료(exit 1) — 실패 격리 검증.
      return function spawnFail() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 80001;
        child.kill = () => { child.emit("close", 143); return true; };
        setImmediate(() => {
          child.stdout.end();
          child.stderr.write("engineering runtime exploded\n");
          child.stderr.end();
          setImmediate(() => child.emit("close", 1));
        });
        return child;
      };
    },
  });
  assert.equal(failing.ok, false, "one failed division must not report full success");
  assert.equal(failing.text, "PARTIAL FINAL", "synthesis still completes with the surviving results");
  const engResult = failing.divisions.find((d) => d.role === "Engineering");
  assert.equal(engResult.ok, false);
  assert.ok(failCeoCalls[1].prompt.includes("status: failed"), "failed division marked as failed for synthesis");
  assert.ok(failCeoCalls[1].prompt.includes("strategy-ok-result"), "surviving division result reaches synthesis");
  orch3.shutdown();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("firm-orchestrate-contract: OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
