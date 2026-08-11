"use strict";
/*
 * storm/storm — Agentlas 자체 Goal/UltraCode 하네스 (Stormbreaker).
 *
 * v1 engine/agentlas-parity.cjs (legacy-v1-engine-snapshot 608–751행)의 포팅.
 * plan → allocate → execute → verify: Hephaestus `route`로 라우팅 근거만 수집하고,
 * 실행은 storm/swarm.cjs 의 스웜 하네스(stormbreaker: true)로 돌린다.
 *
 * 불변식 (v1 사고에서 배운 것 — 약화 금지):
 *  - Core owns the exact Goal/UltraCode prompt. Terminal supplies only host
 *    runtime inventory, worker context, and execution; no local prompt fallback.
 *    Core 하네스가 없으면 stormbreaker-core-harness-unavailable 로 정직 정지한다 —
 *    로컬 모조 하네스로 흉내내지 않는다.
 *  - Hephaestus CLI `--auto-run`을 절대 쓰지 않는다: storm은 자기 하네스에서
 *    실행한다. route 출력은 advisory 증거일 뿐이고 Agentlas 부모 플래너가 최종
 *    계획을 소유한다.
 *  - route 실패(비JSON/exit≠0)는 경고 후 원 목표로 계속한다 — route는 선택적
 *    증거이지 실행 게이트가 아니다.
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { Ui } = require("../agentlas-ui.cjs");
const {
  loadCoreStormbreakerHarness,
  resolveCoreRuntimeRoot,
  spawnCoreModule,
} = require("../agentlas-core-harness.cjs");

/**
 * create(deps) — v1 parity 팩토리와 동일한 D-주입 생성.
 * storm은 swarm과 같은 D를 공유한다 (storm/deps.cjs buildStormDeps 참조).
 */
