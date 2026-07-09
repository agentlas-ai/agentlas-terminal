"use strict";
/*
 * agentlas-parity: 데스크탑 앱 전용이던 기능의 터미널 패리티 구현.
 *
 *   storm      — Hephaestus Stormbreaker(route --auto-run) 파이프라인 실행 (+연구 증거)
 *   swarm      — emergent 에이전트 스웜 (블랙보드 + `## Spawn` 그래프 성장 + 종합)
 *   automation — 앱 스케줄러가 실행하는 자동화의 등록/목록/토글 (같은 SQLite)
 *   usage      — 로컬 실행/자동화/세션 집계
 *   telegram   — 텔레그램 바인딩 현황 (읽기 전용; 페어링은 앱 Connect)
 *   cloud search — 마켓플레이스 검색 (MCP marketplace.search_agents)
 *
 * agentlas.cjs 가 create(deps)로 주입한 헬퍼(captureRuntime/runApi/resolveRuntime 등)만
 * 사용한다 — 이 파일은 DB 스키마와 프로세스 스폰 외에 자체 상태를 갖지 않는다.
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Ui } = require("./agentlas-ui.cjs");

// ── 스웜 상수 (앱 mcp/swarm-run.ts 와 동일한 안전 상한) ──
const SWARM_MAX_TASKS = 24;
const SWARM_SPAWN_PER_TURN = 12;

// Agentlas-OS/Hephaestus 내부 시스템 에이전트(마켓 제품 아님) — 검색/목록에서 숨긴다.
// 데스크탑 electron/agents/hired-agents.ts isInternalAgentSlug 와 규칙 동일.
function isInternalAgentSlug(slug) {
  const s = String(slug || "").toLowerCase();
  return /^researcher-\d+/.test(s) || s === "research-intelligence-desk" || s.startsWith("hephaestus-");
}

function create(deps) {
  const D = deps;

  function newUi(lang) {
    return new Ui({ lang: lang || D.prefsLang() });
  }

  // ── Hephaestus 런타임 해석 (설치 런처 우선, 앱 번들 폴백) ──
  function hephaestusBin() {
    const candidates = [
      process.env.HEPHAESTUS_BIN,
      path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus"),
    ];
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return { kind: "bin", exec: c };
        }
      } catch { /* 다음 후보 */ }
    }
    // 앱 번들 (Resources/Hephaestus) — python3 로 bin/hephaestus 와 동일한 부트스트랩 실행
    const roots = [];
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "Hephaestus"));
    if (process.platform === "darwin") roots.push("/Applications/Agentlas.app/Contents/Resources/Hephaestus");
    for (const root of roots) {
      try {
        if (fs.existsSync(path.join(root, "agentlas_cloud", "__main__.py"))) return { kind: "python", root };
      } catch { /* 다음 후보 */ }
    }
    return null;
  }

  function careerGraphRuntime() {
    const binCandidates = [
      process.env.HEPHAESTUS_CAREER_GRAPH_BIN,
      process.env.HEPHAESTUS_BIN ? path.join(path.dirname(process.env.HEPHAESTUS_BIN), "career-graph") : null,
      path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "career-graph"),
    ];
    for (const c of binCandidates) {
      try {
        if (c && fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return { kind: "bin", exec: c };
        }
      } catch { /* 다음 후보 */ }
    }
    const roots = [
      process.env.HEPHAESTUS_RUNTIME_ROOT,
      path.join(os.homedir(), ".agentlas", "runtime", "current"),
    ];
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "Hephaestus"));
    if (process.platform === "darwin") roots.push("/Applications/Agentlas.app/Contents/Resources/Hephaestus");
    roots.push(path.resolve(__dirname, "..", "..", "agentlas_desktop", "Hephaestus"));
    for (const root of roots) {
      try {
        if (root && fs.existsSync(path.join(root, "career_graph", "__main__.py"))) return { kind: "python", root };
      } catch { /* 다음 후보 */ }
    }
    return null;
  }

  const PY_BOOTSTRAP =
    "import os, runpy, sys; " +
    'cwd=os.getcwd(); root=os.environ["HEPHAESTUS_RUNTIME_ROOT"]; ' +
    'sys.path=[p for p in sys.path if p not in ("", cwd, root)]; ' +
    "sys.path.insert(0, root); " +
    "sys.argv=sys.argv[1:]; " +
    'runpy.run_module(sys.argv[0], run_name="__main__", alter_sys=True)';

  function spawnHephaestus(args, opts) {
    const found = hephaestusBin();
    if (!found) return null;
    if (found.kind === "bin") return spawn(found.exec, args, opts);
    return spawn("python3", ["-c", PY_BOOTSTRAP, "agentlas_cloud", ...args], {
      ...opts,
      env: { ...(opts && opts.env ? opts.env : process.env), HEPHAESTUS_RUNTIME_ROOT: found.root },
    });
  }

  // ── storm — 앱 stormbreakerRun()과 동일: route <goal> --auto-run ──
  // ctx: { ui?, cwd?, research?, background? }
  async function stormRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: storm <goal>  [--research]");
      return { ok: false };
    }
    if (goal.startsWith("-")) {
      ui.error("goal은 '-'로 시작할 수 없습니다.");
      return { ok: false };
    }
    if (!hephaestusBin()) {
      ui.error("Hephaestus 런타임이 없습니다 — 데스크탑 앱 설치 또는 Hephaestus 인스톨러 실행 후 다시 시도하세요.");
      ui.info("설치: https://agentlas.cloud  ·  또는 HEPHAESTUS_BIN=<경로> 지정");
      return { ok: false };
    }
    const cwd = ctx.cwd || D.runCwd();
    const args = ["route", goal, "--project", cwd, "--runtime", "terminal", "--auto-run"];
    if (ctx.research) args.push("--research-evidence");
    if (ctx.background) args.push("--background");

    ui.beginTurn();
    ui.startSpinner(ui.lang === "ko" ? "Stormbreaker 라우팅/파이프라인 실행 중…" : "Stormbreaker routing/pipeline…");
    const result = await new Promise((resolve) => {
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

    let json = null;
    try {
      const s = result.stdout.indexOf("{");
      const e = result.stdout.lastIndexOf("}");
      if (s >= 0 && e > s) json = JSON.parse(result.stdout.slice(s, e + 1));
    } catch { /* 비JSON 출력 */ }

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
    if (result.code !== 0 && !json) ui.error(`hephaestus exited ${result.code}`);
    return { ok: result.code === 0, json };
  }

  async function cmdStorm(db, args, runtimeOverride) {
    const rest = [];
    const ctx = { cwd: D.runCwd() };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--research" || args[i] === "--research-evidence") ctx.research = true;
      else if (args[i] === "--background") ctx.background = true;
      else rest.push(args[i]);
    }
    const r = await stormRun(db, rest.join(" "), ctx);
    if (!r.ok) process.exitCode = 1;
  }

  // ── Hephaestus 네이티브 패스스루 — 엔진 전 기능을 터미널 1급으로 노출 ──
  // stdio inherit 로 돌려 색/프롬프트/스트리밍이 네이티브 그대로 나온다.
  function runHephaestusInteractive(args, opts = {}) {
    const isCareerGraph = args[0] === "career-graph" || args[0] === "career_graph";
    const found = isCareerGraph ? careerGraphRuntime() : hephaestusBin();
    if (!found) {
      process.stderr.write(
        isCareerGraph
          ? "Career Graph 런타임이 없습니다 — 최신 Agentlas OS / Hephaestus 설치 후 다시 시도하세요.\n"
          : "Hephaestus 런타임이 없습니다 — 데스크탑 앱 설치 또는 Hephaestus 인스톨러 실행 후 다시 시도하세요.\n",
      );
      process.stderr.write(
        isCareerGraph
          ? "설치 또는 지정: HEPHAESTUS_CAREER_GRAPH_BIN=<경로> 또는 HEPHAESTUS_RUNTIME_ROOT=<경로>\n"
          : "설치: https://agentlas.cloud  ·  또는 HEPHAESTUS_BIN=<경로> 지정\n",
      );
      return Promise.resolve(1);
    }
    const cwd = opts.cwd || D.runCwd();
    const moduleName = found.kind === "python" && isCareerGraph ? "career_graph" : "agentlas_cloud";
    const moduleArgs = moduleName === "career_graph" ? args.slice(1) : args;
    const child =
      found.kind === "bin"
        ? spawn(found.exec, isCareerGraph ? args.slice(1) : args, { cwd, stdio: "inherit" })
        : spawn("python3", ["-c", PY_BOOTSTRAP, moduleName, ...moduleArgs], {
            cwd,
            stdio: "inherit",
            env: { ...process.env, HEPHAESTUS_RUNTIME_ROOT: found.root },
          });
    return new Promise((resolve) => {
      child.on("error", (e) => {
        process.stderr.write(`Hephaestus 실행 실패: ${e.message}\n`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code == null ? 0 : code));
    });
  }

  const HEP_USAGE = [
    "agentlas hep <hephaestus 서브커맨드…>   — 엔진 전 기능 네이티브 패스스루",
    "",
    "  1급 별칭:",
    "    agentlas build \"<요청>\"            에이전트/팀 빌드·수리·패키징 (hep-build)",
    "    agentlas route \"<요청>\"            라우팅 미리보기 — 어떤 에이전트가 잡히는지",
    "    agentlas research <sub…>           Research Engine (status|gather|search|read|plan…)",
    "    agentlas network <sub…>            로컬 에이전트 네트워크 (init|status|reindex|add-source…)",
    "    agentlas journal <sub…>            Stormbreaker 런 저널 (status|verify|repair|gate)",
    "    agentlas call \"a,b\" \"<컨텍스트>\"    지정한 Hub/Cloud 에이전트 준비 (hep-call)",
    "",
    "  전체 서브커맨드: agentlas hep --help  (wizard·security·package·publish·cards·ao·plugins·meta-agent…)",
  ].join("\n");

  async function cmdHep(db, args) {
    if (!args.length || args[0] === "help") {
      D.out(HEP_USAGE);
      return;
    }
    const code = await runHephaestusInteractive(args);
    if (code !== 0) process.exitCode = code;
  }

  // ── swarm — 앱 swarm-run.ts 프로토콜의 CLI 포트 ──
  function swarmProtocol(goal, tasks, task) {
    const doneList = tasks
      .filter((t) => t.status === "done")
      .slice(-8)
      .map((t) => `- ${t.title}`)
      .join("\n");
    return [
      "You are one worker in an EMERGENT AGENT SWARM collaborating on a shared goal.",
      `SHARED GOAL: ${goal}`,
      "",
      "YOUR TASK RIGHT NOW:",
      `- ${task.title}${task.role ? ` (role: ${task.role})` : ""}`,
      task.brief ? `- Details: ${task.brief}` : "",
      "",
      doneList ? `Already completed by peers (recent):\n${doneList}` : "No peer results yet — you may be first.",
      "",
      "RULES:",
      "1. Do your task concretely with available tools/files in the current working folder.",
      "2. If the goal needs MORE work beyond your task — split into concrete next steps — end your",
      "   message with a `## Spawn` block, one task per line as `role? | brief`:",
      "   ## Spawn",
      "   - webmaster | build the landing page structure",
      "   - | run the tests and report failures",
      "   (role is optional; omit it for any-worker tasks. Do NOT spawn if the goal is already met.)",
      "3. Do NOT restate the whole goal. Do NOT invent work that isn't needed — over-spawning wastes the user's money.",
      "4. Everything above the `## Spawn` block is your result and is shared with peers on the blackboard.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function parseSwarmOutput(text) {
    const m = String(text).match(/^[ \t]*##[ \t]*Spawn[ \t]*$/im);
    if (!m || m.index === undefined) return { result: String(text).trim(), spawn: [] };
    const result = String(text).slice(0, m.index).trim();
    const block = String(text).slice(m.index + m[0].length).split("\n");
    const spawn = [];
    for (const raw of block) {
      const line = raw.trim();
      if (!line.startsWith("-")) {
        if (line.startsWith("#")) break;
        continue;
      }
      const body = line.replace(/^-\s*/, "");
      const parts = body.split("|");
      let role;
      let brief;
      if (parts.length >= 2) {
        role = parts[0].trim() || undefined;
        brief = parts.slice(1).join("|").trim();
      } else {
        brief = body.trim();
      }
      if (brief) spawn.push({ title: brief.slice(0, 80), brief, role });
      if (spawn.length >= SWARM_SPAWN_PER_TURN) break;
    }
    return { result, spawn };
  }

  // ctx: { ui?, cwd?, permission?, runtime?, runtimeOverride?, concurrency?, agent?, projectPath? }
  async function swarmRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: swarm <goal>  [--parallel N]");
      return { ok: false };
    }
    const runtime = ctx.runtime || D.resolveRuntime(db, ctx.runtimeOverride);
    const permission = ctx.permission || "write";
    const cwd = ctx.cwd || D.runCwd();
    const concurrency = Math.max(1, Math.min(8, Number(ctx.concurrency) || 3));
    const env = await D.buildChildEnvCli(db, {
      projectPath: ctx.projectPath || null,
      agentId: ctx.agent && ctx.agent.id,
      permission,
      cwd,
      lang: ui.lang,
    });

    async function runWorker(system, prompt) {
      if (runtime.mode === "cli") {
        return await D.captureRuntime(runtime.kind, system, prompt, { cwd, env, permission });
      }
      const text = await D.runApi(runtime.backend, runtime.model, system, prompt);
      return typeof text === "string" ? text : (text && text.text) || "";
    }

    const label = runtime.mode === "cli" ? runtime.kind : runtime.backend;
    ui.line("");
    ui.line(ui.c.paw("◤ ") + ui.c.bold(ui.c.text("swarm")) + ui.c.dim(`  ${label} · x${concurrency} · max ${SWARM_MAX_TASKS} tasks`));
    ui.info(goal.slice(0, 120));

    let seq = 0;
    const tasks = [{ id: ++seq, title: goal.slice(0, 80), brief: goal, role: undefined, status: "pending", result: "" }];
    const seen = new Set([goal.slice(0, 80).toLowerCase()]);
    let active = 0;
    let failed = 0;

    await new Promise((resolveAll) => {
      const pump = () => {
        const pending = tasks.filter((t) => t.status === "pending");
        if (!pending.length && active === 0) return resolveAll();
        for (const task of pending) {
          if (active >= concurrency) break;
          task.status = "running";
          active++;
          ui.tool(`⚑ ${task.title}` + (task.role ? `  (${task.role})` : ""));
          runWorker(swarmProtocol(goal, tasks, task), task.brief || task.title)
            .then((text) => {
              const parsed = parseSwarmOutput(text);
              task.status = "done";
              task.result = parsed.result;
              ui.toolResult(parsed.result.split("\n").slice(0, 3).join("\n") || "(빈 결과)", true);
              for (const s of parsed.spawn) {
                const key = s.title.toLowerCase();
                if (tasks.length >= SWARM_MAX_TASKS || seen.has(key)) continue;
                seen.add(key);
                tasks.push({ id: ++seq, title: s.title, brief: s.brief, role: s.role, status: "pending", result: "" });
                ui.info(`+ spawn: ${s.title}`);
              }
            })
            .catch((e) => {
              task.status = "failed";
              failed++;
              ui.toolResult(String((e && e.message) || e).slice(0, 200), false);
            })
            .finally(() => {
              active--;
              setImmediate(pump);
            });
        }
      };
      pump();
    });

    const done = tasks.filter((t) => t.status === "done" && t.result);
    ui.line("");
    ui.info(`tasks: ${tasks.length}  ·  done: ${done.length}  ·  failed: ${failed}`);
    if (!done.length) {
      ui.error(ui.lang === "ko" ? "스웜이 완료한 작업이 없습니다." : "The swarm completed no work.");
      return { ok: false };
    }

    ui.startSpinner(ui.lang === "ko" ? "스웜 결과 종합 중…" : "Synthesizing swarm results…");
    const pieces = done.map((t, i) => `### ${i + 1}. ${t.title}\n${t.result}`).join("\n\n");
    let finalText;
    try {
      finalText = await runWorker(
        [
          "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
          "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
          "Do not just concatenate. Do not include a `## Spawn` block.",
          `SHARED GOAL: ${goal}`,
          `Answer in the user's language (${ui.lang === "ko" ? "Korean" : "English"}).`,
        ].join("\n"),
        pieces,
      );
    } catch (e) {
      ui.stopSpinner();
      ui.error("종합 실패: " + String((e && e.message) || e).slice(0, 200));
      finalText = pieces;
    }
    ui.stopSpinner();
    ui.line("");
    ui.markdown(String(finalText).trim());
    return { ok: true, finalText, taskCount: tasks.length, doneCount: done.length };
  }

  async function cmdSwarm(db, args, runtimeOverride) {
    const rest = [];
    let concurrency;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--parallel" || args[i] === "-n") concurrency = Number(args[++i]);
      else rest.push(args[i]);
    }
    const r = await swarmRun(db, rest.join(" "), { concurrency, runtimeOverride });
    if (!r.ok) process.exitCode = 1;
  }

  // ── 미니 cron (5필드: 분 시 일 월 요일) — next_run_at 계산용 ──
  // 앱 스케줄러(croner)는 next_run_at IS NULL 을 "시계 없음"으로 취급하므로 CLI가 직접 채워야 한다.
  function cronField(expr, min, max) {
    const set = new Set();
    for (const part of String(expr).split(",")) {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) return null;
      const step = m[2] ? Number(m[2]) : 1;
      let lo = min;
      let hi = max;
      if (m[1] !== "*") {
        const range = m[1].split("-").map(Number);
        lo = range[0];
        hi = range.length > 1 ? range[1] : m[2] ? max : range[0];
      }
      if (lo < min || hi > max || lo > hi || step < 1) return null;
      for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set;
  }

  function nextCronRun(cron, from = new Date()) {
    const parts = String(cron).trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minS, hourS, domS, monS, dowS] = parts;
    const mins = cronField(minS, 0, 59);
    const hours = cronField(hourS, 0, 23);
    const doms = cronField(domS, 1, 31);
    const mons = cronField(monS, 1, 12);
    const dows = cronField(dowS, 0, 7);
    if (!mins || !hours || !doms || !mons || !dows) return null;
    if (dows.has(7)) dows.add(0);
    const t = new Date(from.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const domOk = doms.has(t.getDate());
      const dowOk = dows.has(t.getDay());
      // 표준 cron: dom/dow 둘 다 제한이면 OR, 아니면 AND
      const domRestricted = domS !== "*";
      const dowRestricted = dowS !== "*";
      const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
      if (mons.has(t.getMonth() + 1) && dayOk && hours.has(t.getHours()) && mins.has(t.getMinutes())) return t;
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  // ── automation — 등록/목록/토글/실행 (run·daemon은 로컬 실행기) ──
  async function cmdAutomation(db, args, runtimeOverride) {
    const sub = args[0] || "list";
    const now = new Date().toISOString();

    if (sub === "list") {
      const rows = db.prepare(
        "SELECT id, name, schedule, target_type, target_id, enabled, next_run_at, last_run_at, run_count, trigger_type FROM automations ORDER BY created_at DESC",
      ).all();
      if (!rows.length) return D.out("자동화가 없습니다.  agentlas automation add --help");
      for (const r of rows) {
        const target = r.target_type + ":" + String(r.target_id).slice(0, 24);
        D.out(
          `${r.enabled ? "●" : "○"} ${String(r.id).slice(0, 8)}  ${String(r.name).padEnd(28).slice(0, 28)} ` +
            `${String(r.schedule || r.trigger_type).padEnd(14)} ${target.padEnd(32)} ` +
            `next=${r.next_run_at ? r.next_run_at.slice(0, 16) : "-"} runs=${r.run_count}`,
        );
      }
      D.out("");
      D.out("지금 실행: agentlas automation run <id>  ·  상주 실행기: agentlas automation daemon");
      D.out("(데스크탑 앱이 켜져 있으면 앱 스케줄러도 실행합니다 — 리스로 중복 실행은 방지됩니다.)");
      return;
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
        D.out('usage: agentlas automation add --name "이름" --agent <slug>|--firm <slug> --cron "0 9 * * *" --prompt "지시" [--tz Asia/Seoul] [--disabled]');
        process.exitCode = 1;
        return;
      }
      let targetType;
      let targetId;
      let targetLabel;
      if (flags.agent) {
        const a = D.resolveAgent(db, flags.agent);
        if (!a) return D.fail(`에이전트를 찾을 수 없습니다: ${flags.agent}`);
        targetType = "agent";
        targetId = a.id;
        targetLabel = a.name;
      } else {
        const f = D.resolveFirm(db, flags.firm);
        if (!f) return D.fail(`회사를 찾을 수 없습니다: ${flags.firm}`);
        targetType = "firm";
        targetId = f.id;
        targetLabel = f.name;
      }
      const next = nextCronRun(flags.cron);
      if (!next) return D.fail(`cron 표현식을 해석할 수 없습니다: "${flags.cron}" (5필드: 분 시 일 월 요일)`);
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO automations (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by,
           next_run_at, created_at, timezone, trigger_type, tool_mode, hub_mode, run_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      ).run(
        id,
        flags.name || `${targetLabel} 자동화`,
        flags.cron,
        targetType,
        targetId,
        flags.prompt,
        flags.disabled ? 0 : 1,
        "cli",
        next.toISOString(),
        now,
        flags.tz || null,
        "schedule",
        "auto",
        "hub-allowed",
      );
      D.out(`등록됨: ${id.slice(0, 8)}  ${flags.name || targetLabel}  next=${next.toISOString().slice(0, 16)}`);
      D.out(`지금 실행: agentlas automation run ${id.slice(0, 8)}  ·  예약 실행: agentlas automation daemon (또는 데스크탑 앱)`);
      return;
    }

    if (sub === "on" || sub === "off") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail(`usage: agentlas automation ${sub} <id>`);
      const row = db.prepare("SELECT id, name, schedule FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(`자동화를 찾을 수 없습니다: ${idPrefix}`);
      if (sub === "on") {
        const next = nextCronRun(row.schedule) || null;
        db.prepare("UPDATE automations SET enabled=1, next_run_at=? WHERE id=?").run(next ? next.toISOString() : null, row.id);
      } else {
        db.prepare("UPDATE automations SET enabled=0 WHERE id=?").run(row.id);
      }
      D.out(`${sub === "on" ? "켜짐" : "꺼짐"}: ${row.id.slice(0, 8)}  ${row.name}`);
      return;
    }

    if (sub === "remove" || sub === "rm") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail("usage: agentlas automation remove <id>");
      const row = db.prepare("SELECT id, name FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(`자동화를 찾을 수 없습니다: ${idPrefix}`);
      db.prepare("DELETE FROM automations WHERE id=?").run(row.id);
      D.out(`삭제됨: ${row.id.slice(0, 8)}  ${row.name}`);
      return;
    }

    if (sub === "runs") {
      const rows = db.prepare(
        `SELECT h.ran_at, h.status, h.error, a.name FROM run_history h
           LEFT JOIN automations a ON a.id = h.automation_id
           ORDER BY h.ran_at DESC LIMIT 15`,
      ).all();
      if (!rows.length) return D.out("실행 이력이 없습니다.");
      for (const r of rows) {
        D.out(
          `${(r.ran_at || "").slice(0, 16).padEnd(17)} ${(r.status || "?").padEnd(9)} ${(r.name || "(삭제됨)").slice(0, 30).padEnd(31)} ${r.error ? String(r.error).slice(0, 40) : ""}`,
        );
      }
      return;
    }

    if (sub === "run") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail("usage: agentlas automation run <id>");
      const row = db.prepare("SELECT * FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(`자동화를 찾을 수 없습니다: ${idPrefix}`);
      const ui = newUi();
      // run-now는 스케줄을 건드리지 않는다 (앱의 advanceSchedule=false와 동일).
      const r = await runAutomationOnce(db, row, { ui, advanceSchedule: false, runtimeOverride });
      if (!r.ok) process.exitCode = 1;
      return;
    }

    if (sub === "daemon") {
      let interval = 30;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--interval") interval = Math.max(10, Number(args[++i]) || 30);
      }
      return automationDaemon(db, { intervalSec: interval });
    }

    D.out("usage: agentlas automation list|add|on <id>|off <id>|remove <id>|run <id>|runs|daemon");
  }

  // ── automation 실행기 — 앱 스케줄러와 같은 SQLite 리스(claimed_at TTL 15분)로 중복 실행 방지 ──
  const AUTOMATION_LEASE_TTL_MS = 15 * 60 * 1000; // 앱 store/automations.ts LEASE_TTL_MS와 동일
  const AUTOMATION_LEASE_OWNER = `cli:${os.hostname()}:${process.pid}`;

  function claimAutomation(db, id, now = new Date()) {
    const cutoff = new Date(now.getTime() - AUTOMATION_LEASE_TTL_MS).toISOString();
    const result = db
      .prepare(
        "UPDATE automations SET claimed_at = ?, lease_owner = ? WHERE id = ? AND enabled = 1 AND (claimed_at IS NULL OR claimed_at < ?)",
      )
      .run(now.toISOString(), AUTOMATION_LEASE_OWNER, id, cutoff);
    return (result.changes ?? result.rowsAffected ?? 0) > 0;
  }

  function releaseAutomation(db, id) {
    try { db.prepare("UPDATE automations SET claimed_at = NULL, lease_owner = NULL WHERE id = ?").run(id); } catch { /* best-effort */ }
  }

  function recordAutomationRun(db, automationId, status, error, scheduledFor) {
    try {
      db.prepare(
        "INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error) VALUES (?,?,?,?,?,0,?)",
      ).run(crypto.randomUUID(), automationId, scheduledFor || null, new Date().toISOString(), status, error || null);
    } catch { /* best-effort */ }
  }

  // 자동화 1건 실행: 타깃(agent/firm)의 시스템 프롬프트로 prompt_template을 활성 런타임에 태운다.
  // ctx: { ui, advanceSchedule?, runtimeOverride?, scheduledFor? }
  async function runAutomationOnce(db, row, ctx = {}) {
    const ui = ctx.ui || newUi();
    // run-now도 리스를 잡는다 — 앱 스케줄러가 같은 행을 동시에 돌리는 것을 방지.
    if (!claimAutomation(db, row.id)) {
      ui.warn(`다른 실행기가 이 자동화를 잡고 있습니다 (lease TTL 15분): ${row.name}`);
      return { ok: false, skipped: true };
    }
    ui.line("");
    ui.line(ui.c.paw("◤ ") + ui.c.bold(ui.c.text("automation")) + ui.c.dim(`  ${row.name}  (${String(row.id).slice(0, 8)})`));

    try {
      // 타깃 해석 (agent/firm) — background/비공개 포함 id 직접 조회.
      let system;
      let agentId = null;
      if (row.target_type === "firm") {
        const firm = db.prepare("SELECT * FROM firms WHERE id = ?").get(row.target_id);
        if (!firm) throw new Error(`회사를 찾을 수 없습니다: ${row.target_id}`);
        system = D.firmSystemPrompt(db, firm);
      } else {
        const agent = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(row.target_id);
        if (!agent) throw new Error(`에이전트를 찾을 수 없습니다: ${row.target_id}`);
        system = agent.system_prompt || `You are ${agent.name}.`;
        agentId = agent.id;
      }

      const cwd = D.runCwd();
      const env = await D.buildChildEnvCli(db, { projectPath: null, agentId, permission: "write", cwd, lang: ui.lang });
      const runtime = D.resolveRuntime(db, ctx.runtimeOverride);
      ui.info(`${runtime.mode === "cli" ? runtime.kind : runtime.backend} · write · ${cwd}`);
      ui.startSpinner(ui.lang === "ko" ? "자동화 실행 중…" : "running automation…");

      let text;
      if (runtime.mode === "cli") {
        text = await D.captureRuntime(runtime.kind, system, row.prompt_template, { cwd, env, permission: "write" });
      } else {
        const r = await D.runApi(runtime.backend, runtime.model, system, row.prompt_template);
        text = typeof r === "string" ? r : (r && r.text) || "";
      }
      ui.stopSpinner();
      ui.markdown(String(text).trim().slice(0, 4000));

      recordAutomationRun(db, row.id, "ok", null, ctx.scheduledFor);
      const advance = ctx.advanceSchedule && row.schedule ? nextCronRun(row.schedule) : null;
      db.prepare(
        "UPDATE automations SET last_run_at = ?, run_count = run_count + 1" + (advance ? ", next_run_at = ?" : "") + " WHERE id = ?",
      ).run(...(advance ? [new Date().toISOString(), advance.toISOString(), row.id] : [new Date().toISOString(), row.id]));
      // max_runs 도달 시 비활성화 (앱과 동일한 종료 조건).
      if (row.max_runs && row.run_count + 1 >= row.max_runs) {
        db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(row.id);
        ui.info(ui.lang === "ko" ? "max_runs 도달 — 자동화를 비활성화했습니다." : "max_runs reached — automation disabled.");
      }
      return { ok: true };
    } catch (e) {
      ui.stopSpinner();
      const msg = String((e && e.message) || e).slice(0, 500);
      ui.error(msg);
      recordAutomationRun(db, row.id, "error", msg, ctx.scheduledFor);
      db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      return { ok: false };
    } finally {
      releaseAutomation(db, row.id);
    }
  }

  // 상주 실행기 — 앱 없이도 자동화가 돌게 하는 포그라운드 데몬 (Ctrl-C로 종료).
  async function automationDaemon(db, opts = {}) {
    const ui = newUi();
    const intervalSec = Math.max(10, opts.intervalSec || 30);
    let stopping = false;
    process.on("SIGINT", () => { stopping = true; ui.line(""); ui.info(ui.lang === "ko" ? "종료 중…" : "stopping…"); });
    process.on("SIGTERM", () => { stopping = true; });

    ui.line("");
    ui.ok(`automation daemon — ${intervalSec}s 폴링 · owner ${AUTOMATION_LEASE_OWNER}`);
    ui.info(ui.lang === "ko" ? "Ctrl-C로 종료. (데스크탑 앱 스케줄러와 리스를 공유해 중복 실행되지 않습니다.)" : "Ctrl-C to stop.");

    while (!stopping) {
      const nowIso = new Date().toISOString();
      let due = [];
      try {
        due = db.prepare(
          "SELECT * FROM automations WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 5",
        ).all(nowIso);
      } catch (e) {
        ui.error("due 조회 실패: " + String((e && e.message) || e));
      }
      for (const row of due) {
        if (stopping) break;
        await runAutomationOnce(db, row, { ui, advanceSchedule: true, scheduledFor: row.next_run_at });
        // 스케줄이 없는(1회성) 행이 남으면 재발화 방지.
        if (!row.schedule || !nextCronRun(row.schedule)) {
          db.prepare("UPDATE automations SET enabled = 0 WHERE id = ? AND (schedule IS NULL OR schedule = '')").run(row.id);
        }
      }
      // interval 대기 (1초 단위로 stop 체크)
      for (let i = 0; i < intervalSec && !stopping; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    ui.info(ui.lang === "ko" ? "데몬 종료." : "daemon stopped.");
  }

  // ── mcp / chats — 데스크탑 데이터 열람 ──
  function cmdMcp(db) {
    let rows = [];
    try {
      rows = db.prepare("SELECT id, name, name_en, transport, enabled FROM mcp_servers ORDER BY installed_at ASC").all();
    } catch { /* 테이블 없음 */ }
    if (!rows.length) return D.out("설치된 MCP 서버가 없습니다. (설치/설정은 데스크탑 앱 또는 에이전트 패키지가 관리)");
    for (const r of rows) {
      D.out(`${r.enabled ? "●" : "○"} ${String(r.name || r.name_en || r.id).padEnd(28).slice(0, 28)} ${String(r.transport || "stdio").padEnd(8)} ${String(r.id).slice(0, 12)}`);
    }
    D.out("");
    D.out("write/full 턴에서 활성(●) stdio 서버가 런타임에 배선됩니다. REPL에서는 /mcp.");
  }

  function cmdChats(db, args) {
    const limit = Math.max(1, Math.min(50, Number(args[0]) || 15));
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT c.id, c.title, c.updated_at, a.name AS agent_name, a.name_en AS agent_name_en
           FROM chats c LEFT JOIN installed_agents a ON a.id = c.agent_id
          WHERE c.archived_at IS NULL AND c.kind = 'user'
          ORDER BY c.updated_at DESC LIMIT ?`,
      ).all(limit);
    } catch { /* 스키마 차이 */ }
    if (!rows.length) return D.out("채팅이 없습니다.");
    for (const r of rows) {
      D.out(`${String(r.updated_at || "").slice(0, 16).padEnd(17)} ${String(r.agent_name || r.agent_name_en || "-").slice(0, 18).padEnd(19)} ${String(r.title || "(제목 없음)").slice(0, 60)}`);
    }
    D.out("");
    D.out("데스크탑 앱과 같은 대화 목록입니다 — 터미널 세션 이어하기는 REPL의 /resume.");
  }

  // ── usage — 로컬 집계 ──
  async function cmdUsage(db) {
    const day = new Date(Date.now() - 86400000).toISOString();
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    const q = (sql, ...p) => {
      try { return db.prepare(sql).get(...p) || {}; } catch { return {}; }
    };
    const ar = q("SELECT kind FROM active_runtime WHERE id=1");
    const agents = q("SELECT COUNT(*) AS n FROM installed_agents");
    const chats = q("SELECT COUNT(*) AS n FROM chats WHERE archived_at IS NULL");
    const msg24 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", day);
    const msg7 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", week);
    const auto = q("SELECT COUNT(*) AS n FROM automations WHERE enabled=1");
    const runs7 = q("SELECT COUNT(*) AS n, SUM(CASE WHEN status='error' OR error IS NOT NULL THEN 1 ELSE 0 END) AS err FROM run_history WHERE ran_at > ?", week);
    D.out(`활성 런타임      ${ar.kind || "(없음)"}`);
    D.out(`설치 에이전트    ${agents.n ?? "?"}`);
    D.out(`활성 채팅        ${chats.n ?? "?"}`);
    D.out(`메시지           24h ${msg24.n ?? 0}  ·  7d ${msg7.n ?? 0}`);
    D.out(`자동화(켜짐)     ${auto.n ?? 0}`);
    D.out(`자동화 실행(7d)  ${runs7.n ?? 0}${runs7.err ? `  (실패 ${runs7.err})` : ""}`);
    D.out("");
    D.out("세션 단위 토큰/비용은 대화 안 /cost, 프로바이더 쿼터 대시보드는 데스크탑 앱에서.");
  }

  // ── telegram — 바인딩 현황 (읽기 전용) ──
  function cmdTelegram(db, args) {
    let rows;
    try {
      rows = db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all();
    } catch {
      rows = [];
    }
    if (!rows.length) {
      D.out("텔레그램 바인딩이 없습니다 — 페어링은 데스크탑 앱 Connect에서 합니다.");
      return;
    }
    for (const r of rows) {
      const bot = r.bot_username ? "@" + r.bot_username : "(봇 미지정)";
      const chat = r.telegram_chat_title || r.telegram_chat_id || "(채팅 미연결)";
      const status = r.status || (r.telegram_chat_id ? "paired" : "pending");
      D.out(`${String(r.id).slice(0, 8)}  ${r.target_kind}:${String(r.target_id).slice(0, 20).padEnd(21)} ${String(bot).padEnd(24)} ${String(chat).slice(0, 28).padEnd(29)} ${status}`);
    }
    D.out("");
    D.out("페어링/봇 발급은 데스크탑 앱 Connect에서, 여기서는 현황만 봅니다.");
  }

  // ── login / logout / whoami — Agentlas Cloud 세션 (데스크탑과 동일한 loopback 브라우저 플로우) ──
  function webBaseUrl() {
    return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  }

  function openInBrowser(url) {
    const argv =
      process.platform === "darwin" ? ["open", url]
      : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
    try {
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
      child.unref();
    } catch { /* URL은 이미 출력됨 — 수동으로 열면 된다 */ }
  }

  async function fetchSessionMeta(cookie) {
    const resp = await fetch(`${webBaseUrl()}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`세션 확인 응답 ${resp.status}`);
    return resp.json();
  }

  async function cmdWhoami() {
    const cookie = await D.cloudSessionCookieCli();
    if (!cookie) {
      D.out("로그아웃 상태입니다.  agentlas login 으로 로그인하세요.");
      process.exitCode = 1;
      return;
    }
    try {
      const j = await fetchSessionMeta(cookie);
      if (j && j.authenticated) {
        const email = (j.user && j.user.email) || "?";
        const ws = j.workspace || {};
        D.out(`로그인됨: ${email}  ·  워크스페이스: ${ws.name || "?"} (${ws.plan || "free"})`);
      } else {
        D.out("세션이 만료되었거나 유효하지 않습니다.  agentlas login 으로 다시 로그인하세요.");
        process.exitCode = 1;
      }
    } catch (e) {
      D.fail("세션 확인 실패: " + String((e && e.message) || e));
    }
  }

  // 웹 /account?desktop=1&callback=<loopback> 이 유효 세션이면 <callback>?session=<value> 로 302 —
  // 데스크탑 signInWithBrowser(electron/auth.ts)와 동일한 프로토콜을 순수 Node http로 구현.
  async function cmdLogin(args = []) {
    const force = args.includes("--force");
    if (!force) {
      const existing = await D.cloudSessionCookieCli();
      if (existing) {
        try {
          const j = await fetchSessionMeta(existing);
          if (j && j.authenticated) {
            D.out(`이미 로그인돼 있습니다 (${(j.user && j.user.email) || "?"}).  재로그인: agentlas login --force`);
            return;
          }
        } catch { /* 확인 실패 — 새로 로그인 진행 */ }
      }
    }

    const http = require("node:http");
    let value;
    try {
      value = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const server = http.createServer((req, res) => {
          let u;
          try { u = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); res.end(); return; }
          if (!u.pathname.startsWith("/callback")) { res.writeHead(404); res.end("not found"); return; }
          const v = u.searchParams.get("session") || u.searchParams.get("token");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<html><body style=\"font-family:-apple-system,sans-serif;padding:40px\"><h3>Agentlas 로그인 완료</h3><p>터미널로 돌아가세요. 이 창은 닫아도 됩니다.</p></body></html>");
          server.close();
          if (v) done(resolve, v);
          else done(reject, new Error("콜백에 session 값이 없습니다."));
        });
        server.on("error", (e) => done(reject, e));
        server.listen(0, "127.0.0.1", () => {
          const port = server.address().port;
          const cb = encodeURIComponent(`http://127.0.0.1:${port}/callback`);
          const url = `${webBaseUrl()}/account?desktop=1&callback=${cb}`;
          D.out("브라우저에서 Agentlas에 로그인하세요 (자동으로 열립니다):");
          D.out("  " + url);
          openInBrowser(url);
        });
        const t = setTimeout(() => { try { server.close(); } catch { /* ignore */ } done(reject, new Error("로그인 대기 시간(180초)이 지났습니다. 다시 시도: agentlas login")); }, 180_000);
        if (t.unref) t.unref();
      });
    } catch (e) {
      return D.fail(String((e && e.message) || e));
    }

    const p = D.cliSessionPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ version: 1, value, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* win32 */ }
    D.out(`세션 저장됨: ${p}`);
    await cmdWhoami();
  }

  function cmdLogout() {
    const p = D.cliSessionPath();
    if (fs.existsSync(p)) {
      try { fs.rmSync(p); D.out("로그아웃 완료 (CLI 세션 삭제)."); } catch (e) { return D.fail("세션 파일 삭제 실패: " + e.message); }
    } else {
      D.out("저장된 CLI 세션이 없습니다.");
    }
    if (process.env.AGENTLAS_SESSION) D.out("주의: AGENTLAS_SESSION 환경변수가 여전히 설정돼 있어 로그인 상태로 보일 수 있습니다.");
  }

  // ── cloud search — 마켓플레이스 검색 ──
  async function cloudSearch(db, args) {
    let limit = 10;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--limit") limit = Math.max(1, Math.min(30, Number(args[++i]) || 10));
      else rest.push(args[i]);
    }
    const query = rest.join(" ").trim();
    if (!query) return D.fail('usage: agentlas cloud search "<찾는 일>" [--limit 10]');
    if (typeof fetch !== "function") return D.fail("이 런타임에 fetch가 없습니다.");
    const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
    const headers = { "content-type": "application/json" };
    try {
      const cookie = await D.cloudSessionCookieCli();
      if (cookie) headers.cookie = cookie;
    } catch { /* 로그인 없어도 검색은 가능 */ }
    let resp;
    try {
      resp = await fetch(`${base.replace(/\/$/, "")}/tools/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "marketplace.search_agents",
          params: { name: "marketplace.search_agents", arguments: { query, limit } },
        }),
      });
    } catch (e) {
      return D.fail(`마켓플레이스 연결 실패: ${(e && e.message) || e}`);
    }
    if (!resp.ok) return D.fail(`마켓플레이스 응답 ${resp.status}`);
    const json = await resp.json();
    if (json.error) return D.fail(json.error.message || "marketplace error");
    const result = json.result || {};
    const rawItems = result.results || result.agents || result.items || (Array.isArray(result) ? result : null);
    // 엔진 내부 에이전트(researcher-<n>, research-intelligence-desk, hephaestus-*)는 제품이 아니므로 숨긴다.
    const items = Array.isArray(rawItems) ? rawItems.filter((it) => !isInternalAgentSlug(it && (it.slug || it.id))) : rawItems;
    if (!Array.isArray(items) || !items.length) {
      D.out(`검색 결과 없음: "${query}"`);
      return;
    }
    for (const it of items.slice(0, limit)) {
      const slug = it.slug || it.id || "?";
      const name = it.name || it.title || slug;
      const kind = it.kind || it.entity_kind || "";
      const tagline = it.tagline || it.description || "";
      D.out(`${String(slug).padEnd(34).slice(0, 34)} ${String(name).slice(0, 26).padEnd(27)} ${String(kind).padEnd(14)} ${String(tagline).slice(0, 60)}`);
    }
    D.out("");
    D.out("설치: agentlas install <slug>");
  }

  return {
    cmdStorm, stormRun, cmdSwarm, swarmRun, cmdAutomation, cmdUsage, cmdTelegram, cloudSearch,
    cmdLogin, cmdLogout, cmdWhoami, cmdHep, runHephaestusInteractive, cmdMcp, cmdChats,
    nextCronRun, parseSwarmOutput,
  };
}

module.exports = { create };
