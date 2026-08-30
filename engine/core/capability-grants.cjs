"use strict";
/*
 * core/capability-grants — 데스크탑이 소유한 통합 능력 승인(capability_grants)을
 * 터미널이 **읽고 쓴다**.
 *
 * 오너 결정(2026-08-20): 승인은 에이전트별·채널별이 아니라 **행동 기준**이고 공유된다.
 * 데스크탑에서 "항상 허용"을 누른 행동은 터미널에서도 다시 묻지 않아야 하고, 데스크탑에서
 * 영구 거부된 행동은 터미널의 어떤 권한 등급으로도 뚫려서는 안 된다. 표는 하나(공유
 * agentlas.sqlite, v98)이므로 규칙도 하나다 — 터미널이 자기 사본을 들면 그 순간 갈라진다.
 *
 * 정본 구현: agentlas_desktop/electron/store/capability-grants.ts.
 * 이 파일은 그 **판정 규칙을 그대로** 옮긴 것이다(키 후보 3종, 스코프 구체성 내림차순,
 * 같은 스코프 안에서 deny > allow, 프리픽스 패턴). 규칙이 갈리면 같은 머신의 두 제품이
 * 같은 행동에 다른 답을 준다 — 바꿀 때는 반드시 양쪽을 함께 바꿀 것.
 *
 * ★터미널은 마이그레이션 follower 다(core/db.cjs 참조). 표가 없으면 **만들지 않는다** —
 *   조용히 기존 동작(터미널 자체 동의/권한 규칙)으로 폴백하고, 왜 폴백했는지 사유를
 *   호출부에 돌려준다. 부재를 성공으로 위장하지 않는다.
 */
const { tableExists } = require("./db.cjs");

const TABLE = "capability_grants";

/** 표가 없는(구버전) 공유 DB 에서 호출부가 사용자에게 그대로 보여줄 수 있는 사유. */
const UNAVAILABLE_REASON =
  "shared database has no capability_grants table (older schema) — " +
  "Terminal fell back to its own consent/permission rules. " +
  "Launch the Agentlas Desktop app once to migrate the shared store.";

/**
 * 능력 클래스 — "항상 허용"이 영구 부여하는 단위.
 * 정본: desktop electron/runtime/tool-approval.ts capabilityClassFor().
 */
function capabilityClassFor(kind, tool) {
  if (kind === "execute" || tool === "bash") return "execute";
  if (kind === "delete") return "delete";
  if (kind === "edit") return "edit";
  if (kind === "fetch" || kind === "network") return "network";
  return "other";
}

/**
 * "항상 허용"이 저장할 인자 패턴 — Claude Code 프리픽스 규칙과 같은 일반화.
 * 정본: desktop tool-approval.ts generalizeDetailPattern().
 */
function generalizeDetailPattern(detail) {
  if (!detail) return null;
  const tokens = String(detail).trim().split(/\s+/);
  if (tokens.length <= 2) return String(detail).trim();
  return `${tokens[0]} ${tokens[1]} *`;
}

/** "git push *" 스타일 프리픽스 패턴. NULL/빈 패턴은 인자 무관 매치. */
function patternMatches(pattern, detail) {
  if (pattern === null || pattern === undefined || pattern === "") return true;
  if (!detail) return false;
  const text = String(pattern);
  // Keep the separator before `*`. Removing it turns `git push *` into the
  // broader prefix `git push`, which also authorizes unrelated `git pushx`.
  if (text.endsWith("*")) return String(detail).startsWith(text.slice(0, -1));
  return String(detail) === text;
}

/** 구체성 내림차순 — 먼저 맞은 스코프가 이긴다(chat > agent > global). */
function scopesFor(query) {
  const scopes = [];
  if (query && query.chatId) scopes.push(`chat:${query.chatId}`);
  if (query && query.agentId) scopes.push(`agent:${query.agentId}`);
  scopes.push("global");
  return scopes;
}

/** 표가 실제로 있는가. 만들지 않는다 — 확인만 한다. */
function capabilityGrantsAvailable(db) {
  if (!db) return false;
  return tableExists(db, TABLE);
}

/**
 * 저장된 규칙으로 결정을 찾는다.
 * @returns {{decision: "allow"|"deny"|null, available: boolean, reason: string|null}}
 *   decision === null 은 "규칙 없음" — 호출부가 기존 동작(질문/권한 등급)으로 간다.
 */
