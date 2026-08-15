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
  // 정본 이름은 agents. list 는 별칭으로 영구 호출 가능(스크립트·게이트 사용).
  agents: () => require("./list.cjs"),
  version: () => require("./version.cjs"),
  graph: () => require("./graph.cjs"),
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
  automation: () => require("./automation.cjs"),
  native: () => require("./native.cjs"),
  // Agentlas as an ACP agent for editors (Zed, JetBrains, …) — PRD 2026-08-15 B-3.
  acp: () => require("./acp.cjs"),
  multimodal: () => require("./multimodal.cjs"),
  document: () => require("./document.cjs"),
  workforce: () => require("./workforce.cjs"),
  // 소스 스코프 편성 4종 — 2026-08-05 네이티브 배선(경위는 workforce.cjs 참조).
  // 별칭이 아니라 1급인 이유는 여전하다: 별칭은 스코프를 전달하지 못한다.
  "hep-network": () => require("./hep-network.cjs"),
  "hep-local": () => require("./hep-local.cjs"),
  "hep-cloud": () => require("./hep-cloud.cjs"),
  "hep-hub": () => require("./hep-hub.cjs"),
  oberon: () => require("./oberon.cjs"),
  experience: () => require("./experience.cjs"),
  memory: () => require("./memory.cjs"),
  evolve: () => require("./evolve.cjs"),
  variant: () => require("./variant.cjs"),
  roles: () => require("./roles.cjs"),
  hep: () => require("./hep.cjs"),
  build: () => require("./build.cjs"),
  connect: () => require("./connect.cjs"),
  call: () => require("./call.cjs"),
  browser: () => require("./browser.cjs"),
  route: () => require("./route.cjs"),
  research: () => require("./research.cjs"),
  netadmin: () => require("./netadmin.cjs"),
  cloud: () => require("./cloud.cjs"),
  upload: () => require("./upload.cjs"),
  storm: () => require("./storm.cjs"),
  swarm: () => require("./swarm.cjs"),
  project: () => require("./project.cjs"),
  context: () => require("./context.cjs"),
  ontology: () => require("./ontology.cjs"),
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
  dashboard: "Dashboard: run `AGENTLAS_TUI=1 agentlas` then /dashboard — or: agentlas doctor · usage · list",
  marketplace: "Hub view: run `AGENTLAS_TUI=1 agentlas` then /marketplace — or: agentlas search \"<what you need>\"",
  library: "Library: run `AGENTLAS_TUI=1 agentlas` then /library — or: agentlas list · env · mcp",
  settings: "Settings: run `AGENTLAS_TUI=1 agentlas` then /settings — change with: agentlas setup · env · creds · multimodal",
  apps: "Apps surface is Desktop-only.",
  quests: "Quests are Desktop-only.",
  bookmarks: "Hub bookmarks: run `AGENTLAS_TUI=1 agentlas` then /marketplace.",
  one: "Agentlas One is a separate Desktop/Mobile product surface.",
};

/*
 * (2026-08-05 이력) hep-* 편성 이름들은 하루 동안 세 상태를 지났다:
 *   ① 외부 CLI 스텁에 배선돼 exit 3 JSON만 뱉는 죽은 메뉴 → 삭제
 *   ② 삭제 직후 "알 수 없는 토큰"이 되어 프롬프트로 낙하, 에이전트가 실제 기동
 *      (상위 오타 가드는 한 단어 전용) → HOST_LLM_ONLY_SURFACES fail-closed 가드
 *   ③ 같은 날 재조사에서 편성 세 조각(4,578줄 루프·로컬 Core MCP·D.callHubTool
 *      주입 지점)이 전부 이 머신에 있음이 확인됨 → 네이티브 배선으로 복원,
 *      가드 폐기. 전선 계약 실측과 배선은 workforce.cjs·local-core-transport.cjs.
 * 남는 교훈: 이름을 지울 때는 반드시 낙하 경로까지 막고, "계층이 없다"는 판정은
 * rg 로 확인한 뒤에 한다.
 */

// 무인자 호출이 프롬프트로 오라우팅되면 안 되는 명령 (smoke 가드 대상)
const GUARDED_NO_ARG = new Set(["search", "install", "upload"]);

