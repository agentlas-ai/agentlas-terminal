"use strict";
/*
 * firms/orchestrate — 회사(firm) 3-tier 위임 실행: CEO PLAN → DELEGATE → SYNTHESIZE.
 *
 * 데스크탑 electron/mcp/firm-orchestrator.ts(읽기 전용 참조)의 계약을 v2 세션 계층
 * 위에 포팅했다. 실행 경로는 세션 계층 하나뿐이다(제2 spawn 경로 금지):
 *  - CEO = orch.spawn 메인 세션 (kind='user' 챗 — 회사 챗)
 *  - 본부(division) = orch.spawn(parentKey=CEO) 서브세션 (kind='division' +
 *    parent_chat_id — 데스크탑 division 서브챗과 동일 패턴, 앱에서도 같은 트리로 보인다)
 *
 * 흐름:
 *  1. PLAN: CEO에게 위임 프로토콜(## Delegate 펜스)을 주입하고 task를 보낸다.
 *  2. DELEGATE: 회신의 ## Delegate 펜스를 파싱, 매칭된 본부만 병렬 실행(전원 강제 금지).
 *     한 본부의 실패는 격리한다 — 오류 문자열을 status:failed 로 표기해 종합에 넘긴다.
 *  3. SYNTHESIZE: CEO 세션의 두 번째 턴이 본부 결과를 종합 — CEO 챗에 자동 영속된다.
 *  펜스가 없으면 PLAN 회신이 곧 최종 답(CEO 단독 처리 — 데스크탑 동형).
 */
const { maxParallel } = require("../sessions/orchestrator.cjs");
const { rowToAgent } = require("../agents/registry.cjs");

const DELEGATE_HEADING = "## Delegate";

// ── ## Delegate 펜스 파싱 ──────────────────────────────────
// 정본은 engine/sessions/fences.cjs parseDelegateBlock — loadDelegateParser()가
// 존재 시 자동으로 그쪽을 집는다(스왑 지점). 아래 로컬 구현은 fences.cjs 가 없는
// 체크아웃(다른 세션 작업 중)을 위한 동형 폴백: 데스크탑 electron/mcp/delegate.ts
// parseDelegations 의 CJS 포팅(workload allocation 필드 없이 target/brief만).
function parseDelegationsLocal(text) {
  const source = String(text || "");
  const idx = source.lastIndexOf(DELEGATE_HEADING);
  if (idx < 0) return { delegations: [], cleanedText: source.trim() };
  const after = source.slice(idx + DELEGATE_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let delegations = [];
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      const raw = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray(data.delegations)
          ? data.delegations
          : [];
      delegations = raw
        .map((d) => {
          if (!d || typeof d !== "object") return null;
          const target = typeof d.target === "string" ? d.target.trim() : "";
          const brief = typeof d.brief === "string" ? d.brief.trim() : "";
          return target ? { target, brief } : null;
        })
        .filter(Boolean);
    } catch {
      delegations = [];
    }
  }
  let cut = source.length;
  if (fence && fence.index != null) cut = idx + DELEGATE_HEADING.length + fence.index + fence[0].length;
  else cut = idx; // 펜스 없으면 dangling heading도 제거
  const cleanedText = (source.slice(0, idx) + source.slice(cut)).trim();
  return { delegations, cleanedText };
}

function loadDelegateParser() {
  try {
    const fences = require("../sessions/fences.cjs");
    if (fences && typeof fences.parseDelegateBlock === "function") return fences.parseDelegateBlock;
    if (fences && typeof fences.parseDelegations === "function") return fences.parseDelegations;
  } catch { /* fences.cjs 미존재 — 로컬 파서 사용 */ }
  return parseDelegationsLocal;
}

/*
 * 제어 블록 스트리퍼 정본 — 벤더 코어의 shared/agent-control-blocks
 * (Desktop·Mobile 과 같은 규칙). 옛 벤더 번들이라 없으면 null — cleanFenceText 는
 * 종전 규칙만으로 fail-open 한다(원문 파괴보다 마커 잔존이 낫다).
 */
