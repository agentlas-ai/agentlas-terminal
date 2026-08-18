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
const crypto = require("node:crypto");
const { findAgent, rowToAgent } = require("../agents/registry.cjs");
const { resolveRuntime } = require("../runtimes/resolve.cjs");
const { Orchestrator } = require("../sessions/orchestrator.cjs");
const sessionStore = require("../sessions/store.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { columnExists } = require("../core/db.cjs");
const schedule = require("./schedule.cjs");
const store = require("./store.cjs");

// ── 실행 계약 상태 (데스크탑 automations.ts:115-176 decodeRuntimeSelection /
//    getAutomationExecutionContractState 동형) ──────────────────────────────
// 손상된/미래 계약 값은 절대 조용히 넓혀 실행하지 않는다 — raw-row 게이트로
// 무인 실행 직전에 검사한다(데스크탑 automation-scheduler.ts:538-549).
const { CONTRACT_RUNTIME_KINDS, CONTRACT_RUNTIME_BACKENDS } = require("../runtimes/kinds.cjs");
const RUNTIME_KINDS = new Set(CONTRACT_RUNTIME_KINDS);
const RUNTIME_BACKENDS = new Set(CONTRACT_RUNTIME_BACKENDS);
const RUNTIME_SELECTION_KEYS = new Set(["kind", "backend", "source", "model", "longContext", "effort"]);

function decodeRuntimeSelection(raw) {
  if (raw == null) return { state: "missing" };
  try {
    const value = JSON.parse(raw);
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every((key) => RUNTIME_SELECTION_KEYS.has(key)) &&
      typeof value.kind === "string" && RUNTIME_KINDS.has(value.kind) &&
      (value.backend === undefined || (typeof value.backend === "string" && RUNTIME_BACKENDS.has(value.backend))) &&
      (value.source === undefined || (typeof value.source === "string" && value.source.length > 0 && value.source.length <= 2048)) &&
      (value.model === undefined || (typeof value.model === "string" && value.model.length > 0 && value.model.length <= 512)) &&
      (value.longContext === undefined || typeof value.longContext === "boolean") &&
      (value.effort === undefined || (typeof value.effort === "string" && value.effort.length <= 128))
    ) {
      return { state: "valid", value };
    }
  } catch { /* 손상 데이터는 아래에서 invalid — 진짜 없는 레거시 핀과 구분한다 */ }
  return { state: "invalid" };
}

function automationContractState(db, row) {
  const runtimeSelection = columnExists(db, "automations", "runtime_selection_json")
    ? decodeRuntimeSelection(row.runtime_selection_json)
    : { state: "missing" };
  const hubMode = !columnExists(db, "automations", "hub_mode") || row.hub_mode == null
    ? "missing"
    : row.hub_mode === "hub-first" || row.hub_mode === "local-only" || row.hub_mode === "hub-allowed"
      ? "valid"
      : "invalid";
  return { runtimeSelection: runtimeSelection.state, runtimePin: runtimeSelection.value || null, hubMode };
}

/**
 * 자동화별 숨김 지속 세션 — 데스크탑 getOrCreateAutomationSession 동형
 * (electron/store/chats.ts:334-375). marker 제목이 바이트 단위로 같아 데스크탑
 * 스케줄러와 같은 division 챗을 공유한다: recurring work가 매 실행마다 새 사용자
 * 챗을 만들지 않고(kind='user' 목록 오염 금지), 이전 결과/차단 상태를 이어받는다.
 */
function automationSessionChatId(db, row, agent) {
  const targetKind = row.target_type === "firm" ? "firm" : "agent";
  const targetHash = crypto.createHash("sha256")
    .update(targetKind).update("\0").update(String(row.target_id))
    .digest("hex").slice(0, 16);
  const marker = `⟦automation⟧${row.id}::target:${targetKind}:${targetHash}`;
  try {
    const existing = db.prepare("SELECT id FROM chats WHERE kind = 'division' AND title = ? LIMIT 1").get(marker);
    if (existing) return existing.id;
    return sessionStore.createChat(db, { agentId: agent.id, title: marker, kind: "division" });
  } catch {
    // chats 스키마가 아직 없으면(비정상 DB) 세션 계층의 기본 챗 생성에 맡긴다.
    return null;
  }
}

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
 * 이 터미널이 실행할 수 없는 계열 판정 — 실행 게이트와 due 셀렉션의 유일한 정본.
 * store.runnerUnsupportedSql 의 SQL 술어와 반드시 같은 조건을 본다(갈리면 굶주림이
 * 되돌아온다: 셀렉션이 담은 행을 실행기가 거부하면 그 행이 due 창을 영구 점유한다).
 *
 * Hub 타깃: 데스크탑은 정확 릴리스 핀 + Hub 런타임으로 실행한다
 * (automation-scheduler.ts:573-630 hub_version_pin 게이트) — 터미널에는 그 실행
 * 계층이 없으므로 위장 실행 금지, 정직 스킵.
 * tool_mode 'browser'/'computer-use': 데스크탑은 Agentlas Browser/컴퓨터유즈 러너를
 * 배선하고 권한 프리플라이트까지 건다(automation-scheduler.ts:619-625). 터미널
 * 세션 계층에는 그 러너가 없다 — 평문 세션으로 돌리는 조용한 다운그레이드 대신
 * 정직 스킵으로 Desktop 실행분(회차)을 그대로 남겨 둔다.
 * @returns {{reason:string, message:string}|null}
 */
