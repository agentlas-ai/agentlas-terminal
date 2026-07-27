"use strict";
/*
 * Shared Desktop/Terminal model-role reader.
 *
 * Persistence is owned by Desktop migration v79. Terminal reads defensively:
 *   orchestrator row -> legacy active_runtime -> null
 *   worker direct row -> orchestrator row/legacy active_runtime
 *
 * The worker may inherit upward for quality; the orchestrator never falls
 * downward to the worker row.
 */
const { tableExists, columnExists } = require("../core/db.cjs");

const MODEL_ROLE_TABLE = "model_roles";
const VALID_ROLES = new Set(["orchestrator", "worker"]);

function cleanText(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function roleRow(db, role) {
  if (!db || !VALID_ROLES.has(role) || !tableExists(db, MODEL_ROLE_TABLE)) return null;
  for (const column of ["role", "kind", "inherit"]) {
    if (!columnExists(db, MODEL_ROLE_TABLE, column)) return null;
  }
  try {
    return db.prepare("SELECT * FROM model_roles WHERE role=?").get(role) || null;
  } catch {
    return null;
  }
}

function legacyOrchestrator(db) {
  if (!db || !tableExists(db, "active_runtime")) return null;
  try {
    const row = db
      .prepare(
        "SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id=1",
      )
      .get();
    if (!row || !cleanText(row.kind)) return null;
    let effort = null;
    if (tableExists(db, "meta")) {
      effort = cleanText(
        db.prepare("SELECT value FROM meta WHERE key='claude_effort'").get()
          ?.value,
      );
    }
    return {
      role: "orchestrator",
      kind: cleanText(row.kind),
      backend: cleanText(row.backend),
      source: cleanText(row.source),
      model: cleanText(row.model),
      effort,
      longContext: Boolean(row.long_context),
      inherit: false,
      updatedAt: null,
      sourceLayer: "active-runtime",
    };
  } catch {
    return null;
  }
}

function normalizedRow(row, role) {
  if (!row || !cleanText(row.kind)) return null;
  return {
    role,
    kind: cleanText(row.kind),
    backend: cleanText(row.backend),
    source: cleanText(row.source),
    model: cleanText(row.model),
    effort: cleanText(row.effort),
    longContext: Boolean(row.long_context),
    inherit: role === "worker" && Boolean(row.inherit),
    updatedAt: cleanText(row.updated_at),
    sourceLayer: "model-role",
  };
}

const MODEL_ROLE_MEMBER_TABLE = "model_role_members";

/** Desktop v80 역할 풀(순서=우선순위). 테이블이 없거나 비면 []. */
function roleMembers(db, role) {
  if (!db || !VALID_ROLES.has(role) || !tableExists(db, MODEL_ROLE_MEMBER_TABLE)) return [];
  for (const column of ["role", "position", "kind"]) {
    if (!columnExists(db, MODEL_ROLE_MEMBER_TABLE, column)) return [];
  }
  try {
    return db
      .prepare("SELECT * FROM model_role_members WHERE role=? ORDER BY position ASC")
      .all(role)
      .map((row) => ({
        ...normalizedRow({ ...row, inherit: 0 }, role),
        position: row.position,
        sourceLayer: "model-role-pool",
      }))
      .filter((row) => row && row.kind);
  } catch {
    return [];
  }
}

/**
 * 풀에서 첫 가용 멤버를 고른다. isAvailable(member)가 없으면 순서 1위.
 * 전원 불가면 조용한 대체 없이 1위를 그대로 쓰고 skipped를 남긴다.
 * worker 풀이 비면 오케스트레이터 풀을 상속하며, 풀 자체가 없으면
 * 기존 단일 행 해석(resolvedModelRole)으로 내려간다.
 */
function pickRoleFromPool(db, role = "orchestrator", isAvailable = null) {
  if (!VALID_ROLES.has(role)) throw new TypeError(`unknown model role: ${role}`);
  const own = roleMembers(db, role);
  const inherited = role === "worker" && own.length === 0;
  const members = inherited ? roleMembers(db, "orchestrator") : own;
  const skipped = [];
  for (const member of members) {
    if (typeof isAvailable === "function" && !isAvailable(member)) {
      skipped.push({ position: member.position, kind: member.kind, reason: "runtime-unavailable" });
      continue;
    }
    return { ...member, role, inherit: inherited, skipped };
  }
  if (members.length > 0) {
    return { ...members[0], role, inherit: inherited, skipped };
  }
  const single = resolvedModelRole(db, role);
  return single ? { ...single, position: null, skipped } : null;
}

function resolvedModelRole(db, role = "orchestrator") {
  if (!VALID_ROLES.has(role)) throw new TypeError(`unknown model role: ${role}`);
  if (role === "orchestrator") {
    return normalizedRow(roleRow(db, "orchestrator"), role) || legacyOrchestrator(db);
  }
  const worker = normalizedRow(roleRow(db, "worker"), "worker");
  if (worker && !worker.inherit) return worker;
  const orchestrator = resolvedModelRole(db, "orchestrator");
  if (!orchestrator) return null;
  return {
    ...orchestrator,
    role: "worker",
    inherit: true,
    updatedAt: worker?.updatedAt || orchestrator.updatedAt,
    sourceLayer:
      worker?.sourceLayer === "model-role"
        ? "model-role-inherit"
        : "active-runtime-inherit",
  };
}

module.exports = {
  MODEL_ROLE_TABLE,
  MODEL_ROLE_MEMBER_TABLE,
  VALID_ROLES,
  roleRow,
  roleMembers,
  pickRoleFromPool,
  legacyOrchestrator,
  resolvedModelRole,
};
