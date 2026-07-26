"use strict";
/*
 * automation 계약 테스트 (오프라인 — 실 CLI 불필요, fake spawn 주입).
 * 검증:
 *  1. cron nextCronRun 정확성 — 타임존 투영 + DST(봄 소멸 시각 / 가을 중복 시각),
 *     dom/dow OR 규칙, 일요일 7 별칭, 범위/스텝, 잘못된 입력 null.
 *  2. 프리셋 컴파일(legacyScheduleSpec) + nextAutomationRun(schedule_json 우선,
 *     interval wallclock/lastRun, once, 해석 불가 스케줄 24h 폴백).
 *  3. add/list/on/off/remove 라운드트립 (커맨드 표면 경유).
 *  4. claim/release 배타성 — 두 클레이머 중 하나만 승리, TTL 지난 리스는 회수.
 *  5. daemon tick 전체 실행 — fake claude stream-json child 로 세션 계층을 태워
 *     run_history + automation_runs 기록, run_count/next_run_at 전진, 리스 해제.
 */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-automation-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmp;

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
bootstrapDbIfMissing();

const { openDb, seedBuiltins, tableExists, columnExists } = require("../engine/core/db.cjs");
const schedule = require("../engine/automation/schedule.cjs");
const store = require("../engine/automation/store.cjs");
const daemon = require("../engine/automation/daemon.cjs");
const automationCmd = require("../engine/commands/automation.cjs");

const iso = (d) => (d ? d.toISOString() : null);

// ── 1. cron / timezone / DST ──
{
  // UTC 기본 동작: 15분 스텝
  assert.equal(
    iso(schedule.nextCronRun("*/15 * * * *", new Date("2026-01-01T00:07:00Z"), "UTC")),
    "2026-01-01T00:15:00.000Z",
  );
  // from 자체가 매치여도 "다음" 분부터 탐색한다 (v1 계약: from+1분 시작)
  assert.equal(
    iso(schedule.nextCronRun("0 * * * *", new Date("2026-01-01T05:00:00Z"), "UTC")),
    "2026-01-01T06:00:00.000Z",
  );
  // Asia/Seoul 09:00 = UTC 00:00 (KST는 DST 없음)
  assert.equal(
    iso(schedule.nextCronRun("0 9 * * *", new Date("2026-01-14T23:00:00Z"), "Asia/Seoul")),
    "2026-01-15T00:00:00.000Z",
  );
  // DST 봄(2026-03-08 America/New_York): 02:30은 그날 존재하지 않는 시각 —
  // 건너뛰고 다음 날 02:30 EDT(=06:30Z)로 안전 착지해야 한다.
  assert.equal(
    iso(schedule.nextCronRun("30 2 * * *", new Date("2026-03-08T05:00:00Z"), "America/New_York")),
    "2026-03-09T06:30:00.000Z",
  );
  // DST 가을(2026-11-01): 01:30이 두 번 온다 — 첫 번째(EDT, 05:30Z)만 잡는다(중복 발화 금지).
  assert.equal(
    iso(schedule.nextCronRun("30 1 * * *", new Date("2026-11-01T04:00:00Z"), "America/New_York")),
    "2026-11-01T05:30:00.000Z",
  );
  // dom/dow 둘 다 제한 → OR (표준 cron): 2026-07-15(수)에서 "1일 또는 월요일" → 7/20(월)
  assert.equal(
    iso(schedule.nextCronRun("0 0 1 * 1", new Date("2026-07-15T12:00:00Z"), "UTC")),
    "2026-07-20T00:00:00.000Z",
  );
  // dom만 제한 → AND 경로: 다음 달 1일
  assert.equal(
    iso(schedule.nextCronRun("0 0 1 * *", new Date("2026-07-15T12:00:00Z"), "UTC")),
    "2026-08-01T00:00:00.000Z",
  );
  // 일요일 별칭 7 → 0
  assert.equal(
    iso(schedule.nextCronRun("0 0 * * 7", new Date("2026-07-15T12:00:00Z"), "UTC")),
    "2026-07-19T00:00:00.000Z",
  );
  // 범위+스텝: 9-17/2 → {9,11,13,15,17}
  assert.equal(
    iso(schedule.nextCronRun("0 9-17/2 * * *", new Date("2026-07-15T10:00:00Z"), "UTC")),
    "2026-07-15T11:00:00.000Z",
  );
  // 잘못된 입력은 null (조용한 오해석 금지)
  assert.equal(schedule.nextCronRun("61 * * * *"), null);
  assert.equal(schedule.nextCronRun("* * * *"), null);
  assert.equal(schedule.nextCronRun("0 9 * * *", new Date(), "Not/AZone"), null);
  console.log("cron+timezone+DST: OK");
}