function runnerSkip(db, row, ko) {
  if (row.target_type === "hub") {
    return {
      reason: "hub-target-unsupported",
      message: ko
        ? `Hub 타깃 자동화는 터미널 데몬이 실행하지 않습니다(정확 릴리스 핀 실행은 Desktop 스케줄러 몫): ${row.name}`
        : `Hub-target automations are not run by the terminal daemon (exact-release Hub execution belongs to the Desktop scheduler): ${row.name}`,
    };
  }
  const rowToolMode = columnExists(db, "automations", "tool_mode") ? row.tool_mode : null;
  if (rowToolMode === "browser" || rowToolMode === "computer-use") {
    return {
      reason: "tool-mode-unsupported",
      message: ko
        ? `tool_mode '${rowToolMode}' 자동화는 터미널 데몬이 실행하지 않습니다(브라우저/컴퓨터유즈 러너는 Desktop 몫): ${row.name}`
        : `tool_mode '${rowToolMode}' automations are not run by the terminal daemon (the browser/computer-use runner belongs to Desktop): ${row.name}`,
    };
  }
  return null;
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
  // ── 터미널이 충실히 실행할 수 없는 계열은 리스를 잡지 않고 스킵한다 ──
  const unsupported = runnerSkip(db, row, ko);
  if (unsupported) {
    ctx.err(unsupported.message);
    return { ok: false, skipped: true, reason: unsupported.reason };
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

  // 데스크탑 스케줄러는 60초마다 리스를 갱신한다. 여기는 한 번 잡고 끝이라
  // TTL(15분)을 넘긴 실행은 프로세스가 살아 있어도 회수 대상이 됐다 — 같은
  // 자동화가 두 실행기에서 겹쳐 도는 경로. 같은 주기로 심장박동을 보낸다.
  const leaseHeartbeat = setInterval(() => {
    try { store.renewAutomationLease(db, row.id); } catch { /* best-effort */ }
  }, 60_000);
  if (typeof leaseHeartbeat.unref === "function") leaseHeartbeat.unref();

  try {
    // ── raw-row 실행 계약 게이트 (데스크탑 automation-scheduler.ts:538-549 동형) ──
    // 손상된 계약 값으로는 무인 실행하지 않는다 — 문구까지 데스크탑과 동일.
    const contract = automationContractState(db, row);
    if (contract.runtimeSelection === "invalid") {
      const msg = "pinned_runtime_contract_invalid: the saved runtime pin is malformed and requires an explicit runtime selection.";
      ctx.err(msg);
      store.recordRun(db, row.id, "needs_input", msg, opts.scheduledFor);
      store.advanceAfterRun(db, row, { ok: false, advanceSchedule: !!opts.advanceSchedule });
      return { ok: false, error: msg };
    }
    if (contract.hubMode === "invalid") {
      const msg = "automation_hub_mode_contract_invalid: the saved Hub routing policy is unknown and requires an explicit selection.";
      ctx.err(msg);
      store.recordRun(db, row.id, "needs_input", msg, opts.scheduledFor);
      store.advanceAfterRun(db, row, { ok: false, advanceSchedule: !!opts.advanceSchedule });
      return { ok: false, error: msg };
    }

    const agent = resolveTargetAgent(db, row);
    // 런타임 사다리: 명시 --runtime > 유효한 자동화 핀(runtime_selection_json) > 기본 사다리.
    // 핀이 있는데 이 터미널이 그 종류를 실행할 수 없으면 조용한 대체 없이 정직 정지
    // (데스크탑 client.ts:1828-1830 pinned-runtime-unavailable 문구 동형).
    let runtime = opts.runtime || null;
    if (!runtime && !opts.runtimeOverride && contract.runtimePin) {
      const pin = contract.runtimePin;
      try {
        runtime = resolveRuntime({ db, prefs: ctx.prefs, explicit: pin.kind });
        if (pin.model) runtime.model = pin.model;
      } catch {
        throw new Error(`Pinned automation runtime is unavailable: ${pin.kind}${pin.model ? ` · ${pin.model}` : ""}`);
      }
    }
    if (!runtime) runtime = resolveRuntime({ db, prefs: ctx.prefs, explicit: opts.runtimeOverride || null });
    // 권한: 자동화 행에 permission 열이 있으면 그 값, 없으면 write (v1 기본과 동일).
    const rowPermission = columnExists(db, "automations", "permission") ? row.permission : null;
    const permission = permissions.normalize(rowPermission || "write", "write");

    ctx.err(ctx.ui.dim(`${agent.slug} · ${runtime.kind} · ${permission} · ${ko ? "자동화" : "automation"} ${String(row.id).slice(0, 8)}`));

    const orch = opts.orchestrator || new Orchestrator({ db, lang: ctx.lang });
    // 자동화 실행 = 숨김 division marker 세션 (데스크탑 chats.ts:334-375 동형).
    // 사용자 챗 목록을 오염시키지 않고, Desktop 스케줄러와 같은 세션을 이어 쓴다.
    const markerChatId = automationSessionChatId(db, row, agent);
    const session = orch.spawn({
      agent,
      runtime,
      permission,
      cwd: process.cwd(),
      title: `automation: ${row.name}`.slice(0, 60),
      spawnImpl: opts.spawnImpl,
      timeoutConfig: opts.timeoutConfig,
      ...(markerChatId ? { chatId: markerChatId } : {}),
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
    clearInterval(leaseHeartbeat);
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
    // 실행 창은 "이 실행기가 실제로 실행할 수 있는" 행만 담는다 (runnable: true).
    // 미지원 계열/남의 리스 행은 스킵돼도 next_run_at 이 전진하지 않으므로, 창에
    // 담으면 시간순 LIMIT 5 의 머리를 영구 점유해 뒤의 자동화를 전부 굶긴다.
    due = store.dueAutomations(db, nowIso, 5, { runnable: true });
  } catch (e) {
    ctx.err("Failed to query due automations: " + String((e && e.message) || e));
    return 0;
  }
  // 미지원 계열은 실행 창에서 빠졌어도 존재 사실은 정직하게 알린다 — Desktop 몫으로
  // 남겨둔 회차이므로 틱마다 반복하지 않고 데몬 수명당 1회만 고지한다.
  if (opts.skipAnnounced) {
    let deferred = [];
    // 고지 상한 50 — 실행 창(5)과 달리 이 목록은 실행에 쓰이지 않으므로 넉넉해도 안전하다.
    try { deferred = store.dueAutomations(db, nowIso, 50, { runnable: false }); } catch { /* best-effort */ }
    for (const row of deferred) {
      if (opts.skipAnnounced.has(row.id)) continue;
      const skip = runnerSkip(db, row, ctx.lang === "ko");
      if (!skip) continue;
      ctx.err(skip.message);
      opts.skipAnnounced.add(row.id);
    }
  }
  let ran = 0;
  for (const row of due) {
    if (opts.shouldStop && opts.shouldStop()) break;
    ran += 1;
    const result = await runAutomationOnce(ctx, db, row, {
      advanceSchedule: true,
      scheduledFor: row.next_run_at,
      runtimeOverride: opts.runtimeOverride,
      runtime: opts.runtime,
      spawnImpl: opts.spawnImpl,
      timeoutConfig: opts.timeoutConfig,
    });
    // 스킵은 회차를 소비하지 않는다 — 1회성 비활성화조차 건드리지 않는다.
    // (미지원 계열은 Desktop 몫이고, lease 스킵은 지금 남이 돌리는 회차다. 셀렉션과
    //  실행 사이의 리스 레이스로 스킵된 1회성 행을 여기서 꺼 버리면 그 실행은 영영 사라진다.)
    if (result && result.skipped) {
      if (
        opts.skipAnnounced &&
        (result.reason === "hub-target-unsupported" || result.reason === "tool-mode-unsupported")
      ) opts.skipAnnounced.add(row.id);
      continue;
    }
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

  const skipAnnounced = new Set(); // 미지원 계열 안내는 데몬 수명당 1회
  while (!stopping) {
    await daemonTick(ctx, db, {
      runtimeOverride: opts.runtimeOverride,
      shouldStop: () => stopping,
      skipAnnounced,
    });
    // interval 대기 (1초 단위로 stop 체크 — SIGINT 후 최대 1초 안에 내려온다)
    for (let i = 0; i < intervalSec && !stopping; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  ctx.out(ko ? "데몬 종료." : "daemon stopped.");
  return 0;
}

module.exports = {
  runAutomationOnce,
  daemonTick,
  automationDaemon,
  resolveTargetAgent,
  automationContractState,
  automationSessionChatId,
  runnerSkip,
  decodeRuntimeSelection,
};
