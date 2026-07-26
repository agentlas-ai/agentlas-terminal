"use strict";
/*
 * runtimes/overrides — 에이전트별 런타임 오버라이드 (공유 테이블 agent_runtime_overrides).
 *
 * 데스크탑 electron/store/agent-runtime-overrides.ts 와 같은 행 모양을 읽는다:
 *   (scope, target_id, label, kind, backend, source, model, effort, long_context, updated_at)
 * 스키마 소유권은 데스크탑에 있으므로 여기서는 방어적으로만 읽는다(tableExists/
 * columnExists) — 구버전 DB에서 열이 없으면 "오버라이드 없음"으로 조용히 전진.
 *
 * 해석 사다리(오너 계약): 명시(--runtime) > 에이전트별 오버라이드 > prefs >
 * active_runtime > detected. resolve.cjs 는 건드리지 않는다 — 이 모듈이
 * 오버라이드 층만 앞에 얹고 나머지는 resolve.cjs 에 위임한다.
 */
const { tableExists, columnExists } = require("../core/db.cjs");
const { RUNTIME_BIN, whichSync } = require("./detect.cjs");
const { resolveRuntime, EXECUTABLE_KINDS } = require("./resolve.cjs");

const OVERRIDE_TABLE = "agent_runtime_overrides";
// 데스크탑 VALID_SCOPES 동형. v2 터미널 호출자는 주로 'agent'지만 firm/division도 읽을 수 있다.
const VALID_SCOPES = new Set(["agent", "firm", "division"]);

function cleanText(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/** 방어적 행 → 오버라이드 정규화 (데스크탑 toOverride 동형). */
function rowToOverride(row) {
  if (!row || !row.kind) return null;
  return {
    scope: row.scope,
    targetId: row.target_id,
    label: cleanText(row.label),
    selection: {
      kind: String(row.kind),
      backend: cleanText(row.backend) || undefined,
      source: cleanText(row.source) || undefined,
      model: cleanText(row.model) || undefined,
      effort: cleanText(row.effort) || undefined,
      longContext: Boolean(row.long_context),
    },
    updatedAt: row.updated_at || null,
  };
}

/** 임의 scope 오버라이드 읽기. 테이블/필수 열이 없으면 null (구버전 DB 전진 호환). */
function readRuntimeOverride(db, scope, targetId) {
  if (!db || !VALID_SCOPES.has(scope)) return null;
  const id = cleanText(targetId);
  if (!id) return null;
  if (!tableExists(db, OVERRIDE_TABLE)) return null;
  // 필수 열만 확인한다. label/effort 등 부가 열은 SELECT * 결과에서 없으면 undefined로 흡수.
  if (!columnExists(db, OVERRIDE_TABLE, "scope") || !columnExists(db, OVERRIDE_TABLE, "target_id") || !columnExists(db, OVERRIDE_TABLE, "kind")) {
    return null;
  }
  try {
    const row = db.prepare(`SELECT * FROM ${OVERRIDE_TABLE} WHERE scope=? AND target_id=?`).get(scope, id);
    return rowToOverride(row);
  } catch {
    return null;
  }
}

/** 에이전트별 오버라이드 (데스크탑 getAgentRuntimeOverride('agent', id) 동형). */
function readAgentRuntimeOverride(db, agentId) {
  return readRuntimeOverride(db, "agent", agentId);
}

/** 데스크탑 findAgentRuntimeOverride 동형 — targets 우선순위(예: agent > division > firm). */
function findRuntimeOverride(db, targets) {
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || !target.targetId) continue;
    const found = readRuntimeOverride(db, target.scope, target.targetId);
    if (found) return found;
  }
  return null;
}

/**
 * 오버라이드를 얹은 런타임 해석.
 * @param {object} p { db, prefs, explicit, agentId, targets?, deps? }
 *   targets: [{scope,targetId}] — 주면 agentId 대신 이 우선순위로 오버라이드를 찾는다
 *            (firm 경로: agent > division > firm).
 *   deps: 테스트 주입 { which, resolve } — 상용 호출자는 사용하지 않는다.
 * @returns resolveRuntime 반환형 + source:"agent-override" 또는
 *          { ..., unavailableOverride } (오버라이드가 있으나 이 머신/v2에서 실행 불가 —
 *          조용히 무시하지 않고 사유를 실어 보내며, 호출자가 note를 출력해야 한다)
 */
function resolveRuntimeForAgent({ db, prefs, explicit, agentId, targets, deps } = {}) {
  const resolveImpl = (deps && deps.resolve) || resolveRuntime;
  // 명시(--runtime)가 항상 이긴다 — 오버라이드는 "사용자가 고르지 않았을 때"의 기본값이다.
  if (explicit) return resolveImpl({ db, prefs, explicit });

  const override = targets && targets.length
    ? findRuntimeOverride(db, targets)
    : agentId
      ? readAgentRuntimeOverride(db, agentId)
      : null;
  if (override) {
    const kind = override.selection.kind;
    // v2 스트리밍 드라이버가 있는 CLI 런타임만 실제 실행 대상이다. byok/ollama/kimi
    // 오버라이드는 데스크탑에서는 유효하지만 터미널 v2 실행 사다리에는 아직 없다 —
    // 조용히 다른 런타임으로 둔갑시키지 않고 unavailableOverride로 정직하게 알린다.
    if (EXECUTABLE_KINDS.has(kind)) {
      const which = (deps && deps.which) || whichSync;
      const bin = which(RUNTIME_BIN[kind]);
      if (bin) {
        return {
          kind,
          bin,
          model: override.selection.model,
          effort: override.selection.effort,
          source: "agent-override",
          override,
        };
      }
    }
    const resolved = resolveImpl({ db, prefs, explicit: null });
    return { ...resolved, unavailableOverride: override };
  }
  return resolveImpl({ db, prefs, explicit: null });
}

/** 오버라이드 실행 불가 시 사용자에게 출력할 한 줄 (데스크탑 문구 동형). */
function unavailableOverrideNote(runtime, lang) {
  if (!runtime || !runtime.unavailableOverride) return "";
  const kind = runtime.unavailableOverride.selection.kind;
  return lang === "ko"
    ? `지정 런타임(${kind})을 이 환경에서 실행할 수 없어 기본 런타임(${runtime.kind})으로 실행합니다.`
    : `Assigned runtime (${kind}) is unavailable here — using the default runtime (${runtime.kind}).`;
}

module.exports = {
  readAgentRuntimeOverride,
  readRuntimeOverride,
  findRuntimeOverride,
  resolveRuntimeForAgent,
  unavailableOverrideNote,
};
