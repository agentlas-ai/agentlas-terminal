"use strict";
/*
 * sessions/apply-fences — 파싱된 펜스 프로토콜을 실제 부작용으로 적용한다.
 * (파싱은 fences.cjs, 적용은 여기 — Desktop client.ts 의 실행 절반에 해당.)
 *
 * 정책 (비협상 불변식과 동일 선상):
 *  - memoryEvents: curate.cjs 의 결정적 게이트가 결정한다(큐레이터는 제안만).
 *    read 권한 턴은 어떤 durable 쓰기도 없다 — 영수증 이벤트만 남는다.
 *  - delegates: 오케스트레이터 동시 상한을 존중한다. 상한 초과는 조용한 큐잉이
 *    아니라 정직한 'delegate-refused' 이벤트다.
 *  - automations: 스케줄 검증 실패는 파서에서 이미 거부됐고, 여기서는 next_run_at
 *    계산 불가/권한 부족/division 재귀를 정직하게 거부한다. Desktop 도 division
 *    챗의 자동화 등록을 막는다(자동화가 자동화를 낳는 재귀 방지, client.ts:3493).
 *  - asks: 세션 이벤트로만 표면화한다. UI 는 REPL 렌더러 소관.
 */

const memoryCurate = require("../memory-cli/curate.cjs");
const automationStore = require("../automation/store.cjs");
const schedule = require("../automation/schedule.cjs");

/** One 이 가져가는 스코프. 프로젝트 스코프는 프로젝트에 남는다. */
const ONE_SCOPES = new Set(["agent_repo", "user_identity"]);

/**
 * Agentlas One 서랍(`~/.agentlas/one/.agentlas/memory-tickets.jsonl`)으로 후보를 넘긴다.
 *
 * One 은 프로젝트를 넘나드는 정체성이라 agent_repo/user_identity 만 가져간다.
 * One 이 꺼져 있거나 서랍이 없으면 아무것도 하지 않는다 — 없는 폴더를 만들지 않는다.
 * 실패해도 턴을 죽이지 않는다(펜스 적용 계약과 동일).
 */
function forwardToOne(events) {
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const root = process.env.AGENTLAS_ONE_DIR || path.join(os.homedir(), ".agentlas", "one");
    const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
    if (!state || state.on !== true) return 0;
    const ledger = path.join(root, ".agentlas", "memory-tickets.jsonl");
    if (!fs.existsSync(ledger)) return 0;

    // 이미 올라온 내용은 다시 넣지 않는다(같은 계약을 One 쪽 emit_ticket 도 쓴다).
    const seen = new Set();
    for (const line of fs.readFileSync(ledger, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const text = String((row.candidate || {}).content || "");
        if (text) seen.add(text.trim().toLowerCase().replace(/\s+/g, " "));
      } catch { /* 깨진 줄은 건너뛴다 */ }
    }

    let written = 0;
    for (const raw of events) {
      for (const candidate of (raw && Array.isArray(raw.candidates) ? raw.candidates : [raw])) {
        if (!candidate || typeof candidate !== "object") continue;
        const scope = String(candidate.suggested_scope || candidate.scope || "");
        if (!ONE_SCOPES.has(scope)) continue;
        const content = String(candidate.content || "").trim();
        if (!content) continue;
        const key = content.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) continue;
        seen.add(key);
        const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.slice(0, 8) : [];
        fs.appendFileSync(ledger, JSON.stringify({
          schemaVersion: "agentlas.one-workspace.v1",
          ticketId: `one-tkt-${Date.now()}-${written}`,
          agentId: "builtin-agentlas-one",
          turnKey: "",
          source: "terminal-memory-events",
          state: "queued",
          candidate: {
            type: String(candidate.memory_kind || candidate.type || "hypothesis"),
            scope,
            content: content.slice(0, 600),
            evidence,
          },
          downgraded: false,
          createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        }) + "\n", "utf8");
        written += 1;
      }
    }
    return written;
  } catch {
    return 0;
  }
}

