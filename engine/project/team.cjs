"use strict";
/*
 * project/team — 터미널에서 프로젝트를 만들고 순서 팀을 편성한다 (독립).
 *
 * 배경(2026-08-06, 오너 원칙): 데스크탑/플러그인은 산출물·설정을 **공유**할 뿐,
 * 설치되어 있거나 거기서 작업이 선행되어야 하는 것은 아니다. 그런데 projects
 * 행을 쓰는 곳이 터미널 엔진에 0곳이라, `run "<task>"`가 "Desktop Work에서
 * 연결하세요"로 막혔다 — 데스크탑을 강제하는 격차. 스키마(projects)는 터미널이
 * 부트스트랩하는 공유 스키마이므로, 여기서 직접 쓴다.
 *
 * 계약(데스크탑 tasks.createProject와 동형):
 *  - 순서 팀의 index 0(컨트롤러)은 로컬 설치 에이전트여야 한다. 로컬이 아니면
 *    폰이 프로젝트를 시작 불가로 만들 수 있다는 모바일 계약과 같은 이유 —
 *    컨트롤러는 이 머신에서 반드시 실행 가능해야 한다.
 *  - 풀 멤버 형태는 controller.cjs parseAgentPool과 정확히 일치:
 *    { agentId, source, releaseId, nameSnapshot }.
 *  - 폴더당 프로젝트는 하나로 수렴한다. 같은 folder_path가 이미 있으면 그 행을
 *    갱신하고, 없으면 만든다(데스크탑이 만든 프로젝트도 그대로 이어받는다).
 */
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");
const { findAgent } = require("../agents/registry.cjs");

function canonical(p) {
  const resolved = path.resolve(String(p || ""));
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** slug/이름 목록 → 검증된 순서 풀. 못 찾은 이름은 정직하게 실패. */
function resolveTeam(db, tokens) {
  const pool = [];
  for (const token of tokens) {
    const agent = findAgent(db, token);
    if (!agent) {
      throw Object.assign(new Error(`agent not found: ${token}`), { code: "team_agent_not_found", honestStop: true, token });
    }
    // 설치 에이전트는 로컬이다(installed_agents에 있음 = 이 머신에서 실행 가능).
    pool.push({
      agentId: agent.id,
      source: "local",
      releaseId: null,
      nameSnapshot: agent.name || agent.slug || agent.id,
    });
  }
  return pool;
}

/**
 * connectProjectTeam(db, folder, tokens, opts)
 *   folder: 프로젝트 루트(cwd)
 *   tokens: 순서 팀 slug/이름 배열 (index 0 = 컨트롤러)
 *   opts.name / opts.systemPrompt (선택)
 * → { id, name, folderPath, team: [{agentId, nameSnapshot}], created }
 */
function connectProjectTeam(db, folder, tokens, opts = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw Object.assign(new Error("a project team needs at least one agent (the first is the controller)"), { code: "team_empty", honestStop: true });
  }
  const columns = new Set(db.prepare("PRAGMA table_info(projects)").all().map((r) => r.name));
  if (!columns.has("folder_path") || !columns.has("agent_pool_json")) {
    throw Object.assign(new Error("This Agentlas data store does not support project teams yet."), { code: "project_teams_unsupported", honestStop: true });
  }
  const team = resolveTeam(db, tokens);
  const root = canonical(folder);
  const now = new Date().toISOString();
  const poolJson = JSON.stringify(team);
  const controllerId = team[0].agentId;
  // default_agent_id 는 데스크탑 마이그레이션이 추가한 컬럼이라 터미널이 신선
  // 부트스트랩한 스키마엔 없을 수 있다 — 있을 때만 쓴다. 컨트롤러 정본은 늘
  // agent_pool_json[0]다(default_agent_id는 데스크탑 호환용 보조 필드).
  const hasDefaultCol = columns.has("default_agent_id");

  return runWriteTransaction(db, () => {
    // 같은 폴더의 기존 프로젝트를 찾는다(데스크탑이 만든 것 포함, 정확 경로만).
    const existing = db.prepare(
      "SELECT id, name FROM projects WHERE folder_path IS NOT NULL AND folder_path = ?",
    ).get(root) || null;
    if (existing) {
      const sets = ["agent_pool_json=?", "updated_at=?"];
      const vals = [poolJson, now];
      if (hasDefaultCol) { sets.push("default_agent_id=?"); vals.push(controllerId); }
      if (opts.name) { sets.push("name=?"); vals.push(opts.name); }
      if (opts.systemPrompt !== undefined) { sets.push("system_prompt=?"); vals.push(opts.systemPrompt); }
      db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id=?`).run(...vals, existing.id);
      return { id: existing.id, name: opts.name || existing.name, folderPath: root, team, created: false };
    }
    const id = `project:local:${crypto.randomUUID()}`;
    const name = opts.name || path.basename(root) || "Project";
    const cols = ["id", "name", "description", "system_prompt", "agent_pool_json", "source_type", "source_ref", "created_at", "updated_at", "folder_path"];
    const vals = [id, name, null, opts.systemPrompt ?? null, poolJson, "local", null, now, now, root];
    if (hasDefaultCol) { cols.splice(3, 0, "default_agent_id"); vals.splice(3, 0, controllerId); }
    db.prepare(`INSERT INTO projects (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
    return { id, name, folderPath: root, team, created: true };
  });
}

module.exports = { connectProjectTeam, resolveTeam };
