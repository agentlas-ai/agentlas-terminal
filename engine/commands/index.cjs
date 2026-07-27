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
  run: () => require("./run.cjs"),
  login: () => require("./login.cjs"),
  logout: () => require("./logout.cjs"),
  whoami: () => require("./whoami.cjs"),
  search: () => require("./search.cjs"),
  update: () => require("./update.cjs"),
  usage: () => require("./usage.cjs"),
  telegram: () => require("./telegram.cjs"),
  setup: () => require("./setup.cjs"),
  env: () => require("./env.cjs"),
  import: () => require("./import.cjs"),
  firm: () => require("./firm.cjs"),
  cd: () => require("./cd.cjs"),
  install: () => require("./install.cjs"),
  plugin: () => require("./plugin.cjs"),
  plugins: () => require("./plugin.cjs"),
  open: () => require("./open.cjs"),
  automation: () => require("./automation.cjs"),
  native: () => require("./native.cjs"),
  chat: () => require("./chat.cjs"),
  multimodal: () => require("./multimodal.cjs"),
  workforce: () => require("./workforce.cjs"),
  network: () => require("./workforce.cjs"),
  taskforce: () => require("./workforce.cjs"),
  oberon: () => require("./oberon.cjs"),
  film: () => require("./film.cjs"),
  experience: () => require("./experience.cjs"),
  memory: () => require("./memory.cjs"),
  evolve: () => require("./evolve.cjs"),
  variant: () => require("./variant.cjs"),
  hep: () => require("./hep.cjs"),
  build: () => require("./build.cjs"),
  connect: () => require("./connect.cjs"),
  call: () => require("./call.cjs"),
  browser: () => require("./browser.cjs"),
  route: () => require("./route.cjs"),
  research: () => require("./research.cjs"),
  netadmin: () => require("./netadmin.cjs"),
  journal: () => require("./journal.cjs"),
  "legacy-network": () => require("./legacy-network.cjs"),
  cloud: () => require("./cloud.cjs"),
  upload: () => require("./upload.cjs"),
  storm: () => require("./storm.cjs"),
  swarm: () => require("./swarm.cjs"),
  project: () => require("./project.cjs"),
  context: () => require("./context.cjs"),
  ontology: () => require("./ontology.cjs"),
  "career-graph": () => require("./career-graph.cjs"),
  creds: () => require("./creds.cjs"),
  billing: () => require("./billing.cjs"),
  uninstall: () => require("./uninstall.cjs"),
};

// v1에 존재했으나 아직 v2로 재구축되지 않은 명령 — 정직 정지 목록.
// 재구축이 끝나면 여기서 지우고 COMMANDS에 올린다.
const NOT_YET_PORTED = [
  
      
        ];

/*
 * 데스크탑 전용 표면 — 터미널에 같은 이름의 명령이 없다.
 * 이 이름들을 그냥 프롬프트로 흘리면 사용자가 "명령을 쳤는데" 에이전트가
 * 저장소를 뒤지고 토큰을 쓴다(실사용 테스트에서 실증). 정직하게 멈추고
 * 데스크탑/대체 경로를 안내한다.
 */
const DESKTOP_ONLY_SURFACES = {
  site: "Site studio (웹·모바일·Agent App 디자인) is Desktop-only.",
  sites: "Site studio (웹·모바일·Agent App 디자인) is Desktop-only.",
  trex: "T-rex slide studio is Desktop-only.",
  slides: "T-rex slide studio is Desktop-only.",
  prompts: "Prompt Store is Desktop-only.",
  dashboard: "Dashboard is Desktop-only — use: agentlas doctor · usage · list · chats",
  marketplace: "Marketplace browsing is Desktop-only — use: agentlas search \"<what you need>\"",
  library: "Library is Desktop-only — use: agentlas list · env · mcp",
  groups: "Agent groups (조합) are Desktop-only.",
  "agent-groups": "Agent groups (조합) are Desktop-only.",
  settings: "Settings UI is Desktop-only — use: agentlas setup · env · creds · multimodal · doctor",
  apps: "Apps surface is Desktop-only.",
  quests: "Quests are Desktop-only.",
  bookmarks: "Hub bookmarks are Desktop-only.",
  one: "Agentlas One is a separate Desktop/Mobile product surface.",
};

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

  if (DESKTOP_ONLY_SURFACES[cmd] && rest.length === 0) {
    ctx.err(`${DESKTOP_ONLY_SURFACES[cmd]}\nIt was not run as a prompt — rerun with quotes if you meant a task: agentlas "${cmd} …"`);
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

module.exports = { dispatch, COMMANDS, NOT_YET_PORTED, GUARDED_NO_ARG, DESKTOP_ONLY_SURFACES };
