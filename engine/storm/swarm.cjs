"use strict";
/*
 * storm/swarm — emergent 에이전트 스웜 (블랙보드 + `## Spawn` 그래프 성장 + 종합).
 *
 * v1 engine/agentlas-parity.cjs (legacy-v1-engine-snapshot 839–1181행)의 포팅.
 * 앱 mcp/swarm-run.ts 프로토콜의 CLI 구현이며, 다음 계약은 토씨까지 보존한다
 * (test/workload-routing-contract.cjs 가 소스 리터럴로 고정):
 *
 *  - `## Spawn` 블록 프로토콜: 워커는 결과 본문 아래 `## Spawn` 블록으로만 자식
 *    작업을 제안한다. 각 자식은 상위 AI가 저작한 workload allocation JSON 하나다.
 *  - LIVE_RUNTIME_INVENTORY 계약: 워커가 고를 수 있는 runtimeId/exactModelId는
 *    실제 설치·연결된 인벤토리뿐이다. 호스트는 그 선택을 *검증만* 한다 —
 *    할당을 직접 저작하거나 키워드로 재구성하지 않는다(오너 결정).
 *  - fail-closed 할당: resolveAllocationAcrossRuntimes가 거부하면 CLI 기본 모델로
 *    조용히 실행하지 않고 "model allocation failed closed"로 던진다.
 *  - Stormbreaker 모드는 Agentlas Core의 정본 Goal+UltraCode 하네스 프롬프트만
 *    사용한다. 이 파일은 GOAL/ULTRACODE 모드 프롬프트를 절대 로컬 정의하지 않는다.
 *  - 모든 워커는 engine/workforce/capture.cjs 의 headless 캡처(captureRuntime)
 *    또는 runApi 로만 실행된다 — 제2의 bespoke 스폰 경로 금지.
 *  - 할당 영수증(JSONL)에는 원문 프롬프트/작업 텍스트가 남지 않는다
 *    (createDecisionReceipt가 해시·리댁션 — workload-routing 계약 테스트가 고정).
 */
const { Ui } = require("../agentlas-ui.cjs");
const workloadRouting = require("../agentlas-workload-routing.cjs");

// ── 스웜 상수 (앱 mcp/swarm-run.ts 와 동일한 안전 상한) ──
const SWARM_MAX_TASKS = 24;
const SWARM_SPAWN_PER_TURN = 12;

// ── swarm 프로토콜 프롬프트 — 앱 swarm-run.ts 와 동일 구조 ──
// "WORK ALREADY ASSIGNED TO PEERS" 블록은 형제 소유권 가시화 계약이다: 워커가
// 이미 배정된 패킷을 중복 spawn 해 사용자의 돈을 낭비하는 사고를 막는다.
function swarmProtocol(goal, tasks, task, liveRuntimeInventory) {
  const doneList = tasks
    .filter((t) => t.status === "done")
    .slice(-8)
    .map((t) => `- ${t.title}`)
    .join("\n");
  const assignedList = tasks
    .filter((t) => t.id !== task.id && t.status !== "failed")
    .slice(0, 24)
    .map((t) => `- [${t.status}] ${t.title}${t.brief ? ` — ${t.brief}` : ""}`)
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
    assignedList ? `WORK ALREADY ASSIGNED TO PEERS (never duplicate these packets):\n${assignedList}` : "",
    "",
    "RULES:",
    "1. Do your task concretely with available tools/files in the current working folder.",
    `LIVE_RUNTIME_INVENTORY=${JSON.stringify(liveRuntimeInventory || [])}`,
    "2. If the goal needs MORE work beyond your task — split into concrete next steps — end your",
    "   message with a `## Spawn` block. Every child MUST be one JSON object with a higher-level AI allocation. Choose runtimeId and exactModelId only from LIVE_RUNTIME_INVENTORY:",
    "   ## Spawn",
    '   - {"role":"webmaster","brief":"build the landing page structure","allocation":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-1","exactModelId":"model-from-inventory","tier":"balanced","effort":"high","phase":"delegate","reasonCodes":["complex-reasoning"],"rationale":"requires coordinated implementation","requiredCapabilities":["code","tools"]}}',
    '   - {"brief":"run focused tests","allocation":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-2","exactModelId":"model-from-inventory","tier":"economy","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"bounded verification","requiredCapabilities":["code","tools"]}}',
    "   Choose each exact runtime/model and effort from the actual child difficulty; do not copy one allocation to every child.",
    "   (role is optional. Do NOT spawn if the goal is already met or another pending/running/done packet already owns that work.)",
    "3. Do NOT restate the whole goal. Do NOT invent work that isn't needed — over-spawning wastes the user's money.",
    "4. Everything above the `## Spawn` block is your result and is shared with peers on the blackboard.",
  ]
    .filter(Boolean)
    .join("\n");
}

