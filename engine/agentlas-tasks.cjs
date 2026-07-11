"use strict";

/* Normalize only task/todo events emitted by the native runtimes.
 * Ordinary tool activity is intentionally excluded: a command is not a fabricated plan item.
 */

function statusOf(value, completed) {
  if (completed === true) return "completed";
  const status = String(value || "pending").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["in_progress", "active", "running", "started"].includes(status)) return "in_progress";
  if (["failed", "error", "blocked", "cancelled", "canceled"].includes(status)) return "failed";
  return "pending";
}

function listFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["todos", "items", "tasks"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function hasExplicitList(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  return ["todos", "items", "tasks"].some((key) => Array.isArray(payload[key]));
}

function sanitizeLabel(value, max = 500) {
  let text = String(value || "");
  // Runtime task text is untrusted terminal content. Strip OSC/CSI/escape controls,
  // flatten line breaks, then cap it before it reaches footer row accounting.
  text = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, max).join("");
}

function normalizeTaskList(payload, source = "runtime") {
  return listFrom(payload).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const label = sanitizeLabel(raw.content || raw.subject || raw.description || raw.text || raw.title || raw.activeForm);
    if (!label) return [];
    return [{
      id: String(raw.id || raw.taskId || `${source}:${index}`),
      label,
      status: statusOf(raw.status, raw.completed),
      source,
    }];
  });
}

function applyTaskTool(current, name, payload, toolId) {
  const tool = String(name || "").toLowerCase();
  if (tool === "todowrite" || tool === "write_todos") {
    return normalizeTaskList(payload, tool);
  }

  if (tool !== "taskcreate" && tool !== "taskupdate") return current;

  const next = Array.isArray(current) ? current.map((task) => ({ ...task })) : [];
  if (tool === "taskcreate") {
    const label = sanitizeLabel(payload?.subject || payload?.description || payload?.activeForm);
    if (!label) return next;
    next.push({ id: String(payload?.taskId || toolId || `taskcreate:${next.length}`), label, status: "pending", source: "taskcreate" });
    return next;
  }
  if (tool === "taskupdate") {
    const id = String(payload?.taskId || toolId || "");
    if (!id) return next;
    if (String(payload?.status || "").toLowerCase() === "deleted") return next.filter((task) => task.id !== id);
    const index = next.findIndex((task) => task.id === id);
    const label = sanitizeLabel(payload?.subject || payload?.description || payload?.activeForm || (index >= 0 && next[index].label) || id);
    const task = { id, label, status: statusOf(payload?.status), source: "taskupdate" };
    if (index >= 0) next[index] = { ...next[index], ...task };
    else next.push(task);
  }
  return next;
}

function applyTaskResult(current, name, payload, toolId) {
  const tool = String(name || "").toLowerCase();
  if (!["taskcreate", "taskupdate", "tasklist"].includes(tool)) return current;
  if (!payload || typeof payload !== "object") return current;
  if (tool === "tasklist") {
    return hasExplicitList(payload) ? normalizeTaskList(payload, "tasklist") : current;
  }
  const record = payload.task && typeof payload.task === "object" ? payload.task : payload;
  const id = String(record.id || record.taskId || payload.taskId || "");
  if (!id) return current;
  const next = Array.isArray(current) ? current.map((task) => ({ ...task })) : [];
  const provisional = next.findIndex((task) => task.id === String(toolId || ""));
  const existing = next.findIndex((task) => task.id === id);
  const index = existing >= 0 ? existing : provisional;
  const prior = index >= 0 ? next[index] : null;
  const label = sanitizeLabel(record.content || record.subject || record.description || record.text || record.title || prior?.label || id);
  const task = { id, label, status: statusOf(record.status || prior?.status), source: tool || "task-result" };
  if (index >= 0) next[index] = { ...prior, ...task };
  else next.push(task);
  if (existing >= 0 && provisional >= 0 && provisional !== existing) next.splice(provisional, 1);
  return next;
}

module.exports = { statusOf, sanitizeLabel, normalizeTaskList, applyTaskTool, applyTaskResult };
