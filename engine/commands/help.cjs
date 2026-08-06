"use strict";
/* help / usage — v2 명령 표면. 재구축이 진행되며 이 표가 곧 진실이다. */

const HELP = `agentlas — the operating system for agents, in your terminal

  agentlas                 open the terminal (REPL)
  agentlas "<task>"        run once with this project's controller
  graph new "<what you want run for you>"   build an automation by talking it through

PROJECT WORK
  run [agent] [prompt]     project-first one-shot; exact agent is an explicit advanced override
  firm <firm> [task]       delegate to a CEO (--runtime · --model · --effort)

AGENTS & HUB
  search "<what you need>" discover agents in the Hub
  install <slug>           install an agent from the Hub
  plugin add <slug> · plugin list      Hub plugins (MCP servers)
  build "<request>"        build an installable agent locally (auto-installs)
  upload <path>            save owner-private in Agent Cloud (--visibility marketplace to publish)
  import <path> · cd · native prepare  local folder agents
  list                     installed agents/companies + orchestrator/worker runtimes
  roles [set <role> <rt>]  show or set orchestrator/worker model roles
  experience <sub>         portable Experience: list|inspect|validate|save|publish|status|export|unpublish
  variant resolve --base-release <id>   local variant selection (variant help)

EXECUTE
  storm <goal>             Goal+UltraCode harness: plan → allocate → execute → verify  [--research]
  swarm <goal>             emergent agent swarm  [--parallel N]
  workforce | network <request>   Agent Workforce Ontology route (public Hub menu)
  hep-network "<request>"  staff across Local + owner Cloud + public Hub (local Core federation)
  hep-local | hep-cloud | hep-hub "<request>"   same, restricted to one source scope
  call "a,b" "<ctx>" · browser <url|status|sites|login> · route "<req>" [--json] · research <sub>

KNOWLEDGE
  memory import · evolve   memory & prompt-evolution proposals
  ontology · career-graph  project knowledge & source routing
  journal <sub>            Stormbreaker run journal
  project <sub>            connect this folder + set an ordered team, standalone
                           (status · init · use <agent> · team <agent>…)
  context <sub>            dependency map: refresh|locate|refs|slice|impact|verify

ACCOUNT & OPS
  login | logout | whoami  Agentlas Cloud sign-in (browser flow)
  cloud <sub>              cloud assets: save|publish|package|list|restore|field-test
  automation <sub>         list|add|on|off|remove|run <id>|runs|daemon
  graph <sub>              new "<what you want>"|list|show|run <name>|export|inspect|install
  creds <sub> · env        credentials and shared env keys
  usage · telegram · mcp   local usage · telegram bindings · MCP servers (mcp probe <id>)
  multimodal               image/video/audio provider settings
  doctor · setup · update  health check · first-run wizard · npm update check
  oberon | film <sub>      AI film render (scaffold|render|list|open)
  hep <sub…> · netadmin    Hephaestus passthrough · local agent network
  version · help

IN-REPL (agentlas → interactive, Orca multi-session)
  /sessions · /tree · /s <n> | /switch <n> · /kill <n> · /rm <n>
  /runtime <kind> · /model <id> · /effort <level> · /permission <level>   (applies to new sessions)
  every command above also works as a slash command (/graph, /search, /automation, …) — /help lists them all
  typing during a running turn queues steering; ctrl-c interrupts the turn

Options: -p|--print · --runtime claude-code|codex|gemini · --model <exact-id> ·
         --effort none|minimal|low|medium|high|xhigh|max ·
         --tier economy|balanced|frontier (requires --model) ·
         --permission read|write|full
`;

/*
 * 한국어판 — 2026-08-05 감사 결함 F: ko 세션에서 /help 본문이 전부 영어였다.
 * 명령 이름·플래그는 원문(입력 어휘) 유지, 설명만 국문. HELP(영문)와 줄 구조를
 * 맞춰 둔다 — runForCommand는 두 판 모두에서 같은 규칙으로 행을 찾는다.
 */
