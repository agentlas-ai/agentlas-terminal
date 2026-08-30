"use strict";
/*
 * agents/registry — 설치 에이전트 조회 (공유 DB 읽기 전용 표면).
 * 라우팅/판정은 여기 없다 — 이 모듈은 결정론적 조회만 한다.
 *
 * 프라이버시 정책(v1/데스크탑 동형): 일부 아키텍처 에이전트는 웹 전용(private) 또는
 * 백그라운드 인프라라서 목록/해석에서 제외된다. visibility 열 + 역할 + 정규화 지문
 * 셋으로 판정한다 — 지문 셋은 이름이 리브랜딩돼도 구본을 계속 가리기 위한 것.
 */
const crypto = require("node:crypto");

const PRIVATE_WEB_AGENT_FINGERPRINTS = new Set([
  "880db20e11cd945e5777b5aaf73c10f24de3e2e190d13631b5f3ed0e4796821c",
  "a0dba10416f15dac84202902284780ee23f31eda9dc068ccf6a28276b585ea36",
  "479d879189166bf9bde1b0cd939db746bf8c1b94f2aad553d08cf7b4a2204f9e",
  "79c16e0347312aceb57c0ec7ee6bb6ebd0118984cc716f9cd56db63d18679183",
  "56ff55fcc909461b5fc449fdb3d685c6cceeb10d59836d9a91faf3ceb41896a4",
  "978dd8a262d86397bbdaca13bbec5be313a68fb2d5c609330888818641af8079",
]);
const BACKGROUND_AGENT_FINGERPRINTS = new Set([
  "9011fb75e638676e23a36f86ea689b6e4de17cb5b5954b36810b5239ab077f0b",
  "0331d654916d648797d31598e3e18eb7fd49166e91783ab9d731648b6e855b90",
]);
const BACKGROUND_ROLES = new Set(["orchestrator", "pm", "curator", "governance"]);
// 데스크탑 electron/agents/policy.ts:35 REMOVED_MARKETPLACE_SEED_SLUGS 동형 —
// 마켓에서 회수된 시드 에이전트는 publicAgentVisibility가 무조건 'private'으로
// 강등한다(electron/agents/policy.ts:96). 데스크탑은 db.ts:1499에서 이 값을
// visibility 열에 백필하지만, 데스크탑 마이그레이션이 안 돈 DB에서 터미널이
// 이 목록 없이 읽으면 회수된 시드가 목록/해석에 다시 새어 나온다.
const REMOVED_MARKETPLACE_SEED_SLUGS = new Set([
  "shop-product-writer",
  "shop-cs-responder",
  "shop-review-monitor",
  "shop-pricing-scout",
  "shop-keyword-finder",
  "marketer-content-writer",
  "marketer-seo-researcher",
  "marketer-schedule-secretary",
  "marketer-ad-copywriter",
  "marketer-analytics-reader",
  "firm-ceo-shop",
  "firm-ceo-marketer",
]);

function policyNormalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function policyFingerprint(value) {
  const normalized = policyNormalize(value);
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex") : null;
}
function agentRowFingerprints(row) {
  return [row.slug, row.name, row.name_en, row.tagline, row.tagline_en]
    .map(policyFingerprint)
    .filter(Boolean);
}
function isPrivateWebOnlyAgentRow(row) {
  if (policyNormalize(row.visibility) === "private") return true;
  if (policyNormalize(row.role) === "meta") return true;
  return agentRowFingerprints(row).some((value) => PRIVATE_WEB_AGENT_FINGERPRINTS.has(value));
}
function isBackgroundAgentRow(row) {
  if (isPrivateWebOnlyAgentRow(row)) return false;
  if (policyNormalize(row.visibility) === "background") return true;
  if (row.builtin && BACKGROUND_ROLES.has(policyNormalize(row.role))) return true;
  return agentRowFingerprints(row).some((value) => BACKGROUND_AGENT_FINGERPRINTS.has(value));
}

/**
 * 데스크탑 publicAgentVisibility 동형 (electron/agents/policy.ts:95-100):
 * 회수된 마켓 시드 슬러그 → private (지문/역할 검사보다 먼저),
 * 웹 전용 → private, 백그라운드 → background, 그 외 → 열 값(없으면 visible).
 */
function publicAgentVisibilityRow(row) {
  if (REMOVED_MARKETPLACE_SEED_SLUGS.has(policyNormalize(row.slug))) return "private";
  if (isPrivateWebOnlyAgentRow(row)) return "private";
  if (isBackgroundAgentRow(row)) return "background";
  const declared = policyNormalize(row.visibility);
  return declared === "visible" || declared === "background" || declared === "private" ? declared : "visible";
}

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || "",
    tagline: row.tagline || "",
    taglineEn: row.tagline_en || "",
    systemPrompt: row.system_prompt || "",
    preferredBackend: row.preferred_backend || null,
    builtin: !!row.builtin,
    visibility: row.visibility || "visible",
    role: row.role || null,
    mcpServersJson: row.mcp_servers_json || "[]",
  };
}

/** 웹 전용(private)·회수 시드 제외 전체 목록 — 백그라운드 인프라는 visibility='background'로 정규화. */
function listPublicAgents(db) {
  return db.prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC").all()
    .filter((row) => publicAgentVisibilityRow(row) !== "private")
    .map((row) => rowToAgent({ ...row, visibility: isBackgroundAgentRow(row) ? "background" : "visible" }));
}

function listAgents(db) {
  return listPublicAgents(db).filter((agent) => agent.visibility !== "background");
}

/** 라우팅 후보(백그라운드 포함, 웹 전용 제외). */
function listRoutableAgents(db) {
  return listPublicAgents(db);
}

/**
 * slug/이름 해석 — 라우팅 가능 집합(listRoutableAgents) 안에서만 찾는다:
 * 웹 전용(private) 에이전트는 이름을 알아도 터미널에서 실행되면 안 된다.
 * 정확 일치 → 유일 부분 일치. 부분 일치가 여럿이면 모호 — 조용히 고르지 않는다.
 */
function findAgent(db, token) {
  const q = String(token || "").trim().toLowerCase();
  if (!q) return null;
  const agents = listRoutableAgents(db);
  const exactId = agents.find((agent) => agent.id === token);
  if (exactId) return exactId; // primary key is authoritative
  const exactSlug = agents.filter((agent) => agent.slug.toLowerCase() === q);
  if (exactSlug.length === 1) return exactSlug[0];
  if (exactSlug.length > 1) return null;
  const exactName = agents.filter((agent) =>
    (agent.name || "").toLowerCase() === q || (agent.nameEn || "").toLowerCase() === q,
  );
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) return null;
  const partial = agents.filter((a) =>
    a.slug.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.nameEn || "").toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  return null;
}

function agentMcpServerIds(db, agentId) {
  try {
    return db.prepare("SELECT server_id FROM agent_mcp_servers WHERE agent_id=?").all(agentId).map((r) => r.server_id);
  } catch {
    return [];
  }
}

/** invoke 시스템 프롬프트: 저장 프롬프트가 없으면 이름 기반 최소 프롬프트 (v1 agentSystemPromptCli 동형). */
function agentSystemPrompt(row) {
  return row && row.system_prompt ? row.system_prompt : `You are ${row?.name || "an Agentlas agent"}.`;
}

module.exports = {
  findAgent,
  listAgents,
  listPublicAgents,
  listRoutableAgents,
  rowToAgent,
  agentMcpServerIds,
  agentSystemPrompt,
  isPrivateWebOnlyAgentRow,
  isBackgroundAgentRow,
  publicAgentVisibilityRow,
};
