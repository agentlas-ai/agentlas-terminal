"use strict";
/*
 * automation/daemon — 자동화 실행기.
 *
 * 실행 경로는 v2 세션 계층 하나뿐이다(제2 경로 금지): registry 로 타깃 해석 →
 * resolveRuntime → Orchestrator.spawn → session.send(prompt_template).
 * v1 parity.cjs 의 captureRuntime/runApi 헬퍼백은 쓰지 않는다.
 *
 * 중복 실행 방지: run-now 포함 모든 실행이 store 의 SQLite 리스를 먼저 잡는다 —
 * Desktop 스케줄러가 같은 행을 동시에 돌리는 것을 막는 유일한 방어선.
 * 리스를 못 잡으면 실행하지 않는다(skip, 정직 보고).
 */
const { findAgent, rowToAgent } = require("../agents/registry.cjs");
const { resolveRuntime } = require("../runtimes/resolve.cjs");
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { columnExists } = require("../core/db.cjs");
const schedule = require("./schedule.cjs");
const store = require("./store.cjs");

/**
 * 자동화 타깃(agent/firm) → 세션에 태울 agent 객체.
 * target_id 는 id(정확)이며, background/비공개 에이전트도 실행 대상이므로
 * id 직접 조회가 1순위다(findAgent 는 slug/이름 해석용 보조).
 */
function resolveTargetAgent(db, row) {
  if (row.target_type === "firm") {
    const firm = db.prepare("SELECT * FROM firms WHERE id = ? OR slug = ?").get(row.target_id, row.target_id);
    if (!firm) throw new Error(`Company not found: ${row.target_id}`);
    const ceo = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(firm.ceo_agent_id);
    if (!ceo) throw new Error(`CEO agent not found for company: ${firm.slug}`);
    const agent = rowToAgent(ceo);
    // v2 firm 시스템 프롬프트 빌더(조직도 위임)는 firm 모듈 몫 — 여기서는 회사
    // 페르소나를 CEO 프롬프트 앞에 붙이는 최소 합성만 한다(조용한 무시 금지).
    agent.systemPrompt = [firm.persona, agent.systemPrompt].filter(Boolean).join("\n\n");
    return agent;
  }
  const direct = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(row.target_id);
  if (direct) return rowToAgent(direct);
  const bySlug = findAgent(db, row.target_id);
  if (!bySlug) throw new Error(`Agent not found: ${row.target_id}`);
  return bySlug;
}

/**
 * 자동화 1건 실행(헤드리스). 권한은 자동화 행의 permission 열(있으면), 없으면 "write".
 * opts:
 *   advanceSchedule  데몬 경로 true / run-now false (v1과 동일)
 *   scheduledFor     기록용 예정 시각(ISO)
 *   runtimeOverride  --runtime 문자열
 *   runtime          이미 확정된 런타임 객체(테스트/재사용) — resolveRuntime 생략
 *   spawnImpl/timeoutConfig  계약 테스트 주입(세션 계층으로 전달)
 *   onSession        session 생성 직후 콜백(렌더러 attach 용)
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, error?:string, finalText?:string}}
 */
