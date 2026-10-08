"use strict";

// Historical summary records are read-only; executable changes use the revision service.
function parseSource(json) {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function terminalSafe(value, maxLength = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizedListLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 200)) : 50;
}

/** 대기 중(사람 결정 필요) 고위험 성장 제안 개수 — 터미널 홈 배너용. */
function countPendingGrowthProposals() { return 0; }

function listGrowthProposals(db, limit = 50) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT * FROM agent_evolution_proposals
          WHERE json_extract(source_json, '$._growth') = 1
            AND status IN ('candidate','applied','measured')
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT ?`,
      )
      .all(normalizedListLimit(limit));
  } catch {
    rows = [];
  }
  const pending = [];
  const applied = [];
  const autoApplied = [];
  for (const row of rows) {
    const source = parseSource(row.source_json);
    const entry = { row, source };
    if (row.status === "candidate") pending.push(entry);
    else {
      applied.push(entry);
      if (source._autoApplied === true) autoApplied.push(entry);
    }
  }
  return { pending, applied, autoApplied };
}

function cmdEvolve(ctx) {
  return require("./agent-workspace.cjs").runWorkspaceCommand(ctx, Array.isArray(ctx.args) ? ctx.args : []);
}

module.exports = { cmdEvolve, countPendingGrowthProposals, listGrowthProposals };