// `## Spawn` 블록 파서 — 순수 함수 (test/swarm-protocol-contract.cjs 가 고정).
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
    if (body.startsWith("{")) {
      const item = workloadRouting.extractJsonObject(body);
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const brief = String(item.brief || "").trim();
        const allocation = workloadRouting.normalizeAllocation(item.allocation || item, "delegate");
        if (brief) {
          spawn.push({
            title: String(item.title || brief).trim().slice(0, 80),
            brief: brief.slice(0, 8_000),
            role: item.role ? String(item.role).trim().slice(0, 80) : undefined,
            allocation,
          });
        }
      }
      if (spawn.length >= SWARM_SPAWN_PER_TURN) break;
      continue;
    }
    const parts = body.split("|");
    let role;
    let brief;
    if (parts.length >= 2) {
      role = parts[0].trim() || undefined;
      brief = parts.slice(1).join("|").trim();
    } else {
      brief = body.trim();
    }
    // Legacy text remains parseable, but it has no AI-authored allocation and
    // therefore runs on the current model with an observable fallback receipt.
    if (brief) spawn.push({ title: brief.slice(0, 80), brief, role, allocation: null });
    if (spawn.length >= SWARM_SPAWN_PER_TURN) break;
  }
  return { result, spawn };
}

/**
 * create(deps) — v1 parity 팩토리와 동일한 D-주입 생성.
 * D 멤버: prefsLang, resolveRuntime, listAvailableRuntimes, captureRuntime,
 *         runApi, buildChildEnvCli, projectCwd, runCwd, modelRoutingReceiptPath.
 * (test/workload-routing-contract.cjs 가 이 D 계약으로 스텁 주입해 end-to-end를
 *  검증한다 — 멤버 이름/시그니처를 바꾸면 데스크탑 패리티가 깨진다.)
 */
