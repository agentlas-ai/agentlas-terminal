"use strict";
/*
 * project/paths — 프로젝트 경계 판정용 경로 헬퍼 (v1 runCwd/projectCwd 포팅).
 *
 * 이 파일이 Terminal 전체의 단일 정본이다. Workforce와 Hephaestus가 각자 복제하면
 * 폴백 보안 경계가 갈리므로 둘 다 여기의 함수를 그대로 export한다.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

let temporaryRunCwd = null;

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("agent run folder is not a private directory");
  }
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw new Error("agent run folder permissions could not be restricted");
    }
  }
  return fs.realpathSync.native(directory);
}

/** 에이전트 격리 실행용 전용 폴더 — "프로젝트 아님" 위치의 안전한 폴백. */
function runCwd() {
  const dir = path.join(userDataDir(), "agent-cwd");
  try {
    return ensurePrivateDirectory(dir);
  } catch (primaryError) {
    try {
      if (!temporaryRunCwd) {
        temporaryRunCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-agent-cwd-"));
      }
      return ensurePrivateDirectory(temporaryRunCwd);
    } catch (fallbackError) {
      const error = new Error(
        "Agentlas could not create a private agent working directory; refusing to use the home folder.",
      );
      error.code = "AGENTLAS_RUN_CWD_UNAVAILABLE";
      error.cause = fallbackError || primaryError;
      throw error;
    }
  }
}

/**
 * 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리(= 대상 프로젝트).
 * 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 안전한 전용 폴더로 폴백한다.
 */
function projectCwd() {
  try {
    const cwd = process.cwd();
    const neutral = runCwd();
    const canonical = cwd ? fs.realpathSync.native(cwd) : "";
    const home = fs.realpathSync.native(os.homedir());
    let data = path.resolve(userDataDir());
    try { data = fs.realpathSync.native(userDataDir()); } catch { /* compare the unresolved configured path */ }
    if (!canonical || canonical === home || canonical === data || canonical === neutral || path.parse(canonical).root === canonical) {
      return neutral;
    }
    return cwd;
  } catch {
    return runCwd();
  }
}

module.exports = { runCwd, projectCwd };
