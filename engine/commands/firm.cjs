"use strict";
/*
 * firm — 회사(CEO) 위임: agentlas firm <slug> [task…]
 * 실행 경로는 세션 계층 하나다(제2 spawn 경로 금지).
 * 무인자: 회사 목록. task 없이 slug만: 그 CEO와 REPL(기존 동작 유지).
 * task가 있으면 데스크탑 firm-orchestrator 동형의 3-tier 위임을 돈다:
 *   CEO PLAN(## Delegate 펜스) → 본부 병렬 실행(division 서브세션) → CEO SYNTHESIZE.
 *   (firms/orchestrate.cjs runFirmTurn — 단순 CEO 챗 1턴이 아니다.)
 */
const { rowToAgent } = require("../agents/registry.cjs");

function parseFirmArgs(args) {
  const flags = { runtime: null, model: null, effort: null, tier: null, permission: null, task: [] };
  const fields = new Map([
    ["--runtime", "runtime"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--tier", "tier"],
    ["--permission", "permission"],
  ]);
  const seen = new Set();
  let passthrough = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (passthrough) { flags.task.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    const at = token.indexOf("=");
    const option = at >= 0 ? token.slice(0, at) : token;
    const field = fields.get(option);
    if (field) {
      if (seen.has(field)) throw new Error(`duplicate option: ${option}`);
      seen.add(field);
      const value = at >= 0 ? token.slice(at + 1) : args[++i];
      if (value === undefined || value === "" || (at < 0 && String(value).startsWith("--"))) {
        throw new Error(`${option} requires a value`);
      }
      flags[field] = String(value);
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unknown option: ${token} (use -- before a task that starts with '-')`);
    }
    flags.task.push(token);
  }
  return flags;
}

function findFirm(db, token) {
  const q = String(token || "").trim().toLowerCase();
  if (!q) return null;
  return db.prepare("SELECT * FROM firms WHERE lower(id)=? OR lower(slug)=? OR lower(name)=?").get(q, q, q)
    || db.prepare("SELECT * FROM firms WHERE lower(slug) LIKE ? ORDER BY slug LIMIT 1").get(`%${q}%`)
    || null;
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  if (!ctx.tableExists(db, "firms")) {
    ctx.out(ko ? "회사가 없습니다." : "No companies yet.");
    return 0;
  }
  if (!args.length) {
    const firms = db.prepare("SELECT slug, name, tagline FROM firms ORDER BY name").all();
    if (!firms.length) {
      ctx.out(ko ? "회사가 없습니다. (팀 폴더를 import 하면 회사로 등록됩니다)" : "No companies yet. (import a team folder to register one)");
      return 0;
    }
    for (const f of firms) ctx.out(`  ${ctx.ui.accent(String(f.slug).padEnd(28))} ${f.name}${f.tagline ? ctx.ui.dim(" — " + f.tagline) : ""}`);
    return 0;
  }

  const firm = findFirm(db, args[0]);
  if (!firm) {
    ctx.err((ko ? "회사를 찾을 수 없음: " : "firm not found: ") + args[0]);
    return 1;
  }
  const ceoRow = firm.ceo_agent_id
    ? db.prepare("SELECT * FROM installed_agents WHERE id=?").get(firm.ceo_agent_id)
    : null;
  if (!ceoRow) {
    ctx.err(ko
      ? `회사 ${firm.slug} 의 CEO 에이전트가 없습니다 (ceo_agent_id 미해결). 팀 폴더를 다시 import 하세요.`
      : `Firm ${firm.slug} has no resolvable CEO agent. Re-import the team folder.`);
    return 1;
  }
  const ceo = rowToAgent(ceoRow);

  // 명령끼리 참조 금지 규칙상 run.cjs 미차용. 오타 옵션은 CEO 계획 턴으로
  // 흘리지 않고, 대시로 시작하는 실제 작업은 `--` 뒤에서만 받는다.
  let flags;
  try { flags = parseFirmArgs(args.slice(1)); }
  catch (error) { ctx.err(String((error && error.message) || error)); return 1; }
  const task = flags.task.join(" ").trim();
  if (task) {
    // 3-tier 위임 실행 — PLAN → DELEGATE → SYNTHESIZE (firms/orchestrate.cjs).
    const { runFirmTurn } = require("../firms/orchestrate.cjs");
    const {
      resolveRuntimeForAgent,
      unavailableOverrideNote,
      unavailableRoleNote,
    } = require("../runtimes/overrides.cjs");
    const { EFFORTS, TIERS } = require("../agentlas-workload-routing.cjs");
    const { Orchestrator } = require("../sessions/orchestrator.cjs");
    const permissions = require("../agentlas-permissions.cjs");
    // 플래그 검증은 CEO 계획 턴을 부르기 전에. normalize는 모르는 값을 read로 fail-closed
    // 강등하는데, firm은 그 권한을 CEO·본부 전 세션·종합 턴까지 그대로 물려주므로 조용히
    // 강등하면 full을 요청한 사용자가 쓰기 차단된 채 3-tier 전체를 돌린 줄 모른다 (run.cjs 동일 가드).
    if (flags.permission && !permissions.LEVELS.includes(String(flags.permission))) {
      ctx.err(`unknown --permission ${flags.permission} (use: ${permissions.LEVELS.join(" | ")})`);
      return 1;
    }
    if (flags.effort && !EFFORTS.includes(String(flags.effort))) {
      ctx.err(`unknown --effort ${flags.effort} (use: ${EFFORTS.join(" | ")})`);
      return 1;
    }
    if (flags.tier && !TIERS.includes(String(flags.tier))) {
      ctx.err(`unknown --tier ${flags.tier} (use: ${TIERS.join(" | ")})`);
      return 1;
    }
    if (flags.tier && !flags.model) {
      ctx.err("--tier requires --model: Terminal never guesses a provider model id from a cost tier");
      return 1;
    }
    let runtime;
    let workerRuntime;
    try {
      // CEO는 orchestrator, 본부는 worker. 명시 핀은 기존 firm 호출과의 호환을 위해
      // 두 역할 모두에 적용하고, 미지정 시 각각 model_roles 기본값을 사용한다.
      runtime = resolveRuntimeForAgent({
        db,
        prefs: ctx.prefs,
        explicit: flags.runtime,
        model: flags.model,
        effort: flags.effort,
        role: "orchestrator",
        targets: [
          { scope: "agent", targetId: ceo.id },
          { scope: "firm", targetId: firm.id },
        ],
      });
      workerRuntime = resolveRuntimeForAgent({
        db,
        prefs: ctx.prefs,
        explicit: flags.runtime,
        model: flags.model,
        effort: flags.effort,
        role: "worker",
        targets: [{ scope: "firm", targetId: firm.id }],
      });
      if (flags.tier) {
        runtime.modelTier = flags.tier;
        workerRuntime.modelTier = flags.tier;
      }
    } catch (e) {
      ctx.err(String((e && e.message) || e));
      return 1;
    }
    if (runtime.unavailableOverride) ctx.err(ctx.ui.dim(unavailableOverrideNote(runtime, ctx.lang)));
    if (runtime.unavailableRoleSelection) ctx.err(ctx.ui.dim(unavailableRoleNote(runtime, ctx.lang)));
    if (workerRuntime.unavailableOverride) ctx.err(ctx.ui.dim(unavailableOverrideNote(workerRuntime, ctx.lang)));
    if (workerRuntime.unavailableRoleSelection) ctx.err(ctx.ui.dim(unavailableRoleNote(workerRuntime, ctx.lang)));
    const orch = new Orchestrator({ db, lang: ctx.lang });
    const dim = ctx.ui.dim;
    const result = await runFirmTurn({
      db,
      orch,
      firm,
      ceoAgent: ceo,
      task,
      runtime,
      workerRuntime,
      resolveWorkerRuntime: flags.runtime || flags.model || flags.effort
        ? null
        : (node) => resolveRuntimeForAgent({
            db,
            prefs: ctx.prefs,
            explicit: null,
            role: "worker",
            targets: [
              { scope: "agent", targetId: node.agent.id },
              { scope: "division", targetId: `${firm.id}:${node.role}` },
              { scope: "firm", targetId: firm.id },
            ],
          }),
      permission: permissions.normalize(flags.permission || (ctx.prefs && ctx.prefs.permission) || "write"),
      cwd: process.cwd(),
      onEvent: (ev) => {
        if (ev.phase === "plan") ctx.err(dim(ko ? `${firm.name} · CEO가 작업을 분배하는 중…` : `${firm.name} · CEO is planning the work…`));
        else if (ev.phase === "delegate") ctx.err(dim((ko ? "위임 → " : "delegating → ") + ev.targets.map((t) => t.name || t.role).join(", ")));
        else if (ev.phase === "repair") ctx.err(dim(ko ? "검증 결함 확인 → 수정 후 재검증" : "Verification blocker found → repairing before re-check"));
        else if (ev.phase === "verify") ctx.err(dim(ko ? "구현 결과 준비 완료 → 독립 검증 시작" : "Implementation ready → starting independent verification"));
        else if (ev.phase === "division-done") ctx.err(dim(`  ${ev.role}: ${ev.ok ? "ok" : "failed"}`));
        else if (ev.phase === "synthesize") ctx.err(dim(ko ? "팀 결과를 종합하는 중…" : "Synthesizing team results…"));
      },
    });
    orch.shutdown();
    if (result.text) ctx.out(result.text.trimEnd());
    if (!result.ok) {
      ctx.err(ko ? "일부 본부/종합 턴이 실패했습니다 (위 status 참조)." : "Some division or synthesis turns failed (see status above).");
      return 1;
    }
    return 0;
  }
  const { startRepl } = require("../ui/repl.cjs");
  return startRepl(ctx, { agent: ceo.slug });
}

module.exports = { run, findFirm, parseFirmArgs };
