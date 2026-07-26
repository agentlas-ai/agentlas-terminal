"use strict";
/*
 * agents/routes — 에이전트 → 로컬 폴더/런타임 매핑 (userData/agent-routes.json).
 * 데스크탑 electron/agents/routes.ts 와 같은 파일을 공유한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

function routesPath() {
  return path.join(userDataDir(), "agent-routes.json");
}

function routesMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(routesPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 원자적 사설 쓰기 (0600) — 데스크탑과 파일을 공유하므로 부분 쓰기가 보이면 안 된다. */
function saveRoutes(routes) {
  const file = routesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(routes, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* win32 */ }
}

function routeForAgent(agentId) {
  return routesMap()[agentId] || null;
}

module.exports = { routesPath, routesMap, saveRoutes, routeForAgent };
