"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { listRoutableAgents } = require("../agents/registry.cjs");

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ""));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function projectColumns(db) {
  try {
    return new Set(db.prepare("PRAGMA table_info(projects)").all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function parseAgentPool(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    throw Object.assign(new Error("This project's agent team cannot be read. Open the project in Agentlas Desktop and save its team again."), { code: "project_team_unreadable", honestStop: true });
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error("This project's agent team cannot be read. Open the project in Agentlas Desktop and save its team again."), { code: "project_team_unreadable", honestStop: true });
  }
  return parsed.filter((member) => member && typeof member === "object"
    && typeof member.agentId === "string" && member.agentId.trim()
    && ["local", "cloud", "hub"].includes(member.source)
    && typeof member.nameSnapshot === "string");
}

function resolveProjectForCwd(db, cwd) {
  const columns = projectColumns(db);
  if (!columns.has("folder_path") || !columns.has("agent_pool_json")) {
    throw Object.assign(new Error("This Agentlas data store does not support project teams yet. Open the latest Agentlas Desktop once, then retry."), { code: "project_teams_unsupported", honestStop: true });
  }
  const rows = db.prepare(
    `SELECT id, name, system_prompt, agent_pool_json, source_type, source_ref, folder_path
       FROM projects
      WHERE folder_path IS NOT NULL AND trim(folder_path) <> ''`,
  ).all();
  const target = canonicalPath(cwd);
  const matches = rows.map((row) => ({ row, root: canonicalPath(row.folder_path) }))
    .filter(({ root }) => pathContains(root, target))
    .sort((a, b) => b.root.length - a.root.length);
  if (!matches.length) {
    throw Object.assign(new Error("This folder is not connected to an Agentlas project. Connect it in Desktop Work, or pass an exact agent for an advanced direct invocation."), { code: "project_not_connected", honestStop: true });
  }
  const bestLength = matches[0].root.length;
  const best = matches.filter((entry) => entry.root.length === bestLength);
  if (best.length !== 1) {
    throw Object.assign(new Error("More than one Agentlas project is connected to this folder. Keep one source connection, then retry."), { code: "project_ambiguous", honestStop: true });
  }
  return { ...best[0].row, rootPath: best[0].root, agentPool: parseAgentPool(best[0].row.agent_pool_json) };
}

function resolveProjectController(db, cwd) {
  const project = resolveProjectForCwd(db, cwd);
  if (!project.agentPool.length) {
    throw Object.assign(new Error("This project has no agent team. Drag agents into the project in Desktop Work, then retry."), { code: "project_team_empty", honestStop: true });
  }
  const controllerRef = project.agentPool[0];
  if (controllerRef.source !== "local") {
    throw Object.assign(new Error(`The project controller “${controllerRef.nameSnapshot}” is not installed locally for Terminal execution. Install that exact release locally or reorder the project team.`), { code: "controller_not_installed", honestStop: true });
  }
  const controller = listRoutableAgents(db).find((agent) => agent.id === controllerRef.agentId) || null;
  if (!controller) {
    throw Object.assign(new Error(`The project controller “${controllerRef.nameSnapshot}” is unavailable. Restore that agent or explicitly choose a new first agent in Desktop Work.`), { code: "controller_unavailable", honestStop: true });
  }
  return { project, controller };
}

function withProjectControllerContext(controller, project) {
  const team = project.agentPool.map((member, index) =>
    `${index + 1}. ${member.nameSnapshot} (${member.source}${member.releaseId ? `, exact release ${member.releaseId}` : ""})`,
  ).join("\n");
  const projectInstruction = String(project.system_prompt || "").trim();
  const ownership = [
    `You are the controller for the Agentlas Work project “${project.name}”.`,
    "You own this task. The remaining ordered project members are eligible sub-agents for task-scoped WorkOrders only.",
    "Do not transfer task ownership, silently substitute an unavailable member, or claim a sub-agent ran without an assignment and execution receipt.",
    "Project team:",
    team,
  ].join("\n");
  return {
    ...controller,
    systemPrompt: [controller.systemPrompt, projectInstruction && `Project system prompt:\n${projectInstruction}`, ownership]
      .filter(Boolean)
      .join("\n\n"),
  };
}

module.exports = {
  canonicalPath,
  pathContains,
  parseAgentPool,
  resolveProjectForCwd,
  resolveProjectController,
  withProjectControllerContext,
};