function readCapabilityDecision(db, query) {
  if (!capabilityGrantsAvailable(db)) {
    return { decision: null, available: false, reason: UNAVAILABLE_REASON };
  }
  const capability = String((query && query.capability) || "other");
  const keys = [capability];
  if (query && query.tool) keys.push(`tool:${query.tool}`);
  keys.push("*");
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT capability, pattern, decision, scope FROM ${TABLE} ` +
        `WHERE capability IN (${keys.map(() => "?").join(",")})`,
      )
      .all(...keys);
  } catch (error) {
    // 표는 있는데 열 모양이 우리가 아는 것과 다르다 — 추측하지 않고 폴백한다.
    return {
      decision: null,
      available: false,
      reason: `capability_grants is present but unreadable (${(error && error.message) || error}) — Terminal fell back to its own rules.`,
    };
  }
  if (!rows || rows.length === 0) return { decision: null, available: true, reason: null };
  for (const scope of scopesFor(query)) {
    const inScope = rows.filter(
      (row) => row.scope === scope && patternMatches(row.pattern, query && query.detail),
    );
    if (inScope.length === 0) continue;
    if (inScope.some((row) => row.decision === "deny")) return { decision: "deny", available: true, reason: null };
    return { decision: "allow", available: true, reason: null };
  }
  return { decision: null, available: true, reason: null };
}

/**
 * 규칙을 영속한다(같은 (capability, pattern, scope)는 마지막 결정으로 덮는다).
 * 데스크탑의 recordCapabilityGrant 와 **같은 행**을 쓴다 — 터미널에서 고른
 * "항상 허용"이 데스크탑에도 그대로 보인다.
 *
 * 표가 없으면 만들지 않고 정직하게 실패를 알린다(ok:false + reason).
 */
function recordCapabilityGrant(db, input) {
  if (!capabilityGrantsAvailable(db)) {
    return { ok: false, available: false, reason: UNAVAILABLE_REASON };
  }
  const decision = input && input.decision;
  if (decision !== "allow" && decision !== "deny") {
    return { ok: false, available: true, reason: "capability_grants decision must be allow or deny" };
  }
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (capability, pattern, decision, scope, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(capability, pattern, scope)
       DO UPDATE SET decision = excluded.decision, source = excluded.source, created_at = excluded.created_at`,
    ).run(
      String((input && input.capability) || "other"),
      input && input.pattern != null && input.pattern !== "" ? String(input.pattern) : null,
      decision,
      String((input && input.scope) || "global"),
      String((input && input.source) || "terminal"),
      new Date().toISOString(),
    );
    return { ok: true, available: true, reason: null };
  } catch (error) {
    return {
      ok: false,
      available: true,
      reason: `capability_grants write failed: ${(error && error.message) || error}`,
    };
  }
}

/** 조회용(도구·게이트가 사람에게 보여줄 때). 표가 없으면 빈 배열 + available:false. */
function listCapabilityGrants(db, scope) {
  if (!capabilityGrantsAvailable(db)) return { rows: [], available: false, reason: UNAVAILABLE_REASON };
  try {
    const rows = scope
      ? db.prepare(`SELECT * FROM ${TABLE} WHERE scope = ? ORDER BY id`).all(String(scope))
      : db.prepare(`SELECT * FROM ${TABLE} ORDER BY id`).all();
    return {
      rows: (rows || []).map((row) => ({
        id: Number(row.id),
        capability: String(row.capability),
        pattern: row.pattern == null ? null : String(row.pattern),
        decision: row.decision === "deny" ? "deny" : "allow",
        scope: String(row.scope),
        source: String(row.source == null ? "chip" : row.source),
        createdAt: String(row.created_at == null ? "" : row.created_at),
      })),
      available: true,
      reason: null,
    };
  } catch (error) {
    return { rows: [], available: false, reason: `capability_grants read failed: ${(error && error.message) || error}` };
  }
}

/** 대화 전체 통과("항상 승인" 대화) — 데스크탑 isChatAlwaysApproved 와 같은 행. */
function isChatAlwaysApproved(db, chatId) {
  if (!capabilityGrantsAvailable(db) || !chatId) return false;
  try {
    const row = db
      .prepare(`SELECT decision FROM ${TABLE} WHERE capability = '*' AND scope = ? ORDER BY id DESC LIMIT 1`)
      .get(`chat:${chatId}`);
    return !!row && row.decision === "allow";
  } catch {
    return false;
  }
}

module.exports = {
  TABLE,
  UNAVAILABLE_REASON,
  capabilityClassFor,
  generalizeDetailPattern,
  patternMatches,
  scopesFor,
  capabilityGrantsAvailable,
  readCapabilityDecision,
  recordCapabilityGrant,
  listCapabilityGrants,
  isChatAlwaysApproved,
};
