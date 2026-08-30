"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { listRoutableAgents } = require("../agents/registry.cjs");

const MAX_AGENT_POOL_MEMBERS = 64;
const MAX_AGENT_POOL_BYTES = 256 * 1024;
const MAX_AGENT_POOL_MEMBER_BYTES = 8 * 1024;
const MAX_AGENT_ID_BYTES = 512;
const MAX_RELEASE_ID_BYTES = 512;
const MAX_MEMBER_NAME_BYTES = 4 * 1024;
const MAX_PROJECT_NAME_BYTES = 4 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
const MAX_COMBINED_SYSTEM_PROMPT_BYTES = 512 * 1024;

function projectError(code, message) {
  return Object.assign(new Error(message), { code, honestStop: true });
}

function boundedText(value, maxBytes, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw projectError("project_team_unreadable", `This project's ${label} is invalid.`);
  const text = value.trim();
  if (!allowEmpty && !text) throw projectError("project_team_unreadable", `This project's ${label} is empty.`);
  if (Buffer.byteLength(text, "utf8") > maxBytes || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw projectError("project_team_unreadable", `This project's ${label} is invalid or too large.`);
  }
  return text;
}

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
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw projectError("project_team_unreadable", "This project's agent team cannot be read. Open the project in Agentlas Desktop and save its team again.");
  }
  const encoded = raw === undefined || raw === null ? "[]" : raw;
  if (Buffer.byteLength(encoded, "utf8") > MAX_AGENT_POOL_BYTES) {
    throw projectError("project_team_unreadable", "This project's agent team is too large. Open the project in Agentlas Desktop and save its team again.");
  }
  let parsed;
  try {
    parsed = JSON.parse(encoded || "[]");
  } catch {
    throw projectError("project_team_unreadable", "This project's agent team cannot be read. Open the project in Agentlas Desktop and save its team again.");
  }
  if (!Array.isArray(parsed)) {
    throw projectError("project_team_unreadable", "This project's agent team cannot be read. Open the project in Agentlas Desktop and save its team again.");
  }
  if (parsed.length > MAX_AGENT_POOL_MEMBERS) {
    throw projectError("project_team_too_large", "This project's agent team has too many members. Open the project in Agentlas Desktop and save its team again.");
  }
  const seen = new Set();
  return parsed.map((member, index) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} is invalid.`);
    }
    if (Buffer.byteLength(JSON.stringify(member), "utf8") > MAX_AGENT_POOL_MEMBER_BYTES) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} is too large.`);
    }
    const keys = Object.keys(member).sort();
    const legacyKeys = ["agentId", "nameSnapshot", "releaseId", "source"];
    const canonicalKeys = ["agentId", "controllerAgentId", "entityKind", "firmId", "nameSnapshot", "releaseId", "source", "targetId"];
    const isLegacy = keys.length === legacyKeys.length && keys.every((key, keyIndex) => key === legacyKeys[keyIndex]);
    const isCanonical = keys.length === canonicalKeys.length && keys.every((key, keyIndex) => key === canonicalKeys[keyIndex]);
    if (!isLegacy && !isCanonical) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} is incomplete.`);
    }
    const nameSnapshot = boundedText(member.nameSnapshot, MAX_MEMBER_NAME_BYTES, `agent team member ${index + 1} name`);
    if (!["local", "cloud", "hub"].includes(member.source)) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} has an invalid source.`);
    }
    const releaseId = member.releaseId === null
      ? null
      : boundedText(member.releaseId, MAX_RELEASE_ID_BYTES, `agent team member ${index + 1} release`);
    if (isLegacy) {
      const agentId = boundedText(member.agentId, MAX_AGENT_ID_BYTES, `agent team member ${index + 1} agentId`);
      const key = `${member.source}:agent:${agentId}:${releaseId || ""}`;
      if (seen.has(key)) throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} is duplicated.`);
      seen.add(key);
      return {
        entityKind: "agent", targetId: agentId, agentId, firmId: null, controllerAgentId: null,
        source: member.source, releaseId, nameSnapshot,
      };
    }

    if (member.entityKind !== "agent" && member.entityKind !== "team") {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} has an invalid entity kind.`);
    }
    const optionalId = (value, label) => value === null
      ? null
      : boundedText(value, MAX_AGENT_ID_BYTES, `agent team member ${index + 1} ${label}`);
    const targetId = boundedText(member.targetId, MAX_AGENT_ID_BYTES, `agent team member ${index + 1} targetId`);
    const agentId = optionalId(member.agentId, "agentId");
    const firmId = optionalId(member.firmId, "firmId");
    const controllerAgentId = optionalId(member.controllerAgentId, "controllerAgentId");
    if (member.entityKind === "agent" && (firmId !== null || controllerAgentId !== null || (member.source === "local" && agentId === null))) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} has inconsistent agent identity fields.`);
    }
    if (member.entityKind === "team" && (agentId !== null || (member.source === "local" && firmId === null))) {
      throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} has inconsistent team identity fields.`);
    }
    const key = `${member.source}:${member.entityKind}:${targetId}:${releaseId || ""}`;
    if (seen.has(key)) throw projectError("project_team_unreadable", `This project's agent team member ${index + 1} is duplicated.`);
    seen.add(key);
    return { entityKind: member.entityKind, targetId, agentId, firmId, controllerAgentId, source: member.source, releaseId, nameSnapshot };
  });
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
  const row = best[0].row;
  boundedText(row.name, MAX_PROJECT_NAME_BYTES, "name");
  if (row.system_prompt !== null && row.system_prompt !== undefined) {
    boundedText(row.system_prompt, MAX_SYSTEM_PROMPT_BYTES, "system prompt", { allowEmpty: true });
  }
  return { ...row, rootPath: best[0].root, agentPool: parseAgentPool(row.agent_pool_json) };
}

