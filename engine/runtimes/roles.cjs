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
  VALID_ROLES,
  roleRow,
  legacyOrchestrator,
  resolvedModelRole,
};