async function runAutomationOnce(ctx, db, row, opts = {}) {
  const ko = ctx.lang === "ko";
  if (!row.enabled) {
    ctx.err(ko
      ? `이 자동화는 비활성화되어 실행하지 않았습니다: ${row.name}`
      : `This automation is disabled and was not run: ${row.name}`);
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!store.leaseSupported(db)) {
    // 리스 열이 없는 DB에서는 Desktop 과의 배타성을 증명할 수 없다 — fail-closed.
    ctx.err(ko
      ? "automations 테이블에 리스 열(claimed_at/lease_owner)이 없어 실행을 거부합니다. Desktop 앱을 먼저 업데이트하세요."
      : "automations table lacks lease columns (claimed_at/lease_owner); refusing to run. Update the Desktop app first.");
    return { ok: false, skipped: true, reason: "lease-unsupported" };
  }
  // run-now도 리스를 잡는다 — 앱 스케줄러가 같은 행을 동시에 돌리는 것을 방지.
  if (!store.claimAutomation(db, row.id)) {
    ctx.err(ko
      ? `다른 실행기가 이 자동화 리스를 보유 중입니다(15분 TTL): ${row.name}`
      : `Another runner holds this automation (lease TTL 15 minutes): ${row.name}`);
    return { ok: false, skipped: true, reason: "lease" };
  }

  try {
    const agent = resolveTargetAgent(db, row);
    const runtime = opts.runtime || resolveRuntime({ db, prefs: ctx.prefs, explicit: opts.runtimeOverride || null });
    // 권한: 자동화 행에 permission 열이 있으면 그 값, 없으면 write (v1 기본과 동일).
    const rowPermission = columnExists(db, "automations", "permission") ? row.permission : null;
    const permission = permissions.normalize(rowPermission || "write", "write");

    ctx.err(ctx.ui.dim(`${agent.slug} · ${runtime.kind} · ${permission} · ${ko ? "자동화" : "automation"} ${String(row.id).slice(0, 8)}`));

    const orch = opts.orchestrator || new Orchestrator({ db, lang: ctx.lang });
    const session = orch.spawn({
      agent,
      runtime,
      permission,
      cwd: process.cwd(),
      title: `automation: ${row.name}`.slice(0, 60),
      spawnImpl: opts.spawnImpl,
      timeoutConfig: opts.timeoutConfig,
    });
    if (typeof opts.onSession === "function") opts.onSession(session);

    const res = await session.send(row.prompt_template);
    const finalText = (res && (res.finalText || res.text)) || "";
    const failed = session.status === "failed";
    const errMsg = failed ? String(session.lastError || "runtime turn failed").slice(0, 500) : null;

    if (failed) {
      ctx.err(errMsg);
      store.recordRun(db, row.id, "error", errMsg, opts.scheduledFor);
    } else {
      store.recordRun(db, row.id, "ok", null, opts.scheduledFor);
    }
    const after = store.advanceAfterRun(db, row, { ok: !failed, advanceSchedule: !!opts.advanceSchedule });
    if (after.maxRunsReached) {
      ctx.err(ko ? "max_runs 도달 — 자동화를 비활성화했습니다." : "max_runs reached — automation disabled.");
    }
    return failed ? { ok: false, error: errMsg } : { ok: true, finalText };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    ctx.err(msg);
    store.recordRun(db, row.id, "error", msg, opts.scheduledFor);
    store.advanceAfterRun(db, row, { ok: false, advanceSchedule: !!opts.advanceSchedule });
    return { ok: false, error: msg };
  } finally {
    store.releaseAutomation(db, row.id);
  }
}

/**
 * 데몬 1틱: due 자동화를 순서대로 실행하고 스케줄을 전진시킨다.
 * 순차 실행(동시 아님) — v1과 동일. 자동화끼리 세션 폭주를 만들지 않는다.
 * @returns {number} 실행 시도한 자동화 수
 */
async function daemonTick(ctx, db, opts = {}) {
  const nowIso = (opts.now || new Date()).toISOString();
  let due = [];
  try {
    due = store.dueAutomations(db, nowIso, 5);
  } catch (e) {
    ctx.err("Failed to query due automations: " + String((e && e.message) || e));
    return 0;
  }
  let ran = 0;
  for (const row of due) {
    if (opts.shouldStop && opts.shouldStop()) break;
    ran += 1;
    await runAutomationOnce(ctx, db, row, {
      advanceSchedule: true,
      scheduledFor: row.next_run_at,
      runtimeOverride: opts.runtimeOverride,
      runtime: opts.runtime,
      spawnImpl: opts.spawnImpl,
      timeoutConfig: opts.timeoutConfig,
    });
    // 스케줄이 없는(1회성) 행이 남으면 재발화 방지 (v1과 동일).
    if (!row.schedule || !schedule.nextAutomationRun(row)) {
      db.prepare("UPDATE automations SET enabled = 0 WHERE id = ? AND (schedule IS NULL OR schedule = '')").run(row.id);
    }
  }
  return ran;
}

/** 상주 실행기 — 앱 없이도 자동화가 돌게 하는 포그라운드 데몬 (Ctrl-C로 종료). */
async function automationDaemon(ctx, db, opts = {}) {
  const ko = ctx.lang === "ko";
  const intervalSec = Math.max(10, opts.intervalSec || 30);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", () => { stop(); ctx.err(ko ? "종료 중…" : "stopping…"); });
  process.on("SIGTERM", stop);

  ctx.out(ctx.ui.green(`automation daemon — polling every ${intervalSec}s · owner ${store.LEASE_OWNER}`));
  ctx.out(ctx.ui.dim(ko
    ? "Ctrl-C로 종료. (데스크탑 앱 스케줄러와 리스를 공유해 중복 실행되지 않습니다.)"
    : "Ctrl-C to stop. (Shares the SQLite lease with the Desktop scheduler; no duplicate runs.)"));

  while (!stopping) {
    await daemonTick(ctx, db, {
      runtimeOverride: opts.runtimeOverride,
      shouldStop: () => stopping,
    });
    // interval 대기 (1초 단위로 stop 체크 — SIGINT 후 최대 1초 안에 내려온다)
    for (let i = 0; i < intervalSec && !stopping; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  ctx.out(ko ? "데몬 종료." : "daemon stopped.");
  return 0;
}

module.exports = { runAutomationOnce, daemonTick, automationDaemon, resolveTargetAgent };