// ── 2. 프리셋 컴파일 + nextAutomationRun ──
{
  assert.deepEqual(schedule.legacyScheduleSpec("daily-9:30", "UTC"), { kind: "cron", expr: "30 9 * * *", tz: "UTC" });
  assert.deepEqual(schedule.legacyScheduleSpec("weekday-08:00", "UTC"), { kind: "cron", expr: "0 8 * * 1-5", tz: "UTC" });
  assert.deepEqual(schedule.legacyScheduleSpec("weekly-mon-10:00", "UTC"), { kind: "cron", expr: "0 10 * * 1", tz: "UTC" });
  assert.deepEqual(schedule.legacyScheduleSpec("monthly-15-9:00", "UTC"), { kind: "cron", expr: "0 9 15 * *", tz: "UTC" });
  assert.deepEqual(schedule.legacyScheduleSpec("hourly"), { kind: "interval", everyMs: 3600000, anchor: "lastRun" });
  assert.deepEqual(schedule.legacyScheduleSpec("every-15m"), { kind: "interval", everyMs: 900000, anchor: "lastRun" });
  assert.deepEqual(schedule.legacyScheduleSpec("every-2h"), { kind: "interval", everyMs: 7200000, anchor: "lastRun" });
  assert.deepEqual(schedule.legacyScheduleSpec("cron:*/5 * * * *", "UTC"), { kind: "cron", expr: "*/5 * * * *", tz: "UTC" });
  assert.deepEqual(schedule.legacyScheduleSpec("0 9 * * *", "UTC"), { kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  assert.equal(schedule.legacyScheduleSpec("monthly-32-9:00", "UTC"), null);
  assert.equal(schedule.legacyScheduleSpec(""), null);

  const from = new Date("2026-07-15T10:20:00Z");
  // schedule_json 이 legacy schedule 보다 우선
  assert.equal(
    iso(schedule.nextAutomationRun({
      schedule: "0 9 * * *",
      schedule_json: JSON.stringify({ kind: "cron", expr: "0 12 * * *", tz: "UTC" }),
      timezone: "UTC",
    }, from)),
    "2026-07-15T12:00:00.000Z",
  );
  // interval wallclock: 다음 정시 경계
  assert.equal(
    iso(schedule.nextAutomationRun({
      schedule: "hourly",
      schedule_json: JSON.stringify({ kind: "interval", everyMs: 3600000, anchor: "wallclock" }),
    }, from)),
    "2026-07-15T11:00:00.000Z",
  );
  // interval lastRun 앵커: from + everyMs
  assert.equal(
    iso(schedule.nextAutomationRun({ schedule: "every-15m" }, from)),
    "2026-07-15T10:35:00.000Z",
  );
  // once: 미래면 그 시각, 과거면 null
  assert.equal(
    iso(schedule.nextAutomationRun({ schedule: "x", schedule_json: JSON.stringify({ kind: "once", atIso: "2026-08-01T00:00:00Z" }) }, from)),
    "2026-08-01T00:00:00.000Z",
  );
  assert.equal(
    schedule.nextAutomationRun({ schedule: "x", schedule_json: JSON.stringify({ kind: "once", atIso: "2026-01-01T00:00:00Z" }) }, from),
    null,
  );
  // 해석 불가 스케줄은 24h 폴백 (due 행을 같은 시각에 방치하면 무한 재발화)
  assert.equal(
    iso(schedule.nextAutomationRun({ schedule: "gibberish-token" }, from)),
    "2026-07-16T10:20:00.000Z",
  );
  // 스케줄 자체가 없으면 null
  assert.equal(schedule.nextAutomationRun({ schedule: "" }, from), null);
  console.log("presets+nextAutomationRun: OK");
}

// ── 공유 픽스처: DB + ctx ──
const db = openDb();
seedBuiltins(db);
const agentRow = db.prepare("SELECT * FROM installed_agents LIMIT 1").get();
assert.ok(agentRow, "builtin agent seeded");

const outLines = [];
const errLines = [];
const idFn = (s) => String(s);
const ctx = {
  lang: "en",
  prefs: {},
  ui: { bold: idFn, dim: idFn, accent: idFn, green: idFn, red: idFn },
  out: (s = "") => outLines.push(String(s)),
  err: (s = "") => errLines.push(String(s)),
  db: () => db,
  tableExists,
  columnExists,
};

// ── fake claude-code child (test/session-orchestrator-contract.cjs 패턴) ──
function fakeClaudeSpawn(replyText, { fail = false } = {}) {
  return function spawnFake() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99999;
    child.kill = () => { child.emit("close", 143); return true; };
    setImmediate(() => {
      const lines = fail
        ? [
            { type: "system", subtype: "init", session_id: "sess-auto-fail" },
            // is_error result + exit 0: Runtime Doctor 경로를 타지 않는 결정적 실패
            { type: "result", is_error: true, result: replyText },
          ]
        : [
            { type: "system", subtype: "init", session_id: "sess-auto-1" },
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
const fakeRuntime = { kind: "claude-code", bin: "/nonexistent/claude-fake" };
const timeoutConfig = { idleMs: 5000, totalMs: 10000, killGraceMs: 100 };

(async () => {
  // ── 3. add/list/on/off/remove 라운드트립 (커맨드 표면) ──
  let code = await automationCmd.run(ctx, ["list"]);
  assert.equal(code, 0);
  assert.match(outLines.join("\n"), /No automations/);

  code = await automationCmd.run(ctx, ["add", "--agent", agentRow.slug, "--prompt", "p"]);
  assert.equal(code, 1, "add without --cron fails");

  outLines.length = 0;
  code = await automationCmd.run(ctx, [
    "add", "--name", "Morning brief", "--agent", agentRow.slug,
    "--cron", "0 9 * * *", "--prompt", "Summarize overnight items.", "--tz", "Asia/Seoul",
  ]);
  assert.equal(code, 0, "add ok");
  const created = db.prepare("SELECT * FROM automations WHERE name='Morning brief'").get();
  assert.ok(created, "automation row inserted");
  assert.equal(created.enabled, 1);
  assert.equal(created.target_type, "agent");
  assert.equal(created.target_id, agentRow.id);
  assert.equal(created.timezone, "Asia/Seoul");
  assert.equal(created.trigger_type, "schedule");
  assert.ok(created.next_run_at, "next_run_at precomputed (croner treats NULL as no clock)");

  code = await automationCmd.run(ctx, ["add", "--agent", agentRow.slug, "--cron", "99 * * * *", "--prompt", "x"]);
  assert.equal(code, 1, "invalid cron rejected");

  const prefix = created.id.slice(0, 8);
  code = await automationCmd.run(ctx, ["off", prefix]);
  assert.equal(code, 0);
  assert.equal(db.prepare("SELECT enabled FROM automations WHERE id=?").get(created.id).enabled, 0);

  code = await automationCmd.run(ctx, ["on", prefix]);
  assert.equal(code, 0);
  const reEnabled = db.prepare("SELECT enabled, next_run_at FROM automations WHERE id=?").get(created.id);
  assert.equal(reEnabled.enabled, 1);
  assert.ok(reEnabled.next_run_at > new Date().toISOString(), "on recomputes future next_run_at");

  outLines.length = 0;
  code = await automationCmd.run(ctx, ["list"]);
  assert.equal(code, 0);
  assert.match(outLines.join("\n"), /Morning brief/);

  code = await automationCmd.run(ctx, ["remove", prefix]);
  assert.equal(code, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automations").get().n, 0);

  code = await automationCmd.run(ctx, ["on", "deadbeef"]);
  assert.equal(code, 1, "missing automation → exit 1");
  console.log("add/list/on/off/remove round-trip: OK");

  // ── 4. claim/release 배타성 ──
  const autoId = store.addAutomation(db, {
    name: "Lease test", targetType: "agent", targetId: agentRow.id,
    cron: "*/5 * * * *", prompt: "noop", tz: null, disabled: false,
  }, schedule.nextCronRun("*/5 * * * *", new Date(), null));

  const now = new Date();
  assert.equal(store.claimAutomation(db, autoId, now, "cli:hostA:1"), true, "first claimer wins");
  assert.equal(store.claimAutomation(db, autoId, now, "cli:hostB:2"), false, "second claimer must lose");
  const leased = db.prepare("SELECT claimed_at, lease_owner FROM automations WHERE id=?").get(autoId);
  assert.equal(leased.lease_owner, "cli:hostA:1", "winner owns the lease");

  store.releaseAutomation(db, autoId);
  assert.equal(db.prepare("SELECT claimed_at FROM automations WHERE id=?").get(autoId).claimed_at, null);
  assert.equal(store.claimAutomation(db, autoId, now, "cli:hostB:2"), true, "released lease reclaimable");

  // TTL(15분) 지난 stale 리스는 회수 가능 — Desktop 크래시 후 자동화가 영구 잠기면 안 된다.
  db.prepare("UPDATE automations SET claimed_at=? WHERE id=?")
    .run(new Date(now.getTime() - store.LEASE_TTL_MS - 60000).toISOString(), autoId);
  assert.equal(store.claimAutomation(db, autoId, now, "cli:hostC:3"), true, "stale lease reclaimed after TTL");
  store.releaseAutomation(db, autoId);

  // 리스 보유 중 run-now 는 skip (중복 실행 절대 금지)
  assert.equal(store.claimAutomation(db, autoId, new Date(), "desktop:app"), true);
  const skipped = await daemon.runAutomationOnce(ctx, db,
    db.prepare("SELECT * FROM automations WHERE id=?").get(autoId),
    { runtime: fakeRuntime, spawnImpl: fakeClaudeSpawn("must not run"), timeoutConfig });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, "lease", "lease-held automation skipped");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_history WHERE automation_id=?").get(autoId).n, 0, "skip records no run");
  store.releaseAutomation(db, autoId);
  db.prepare("DELETE FROM automations WHERE id=?").run(autoId);
  console.log("claim/release exclusivity: OK");

  // ── 5. daemon tick 전체 실행 (fake runtime, 세션 계층 경유) ──
  const dueId = store.addAutomation(db, {
    name: "Due automation", targetType: "agent", targetId: agentRow.id,
    cron: "*/5 * * * *", prompt: "Automation prompt goes to the session.", tz: null, disabled: false,
  }, schedule.nextCronRun("*/5 * * * *", new Date(), null));
  // due 로 만들기: next_run_at 을 과거로
  db.prepare("UPDATE automations SET next_run_at=? WHERE id=?")
    .run(new Date(Date.now() - 60000).toISOString(), dueId);

  const ran = await daemon.daemonTick(ctx, db, {
    runtime: fakeRuntime,
    spawnImpl: fakeClaudeSpawn("automation reply text"),
    timeoutConfig,
  });
  assert.equal(ran, 1, "one due automation executed");

  const afterRow = db.prepare("SELECT * FROM automations WHERE id=?").get(dueId);
  assert.equal(afterRow.run_count, 1, "run_count incremented on success");
  assert.ok(afterRow.last_run_at, "last_run_at set");
  assert.ok(afterRow.next_run_at > new Date(Date.now() - 1000).toISOString(), "next_run_at advanced to the future");
  assert.equal(afterRow.enabled, 1, "recurring automation stays enabled");
  assert.equal(afterRow.claimed_at, null, "lease released after run");

  const hist = db.prepare("SELECT * FROM run_history WHERE automation_id=?").all(dueId);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, "ok");
  assert.equal(hist[0].error, null);
  assert.ok(hist[0].scheduled_for, "scheduled_for recorded from next_run_at");

  const autoRuns = db.prepare("SELECT * FROM automation_runs WHERE automation_id=?").all(dueId);
  assert.equal(autoRuns.length, 1, "automation_runs row recorded");
  assert.equal(autoRuns[0].status, "ok");

  // 세션 계층 경유 증명: 자동화 실행이 chats/chat_messages 에 영속됐다
  const autoChat = db.prepare(
    "SELECT c.id FROM chats c JOIN chat_messages m ON m.chat_id=c.id WHERE m.role='user' AND m.text='Automation prompt goes to the session.'",
  ).get();
  assert.ok(autoChat, "automation turn persisted through the v2 session layer");

  // 실패 실행: error 기록 + run_count 미증가 + next_run_at 는 그래도 전진
  db.prepare("UPDATE automations SET next_run_at=? WHERE id=?")
    .run(new Date(Date.now() - 60000).toISOString(), dueId);
  const beforeFail = db.prepare("SELECT run_count FROM automations WHERE id=?").get(dueId).run_count;
  await daemon.daemonTick(ctx, db, {
    runtime: fakeRuntime,
    spawnImpl: fakeClaudeSpawn("boom: fake runtime failure", { fail: true }),
    timeoutConfig,
  });
  const failRow = db.prepare("SELECT * FROM automations WHERE id=?").get(dueId);
  assert.equal(failRow.run_count, beforeFail, "failed run does not inflate success count");
  assert.ok(failRow.next_run_at > new Date(Date.now() - 1000).toISOString(), "schedule still advances after failure");
  assert.equal(failRow.claimed_at, null, "lease released after failed run");
  const failHist = db.prepare("SELECT * FROM run_history WHERE automation_id=? ORDER BY ran_at DESC").all(dueId);
  assert.equal(failHist[0].status, "error");
  assert.match(String(failHist[0].error), /boom/);

  // runs 서브커맨드가 기록을 보여준다
  outLines.length = 0;
  code = await automationCmd.run(ctx, ["runs"]);
  assert.equal(code, 0);
  assert.match(outLines.join("\n"), /Due automation/);
  console.log("daemon tick execution: OK");

  // 정리
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("automation-contract: OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
