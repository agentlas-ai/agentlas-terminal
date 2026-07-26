"use strict";
/*
 * commands/index — 명령 디스패치 테이블.
 * 규칙:
 *  - 명령 하나 = 파일 하나. 명령 파일은 기능 모듈만 import한다(명령끼리 참조 금지).
 *  - 아직 v2로 포팅되지 않은 명령은 "정직 정지": 안내 + exit 1. 가짜 성공 금지.
 *  - 무인자 search/install/upload는 usage + exit 1 (프롬프트 오라우팅 방지 가드).
 */
const path = require("node:path");

// 각 명령 파일은 { run(ctx, args) } 를 export한다. ctx는 엔진이 만든 얕은 DI 객체.
const COMMANDS = {
  version: () => require("./version.cjs"),
  list: () => require("./list.cjs"),
  chats: () => require("./chats.cjs"),
  doctor: () => require("./doctor.cjs"),
  mcp: () => require("./mcp.cjs"),
  help: () => require("./help.cjs"),
  usage: () => require("./help.cjs"),
};

// v1에 존재했으나 아직 v2로 재구축되지 않은 명령 — 정직 정지 목록.
// 재구축이 끝나면 여기서 지우고 COMMANDS에 올린다.
const NOT_YET_PORTED = [
  "run", "chat", "open", "firm", "import", "cd", "native",
  "search", "install", "plugin", "build", "upload", "connect",
  "storm", "swarm", "network", "workforce", "taskforce", "legacy-network",
  "call", "browser", "route", "research", "netadmin", "journal",
  "login", "logout", "whoami", "automation", "creds", "env", "memory",
  "evolve", "multimodal", "oberon", "film", "ontology", "career-graph",
  "cloud", "experience", "variant", "telegram", "setup", "project",
  "context", "update", "hep",
];

// 무인자 호출이 프롬프트로 오라우팅되면 안 되는 명령 (smoke 가드 대상)
const GUARDED_NO_ARG = new Set(["search", "install", "upload"]);

function dispatch(ctx, argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) return null; // 엔진이 REPL로 진입

  if (COMMANDS[cmd]) {
    return COMMANDS[cmd]().run(ctx, rest);
  }

  if (GUARDED_NO_ARG.has(cmd) && rest.length === 0) {
    ctx.err(`Usage: agentlas ${cmd} <args…>`);
    return 1;
  }

  if (NOT_YET_PORTED.includes(cmd)) {
    ctx.err(
      `'${cmd}' is not wired into the v2 engine yet.\n` +
      `The terminal is being rebuilt from the frame up; this command returns as its module lands.\n` +
      `Last full v1 build: git tag legacy-v1-engine-snapshot (agentlas v0.9.10 on npm).`,
    );
    return 1;
  }

  return undefined; // 알 수 없는 토큰 — 엔진이 에이전트 이름/프롬프트로 해석 시도
}

module.exports = { dispatch, COMMANDS, NOT_YET_PORTED, GUARDED_NO_ARG };
