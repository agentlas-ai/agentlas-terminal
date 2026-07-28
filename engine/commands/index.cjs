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
  // 소스 스코프 스태핑 3종은 1급 명령이다 — 별칭으로 접으면 스코프가 사라진다.
  // (아래 COMMAND_ALIASES 주석의 2026-07-28 수리 참조.)
  "hep-network": () => require("./hep-network.cjs"),
  "hep-local": () => require("./hep-local.cjs"),
  "hep-cloud": () => require("./hep-cloud.cjs"),
  "hep-hub": () => require("./hep-hub.cjs"),
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

// 플랫폼 간 이름 통일(오너 결정 2026-07-27): 클로드코드/코덱스에서 부르는 hep-*
// 스킬명과 터미널 명령이 서로 다르면 사용자가 어느 표면에 있는지에 따라 이름을
// 바꿔 써야 한다. 같은 기능은 어디서든 같은 이름으로 부른다.
//
// 불변식(2026-07-28 수리): 별칭은 "같은 기능"에만 건다. 소스 스코프를 이름에
// 달고 있는 hep-local / hep-cloud / hep-hub 는 여기 넣으면 안 된다 — 별칭은
// 이름만 바꿔주고 스코프는 어디에도 전달되지 않기 때문이다. 실제로 그랬다:
//   hep-cloud → cloud      : 자산 보관함 명령. 과제 문자열을 서브커맨드로 읽어
//                            `usage: agentlas cloud <save|…>` + exit 1.
//   hep-local → workforce  : cmdWorkforce 는 스코프 플래그를 받지 않는다(전량
//                            공개 Hub 메뉴 스태핑). "로컬 전용"이 조용히 넓어짐.
//   hep-hub   → search     : 디렉터리 나열만 하고 아무것도 실행하지 않음.
// 세 명령은 스코프를 실제로 지키는 Hephaestus 네이티브 표면으로 가는 1급 명령
// (COMMANDS 의 hep-local/hep-cloud/hep-hub)으로 승격했다.
//
// 같은 이유로 hep-network 도 별칭에서 뺐다(2026-07-28). 이름은 "Local + owner
// Cloud + public Hub"인데 cmdWorkforce 는 스코프를 어디에도 싣지 않고
// agentlas.cloud/api/mcp/v1 을 직접 친다. 그 서버는 sourceScope 가 없으면 "hub"
// 로 기본값을 잡으므로(agentlas/.../lib/mcp/workforce.ts:228) 로컬·클라우드
// 에이전트는 후보에 들어간 적이 없는데 결과는 네트워크 전량을 본 것처럼 남았다.
// 연합은 Core 가 소유한다 — 네이티브 표면으로 넘긴다.
const COMMAND_ALIASES = {
  "hep-build": "build",
  "hep-call": "call",
  "hep-search": "search",
  "hep-upload": "upload",
  "hep-storm": "storm",
  "hep-browser": "browser",
  "hep-connect": "connect",
};

function resolveCommandName(cmd) {
  return COMMAND_ALIASES[cmd] || cmd;
}

function dispatch(ctx, argv) {
  const [rawCmd, ...rest] = argv;
  if (!rawCmd) return null; // 엔진이 REPL로 진입
  const cmd = resolveCommandName(rawCmd);

  if (COMMANDS[cmd]) {
    return COMMANDS[cmd]().run(ctx, rest);
  }

  if (GUARDED_NO_ARG.has(cmd) && rest.length === 0) {
    ctx.err(`Usage: agentlas ${cmd} <args…>`);
    return 1;
  }

  /*
   * 인자 유무와 무관하게 막는다. `rest.length === 0` 조건이 붙어 있던 동안은
   * 단어 하나만 더 붙이면(`agentlas settings theme`, `marketplace browse`)
   * 가드를 그냥 지나쳐 dispatch가 undefined를 반환했고, 엔진은 그걸 프롬프트로
   * 보고 실제 에이전트를 띄웠다 — 제품이 "데스크탑 전용"이라고 선언한 화면
   * 이름에 토큰이 청구되고 에이전트가 사용자 저장소에서 셸까지 돌렸다(실사용
   * 실증: settings theme → System Optimizer가 Bash 실행, marketplace browse →
   * 20883 토큰 소진). agentlas.cjs의 오타 가드는 `normalized.length === 1`
   * 이라 이 경로를 못 받는다. 여기가 유일한 차단 지점이므로 arity를 보지 않는다.
   * 진짜 작업이면 안내대로 따옴표로 묶어 하나의 프롬프트로 넘긴다.
   */
  if (DESKTOP_ONLY_SURFACES[cmd]) {
    const asTask = [rawCmd, ...rest].join(" ");
    ctx.err(`${DESKTOP_ONLY_SURFACES[cmd]}\nIt was not run as a prompt — rerun with quotes if you meant a task: agentlas "${asTask}"`);
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

module.exports = { dispatch, COMMANDS, COMMAND_ALIASES, resolveCommandName, NOT_YET_PORTED, GUARDED_NO_ARG, DESKTOP_ONLY_SURFACES };
