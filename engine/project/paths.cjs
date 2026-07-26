"use strict";
/*
 * project/paths — 프로젝트 경계 판정용 경로 헬퍼 (v1 runCwd/projectCwd 포팅).
 *
 * workforce/capture.cjs에도 같은 규칙의 projectCwd가 있지만 기능 디렉터리 간
 * 수평 의존을 만들지 않기 위해 여기 별도 구현을 둔다. 규칙이 바뀌면 둘 다 함께
 * 바꿔야 한다 (v1 monolith 9961–9981 라인이 원본 계약).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

/** 에이전트 격리 실행용 전용 폴더 — "프로젝트 아님" 위치의 안전한 폴백. */
function runCwd() {
  const dir = path.join(userDataDir(), "agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

/**
 * 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리(= 대상 프로젝트).
 * 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 안전한 전용 폴더로 폴백한다.
 */
function projectCwd() {
  try {
    const cwd = process.cwd();
    if (!cwd || cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return runCwd();
    return cwd;
  } catch {
    return runCwd();
  }
}

module.exports = { runCwd, projectCwd };
