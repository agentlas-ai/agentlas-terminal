"use strict";
/*
 * automation — 자동화 등록/목록/토글/삭제/실행 (v1 cmdAutomation 의 v2 포팅).
 *   list (기본) | add | on <id> | off <id> | remove <id> | run <id> | runs | daemon
 *
 * 스케줄 계산은 automation/schedule, DB는 automation/store, 실행은
 * automation/daemon(세션 계층)만 쓴다. run <id> 는 스케줄을 건드리지 않는다
 * (앱의 advanceSchedule=false 와 동일); 예약 전진은 daemon 경로에서만 일어난다.
 */
const { findAgent } = require("../agents/registry.cjs");
const schedule = require("../automation/schedule.cjs");
const store = require("../automation/store.cjs");
const daemon = require("../automation/daemon.cjs");

function resolveFirm(db, token) {
  const q = String(token || "").trim();
  if (!q) return null;
  try {
    return db.prepare("SELECT * FROM firms WHERE id = ? OR lower(slug) = lower(?) OR name = ?").get(q, q, q) || null;
  } catch {
    return null;
  }
}

async function run(ctx, args) {
  const sub = args[0] || "list";
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  const usage = (tail) => (ko ? `사용법: agentlas automation ${tail}` : `usage: agentlas automation ${tail}`);
  const missingAutomation = (id) => (ko ? `자동화를 찾지 못했습니다: ${id}` : `Automation not found: ${id}`);
  const fail = (msg) => { ctx.err(msg); return 1; };

  if (sub === "list") {
    const rows = store.listAutomations(db);
    if (!rows.length) {
      ctx.out(ko
        ? "자동화가 없습니다. `agentlas automation add --help`로 추가 방법을 확인하세요."
        : "No automations. Run agentlas automation add --help.");
      return 0;
    }
    for (const r of rows) {
      const target = r.target_type + ":" + String(r.target_id).slice(0, 24);
      ctx.out(
        `${r.enabled ? ctx.ui.green("●") : ctx.ui.dim("○")} ${ctx.ui.bold(String(r.id).slice(0, 8))}  ${String(r.name).padEnd(28).slice(0, 28)} ` +
          `${String(r.schedule || r.trigger_type || "-").padEnd(14)} ${target.padEnd(32)} ` +
          `${ko ? "다음" : "next"}=${r.next_run_at ? r.next_run_at.slice(0, 16) : "-"} ` +
          `${ko ? "성공" : "success"}=${r.run_count ?? 0}`,
      );
    }
    ctx.out("");
    ctx.out(ctx.ui.dim(ko
      ? "지금 실행: agentlas automation run <id>  ·  데몬: agentlas automation daemon"
      : "Run now: agentlas automation run <id>  ·  daemon: agentlas automation daemon"));
    ctx.out(ctx.ui.dim(ko
      ? "Desktop 앱이 열려 있을 때는 Desktop 스케줄러도 실행되며, 리스로 중복 실행을 막습니다."
      : "The Desktop scheduler also runs when the app is open; leases prevent duplicate runs."));
    return 0;
  }

  if (sub === "add") {
    // agentlas automation add --name "..." --agent <slug>|--firm <slug> --cron "0 9 * * *" --prompt "..."
    const flags = {};
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--name") flags.name = args[++i];
      else if (a === "--agent") flags.agent = args[++i];
      else if (a === "--firm") flags.firm = args[++i];
      else if (a === "--cron") flags.cron = args[++i];
      else if (a === "--prompt") flags.prompt = args[++i];
      else if (a === "--tz") flags.tz = args[++i];
      else if (a === "--disabled") flags.disabled = true;
    }
    if (!flags.cron || !flags.prompt || (!flags.agent && !flags.firm)) {
      ctx.err(ko
        ? '사용법: agentlas automation add --name "이름" --agent <슬러그>|--firm <슬러그> --cron "0 9 * * *" --prompt "지시" [--tz Asia/Seoul] [--disabled]'
        : 'usage: agentlas automation add --name "name" --agent <slug>|--firm <slug> --cron "0 9 * * *" --prompt "instructions" [--tz Asia/Seoul] [--disabled]');
      return 1;
    }
    let targetType;
    let targetId;
    let targetLabel;
    if (flags.agent) {
      const a = findAgent(db, flags.agent);
      if (!a) return fail(ko ? `에이전트를 찾지 못했습니다: ${flags.agent}` : `Agent not found: ${flags.agent}`);
      targetType = "agent";
      targetId = a.id;
      targetLabel = a.name;
    } else {
      const f = resolveFirm(db, flags.firm);
      if (!f) return fail(ko ? `회사를 찾지 못했습니다: ${flags.firm}` : `Company not found: ${flags.firm}`);
      targetType = "firm";
      targetId = f.id;
      targetLabel = f.name;
    }
    // 잘못된 IANA 존이면 nextCronRun 이 cron 파싱 실패와 똑같이 null 을 돌려준다.
    // 그대로 두면 멀쩡한 cron 을 범인으로 지목해서, 사용자가 cron 만 계속 고쳐 쓰며
    // 매번 같은 실패를 본다. 존을 먼저 검증해 틀린 필드를 정확히 지목한다.
    if (flags.tz && !schedule.isValidTimezone(flags.tz)) {
      return fail(ko
        ? `타임존을 해석하지 못했습니다: "${flags.tz}" (IANA 형식이 필요합니다 — 예: Asia/Seoul, UTC, America/New_York)`
        : `Could not parse timezone: "${flags.tz}" (needs IANA format — e.g. Asia/Seoul, UTC, America/New_York)`);
    }
    const next = schedule.nextCronRun(flags.cron, new Date(), flags.tz || null);
    if (!next) {
      return fail(ko
        ? `cron 표현식을 해석하지 못했습니다: "${flags.cron}" (5개 필드: 분 시 일 월 요일)`
        : `Could not parse cron expression: "${flags.cron}" (5 fields: minute hour day month weekday)`);
    }
    const id = store.addAutomation(db, {
      name: flags.name || `${targetLabel} automation`,
      targetType,
      targetId,
      cron: flags.cron,
      prompt: flags.prompt,
      tz: flags.tz || null,
      disabled: !!flags.disabled,
    }, next);
    ctx.out(`${ko ? "생성됨" : "Created"}: ${ctx.ui.bold(id.slice(0, 8))}  ${flags.name || targetLabel}  ${ko ? "다음" : "next"}=${next.toISOString().slice(0, 16)}`);
    ctx.out(ctx.ui.dim(ko
      ? `지금 실행: agentlas automation run ${id.slice(0, 8)}  ·  예약 실행: agentlas automation daemon (또는 Desktop)`
      : `Run now: agentlas automation run ${id.slice(0, 8)}  ·  scheduled: agentlas automation daemon (or Desktop)`));
    return 0;
  }

  if (sub === "on" || sub === "off") {
    const idPrefix = args[1];
    if (!idPrefix) return fail(usage(`${sub} <id>`));
    const row = store.getAutomationByPrefix(db, idPrefix);
    if (!row) return fail(missingAutomation(idPrefix));
    store.setEnabled(db, row, sub === "on");
    ctx.out(`${sub === "on" ? (ko ? "활성화됨" : "Enabled") : (ko ? "비활성화됨" : "Disabled")}: ${row.id.slice(0, 8)}  ${row.name}`);
    return 0;
  }

  if (sub === "remove" || sub === "rm") {
    const idPrefix = args[1];
    if (!idPrefix) return fail(usage("remove <id>"));
    const row = store.getAutomationByPrefix(db, idPrefix);
    if (!row) return fail(missingAutomation(idPrefix));
    store.removeAutomation(db, row.id);
    ctx.out(`${ko ? "삭제됨" : "Deleted"}: ${row.id.slice(0, 8)}  ${row.name}`);
    return 0;
  }

  if (sub === "runs") {
    const rows = store.listRuns(db, 15);
    if (!rows.length) {
      ctx.out(ko ? "실행 기록이 없습니다." : "No run history.");
      return 0;
    }
    for (const r of rows) {
      const status = ko
        ? (r.status === "ok" ? "성공" : r.status === "error" ? "오류" : (r.status || "?"))
        : (r.status || "?");
      ctx.out(
        `${(r.ran_at || "").slice(0, 16).padEnd(17)} ${(r.status === "ok" ? ctx.ui.green(status.padEnd(9)) : ctx.ui.red(status.padEnd(9)))} ` +
          `${(r.name || (ko ? "(삭제됨)" : "(deleted)")).slice(0, 30).padEnd(31)} ${r.error ? ctx.ui.dim(String(r.error).slice(0, 40)) : ""}`,
      );
    }
    return 0;
  }

  if (sub === "run") {
    const idPrefix = args[1];
    let runtimeOverride = null;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--runtime") runtimeOverride = args[++i];
    }
    if (!idPrefix) return fail(usage("run <id>"));
    const row = store.getAutomationByPrefix(db, idPrefix);
    if (!row) return fail(missingAutomation(idPrefix));
    // run-now는 스케줄을 건드리지 않는다 (앱의 advanceSchedule=false와 동일).
    let renderer = null;
    const r = await daemon.runAutomationOnce(ctx, db, row, {
      advanceSchedule: false,
      runtimeOverride,
      onSession: (session) => {
        if (ctx.uiInstance) {
          const { Renderer } = require("../ui/renderer.cjs");
          renderer = new Renderer(ctx.uiInstance);
          renderer.attach(session, { replay: false });
        }
      },
    });
    if (renderer) renderer.detach();
    return r.ok ? 0 : 1;
  }

  if (sub === "daemon") {
    let interval = 30;
    let runtimeOverride = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--interval") interval = Math.max(10, Number(args[++i]) || 30);
      else if (args[i] === "--runtime") runtimeOverride = args[++i];
    }
    return daemon.automationDaemon(ctx, db, { intervalSec: interval, runtimeOverride });
  }

  ctx.err(usage("list|add|on <id>|off <id>|remove <id>|run <id>|runs|daemon"));
  return 1;
}

module.exports = { run };