function exactInstalledRelease(db, agentId) {
  try {
    const row = db.prepare(
      "SELECT agent_release_id FROM installed_agent_hub_bindings WHERE installed_agent_id=?",
    ).get(agentId);
    return row && typeof row.agent_release_id === "string" ? row.agent_release_id : null;
  } catch {
    return null;
  }
}

function resolveProjectController(db, cwd) {
  const project = resolveProjectForCwd(db, cwd);
  if (!project.agentPool.length) {
    throw Object.assign(new Error("This project has no agent team. Drag agents into the project in Desktop Work, then retry."), { code: "project_team_empty", honestStop: true });
  }
  const controllerRef = project.agentPool[0];
  const controllerAgentId = controllerRef.entityKind === "team"
    ? controllerRef.controllerAgentId
    : controllerRef.agentId;
  if (!controllerAgentId) {
    throw Object.assign(new Error(`The project controller “${controllerRef.nameSnapshot}” is not installed locally for Terminal execution. Install that exact release locally or reorder the project team.`), { code: "controller_not_installed", honestStop: true });
  }
  if (controllerRef.entityKind === "team" && controllerRef.source !== "local" && controllerRef.releaseId !== null) {
    throw projectError("controller_release_unavailable", `The project controller team “${controllerRef.nameSnapshot}” needs its exact team release restored before Terminal can execute it.`);
  }
  if (controllerRef.entityKind === "agent" && controllerRef.releaseId !== null && exactInstalledRelease(db, controllerAgentId) !== controllerRef.releaseId) {
    throw projectError("controller_release_unavailable", `The project controller “${controllerRef.nameSnapshot}” is pinned to an unavailable exact release. Restore that release or explicitly choose a new first agent in Desktop Work.`);
  }
  const controller = listRoutableAgents(db).find((agent) => agent.id === controllerAgentId) || null;
  if (!controller) {
    throw Object.assign(new Error(`The project controller “${controllerRef.nameSnapshot}” is unavailable. Restore that agent or explicitly choose a new first agent in Desktop Work.`), { code: "controller_unavailable", honestStop: true });
  }
  return { project, controller };
}

function withProjectControllerContext(controller, project) {
  const projectName = boundedText(project.name, MAX_PROJECT_NAME_BYTES, "name");
  const team = project.agentPool.map((member, index) =>
    `${index + 1}. ${member.nameSnapshot} (${member.source}${member.releaseId ? `, exact release ${member.releaseId}` : ""})`,
  ).join("\n");
  const projectInstruction = project.system_prompt === null || project.system_prompt === undefined
    ? ""
    : boundedText(project.system_prompt, MAX_SYSTEM_PROMPT_BYTES, "system prompt", { allowEmpty: true });
  const controllerPrompt = boundedText(controller.systemPrompt || "", MAX_SYSTEM_PROMPT_BYTES, "controller system prompt", { allowEmpty: true });
  const ownership = [
    `You are the controller for the Agentlas Work project “${projectName}”.`,
    "You own this task. The remaining ordered project members are eligible sub-agents for task-scoped WorkOrders only.",
    "Do not transfer task ownership, silently substitute an unavailable member, or claim a sub-agent ran without an assignment and execution receipt.",
    "Project team:",
    team,
  ].join("\n");
  const systemPrompt = [controllerPrompt, projectInstruction && `Project system prompt:\n${projectInstruction}`, ownership]
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_COMBINED_SYSTEM_PROMPT_BYTES) {
    throw projectError("project_context_too_large", "This project's controller context is too large to execute safely.");
  }
  return {
    ...controller,
    systemPrompt,
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
