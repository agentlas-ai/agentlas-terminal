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

/** 표시/전달용 텍스트에서 제어 펜스를 제거한다(파싱만 — 부작용 없음). 실패 시 원문. */
function cleanFenceText(text) {
  const raw = String(text || "");
  try {
    const fences = require("../sessions/fences.cjs");
    if (fences && typeof fences.parseReplyFences === "function") {
      return fences.parseReplyFences(raw).cleanText;
    }
  } catch { /* fences 미존재/파서 실패 — 원문 보존 */ }
  return parseDelegationsLocal(raw).cleanedText;
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
    "After delegating, STOP — their results come back to you to synthesize. Don't do their work yourself.",
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

function turnText(res) {
  return ((res && (res.finalText || res.text)) || "").trim();
}

/**
 * 회사 1태스크 실행: PLAN → DELEGATE → SYNTHESIZE.
 * @param {object} p
 *   db, orch(Orchestrator), firm(firms 행), ceoAgent(rowToAgent 결과),
 *   task, runtime, permission, cwd, onEvent?({phase,...}),
 *   spawnImplFor?({kind:'ceo'|'division', role?}) — 계약 테스트 전용 fake spawn 주입,
 *   timeoutConfig? — 테스트 전용.
 * @returns {ok, text, chatId, plan:{text,delegations}, divisions:[{role,name,ok,text,chatId}]}
 */
async function runFirmTurn(p) {
  const { db, orch, firm, ceoAgent, task, runtime, permission, cwd } = p;
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

  // 2) DELEGATE — 매칭된 본부만 병렬 실행. 본부 세션은 CEO 세션의 자식으로 스폰되어
  // kind='division' + parent_chat_id(CEO 챗)로 영속된다. 한 본부의 실패는 격리한다.
  onEvent({ phase: "delegate", targets: matched.map((m) => ({ role: m.node.role, name: m.node.name, brief: m.brief })) });
  const divisionResults = await parallelCap(matched, maxParallel(), async (m) => {
    const session = orch.spawn({
      agent: m.node.agent,
      runtime,
      permission,
      cwd,
      title: `division: ${m.node.role}`,
      parentKey: ceoSession.key,
      activate: false,
      spawnImpl: p.spawnImplFor ? p.spawnImplFor({ kind: "division", role: m.node.role }) : undefined,
      timeoutConfig: p.timeoutConfig,
    });
    // 본부 세션도 generic 자동 위임을 끈다 — 터미널 firm 은 아직 tier-3(전문가) 배선이
    // 없고, 본부 회신의 펜스로 동일 에이전트 클론이 무통제 스폰되면 안 된다.
    session.orchestrator = null;
    let text = "";
    let ok = false;
    try {
      const res = await session.send(m.brief || task);
      text = cleanFenceText(turnText(res));
      ok = session.status === "done";
      if (!ok && !text) text = session.lastError || "no response";
    } catch (e) {
      text = (e && e.message) || String(e);
      ok = false;
    }
    onEvent({ phase: "division-done", role: m.node.role, ok });
    return { role: m.node.role, name: m.node.name, ok, text, chatId: session.chatId };
  });

  // 3) SYNTHESIZE — CEO 세션의 두 번째 턴. status:failed 표기로 오류 문자열이 산출물로
  // 오독되는 것을 막는다(데스크탑 CONFLICT_SYNTHESIS_GUIDANCE 계약).
  onEvent({ phase: "synthesize" });
  const synthPrompt =
    `${task}\n\n[Results from your team — synthesize into one final answer for the user]\n` +
    `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
    divisionResults
      .map((r) => `## ${r.name} (${r.role})\nstatus: ${r.ok ? "ok" : "failed"}\n${r.text}`)
      .join("\n\n");
  const finalRes = await ceoSession.send(synthPrompt);
  const finalText = cleanFenceText(turnText(finalRes));
  const finalOk = ceoSession.status === "done";
  onEvent({ phase: "final", delegated: true, ok: finalOk });

  // CEO 종합 턴의 성공은 팀의 성공이 아니다 — 자식 결과를 집계해 부분 완료가 성공으로
  // 둔갑하지 않게 한다(데스크탑 동일 수리).
  return {
    ok: finalOk && divisionResults.every((r) => r.ok),
    text: finalText,
    chatId: ceoSession.chatId,
    plan: { text: cleanedText, delegations },
    divisions: divisionResults,
  };
}

module.exports = {
  runFirmTurn,
  parseDelegationsLocal,
  buildDelegateProtocol,
  matchTargets,
  resolveDivisions,
  DELEGATE_HEADING,
};