// 플랫폼 간 이름 통일(오너 결정 2026-07-27): 클로드코드/코덱스에서 부르는 hep-*
// 스킬명과 터미널 명령이 서로 다르면 사용자가 어느 표면에 있는지에 따라 이름을
// 바꿔 써야 한다. 같은 기능은 어디서든 같은 이름으로 부른다.
//
// 불변식: 별칭은 "같은 기능"에만 건다. 이름이 소스 스코프를 약속하는데 별칭이
// 스코프를 버리면 제품이 거짓말을 한다 — 2026-07-28 에 실제로 그랬다
// (hep-cloud→cloud 자산 보관함, hep-local→workforce 전량 Hub, hep-hub→search).
// hep-network/hep-local/hep-cloud/hep-hub 는 그래서 여기 없다 — 스코프를 실제로
// 관통시키는 1급 명령(COMMANDS)이다. 경위(스텁→삭제→네이티브 배선)는 위
// 2026-08-05 이력 주석 참조.
const COMMAND_ALIASES = {
  // legacy-network는 역사적으로 hep-network를 뜻했다(v1 호환 탈출구). 이제
  // hep-network가 네이티브이므로 같은 기능 별칭이 성립한다 — 스코프도 동일(network).
  "legacy-network": "hep-network",
  "hep-build": "build",
  "hep-call": "call",
  "hep-search": "search",
  "hep-upload": "upload",
  "hep-storm": "storm",
  "hep-browser": "browser",
  "hep-connect": "connect",
  // 2026-08-11: 같은 기능을 두 이름으로 광고하던 것을 별칭으로 접었다.
  list: "agents",
  network: "workforce",
  taskforce: "workforce",
  film: "oberon",
};

/*
 * 제거된 명령 — 이름을 그냥 없애면 인자와 함께 프롬프트로 새어 유료 턴이 된다
 * (아래 marketplace 사고 주석과 같은 계열). 착지 안내를 두고 arity 무관하게 잡는다.
 */
const REMOVED_COMMANDS = {
  journal: {
    en: "`journal` was removed — it reported \"ok\" for runs that do not exist and read the wrong folder.\nExperts: agentlas hep stormbreaker journal --run-id <id> --journal <path>",
    ko: "`journal` 은 제거됐습니다 — 없는 실행에도 \"ok\" 를 답했고 다른 폴더를 봤습니다.\n전문가용: agentlas hep stormbreaker journal --run-id <id> --journal <path>",
  },
  "career-graph": {
    en: "`career-graph` was removed — its read commands silently created project state.\nSources: agentlas ontology   ·   Index: hephaestus career-graph ingest --project .",
    ko: "`career-graph` 는 제거됐습니다 — 조회 명령이 말없이 프로젝트 상태를 만들었습니다.\n소스: agentlas ontology   ·   색인: hephaestus career-graph ingest --project .",
  },
  plugins: {
    en: "Use: agentlas plugin list",
    ko: "이렇게 쓰세요: agentlas plugin list",
  },
};

function resolveCommandName(cmd) {
  return COMMAND_ALIASES[cmd] || cmd;
}

/**
 * 자기 도움말을 직접 가진 명령들 — `<명령> --help` 는 이들에게 그대로 넘어간다.
 *
 * ★배경(실사용 실측 2026-08-06): 라우터가 `--help`를 가로채 도움말 표에서 한 줄을
 *   긁어 보여줘서, `agentlas graph --help` 는 "Usage: agentlas graph [options]" 두 줄이
 *   전부였다. 정작 `graph help` 에는 하위 명령 8개를 설명하는 제대로 된 안내가 있는데
 *   **사용자가 가장 먼저 치는 철자(`--help`)로는 영원히 닿지 못했다.**
 *
 * 목록으로 두는 이유: 모든 명령에 "help"를 넘기면, 자기 도움말이 없는 명령은 그것을
 * 인자로 읽는다(`agentlas run --help` 가 "help"라는 이름을 찾는 식). 추측하지 않는다.
 * `test/command-help-contract.cjs` 가 이 목록과 실제 분기를 대조한다.
 */
const SELF_HELP_COMMANDS = new Set(["graph", "plugin", "billing", "roles", "native"]);

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
  // (2026-08-05) HOST_LLM_ONLY_SURFACES 가드가 여기 있었다 — hep-* 네이티브
  // 배선으로 표가 비면서 분기도 제거했다. 등록 명령을 지울 일이 다시 생기면
  // 낙하 가드부터 만들 것: 상위 오타 가드는 한 단어 전용이라 인자가 붙은
  // 삭제 이름은 프롬프트로 흘러 에이전트를 기동한다(실측·토큰 소모).

  if (REMOVED_COMMANDS[cmd]) {
    ctx.err(REMOVED_COMMANDS[cmd][ctx.lang === "ko" ? "ko" : "en"]);
    return 1;
  }
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

module.exports = { dispatch, COMMANDS, COMMAND_ALIASES, resolveCommandName, SELF_HELP_COMMANDS, NOT_YET_PORTED, GUARDED_NO_ARG, DESKTOP_ONLY_SURFACES, REMOVED_COMMANDS };
