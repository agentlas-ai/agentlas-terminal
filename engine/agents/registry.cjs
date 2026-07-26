"use strict";
/*
 * agents/registry — 설치 에이전트 조회 (공유 DB 읽기 전용 표면).
 * 라우팅/판정은 여기 없다 — 이 모듈은 결정론적 조회만 한다.
 */

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || "",
    tagline: row.tagline || "",
    systemPrompt: row.system_prompt || "",
    preferredBackend: row.preferred_backend || null,
    builtin: !!row.builtin,
    visibility: row.visibility || "visible",
    role: row.role || null,
    mcpServersJson: row.mcp_servers_json || "[]",
  };
}

/** slug 정확 일치 → slug 부분/이름 일치(가시 에이전트 우선) 순으로 해석. 없으면 null. */
function findAgent(db, token) {
  const q = String(token || "").trim().toLowerCase();
  if (!q) return null;
  const exact = db.prepare("SELECT * FROM installed_agents WHERE lower(slug)=?").get(q);
  if (exact) return rowToAgent(exact);
  const like = `%${q}%`;
  const candidates = db.prepare(
    "SELECT * FROM installed_agents WHERE lower(slug) LIKE ? OR lower(name) LIKE ? OR lower(name_en) LIKE ? ORDER BY (visibility='visible') DESC, builtin ASC, slug LIMIT 2",
  ).all(like, like, like);
  // 후보가 둘 이상이면 모호 — 조용히 아무거나 고르지 않는다.
  if (candidates.length === 1) return rowToAgent(candidates[0]);
  return null;
}

function listAgents(db, { includeHidden = false } = {}) {
  const rows = includeHidden
    ? db.prepare("SELECT * FROM installed_agents ORDER BY builtin DESC, slug").all()
    : db.prepare("SELECT * FROM installed_agents WHERE visibility='visible' ORDER BY builtin DESC, slug").all();
  return rows.map(rowToAgent);
}

function agentMcpServerIds(db, agentId) {
  try {
    return db.prepare("SELECT server_id FROM agent_mcp_servers WHERE agent_id=?").all(agentId).map((r) => r.server_id);
  } catch {
    return [];
  }
}

module.exports = { findAgent, listAgents, rowToAgent, agentMcpServerIds };
