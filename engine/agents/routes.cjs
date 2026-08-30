"use strict";
/*
 * agents/routes — 에이전트 → 로컬 폴더/런타임 매핑 (userData/agent-routes.json).
 * 데스크탑 electron/agents/routes.ts 와 같은 파일을 공유한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { userDataDir } = require("../core/paths.cjs");

function routesPath() {
  return path.join(userDataDir(), "agent-routes.json");
}

function routesMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(routesPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null);
    return Object.assign(Object.create(null), parsed);
  } catch {
    return Object.create(null);
  }
}

/** 원자적 사설 쓰기 (0600) — 데스크탑과 파일을 공유하므로 부분 쓰기가 보이면 안 된다. */
function saveRoutes(routes) {
  const file = routesPath();
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(routes, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDirectoryBestEffort(parent);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* rename consumed it, or cleanup is best-effort */ }
  }
}

function fsyncDirectoryBestEffort(directory) {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch {
    // Some filesystems do not support directory fsync. The same-directory
    // rename still keeps readers on either the complete old or complete new map.
  }
}

function routeForAgent(agentId) {
  return routesMap()[agentId] || null;
}

module.exports = { routesPath, routesMap, saveRoutes, routeForAgent };