let _stripCanonical; // undefined=미시도 · null=정본 없음 · function=정본
function loadCanonicalStripper() {
  if (_stripCanonical === undefined) {
    try {
      const loaded = require("../core/desktop-core.cjs").loadCoreShared("agent-control-blocks");
      _stripCanonical = loaded && loaded.module && typeof loaded.module.stripAgentControlBlocks === "function"
        ? loaded.module.stripAgentControlBlocks
        : null;
    } catch {
      _stripCanonical = null;
    }
  }
  return _stripCanonical;
}

/** 표시/전달용 텍스트에서 제어 펜스를 제거한다(파싱만 — 부작용 없음). 실패 시 원문. */
function cleanFenceText(text) {
  const raw = String(text || "");
  let cleaned;
  try {
    const fences = require("../sessions/fences.cjs");
    if (fences && typeof fences.parseReplyFences === "function") {
      cleaned = fences.parseReplyFences(raw).cleanText;
    }
  } catch { /* fences 미존재/파서 실패 — 원문 보존 */ }
  if (cleaned == null) cleaned = parseDelegationsLocal(raw).cleanedText;
  // HTML 주석 봉투는 정본보다 먼저 — 정본이 헤딩만 도려내면 주석 껍데기가 남는다.
  cleaned = cleaned.replace(/<!--\s*[\s\S]*?## Memory Events[\s\S]*?-->/gi, "");
  // 정본 스트리퍼(settled 모드): 손코딩이 몰랐던 <<agentlas-ask>>·surface·followups·
  // goal-complete 마커와 잔여 헤딩까지 Desktop 과 같은 규칙으로 지운다.
  const strip = loadCanonicalStripper();
  if (strip) {
    try {
      cleaned = strip(cleaned, { streaming: false });
    } catch { /* 정본 실패 — 종전 규칙만으로 fail-open */ }
  }
  // 터미널 고유 정제(정본 범위 밖): 스킬 나레이션·오케스트레이터 헤더·판정 태그.
  return cleaned
    .replace(/^\s*(?:사용 스킬|Skills used)\s*:[^\n.!?]*[.!?]?\s*(?:(?:이유|Reason)\s*:[^.!?]*[.!?]\s*)?/i, "")
    .replace(/^\s*I(?:'|’)m using (?:the )?`?[^`.\n]+`? skill because [^.]*\.\s*/i, "")
    .replace(/^\s*Execution mode:\s*`?appbridge-ceo-orchestrator`?[^\n]*\n?/gim, "")
    .replace(/<verification_verdict>\s*(?:PASS|FAIL)\s*<\/verification_verdict>/gi, "")
    .trim();
}

/** 리더(CEO) 시스템 프롬프트에 주입할 위임 가이드 (데스크탑 buildDelegateProtocol 동형 축약). */
function buildDelegateProtocol(reports) {
  const list = reports
    .map((r) => `  - ${r.role}${r.name && r.name !== r.role ? ` (${r.name})` : ""}`)
    .join("\n");
  return [
    "## Delegation (you orchestrate a team)",
    "",
    "You lead a team. For THIS task, engage ONLY the direct reports actually needed —",
    "never all of them. Give each a focused brief (goal + specifics). If none are needed,",
    "do the work yourself and emit no Delegate block.",
    "This is the only delegation planning round. Include every role required to finish the request now,",
    "including downstream independent QA or verification roles. State dependencies in their briefs;",
    "the host will delay verification until production results exist. Never defer a needed role to synthesis.",
    "",
    "Your direct reports:",
    list,
    "",
    "To delegate, end your reply with exactly this block (omit entirely if delegating to none):",
    "",
    DELEGATE_HEADING,
    "```json",
    '{ "delegations": [ { "target": "<report role or name above>", "brief": "<what they should do>" } ] }',
    "```",
    "",
    "After delegating, STOP — their results come back to you to synthesize. Synthesis is final and cannot start new work.",
  ].join("\n");
}

// 종합 노드에게 주는 상충/실패 처리 규칙 (데스크탑 CONFLICT_SYNTHESIS_GUIDANCE 동형):
// status:failed 결과는 오류 문자열이지 산출물이 아니다 — 지어내 메우면 안 된다.
const CONFLICT_SYNTHESIS_GUIDANCE = [
  "Rules for this synthesis:",
  '- A result marked "status: failed" is an error message, not a deliverable. Never treat it as findings, and never invent content to fill its gap.',
  "- Resolve conflicts between results explicitly instead of averaging or silently picking one.",
  "- If a failed or missing result means the goal was not met, say so plainly rather than presenting a partial answer as complete.",
].join("\n");

/** delegation 타깃을 본부(role/name)와 매칭 (데스크탑 matchTargets 동형). */
function matchTargets(delegations, candidates) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const picked = [];
  const used = new Set();
  for (const d of delegations) {
    const t = norm(d.target);
    if (!t) continue;
    const node = candidates.find(
      (c) =>
        !used.has(c.key) &&
        (norm(c.role) === t || norm(c.name) === t || norm(c.role).includes(t) || t.includes(norm(c.role))),
    );
    if (node) {
      used.add(node.key);
      picked.push({ node, brief: d.brief || "" });
    }
  }
  return picked;
}

function deptLabel(name) {
  return String(name || "").replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * org_chart_json → 본부(division) 노드 목록.
 * 각 노드는 실제 설치 에이전트로 해석을 시도한다(agentId → agentSlug). 해석 실패 시
 * 합성 노드: FK-safe 하게 CEO의 agent id 를 쓴다(데스크탑 runDivision fkAgentId 동형 —
 * chats.agent_id FK 가 살아있는 행을 가리켜야 한다). 역할 프롬프트는 role 기반.
 */
function resolveDivisions(db, firm, ceoAgent) {
  let chart = [];
  try {
    const parsed = JSON.parse(firm.org_chart_json || "[]");
    if (Array.isArray(parsed)) chart = parsed;
  } catch { chart = []; }
  const nodes = [];
  for (const node of chart) {
    if (!node || !node.reportsTo) continue; // CEO 자신(reportsTo=null)은 본부가 아니다
    const role = deptLabel(node.role || node.agentSlug || "Division");
    let agent = null;
    try {
      const row = (node.agentId
        ? db.prepare("SELECT * FROM installed_agents WHERE id=?").get(node.agentId)
        : null)
        || (node.agentSlug
          ? db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(node.agentSlug)
          : null);
      if (row) agent = rowToAgent(row);
    } catch { agent = null; }
    const name = agent ? agent.name : role;
    const roleContext = `\n\n## Firm role context\nYou are ${name}, the ${role} division of '${firm.name}'. Answer your CEO's brief for this division.`;
    nodes.push({
      key: `${firm.slug}:${role}`,
      role,
      name,
      agent: agent
        ? { ...agent, systemPrompt: `${agent.systemPrompt || `You are ${name}.`}${roleContext}` }
        // 합성 본부 — 실 에이전트가 없으면 CEO id로 FK-safe 하게 챗을 만들고 역할 프롬프트만 준다.
        : { id: ceoAgent.id, slug: `${firm.slug}-${role.toLowerCase().replace(/\s+/g, "-")}`, name, systemPrompt: `You are ${name}, the ${role} division of '${firm.name}'.${roleContext}` },
    });
  }
  return nodes;
}

/** 간단한 동시성 풀 (데스크탑 parallelCap 동형) — 세션 동시 상한을 존중한다. */
async function parallelCap(items, cap, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, () => worker()));
  return out;
}

function isVerificationDivision(node) {
  // key에는 `<firm-slug>:` 접두사가 들어간다. 회사 이름이 `firm-test`/`qa-studio`인
  // 것만으로 모든 본부를 검증 본부로 오분류하면 구현 슬롯이 하나도 실행되지 않는다.
  const label = `${node && node.role || ""} ${node && node.name || ""}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return /\b(?:eval|qa|quality|test|verification|verifier)\b|policy\s+gate/.test(label);
}

function isIntegrationDivision(item, siblingProductionCount) {
  if (!item || siblingProductionCount < 2 || isVerificationDivision(item.node)) return false;
  const label = `${item.node && item.node.role || ""} ${item.node && item.node.name || ""}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const brief = String(item.brief || "").toLowerCase();
  if (/\bdesign\b/.test(label)) return false;
  return /\b(?:web|frontend|integration|integrator|release)\b/.test(label)
    || /\b(?:integrat(?:e|ion)|wire|combine|merge)\b/.test(brief)
    || /\bafter\b[\s\S]{0,80}\b(?:game|design|production|upstream|implementation)\b/.test(brief)
    || /\b(?:once|when)\b[\s\S]{0,80}\b(?:complete|ready|finish)/.test(brief);
}

function stageTargets(targets) {
  const nonVerification = targets.filter((m) => !isVerificationDivision(m.node));
  const integration = nonVerification.filter((m) => isIntegrationDivision(m, nonVerification.length));
  const integrationKeys = new Set(integration.map((m) => m.node.key));
  return {
    production: nonVerification.filter((m) => !integrationKeys.has(m.node.key)),
    integration,
    verification: targets.filter((m) => isVerificationDivision(m.node)),
  };
}

function resultStatusContext(results) {
  return results.length
    ? results.map((r) => `- ${r.name}: ${r.ok ? "completed" : "failed"}`).join("\n")
    : "- No upstream production slot was selected; inspect the current folder honestly.";
}

function verificationResultOk(text, sessionOk) {
  if (!sessionOk) return false;
  const source = String(text || "").trim();
  const explicit = source.match(/<verification_verdict>\s*(PASS|FAIL)\s*<\/verification_verdict>/i);
  // 검증 프롬프트가 요구한 machine-readable verdict가 유일한 성공 근거다.
  // 본문 어조로 성공을 추측하면 태그를 빠뜨린 응답이나 명시적 FAIL까지 통과할 수 있다.
  return Boolean(explicit && explicit[1].toUpperCase() === "PASS");
}

function latestResultsAllOk(results) {
  const latest = new Map();
  for (const result of results) latest.set(result.key || `${result.role}:${result.name}`, result.ok);
  return [...latest.values()].every(Boolean);
}

function turnText(res) {
  // Session returns user-safe text by default. Firm owns its three-tier
  // Delegate protocol, so it alone reads the private raw control text and
  // parses the fence before producing the user-facing synthesis.
  return ((res && (res.controlText || res.finalText || res.text)) || "").trim();
}

/**
 * 회사 1태스크 실행: PLAN → DELEGATE → SYNTHESIZE.
 * @param {object} p
 *   db, orch(Orchestrator), firm(firms 행), ceoAgent(rowToAgent 결과),
 *   task, runtime(orchestrator), workerRuntime?, resolveWorkerRuntime?(division),
 *   permission, cwd, onEvent?({phase,...}),
 *   spawnImplFor?({kind:'ceo'|'division', role?}) — 계약 테스트 전용 fake spawn 주입,
 *   timeoutConfig? — 테스트 전용.
 * @returns {ok, text, chatId, plan:{text,delegations}, divisions:[{role,name,ok,text,chatId}]}
 */
async function runFirmTurn(p) {
  const { db, orch, firm, ceoAgent, task, runtime, permission, cwd } = p;
  const workerRuntime = p.workerRuntime || runtime;
  const onEvent = typeof p.onEvent === "function" ? p.onEvent : () => {};
  const parseDelegations = loadDelegateParser();
  const divisions = resolveDivisions(db, firm, ceoAgent);

  // CEO 시스템 프롬프트 = CEO 페르소나 + 회사 컨텍스트 + (본부가 있으면) 위임 프로토콜.
  let ceoSystem = `${ceoAgent.systemPrompt || `You are the CEO of ${firm.name}.`}\n\n[FIRM] You are the CEO of '${firm.name}'.`;
  if (divisions.length) {
    ceoSystem += `\n\n${buildDelegateProtocol(divisions.map((d) => ({ role: d.role, name: d.name })))}`;
  }
  const ceoSession = orch.spawn({
    agent: { ...ceoAgent, systemPrompt: ceoSystem },
    runtime,
    permission,
    cwd,
    title: `${firm.name}: ${String(task).slice(0, 50)}`,
    spawnImpl: p.spawnImplFor ? p.spawnImplFor({ kind: "ceo" }) : undefined,
    timeoutConfig: p.timeoutConfig,
  });
  // ⚠️ 세션 계층의 generic 자동 위임(apply-fences.cjs)은 ## Delegate 를 보면 "부모와
  // 같은 에이전트"의 자식을 스폰한다. firm 3-tier 는 본부별 실 에이전트 바인딩 + 종합
  // 시퀀스가 필요하므로 이 turn 들의 위임 적용은 이 모듈이 소유한다 — CEO 세션에서
  // 오르카 역참조를 떼어 이중 실행(CEO 페르소나 클론 + 본부 에이전트)을 막는다.
  // apply-fences 는 orch 부재 시 'delegate-refused' 영수증만 남긴다(정직·무부작용).
  ceoSession.orchestrator = null;

  // 1) PLAN
  onEvent({ phase: "plan", firm: firm.slug, ceo: ceoAgent.slug });
  const planRes = await ceoSession.send(task);
  const planRaw = turnText(planRes);
  if (ceoSession.status === "failed") {
    return {
      ok: false,
      text: planRaw || ceoSession.lastError || "CEO plan failed",
      chatId: ceoSession.chatId,
      plan: { text: planRaw, delegations: [] },
      divisions: [],
    };
  }
  const { delegations, cleanedText } = parseDelegations(planRaw);
  const matched = divisions.length ? matchTargets(delegations, divisions) : [];

  // CEO가 위임 안 함(또는 본부 없음) → PLAN 회신이 곧 최종 답 (데스크탑 동형).
  // 이미 세션 계층이 CEO 챗에 영속했다.
  if (!matched.length) {
    onEvent({ phase: "final", delegated: false });
    return {
      ok: true,
      text: cleanedText || planRaw,
      chatId: ceoSession.chatId,
      plan: { text: cleanedText || planRaw, delegations },
      divisions: [],
    };
  }

  // 2) DELEGATE — 구현/디자인은 병렬로 실행하되 독립 검증 본부는 그 결과가 실제
  // 작업 폴더에 반영된 뒤 실행한다. QA를 구현과 동시에 시작하면 "코드 없음"을 정상
  // 결과로 반환해 CEO가 뒤늦게 충돌을 수습하게 된다. 병렬성은 의존성이 없는 슬롯에만
  // 적용하고, 검증 슬롯은 명시적인 2단계 WorkOrder로 보존한다.
  onEvent({ phase: "delegate", targets: matched.map((m) => ({ role: m.node.role, name: m.node.name, brief: m.brief })) });
  const initialStages = stageTargets(matched);
  const runTargets = async (targets, stageContext, stageKind) => parallelCap(targets, maxParallel(), async (m) => {
    const divisionRuntime = typeof p.resolveWorkerRuntime === "function"
      ? p.resolveWorkerRuntime(m.node)
      : workerRuntime;
    const session = orch.spawn({
      agent: m.node.agent,
      runtime: divisionRuntime,
      permission,
      cwd,
      title: `division: ${m.node.role}`,
      parentKey: ceoSession.key,
      activate: false,
      spawnImpl: p.spawnImplFor
        ? p.spawnImplFor({ kind: "division", role: m.node.role, runtime: divisionRuntime })
        : undefined,
      timeoutConfig: p.timeoutConfig,
    });
    // 본부 세션도 generic 자동 위임을 끈다 — 터미널 firm 은 아직 tier-3(전문가) 배선이
    // 없고, 본부 회신의 펜스로 동일 에이전트 클론이 무통제 스폰되면 안 된다.
    session.orchestrator = null;
    let text = "";
    let ok = false;
    try {
      const prompt = stageKind === "verification"
        ? `${m.brief || task}\n\n[Independent verification stage]\nAll upstream production and integration WorkOrders have finished. Inspect and exercise the current project folder as it exists now. Do not rely on an earlier empty-workspace observation.\n${stageContext}\n\nEnd the response with exactly <verification_verdict>PASS</verification_verdict> only when every requested acceptance condition passes after fixes. Otherwise end with <verification_verdict>FAIL</verification_verdict> and identify the remaining blocker.`
        : stageKind === "integration"
          ? `${m.brief || task}\n\n[Integration stage]\nThe upstream production WorkOrders have finished. Inspect their actual files in the current project, integrate every relevant implementation and design deliverable into the runnable product, then verify the integrated launch surface before returning. Do not report a missing or late upstream package without re-reading the current folder.\n${stageContext}`
          : stageKind === "repair"
            ? `${m.brief || task}\n\n[Release-blocking repair stage]\nIndependent verification found the following failures in the current integrated product. Inspect the evidence and current files, repair the actual shipped experience, and rerun the relevant checks before returning. Do not merely describe the fix.\n${stageContext}`
            : (m.brief || task);
      const res = await session.send(prompt);
      const rawText = turnText(res);
      text = cleanFenceText(rawText);
      ok = stageKind === "verification"
        ? verificationResultOk(rawText, session.status === "done")
        : session.status === "done";
      if (!ok && !text) text = session.lastError || "no response";
    } catch (e) {
      text = (e && e.message) || String(e);
      ok = false;
    }
    onEvent({ phase: "division-done", role: m.node.role, ok });
    return { key: m.node.key, role: m.node.role, name: m.node.name, ok, text, chatId: session.chatId };
  });
  const productionResults = await runTargets(initialStages.production, "", "production");
  let integrationResults = [];
  if (initialStages.integration.length) {
    onEvent({ phase: "integrate", targets: initialStages.integration.map((m) => ({ role: m.node.role, name: m.node.name })) });
    integrationResults = await runTargets(initialStages.integration, resultStatusContext(productionResults), "integration");
  }
  let verificationResults = [];
  if (initialStages.verification.length) {
    const upstreamResults = [...productionResults, ...integrationResults];
    verificationResults = await runTargets(initialStages.verification, resultStatusContext(upstreamResults), "verification");
  }
  const divisionResults = [...productionResults, ...integrationResults, ...verificationResults];

  // Verification is a release gate, not a terminal report. When it finds a
  // blocker, run one bounded repair cycle with the implementation/integration
  // slots that produced the build, then independently verify the repaired
  // product again. This closes the common "QA says FAIL and the command ends"
  // gap while keeping retries finite.
  if (initialStages.verification.length && verificationResults.some((result) => !result.ok)) {
    const repairContext = verificationResults
      .filter((result) => !result.ok)
      .map((result) => `## ${result.name} (${result.role})\n${result.text}`)
      .join("\n\n");
    const repairTargets = [...initialStages.production, ...initialStages.integration];
    if (repairTargets.length) {
      onEvent({ phase: "repair", targets: repairTargets.map((m) => ({ role: m.node.role, name: m.node.name })) });
      const repairResults = await runTargets(repairTargets, repairContext, "repair");
      divisionResults.push(...repairResults);
      const recheckContext = resultStatusContext([...productionResults, ...integrationResults, ...repairResults]);
      const recheckResults = await runTargets(initialStages.verification, recheckContext, "verification");
      divisionResults.push(...recheckResults);
    }
  }
  const usedDivisionKeys = new Set(matched.map((m) => m.node.key));
  const divisionAttempts = new Map(matched.map((m) => [m.node.key, 1]));

  // 3) SYNTHESIZE — CEO 세션의 두 번째 턴. status:failed 표기로 오류 문자열이 산출물로
  // 오독되는 것을 막는다(데스크탑 CONFLICT_SYNTHESIS_GUIDANCE 계약).
  onEvent({ phase: "synthesize" });
  const synthPrompt =
    `${task}\n\n[Results from your team — synthesize into one final answer for the user]\n` +
    `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
    divisionResults
      .map((r) => `## ${r.name} (${r.role})\nstatus: ${r.ok ? "ok" : "failed"}\n${r.text}`)
      .join("\n\n");
  let finalRes = await ceoSession.send(synthPrompt);
  let finalRaw = turnText(finalRes);

  // A controller may discover the next required role only after reading the
  // first results (for example PM -> Game/Design -> Eval). Execute bounded,
  // previously-unused follow-up delegations instead of printing "starting"
  // prose and ending the command without doing the work.
  for (let round = 0; round < divisions.length; round += 1) {
    const followupParsed = parseDelegations(finalRaw);
    const hasFailedResult = !latestResultsAllOk(divisionResults);
    const followup = matchTargets(followupParsed.delegations, divisions)
      .filter((m) => !usedDivisionKeys.has(m.node.key) || (hasFailedResult && (divisionAttempts.get(m.node.key) || 0) < 2));
    if (!followup.length) break;
    for (const item of followup) {
      usedDivisionKeys.add(item.node.key);
      divisionAttempts.set(item.node.key, (divisionAttempts.get(item.node.key) || 0) + 1);
    }
    onEvent({ phase: "delegate", targets: followup.map((m) => ({ role: m.node.role, name: m.node.name, brief: m.brief })) });
    const followupStages = stageTargets(followup);
    const followupProductionResults = await runTargets(followupStages.production, "", "production");
    let followupIntegrationResults = [];
    if (followupStages.integration.length) {
      const upstream = [...divisionResults, ...followupProductionResults];
      onEvent({ phase: "integrate", targets: followupStages.integration.map((m) => ({ role: m.node.role, name: m.node.name })) });
      followupIntegrationResults = await runTargets(followupStages.integration, resultStatusContext(upstream), "integration");
    }
    let followupVerificationResults = [];
    if (followupStages.verification.length) {
      const upstream = [...divisionResults, ...followupProductionResults, ...followupIntegrationResults];
      followupVerificationResults = await runTargets(followupStages.verification, resultStatusContext(upstream), "verification");
    }
    divisionResults.push(...followupProductionResults, ...followupIntegrationResults, ...followupVerificationResults);
    onEvent({ phase: "synthesize" });
    finalRes = await ceoSession.send(
      `${task}\n\n[Updated results from your team — continue orchestration only if a still-unused required role is missing; otherwise return the final user result.]\n` +
      `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
      divisionResults.map((r) => `## ${r.name} (${r.role})\nstatus: ${r.ok ? "ok" : "failed"}\n${r.text}`).join("\n\n"),
    );
    finalRaw = turnText(finalRes);
  }
  const finalText = cleanFenceText(finalRaw);
  const finalOk = ceoSession.status === "done";
  onEvent({ phase: "final", delegated: true, ok: finalOk });

  // CEO 종합 턴의 성공은 팀의 성공이 아니다 — 자식 결과를 집계해 부분 완료가 성공으로
  // 둔갑하지 않게 한다(데스크탑 동일 수리).
  return {
    ok: finalOk && latestResultsAllOk(divisionResults),
    text: finalText,
    chatId: ceoSession.chatId,
    plan: { text: cleanedText, delegations },
    divisions: divisionResults,
  };
}

module.exports = {
  runFirmTurn,
  parseDelegationsLocal,
  cleanFenceText,
  buildDelegateProtocol,
  matchTargets,
  resolveDivisions,
  DELEGATE_HEADING,
};
