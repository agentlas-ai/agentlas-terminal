"use strict";
/*
 * automation — 자동화 등록/목록/토글/삭제/실행 (v1 cmdAutomation 의 v2 포팅).
 *   list (기본) | add | on <id> | off <id> | remove <id> | run <id> | runs | daemon
 *   tick            1회 due 스윕 후 종료(launchd/cron 이 poke 하는 진입점)
 *   install         macOS launchd 상주 켜기 — 앱/창이 꺼져 있어도 발동(opt-in)
 *   uninstall       상주 끄기 · status  상주 상태
 *
 * 스케줄 계산은 automation/schedule, DB는 automation/store, 실행은
 * automation/daemon(세션 계층)만 쓴다. run <id> 는 스케줄을 건드리지 않는다
 * (앱의 advanceSchedule=false 와 동일); 예약 전진은 daemon 경로에서만 일어난다.
 */
const { findAgent } = require("../agents/registry.cjs");
const schedule = require("../automation/schedule.cjs");
const store = require("../automation/store.cjs");
const daemon = require("../automation/daemon.cjs");

function parseOptions(args, schema) {
  const values = new Set(schema.values || []);
  const booleans = new Set(schema.booleans || []);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (!token.startsWith("--") || token === "--") throw new Error(`unexpected argument: ${token}`);
    const at = token.indexOf("=");
    const key = token.slice(2, at >= 0 ? at : undefined);
    if (!values.has(key) && !booleans.has(key)) throw new Error(`unknown option: --${key}`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`duplicate option: --${key}`);
    if (booleans.has(key)) {
      if (at >= 0) throw new Error(`--${key} does not take a value`);
      out[key] = true;
      continue;
    }
    const value = at >= 0 ? token.slice(at + 1) : args[++i];
    if (value === undefined || value === "" || (at < 0 && String(value).startsWith("--"))) {
      throw new Error(`--${key} requires a value`);
    }
    out[key] = String(value);
  }
  return out;
}