const HELP_KO = `agentlas — 터미널 속 에이전트 운영체제

  agentlas                 터미널(REPL) 열기
  agentlas "<작업>"        이 프로젝트의 컨트롤러로 1회 실행
  graph new "<대신 시킬 일>"   대화로 설명하면 자동화를 만들어 줍니다

PROJECT WORK
  run [agent] [prompt]     프로젝트 우선 1회 실행; 특정 에이전트 지정은 명시적 고급 경로
  firm <firm> [task]       회사 CEO에게 위임 (--runtime · --model · --effort)

AGENTS & HUB
  search "<필요한 것>"     Hub에서 에이전트 찾기
  install <slug>           Hub 에이전트 설치
  plugin add <slug> · plugin list      Hub 플러그인 (MCP 서버)
  build "<요청>"           에이전트를 로컬에서 만들고 바로 설치
  upload <path>            Agent Cloud에 소유자 비공개 저장 (--visibility marketplace 로 발행)
  import <path> · cd · native prepare  로컬 폴더 에이전트
  list                     설치 에이전트/회사 + 오케스트레이터·워커 런타임
  roles [set <role> <rt>]  오케스트레이터·워커 모델 역할 조회/설정
  experience <sub>         이동식 Experience: list|inspect|validate|save|publish|status|export|unpublish
  variant resolve --base-release <id>   로컬 변형 선택 (variant help)

EXECUTE
  storm <goal>             Goal+UltraCode 하니스: 계획 → 배정 → 실행 → 검증  [--research]
  swarm <goal>             창발형 에이전트 스웜  [--parallel N]
  workforce | network <request>   Agent Workforce Ontology 편성 (공개 Hub 메뉴)
  hep-network "<request>"  로컬+오너 클라우드+공개 Hub 연합 편성 (로컬 Core 연합)
  hep-local | hep-cloud | hep-hub "<request>"   같은 편성, 한 소스 스코프로 제한
  call "a,b" "<ctx>" · browser <url|status|sites|login> · route "<req>" [--json] · research <sub>

KNOWLEDGE
  memory import · evolve   메모리·프롬프트 진화 제안
  ontology · career-graph  프로젝트 지식·소스 라우팅
  journal <sub>            Stormbreaker 런 저널
  project <sub>            이 폴더를 프로젝트로 연결 + 순서 팀 편성 (독립)
                           (status · init · use <에이전트> · team <에이전트>…)
  context <sub>            의존성 지도: refresh|locate|refs|slice|impact|verify

ACCOUNT & OPS
  login | logout | whoami  Agentlas Cloud 로그인 (브라우저 플로)
  cloud <sub>              클라우드 자산: save|publish|package|list|restore|field-test
  automation <sub>         list|add|on|off|remove|run <id>|runs|daemon
  graph <sub>              new "<시킬 일>"|list|show|run <이름>|export|inspect|install
  creds <sub> · env        자격증명·공유 env 키 (creds list 로 확인)
  usage · telegram · mcp   로컬 사용량 · 텔레그램 연결 · MCP 서버 (mcp probe <id>)
  multimodal               이미지/영상/음성 제공자 설정
  doctor · setup · update  건강 점검 · 첫 실행 마법사 · npm 업데이트 확인
  oberon | film <sub>      AI 필름 렌더 (scaffold|render|list|open)
  hep <sub…> · netadmin    Hephaestus 패스스루 · 로컬 에이전트 네트워크
  version · help

IN-REPL (agentlas → 대화형, Orca 다중 세션)
  /sessions · /tree · /s <n> | /switch <n> · /kill <n> · /rm <n>
  /runtime <kind> · /model <id> · /effort <level> · /permission <level>   (새 세션부터 적용)
  위의 모든 명령은 슬래시 명령(/graph, /search, /automation, …)으로도 됩니다 — 전체 목록은 /help
  실행 중 입력하면 조종 큐에 쌓이고, ctrl-c 로 턴을 중단합니다

Options: -p|--print · --runtime claude-code|codex|gemini · --model <exact-id> ·
         --effort none|minimal|low|medium|high|xhigh|max ·
         --tier economy|balanced|frontier (--model 필요) ·
         --permission read|write|full
`;

function helpText(ctx) {
  return ctx && ctx.lang === "ko" ? HELP_KO : HELP;
}

function run(ctx) {
  ctx.out(helpText(ctx).trimEnd());
  return 0;
}

function runForCommand(ctx, command) {
  const name = String(command || "").trim();
  const rows = helpText(ctx).split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(":"))
    .filter((line) => {
      const commandColumn = line.split(/\s{2,}/, 1)[0];
      return commandColumn
        .split(/\s*·\s*|\s*\|\s*/)
        .some((entry) => entry === name || entry.startsWith(`${name} `));
    });
  ctx.out(`Usage: agentlas ${name} [options]`);
  if (rows.length > 0) {
    for (const row of rows) ctx.out(`  ${row}`);
  } else {
    ctx.out(`  See "agentlas help" for the full command list.`);
  }
  return 0;
}

module.exports = { run, runForCommand, HELP, HELP_KO };
