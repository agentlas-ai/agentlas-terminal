"use strict";
/*
 * core/paths — 모든 경로 규칙의 단일 정본.
 * bin/agentlas.cjs(런처)의 userDataDir 규칙과 반드시 동일해야 한다:
 * 데스크탑 앱과 같은 userData를 공유하는 것이 제품 계약이다.
 */
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

function dbPath() {
  return path.join(userDataDir(), "agentlas.sqlite");
}

function terminalConfigPath() {
  return path.join(userDataDir(), "terminal-config.json");
}

function engineRoot() {
  return path.dirname(__dirname);
}

function packageRoot() {
  return path.dirname(engineRoot());
}

module.exports = { userDataDir, dbPath, terminalConfigPath, engineRoot, packageRoot };