function create(deps) {
  const D = deps;

  function newUi(lang) {
    return new Ui({ lang: lang || D.prefsLang() });
  }

  // ctx: { ui?, cwd?, permission?, runtime?, runtimeOverride?, concurrency?, agent?, projectPath? }
  async function swarmRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: swarm <goal>  [--parallel N]");
      return { ok: false };
    }
    // 런타임 부재는 D.resolveRuntime의 code="no_runtime" throw로 정직 정지한다.
    const runtime = ctx.runtime || D.resolveRuntime(db, ctx.runtimeOverride);
    const stormbreaker = ctx.stormbreaker === true;
    const executionHarness = stormbreaker ? ctx.executionHarness : null;
    // Core 하네스 없이 stormbreaker 모드 진입 금지 — 로컬 모조 프롬프트로 대체하는
    // 것은 계약 위반이다(모델 실행 전에 실패해야 한다).
    if (stormbreaker && (!executionHarness || typeof executionHarness.system_prompt !== "string")) {
      ui.error("Stormbreaker requires the canonical Goal + UltraCode harness from Agentlas Core.");
      return { ok: false, error: "stormbreaker-core-harness-unavailable" };
    }
    const coreHarnessPrompt = executionHarness && executionHarness.system_prompt;
    const permission = ctx.permission || "write";
    const discoveredRuntimes = ctx.runtimes && ctx.runtimes.length
      ? ctx.runtimes
      : typeof D.listAvailableRuntimes === "function"
        ? D.listAvailableRuntimes(db, runtime)
        : [runtime];
    const runtimes = discoveredRuntimes
      .map((candidate, index) => ({ ...candidate, runtimeId: candidate.runtimeId || `runtime-${index + 1}` }));
    const liveRuntimeInventory = workloadRouting.runtimeInventory(runtimes);
    // 워커는 사용자의 실제 프로젝트 폴더에서 실행된다 (계약 테스트가 소스 고정).
    const cwd = ctx.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd());
    const concurrency = Math.max(1, Math.min(8, Number(ctx.concurrency) || 3));
    const env = await D.buildChildEnvCli(db, {
      projectPath: ctx.projectPath || null,
      agentId: ctx.agent && ctx.agent.id,
      permission,
      cwd,
      lang: ui.lang,
    });

    async function runBaseWorker(system, prompt, options = {}) {
      // 플래너/판정성 턴은 텍스트(JSON)만 내면 된다 — 실행 권한을 주면 모델이
      // 계획 대신 goal을 그 자리에서 실행해버린다(실사용 storm 테스트에서 실증:
      // 플래너 턴이 hello.txt를 직접 생성). options.permission으로 read 강등 허용.
      const turnPermission = options.permission || permission;
      if (runtime.mode === "cli") {
        return await D.captureRuntime(runtime.kind, system, prompt, {
          cwd,
          env,
          permission: turnPermission,
          // no-authority: 도구 자체를 비운다 — read(plan 모드)만으로는 claude가
          // "계획 파일 작성 후 승인 대기" UX로 납치되어 JSON을 내지 않는다(실측).
          authorityMode: options.authorityMode,
          model: ctx.modelPin || runtime.model || null,
          effort: ctx.effortPin === undefined ? null : ctx.effortPin,
        });
      }
      const text = await D.runApi(runtime.backend, ctx.modelPin || runtime.model, system, prompt);
      return typeof text === "string" ? text : (text && text.text) || "";
    }

    function recordAllocation(task, stage, decision, resolution, parentTaskId = null) {
      const receipt = workloadRouting.createDecisionReceipt({
        taskId: `${stage}-${task.id || "synthesis"}`,
        parentTaskId,
        taskText: task.brief || task.title || goal,
        stage,
        decision,
        resolution,
      });
      try {
        workloadRouting.appendDecisionReceipt(
          receipt,
          ctx.receiptFile || (D.modelRoutingReceiptPath && D.modelRoutingReceiptPath()),
        );
      } catch (error) {
        ui.warn(`model routing receipt failed: ${String((error && error.message) || error).slice(0, 120)}`);
      }
      return receipt;
    }

    async function runAllocatedWorker(system, prompt, task, stage, parentTaskId = null) {
      const resolution = workloadRouting.resolveAllocationAcrossRuntimes({
        runtimes,
        fallbackRuntime: runtime,
        decision: task.allocation,
        modelPin: ctx.modelPin,
        effortPin: ctx.effortPin,
        availableModels: ctx.availableModels,
        maxTier: ctx.maxTier || process.env.AGENTLAS_MODEL_MAX_TIER,
      });
      recordAllocation(task, stage, task.allocation, resolution, parentTaskId);
      // 할당 거부 후 CLI 기본 모델로 조용히 실행 금지 — fail-closed (계약 테스트 고정).
      if (!resolution.ok) {
        throw new Error(`model allocation failed closed: ${resolution.fallbackReason || "no compliant live model"}`);
      }
      if (resolution.fallbackReason) {
        ui.info(`model route: ${resolution.source} · ${resolution.runtimeId || "current"} · ${resolution.model || runtime.kind || runtime.backend} · ${resolution.fallbackReason}`);
      }
      const selectedRuntime = resolution.runtime || runtime;
      task.resolvedAllocation = {
        runtimeId: resolution.runtimeId || selectedRuntime.runtimeId || null,
        runtimeKind: selectedRuntime.kind || selectedRuntime.backend || null,
        model: resolution.model || selectedRuntime.model || null,
        effort: resolution.effort ?? null,
        source: resolution.source,
        fallbackReason: resolution.fallbackReason || null,
      };
      if (selectedRuntime.mode === "cli") {
        return await D.captureRuntime(selectedRuntime.kind, system, prompt, {
          cwd,
          env,
          permission,
          model: resolution.model,
          effort: resolution.effort,
        });
      }
      const text = await D.runApi(selectedRuntime.backend, resolution.model || selectedRuntime.model, system, prompt);
      return typeof text === "string" ? text : (text && text.text) || "";
    }

    const label = runtime.mode === "cli" ? runtime.kind : runtime.backend;
    ui.line("");
    ui.line(ui.c.paw("◤ ") + ui.c.bold(ui.c.text(stormbreaker ? "stormbreaker" : "swarm")) + ui.c.dim(`  Agentlas harness · ${label} · x${concurrency} · max ${SWARM_MAX_TASKS} tasks`));
    ui.info(goal.slice(0, 120));

    ui.startSpinner(ui.lang === "ko" ? "상위 AI가 작업별 모델 비용을 배정 중…" : "Higher-level AI is allocating task models…");
    let planned = null;
    // 플래너는 읽기 전용 + 무효 JSON 1회 재시도. v1의 "현재 모델로 투명 폴백" 경로는
    // 이후의 폴백 제거·정직정지 강화로 죽은 길이 됐는데 메시지와 유령 작업만 남아
    // "폴백한다"고 말하고 fail-closed로 죽는 모순을 냈다(실사용 storm 테스트 실증).
    // 방침대로: 재시도 후에도 무효면 정직 정지.
    for (let attempt = 0; attempt < 2 && !planned; attempt++) {
      try {
        const plannerText = await runBaseWorker(
          [
            coreHarnessPrompt,
            workloadRouting.plannerSystemPrompt({
              language: ui.lang === "ko" ? "Korean" : "English",
              maxTasks: Math.min(SWARM_SPAWN_PER_TURN, SWARM_MAX_TASKS),
              mode: stormbreaker ? "stormbreaker-goal-ultracode" : "swarm",
              liveRuntimeInventory,
            }),
            attempt > 0
              ? "PREVIOUS ATTEMPT WAS NOT VALID PLAN JSON. Reply with ONLY the plan JSON object — no prose, no tool use."
              : "",
          ].filter(Boolean).join("\n\n"),
          ctx.routeContext
            ? `${goal}\n\nHEPHAESTUS ROUTE EVIDENCE (advisory; the Agentlas parent owns the final plan):\n${ctx.routeContext}`
            : goal,
          { permission: "read", authorityMode: "no-authority" },
        );
        planned = workloadRouting.normalizePlan(plannerText, { maxTasks: SWARM_SPAWN_PER_TURN });
      } catch (error) {
        ui.warn(`workload planner failed: ${String((error && error.message) || error).slice(0, 160)}`);
      }
    }
    ui.stopSpinner();
    if (!planned) {
      ui.error(ui.lang === "ko"
        ? "플래너가 유효한 실행 계획(JSON)을 내지 못했습니다 — 정지합니다 (조용한 폴백 금지)."
        : "The planner did not produce a valid plan JSON — stopping (no silent fallback).");
      return { ok: false, reason: "invalid_plan_json" };
    }
    if (planned) {
      ui.line("");
      ui.info(stormbreaker
        ? (ui.lang === "ko" ? "Stormbreaker Goal/UltraCode 실행 계획:" : "Stormbreaker Goal/UltraCode execution plan:")
        : (ui.lang === "ko" ? "스웜 실행 계획:" : "Swarm execution plan:"));
      for (const task of planned.tasks) {
        const allocation = task.allocation;
        ui.line(`  ${ui.c.emerald("▸ ")}${ui.c.text(task.title)}${ui.c.dim(`  ${allocation.runtimeId || "current"} · ${allocation.exactModelId || allocation.tier} · ${allocation.effort}`)}`);
      }
      ui.line(`  ${ui.c.emerald("◆ ")}${ui.c.text("synthesis")}${ui.c.dim(`  ${planned.synthesis.runtimeId || "current"} · ${planned.synthesis.exactModelId || planned.synthesis.tier} · ${planned.synthesis.effort}`)}`);
    }

    let seq = 0;
    const initialTasks = planned.tasks; // 정직 정지 이후 planned는 항상 유효 — 유령 폴백 작업 경로 제거
    const tasks = initialTasks.map((task) => ({ id: ++seq, ...task, status: "pending", result: "", parentTaskId: null }));
    const seen = new Set(tasks.map((task) => task.title.toLowerCase()));
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
          runAllocatedWorker(
            [coreHarnessPrompt, swarmProtocol(goal, tasks, task, liveRuntimeInventory)].filter(Boolean).join("\n\n"),
            task.brief || task.title,
            task,
            "worker",
            task.parentTaskId,
          )
            .then((text) => {
              const parsed = parseSwarmOutput(text);
              task.status = "done";
              task.result = parsed.result;
              ui.toolResult(parsed.result.split("\n").slice(0, 3).join("\n") || "(empty result)", true);
              for (const s of parsed.spawn) {
                const key = s.title.toLowerCase();
                if (tasks.length >= SWARM_MAX_TASKS || seen.has(key)) continue;
                seen.add(key);
                tasks.push({ id: ++seq, title: s.title, brief: s.brief, role: s.role, allocation: s.allocation, status: "pending", result: "", parentTaskId: `worker-${task.id}` });
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
    // HOST-VERIFIED ALLOCATION: 최종 게이트(종합자)는 호스트가 검증한 런타임·모델·
    // effort 증거를 그대로 받는다 — 워커 자기 신고가 아니라 resolve 결과다.
    const pieces = done.map((t, i) => [
      `### ${i + 1}. ${t.title}`,
      `HOST-VERIFIED ALLOCATION: ${JSON.stringify(t.resolvedAllocation || null)}`,
      t.result,
    ].join("\n")).join("\n\n");
    let finalText;
    try {
      const synthesisTask = {
        id: "final",
        title: "swarm synthesis",
        brief: goal,
        allocation: planned && planned.synthesis,
      };
      finalText = await runAllocatedWorker(
        [
          coreHarnessPrompt,
          "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
          "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
          "Do not just concatenate. Do not include a `## Spawn` block.",
          `SHARED GOAL: ${goal}`,
          `Answer in the user's language (${ui.lang === "ko" ? "Korean" : "English"}).`,
        ].join("\n"),
        pieces,
        synthesisTask,
        "synthesis",
      );
    } catch (e) {
      ui.stopSpinner();
      ui.error("Synthesis failed: " + String((e && e.message) || e).slice(0, 200));
      finalText = pieces;
    }
    ui.stopSpinner();
    ui.line("");
    ui.markdown(String(finalText).trim());
    return { ok: true, finalText, taskCount: tasks.length, doneCount: done.length };
  }

  async function cmdSwarm(db, args, runtimeOverride, executionContext = {}) {
    const rest = [];
    let concurrency;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--parallel" || args[i] === "-n") concurrency = Number(args[++i]);
      else rest.push(args[i]);
    }
    const r = await swarmRun(db, rest.join(" "), { ...executionContext, concurrency, runtimeOverride });
    if (!r.ok) process.exitCode = 1;
    return r;
  }

  return { swarmRun, cmdSwarm, swarmProtocol, parseSwarmOutput };
}

module.exports = { create, swarmProtocol, parseSwarmOutput, SWARM_MAX_TASKS, SWARM_SPAWN_PER_TURN };