/**
 * @param {import('./session.cjs').Session} session 방금 턴을 끝낸 세션
 * @param {object} parsed parseReplyFences 결과
 * @param {{orch?: object}} opts orch 미지정 시 session.orchestrator 사용
 * @returns 적용 영수증 { asks, memory, automations, delegates, refused }
 */
function applyReplyFences(session, parsed, opts = {}) {
  const orch = opts.orch || session.orchestrator || null;
  const record = (ev) => session._record({ at: Date.now(), ...ev });
  const receipts = { asks: 0, memory: null, automations: [], delegates: [], refused: [] };
  const canWrite = session.permission !== "read";

  // 파서가 표면화한 오류(잘못된 스케줄 등) — 조용히 삼키지 않는다.
  for (const err of parsed.errors || []) {
    record({ type: "fence-error", text: err });
  }

  /* ── asks → 세션 이벤트 (REPL 렌더러가 표면화) ───────────────────────── */
  for (const ask of parsed.asks || []) {
    record({ type: "ask", payload: ask });
    receipts.asks += 1;
  }

  /* ── memoryEvents → curate 게이트 (제안 ≠ 승인) ─────────────────────── */
  if (Array.isArray(parsed.memoryEvents) && parsed.memoryEvents.length) {
    // 프로젝트 경계: 명시 초기화된(.agentlas 존재) 폴더만 project 스코프 대상 —
    // 임의 cwd 에 .agentlas 스캐폴딩을 만들지 않는다(session.cjs 프롬프트 증강과 동일 기준).
    let projectPath = null;
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      projectPath = fs.existsSync(path.join(session.cwd, ".agentlas")) ? session.cwd : null;
    } catch { projectPath = null; }
    const ctx = {
      permission: session.permission,
      projectPath,
      agentId: session.agent.id,
      curatedMemories: [],
    };
    // 게이트 로직을 복제하지 않기 위해 이벤트를 정확한 wire 블록으로 재구성해
    // curateCliReply 에 그대로 통과시킨다(시크릿/스코프/중복/권한 게이트 전부 재사용).
    const heading = memoryCurate.loadArch().eventsHeading;
    const block = `${heading}\n\`\`\`json\n${JSON.stringify(parsed.memoryEvents)}\n\`\`\``;
    try {
      memoryCurate.curateCliReply(session.db, block, ctx);
    } catch { /* 게이트 실패가 턴 자체를 죽이면 안 된다 */ }
    receipts.memory = {
      candidates: parsed.memoryEvents.length,
      written: ctx.curatedMemories.length,
      permission: session.permission,
    };
    // Agentlas One 이 켜져 있으면 에이전트 스코프 후보를 One 서랍에도 티켓으로 넘긴다.
    // 프로젝트 스코프는 여기 남기고 옮기지 않는다 — One 은 프로젝트를 넘나드는 정체성이라
    // agent_repo/user_identity 만 One 의 것이다(기획 2.2 스코프 경계).
    receipts.memory.one = forwardToOne(parsed.memoryEvents);
    // read 권한 턴 = durable 쓰기 0 — 영수증 이벤트만 남는다.
    record({ type: "memory-curated", ...receipts.memory });
  }

  /* ── automations → automation/store.cjs addAutomation ────────────────── */
  for (const a of parsed.automations || []) {
    if (!canWrite) {
      // Desktop automationPermissionRequired(client.ts:3500) 과 동일한 정직 거부.
      const refusal = { type: "automation-refused", name: a.name, reason: "write permission required" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    if (session.parent || session.chatKind === "division") {
      // division 서브세션(자동화 marker 세션 포함)의 자동화 등록 금지 — 자동화가
      // 자동화를 만드는 재귀 방지. 데스크탑 client.ts:3493(chat.kind !== 'division')과 동형:
      // parent 없는 자동화 실행 세션도 division 챗이므로 반드시 이 가드에 걸려야 한다.
      const refusal = { type: "automation-refused", name: a.name, reason: "division session may not register automations" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    // 파서가 이미 스케줄을 검증했지만, next_run_at 이 실제로 계산되는지 최종 확인.
    // 시계 없는 행(next_run_at NULL)은 앱 스케줄러가 영영 안 깨운다 — 등록 거부가 정직.
    const next = schedule.nextAutomationRun({ schedule: a.schedule, timezone: a.tz || null });
    if (!next) {
      const refusal = { type: "automation-refused", name: a.name, reason: `schedule "${a.schedule}" has no next run` };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    try {
      const id = automationStore.addAutomation(session.db, {
        name: a.name,
        targetType: "agent",
        targetId: session.agent.id, // 실행 주체 = 이 세션의 에이전트
        cron: a.schedule, // 레거시 미러 토큰(schedule 열) — daemon 이 legacyScheduleSpec 으로 해석
        prompt: a.prompt,
        tz: a.tz || null,
      }, next);
      const receipt = {
        type: "automation-registered",
        id,
        name: a.name,
        schedule: a.schedule,
        nextRunAt: next.toISOString(),
        // steps[] 는 wire 로 받았지만 터미널은 그래프 합성이 없다 — 위장하지 않고 표기.
        ...(a.steps ? { stepsIgnored: a.steps.length } : {}),
      };
      record(receipt);
      receipts.automations.push(receipt);
    } catch (e) {
      const refusal = { type: "automation-refused", name: a.name, reason: (e && e.message) || String(e) };
      record(refusal);
      receipts.refused.push(refusal);
    }
  }

  /* ── delegates → 오케스트레이터로 division 서브세션 스폰 ─────────────── */
  // 상한은 lazy require — session.cjs ↔ orchestrator.cjs 로드 사이클 방지.
  const { maxParallel } = require("./orchestrator.cjs");
  for (const d of parsed.delegates || []) {
    if (!orch || !session.key) {
      const refusal = { type: "delegate-refused", target: d.target, reason: "no orchestrator attached to this session" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    const brief = (d.brief || "").trim();
    if (!brief) {
      const refusal = { type: "delegate-refused", target: d.target, reason: "empty delegate brief" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    if (orch.runningCount() >= maxParallel()) {
      // 상한 초과 = 대기가 아니라 정직한 거부(오케스트레이터 정책과 동일).
      const refusal = {
        type: "delegate-refused",
        target: d.target,
        reason: `parallel limit ${maxParallel()} reached (running: ${orch.runningCount()})`,
      };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    // 부모의 런타임/권한/작업폴더를 물려받는 division 자식. spawnImpl/timeoutConfig
    // 전달은 계약 테스트(오프라인 fake spawn)를 위해 필요하고 프로덕션에선 null 이다.
    const child = orch.spawn({
      agent: session.agent,
      runtime: session.runtime,
      permission: session.permission,
      cwd: session.cwd,
      parentKey: session.key,
      activate: false,
      title: `delegate: ${d.target}`,
      spawnImpl: session._spawnImpl,
      timeoutConfig: session._timeoutConfig,
    });
    try {
      const promise = orch.sendTo(child.key, brief);
      const receipt = { type: "delegate-spawned", key: child.key, target: d.target, allocation: d.allocation || null };
      record(receipt);
      receipts.delegates.push({ key: child.key, target: d.target, promise });
    } catch (e) {
      // sendTo 의 상한 판정이 최종 권위다(스폰 사이 레이스) — 스폰만 된 유령 세션은 제거.
      orch.remove(child.key);
      const refusal = { type: "delegate-refused", target: d.target, reason: (e && e.message) || String(e) };
      record(refusal);
      receipts.refused.push(refusal);
    }
  }

  return receipts;
}

// forwardToOne 은 One 서랍 전달의 유일한 지점이라 계약 테스트가 직접 잴 수 있게 함께 노출한다.
module.exports = { applyReplyFences, forwardToOne };