function create(deps) {
  const D = deps;
  const { swarmRun } = require("./swarm.cjs").create(D);

  /*
   * 셸 이행 정지작업 (D3 Phase 1-2, 2026-08-11): ctx가 준 Ui가 있으면 그것을
   * 쓴다. 자체 생성 Ui는 렌더러 교체 시 구 코드가 stdout에 직접 써 프레임을
   * 찢는 병렬 경로였다. 생성은 주입이 없을 때의 폴백으로만 남긴다.
   */
  function newUi(lang) {
    if (D.uiInstance) return D.uiInstance;
    return new Ui({ lang: lang || D.prefsLang() });
  }

  // ── Hephaestus 런타임 해석 (설치 런처 우선, Core 파이썬 루트 폴백) ──
  function hephaestusBin() {
    const candidates = [
      process.env.HEPHAESTUS_BIN,
      path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus"),
    ];
    for (const c of process.platform === "win32" ? [] : candidates) {
      try {
        if (c && fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return { kind: "bin", exec: c };
        }
      } catch { /* 다음 후보 */ }
    }
    const root = resolveCoreRuntimeRoot();
    if (root) return { kind: "python", root };
    return null;
  }

  function spawnHephaestus(args, opts) {
    const found = hephaestusBin();
    if (!found) return null;
    if (found.kind === "bin") return spawn(found.exec, args, opts);
    return spawnCoreModule("agentlas_cloud", args, opts, found.root);
  }

  // ── storm — Agentlas 자체 Goal/UltraCode 하네스 ──
  // Core owns the exact Goal/UltraCode prompt. Terminal supplies only host
  // runtime inventory, worker context, and execution; no local prompt fallback.
  // ctx: { ui?, cwd?, research?, background?, runtimeOverride? }
  async function stormRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: storm <goal>  [--research]");
      return { ok: false };
    }
    if (goal.startsWith("-")) {
      ui.error("goal cannot start with '-'.", { reveal: true });
      return { ok: false };
    }
    const cwd = ctx.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd());
    let executionHarness;
    try {
      executionHarness = await loadCoreStormbreakerHarness(cwd);
    } catch (error) {
      ui.error(`Stormbreaker Core harness unavailable: ${String((error && error.message) || error).slice(0, 400)}`, { reveal: true });
      return { ok: false, error: "stormbreaker-core-harness-unavailable" };
    }
    const args = ["route", goal, "--project", cwd, "--runtime", "terminal"];
    if (ctx.research) args.push("--research-evidence");
    if (ctx.background) {
      ui.warn(ui.lang === "ko"
        ? "Agentlas 자체 Stormbreaker 하네스는 현재 포그라운드에서 실행합니다. 세션이 끝나도 영수증으로 재개 지점을 보존합니다."
        : "The Agentlas-owned Stormbreaker harness currently runs in the foreground and preserves resume receipts.");
    }

    let result = { code: 0, stdout: "", stderr: "" };
    if (hephaestusBin()) {
      ui.beginTurn();
      ui.startSpinner(ui.lang === "ko" ? "Stormbreaker 라우팅 근거 수집 중…" : "Stormbreaker gathering route evidence…");
      result = await new Promise((resolve) => {
        const child = spawnHephaestus(args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderrTail = [];
        child.stdout.on("data", (c) => { stdout += c.toString(); });
        child.stderr.on("data", (c) => {
          for (const ln of c.toString().split("\n")) {
            const line = ln.trim();
            if (!line) continue;
            stderrTail.push(line);
            if (stderrTail.length > 30) stderrTail.shift();
            ui.updateSpinner(line.slice(0, 100));
          }
        });
        child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err.message) }));
        child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr: stderrTail.join("\n") }));
      });
      ui.stopSpinner();
      ui.endTurn();
    }

    let json = null;
    try {
      const s = result.stdout.indexOf("{");
      const e = result.stdout.lastIndexOf("}");
      if (s >= 0 && e > s) json = JSON.parse(result.stdout.slice(s, e + 1));
    } catch { /* 비JSON 출력 */ }

    let routeContext = "";
    if (json) {
      const action = json.action || json.route_action || (json.route_decision && json.route_decision.action) || json.status || "?";
      ui.line("");
      ui.ok((ui.lang === "ko" ? "storm 결과: " : "storm result: ") + action);
      const fields = {
        receipt_id: json.receipt_id || (json.route_decision && json.route_decision.receipt_id),
        pipeline_id: json.pipeline_id,
        journal: json.journal,
        status: json.status,
        can_report_success: json.final_gate && json.final_gate.can_report_success,
      };
      if (json.auto_run) {
        fields.auto_run = String(json.auto_run.status || "") + (json.auto_run.reason ? ` — ${json.auto_run.reason}` : "");
      }
      const sel = json.selected;
      if (sel) fields.selected = typeof sel === "string" ? sel : sel.id || sel.slug || sel.name;
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null && v !== "") ui.info(`${k}: ${v}`);
      }
      if (json.clarify_question) ui.warn(String(json.clarify_question));
      if (json.reason) ui.info(String(json.reason));
      // 파이프라인 패킷 요약
      const packets = json.execution_fabric && json.execution_fabric.packets;
      if (Array.isArray(packets)) {
        routeContext = packets.slice(0, 24).map((p) => {
          const title = String(p.title || p.id || "packet").replace(/\s+/g, " ").slice(0, 160);
          const card = p.card ? ` [agent:${String(p.card).slice(0, 100)}]` : "";
          return `- ${title}${card}`;
        }).join("\n");
        for (const p of packets.slice(0, 12)) {
          ui.line("  " + ui.c.emerald("▸ ") + ui.c.text(String(p.title || p.id || "packet")) + (p.card ? ui.c.dim("  " + p.card) : ""));
        }
      }
      // 파이프라인이 아니면 추천 에이전트라도 보여준다 (hub_candidates 등)
      const exec = json.execution || {};
      const recos = []
        .concat(exec.recommended_agents || [], exec.alternatives || [])
        .map((a) => (typeof a === "string" ? a : a && (a.id || a.slug || a.name)))
        .filter(Boolean);
      if (recos.length) {
        ui.line("");
        ui.info(ui.lang === "ko" ? "추천 에이전트:" : "recommended agents:");
        for (const r of recos.slice(0, 8)) ui.line("  " + ui.c.emerald("▸ ") + ui.c.text(r));
        ui.info(ui.lang === "ko" ? '빌려 실행: agentlas cloud install <slug> 또는 "/storm"을 더 구체적 목표로.' : "borrow: agentlas cloud install <slug>, or re-run /storm with a more specific goal.");
      }
    } else {
      const raw = (result.stdout || result.stderr || "").trim();
      if (raw) ui.markdown(raw.slice(0, 4000));
    }
    if (result.code !== 0 && !json) {
      ui.warn(`Hephaestus route evidence unavailable (${result.code}); Agentlas parent planner will continue from the original goal.`);
    }

    const harnessResult = await swarmRun(db, goal, {
      ...ctx,
      ui,
      cwd,
      runtimeOverride: ctx.runtimeOverride,
      stormbreaker: true,
      executionHarness,
      routeContext,
    });
    return { ...harnessResult, routeDecision: json };
  }

  async function cmdStorm(db, args, runtimeOverride, executionContext = {}) {
    const rest = [];
    const ctx = {
      ...executionContext,
      cwd: executionContext.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd()),
      runtimeOverride,
    };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--research" || args[i] === "--research-evidence") ctx.research = true;
      else if (args[i] === "--background") ctx.background = true;
      else rest.push(args[i]);
    }
    const r = await stormRun(db, rest.join(" "), ctx);
    if (!r.ok) process.exitCode = 1;
    return r;
  }

  return { stormRun, cmdStorm };
}

module.exports = { create };