function intervalOption(raw, minimum, label = "--interval") {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} requires an integer of at least ${minimum} seconds`);
  }
  return parsed;
}

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
    if (args.length !== 1 && args.length !== 0) return fail(`unexpected argument: ${String(args[1])}`);
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
    let flags;
    try {
      flags = parseOptions(args.slice(1), {
        values: ["name", "agent", "firm", "cron", "prompt", "tz"],
        booleans: ["disabled"],
      });
    } catch (error) { return fail(String((error && error.message) || error)); }
    if (flags.agent && flags.firm) return fail("use only one of --agent or --firm");
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
    if (args.length !== 2) return fail(`unexpected argument: ${String(args[2])}`);
    const row = store.getAutomationByPrefix(db, idPrefix);
    if (!row) return fail(missingAutomation(idPrefix));
    const outcome = store.setEnabledChecked(db, row, sub === "on");
    if (!outcome.changed) {
      return fail(ko
        ? `자동화가 변경되는 동안 사라졌습니다: ${row.id}`
        : `Automation changed before it could be updated: ${row.id}`);
    }
    ctx.out(`${sub === "on" ? (ko ? "활성화됨" : "Enabled") : (ko ? "비활성화됨" : "Disabled")}: ${row.id.slice(0, 8)}  ${row.name}`);
    return 0;
  }

  if (sub === "remove" || sub === "rm") {
    const idPrefix = args[1];
    if (!idPrefix) return fail(usage("remove <id>"));
    if (args.length !== 2) return fail(`unexpected argument: ${String(args[2])}`);
    const row = store.getAutomationByPrefix(db, idPrefix);
    if (!row) return fail(missingAutomation(idPrefix));
    if (!store.removeAutomation(db, row.id)) {
      return fail(ko
        ? `자동화가 삭제되는 동안 사라졌습니다: ${row.id}`
        : `Automation changed before it could be deleted: ${row.id}`);
    }
    ctx.out(`${ko ? "삭제됨" : "Deleted"}: ${row.id.slice(0, 8)}  ${row.name}`);
    return 0;
  }

  if (sub === "runs") {
    if (args.length !== 1) return fail(`unexpected argument: ${String(args[1])}`);
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
    if (!idPrefix) return fail(usage("run <id>"));
    let runFlags;
    try { runFlags = parseOptions(args.slice(2), { values: ["runtime"], booleans: [] }); }
    catch (error) { return fail(String((error && error.message) || error)); }
    const runtimeOverride = runFlags.runtime || null;
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
    let daemonFlags;
    try { daemonFlags = parseOptions(args.slice(1), { values: ["interval", "runtime"], booleans: [] }); }
    catch (error) { return fail(String((error && error.message) || error)); }
    let interval = 30;
    try { if (daemonFlags.interval !== undefined) interval = intervalOption(daemonFlags.interval, 10); }
    catch (error) { return fail(String((error && error.message) || error)); }
    const runtimeOverride = daemonFlags.runtime || null;
    return daemon.automationDaemon(ctx, db, { intervalSec: interval, runtimeOverride });
  }

  // 1회 due 스윕 후 종료 — launchd/cron 이 poke 하는 진입점(상주 루프 아님).
  if (sub === "tick") {
    if (args.length !== 1) return fail(`unexpected argument: ${String(args[1])}`);
    await daemon.daemonTick(ctx, db, {});
    return 0;
  }

  // 앱/창이 꺼져 있어도 자동화가 발동하도록 macOS launchd 로 상주시킨다(opt-in).
  if (sub === "install" || sub === "uninstall" || sub === "status") {
    const launchd = require("../automation/launchd.cjs");
    if (sub === "status") {
      if (args.length !== 1) return fail(`unexpected argument: ${String(args[1])}`);
      const st = launchd.launchdStatus();
      if (!st.supported) { ctx.out(ko ? "launchd 상주는 macOS 전용입니다. 다른 OS 는 `agentlas automation daemon` 을 켜 두세요." : "launchd persistence is macOS-only. On other systems keep `agentlas automation daemon` running."); return 0; }
      ctx.out(`${st.loaded ? ctx.ui.green("✓") : ctx.ui.dim("○")} ${ko ? "상주(launchd)" : "persistence (launchd)"}: ${st.loaded ? (ko ? "실행 중" : "loaded") : st.installed ? (ko ? "설치됨(미로드)" : "installed (not loaded)") : (ko ? "미설치" : "not installed")}`);
      ctx.out(ctx.ui.dim(`plist: ${st.plistPath}`));
      if (!st.loaded) ctx.out(ctx.ui.dim(ko ? "켜기: agentlas automation install" : "Enable: agentlas automation install"));
      return 0;
    }
    if (sub === "install") {
      let installFlags;
      try { installFlags = parseOptions(args.slice(1), { values: ["interval"], booleans: [] }); }
      catch (error) { return fail(String((error && error.message) || error)); }
      let interval = 300;
      try { if (installFlags.interval !== undefined) interval = intervalOption(installFlags.interval, 30); }
      catch (error) { return fail(String((error && error.message) || error)); }
      const st = launchd.enableLaunchd({ intervalSec: interval });
      if (st.error) { ctx.err(`${ctx.ui.red("✖")} ${st.error}`); return 1; }
      ctx.out(`${ctx.ui.green("✓")} ${ko ? "상주를 켰습니다 — 앱/창이 꺼져 있어도 자동화가 발동합니다" : "persistence on — automations fire even with the app/window closed"} (${interval}s)`);
      ctx.out(ctx.ui.dim(ko ? `${Math.max(30, interval)}초마다 due 를 확인합니다. 끄기: agentlas automation uninstall` : `checks due automations every ${Math.max(30, interval)}s. Disable: agentlas automation uninstall`));
      return 0;
    }
    // uninstall
    if (args.length !== 1) return fail(`unexpected argument: ${String(args[1])}`);
    const st = launchd.disableLaunchd();
    if (st.error) { ctx.err(`${ctx.ui.red("✖")} ${st.error}`); return 1; }
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "상주를 껐습니다. 자동화는 포그라운드 daemon 을 켜 둘 때만 발동합니다." : "persistence off. Automations fire only while a foreground daemon runs."}`);
    return 0;
  }

  ctx.err(usage("list|add|on <id>|off <id>|remove <id>|run <id>|runs|daemon|tick|install|uninstall|status"));
  return 1;
}

module.exports = { run, parseOptions, intervalOption };
