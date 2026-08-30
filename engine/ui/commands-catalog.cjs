"use strict";
/*
 * ui/commands-catalog — 명령 정본 한 벌 (2026-08-11 전면 재작성).
 *
 * 배경: 같은 목록이 네 곳에 손으로 유지되고 있었다 — palette.SLASH_COMMANDS(71행),
 * help.HELP(EN 61줄), help.HELP_KO(133줄), shell.toSlashCommands(파생). 넷이 서로
 * 어긋난 것이 결함 대부분의 기계적 원인이었다:
 *   · 영문 화면에 한글 인자 힌트(`/graph [run <이름>]`)
 *   · 같은 기능이 서로 다른 설명으로 두 줄(`search "<what you need>"` vs `"<필요한 것>"`)
 *   · renderPalette 가 설명 텍스트로 중복 제거 → `/switch` `/list` `/exit` 가 조용히 사라짐
 *   · /help 가 표면마다 61 / 133 / 67줄
 *
 * 그래서 정본을 하나로 합치고, 별칭은 **행이 아니라 필드**로 둔다. 별칭이 행이 아니면
 * 중복 설명 자체가 생기지 않으므로 위 dedup 이 필요 없어지고, 숨김 사고가 구조적으로 막힌다.
 *
 * 불변식(게이트 test/command-surface-contract.cjs 가 잠근다):
 *  - COMMANDS 키 ↔ 카탈로그 행 1:1. 예외는 surfaces:["repl"] (셸 switch 가 직접 처리).
 *  - args 는 ASCII 정본. 한국어는 argsKo 로만 — 언어 혼재 금지.
 *  - tier "core" 만 기본 /help 에 나온다. 나머지는 /help all. 단 Tab 완성은 전부 된다
 *    (완성에서 숨기는 것이 바로 `/switch` 결함이었다).
 */

const { visWidth } = require("./width.cjs");

const GROUPS = [
  { key: "start", ko: "시작", en: "Start here" },
  { key: "work", ko: "일 시키기", en: "Do work" },
  { key: "agents", ko: "에이전트", en: "Agents" },
  { key: "automate", ko: "자동화", en: "Automate" },
  { key: "session", ko: "세션 (셸 안에서만)", en: "Sessions (in-shell only)" },
  { key: "settings", ko: "설정 (셸 안에서만)", en: "Settings (in-shell only)" },
  { key: "account", ko: "계정·자산", en: "Account & assets" },
  { key: "knowledge", ko: "프로젝트 지식", en: "Project knowledge" },
  { key: "advanced", ko: "고급", en: "Advanced" },
];

const CLI = ["cli"];
const BOTH = ["cli", "repl"];
const REPL = ["repl"];

/* eslint-disable max-len */
const CATALOG = [
  // ── 1 start ───────────────────────────────────────────────────────────────
  { name: "setup", group: "start", tier: "core", surfaces: CLI, args: "", ko: "첫 실행 마법사 — 언어·런타임·권한", en: "First-run wizard — language, runtime, permission" },
  { name: "doctor", group: "start", tier: "core", surfaces: BOTH, args: "[--json]", ko: "설치 상태 점검", en: "Check this installation" },
  { name: "login", group: "start", tier: "core", surfaces: BOTH, args: "[--force]", ko: "Agentlas 로그인 (--force 로 계정 전환)", en: "Sign in to Agentlas (--force switches account)" },
  { name: "help", group: "start", tier: "core", surfaces: BOTH, args: "[all|<command>]", argsKo: "[all|<명령>]", ko: "명령 보기 (all = 전체 목록)", en: "Show commands (all = the full list)" },

  // ── 2 work ────────────────────────────────────────────────────────────────
  { name: "one", group: "work", tier: "core", surfaces: CLI, args: '["<prompt>"] [--list|--new]', argsKo: '["<프롬프트>"] [--list|--new]', ko: "개인 에이전트 One — 같은 One 대화를 이어감", en: "Your personal agent One — continues the same One conversation" },
  { name: "run", group: "work", tier: "core", surfaces: CLI, args: '[agent] "<task>"', argsKo: '[에이전트] "<작업>"', ko: "이 프로젝트 컨트롤러로 1회 실행", en: "Run once with this project's controller" },
  { name: "project", group: "work", tier: "core", surfaces: BOTH, args: "[status|use <agent>]", argsKo: "[status|use <에이전트>]", ko: "이 폴더를 프로젝트로 연결", en: "Connect this folder to a project" },
  { name: "storm", group: "work", tier: "core", surfaces: BOTH, args: '"<goal>"', argsKo: '"<목표>"', ko: "목표 하나를 계획→실행→검증까지", en: "Drive one goal: plan, execute, verify" },
  { name: "workforce", group: "work", tier: "core", surfaces: BOTH, aliases: ["network", "taskforce"], args: '"<request>"', argsKo: '"<요청>"', ko: "여러 에이전트를 편성해 실행 (공개 Hub)", en: "Staff several agents and run (public Hub)" },
  { name: "call", group: "work", tier: "core", surfaces: BOTH, aliases: ["hep-call"], args: '"a,b" "<context>"', argsKo: '"a,b" "<맥락>"', ko: "이름을 아는 에이전트를 직접 호출", en: "Call agents you name" },

  // ── 3 agents ──────────────────────────────────────────────────────────────
  { name: "agents", group: "agents", tier: "core", surfaces: BOTH, aliases: ["list"], args: "[--json]", ko: "설치된 에이전트·팀", en: "Installed agents and teams" },
  { name: "search", group: "agents", tier: "core", surfaces: BOTH, aliases: ["hep-search"], args: '"<what you need>"', argsKo: '"<필요한 것>"', ko: "Hub에서 에이전트 찾기", en: "Find agents in the Hub" },
  { name: "install", group: "agents", tier: "core", surfaces: BOTH, args: "<slug>", ko: "Hub 에이전트 설치", en: "Install an agent from the Hub" },
  { name: "build", group: "agents", tier: "core", surfaces: BOTH, aliases: ["hep-build"], args: '"<the agent you want>"', argsKo: '"<원하는 에이전트>"', ko: "에이전트를 여기서 만들어 바로 설치 (쓰기 권한)", en: "Build an agent here and install it (runs with write permission)" },
  { name: "roles", group: "agents", tier: "core", surfaces: BOTH, args: "[set <role> <runtime>]", argsKo: "[set <역할> <런타임>]", ko: "오케스트레이터·워커 모델 지정", en: "Set the orchestrator and worker models" },

  // ── 4 automate ────────────────────────────────────────────────────────────
  { name: "automation", group: "automate", tier: "core", surfaces: BOTH, args: "[list|add|on|off|run]", ko: "예약 실행", en: "Scheduled runs" },
  { name: "graph", group: "automate", tier: "core", surfaces: BOTH, args: "[list|show|run <name>]", argsKo: "[list|show|run <이름>]", ko: "저장된 자동화 그래프", en: "Saved automation graphs" },

  // ── 5 session (셸 전용) ───────────────────────────────────────────────────
  { name: "sessions", group: "session", tier: "core", surfaces: REPL, aliases: ["tree"], args: "", ko: "지금 도는 세션 목록", en: "Sessions running now" },
  { name: "s", group: "session", tier: "core", surfaces: REPL, aliases: ["switch"], args: "<n>", ko: "그 세션으로 전환", en: "Switch to that session" },
  { name: "kill", group: "session", tier: "core", surfaces: REPL, args: "<n>", ko: "그 세션의 턴 중단", en: "Interrupt that session's turn" },
  { name: "rm", group: "session", tier: "core", surfaces: REPL, args: "<n>", ko: "그 세션 닫기", en: "Close that session" },
  { name: "quit", group: "session", tier: "core", surfaces: REPL, aliases: ["exit"], args: "", ko: "종료", en: "Quit" },

  // ── 6 settings (셸 전용 · 전부 세션 한정, 영구 경로를 설명에 못박는다) ────
  { name: "permission", group: "settings", tier: "core", surfaces: REPL, args: "read|write|full", ko: "이 셸의 새 세션 권한 (영구: agentlas setup)", en: "Permission for new sessions here (persist: agentlas setup)" },
  { name: "model", group: "settings", tier: "core", surfaces: REPL, args: "<id|default>", ko: "이 셸의 새 세션 모델 (영구: agentlas roles set)", en: "Model for new sessions here (persist: agentlas roles set)" },
  { name: "runtime", group: "settings", tier: "core", surfaces: REPL, args: "<kind>", ko: "이 셸의 새 세션 런타임 (영구: agentlas roles set)", en: "Runtime for new sessions here (persist: agentlas roles set)" },
  { name: "effort", group: "settings", tier: "core", surfaces: REPL, args: "<level>", ko: "이 셸의 새 세션 추론 강도 (영구: agentlas roles set --effort)", en: "Reasoning effort for new sessions here (persist: agentlas roles set --effort)" },
  { name: "shell", group: "settings", tier: "core", surfaces: REPL, args: "on|off", ko: "새 대화형 셸 켜기/끄기", en: "Turn the new interactive shell on or off" },

  // ── 7 account ─────────────────────────────────────────────────────────────
  { name: "whoami", group: "account", tier: "more", surfaces: BOTH, args: "", ko: "로그인 계정 확인", en: "Show the signed-in account" },
  { name: "logout", group: "account", tier: "more", surfaces: BOTH, args: "", ko: "로그아웃", en: "Sign out" },
  { name: "billing", group: "account", tier: "more", surfaces: BOTH, args: "", ko: "크레딧 잔액 (구독·대여 수익)", en: "Credit balances (subscription and rental earnings)" },
  { name: "usage", group: "account", tier: "more", surfaces: BOTH, args: "", ko: "이 설치의 사용 현황", en: "Local usage on this install" },
  { name: "cloud", group: "account", tier: "more", surfaces: BOTH, args: "<save|publish|list|...>", ko: "Agent Cloud 자산", en: "Agent Cloud assets" },
  { name: "upload", group: "account", tier: "more", surfaces: BOTH, aliases: ["hep-upload"], args: "<path> [--visibility ...]", argsKo: "<경로> [--visibility ...]", ko: "기본은 비공개 저장, --visibility marketplace 로 공개 발행", en: "Owner-private by default; --visibility marketplace publishes" },
  { name: "uninstall", group: "account", tier: "more", surfaces: BOTH, args: "<slug> [--yes]", ko: "에이전트 삭제 (대화 기록도 함께 지워짐)", en: "Delete an agent (its chats are deleted too)" },
  { name: "update", group: "account", tier: "more", surfaces: BOTH, args: "[--json]", ko: "npm 업데이트 확인", en: "Check for an npm update" },
  { name: "version", group: "account", tier: "more", surfaces: BOTH, args: "", ko: "버전", en: "Version" },

  // ── 8 knowledge ───────────────────────────────────────────────────────────
  { name: "ontology", group: "knowledge", tier: "more", surfaces: BOTH, args: "[status|list|add <path>]", argsKo: "[status|list|add <경로>]", ko: "이 프로젝트가 읽을 지식 소스 등록", en: "Register the knowledge sources this project may read" },
  { name: "context", group: "knowledge", tier: "more", surfaces: BOTH, args: "<locate|slice|impact|...>", ko: "코드 의존성 맵 (Agentlas OS Core 필요)", en: "Code dependency map (requires Agentlas OS Core)" },
  { name: "memory", group: "knowledge", tier: "more", surfaces: BOTH, args: "<sub>", ko: "메모리", en: "Memory" },
  { name: "experience", group: "knowledge", tier: "more", surfaces: BOTH, args: "<list|inspect|save|...>", ko: "이식 가능한 Experience", en: "Portable Experience" },
  { name: "evolve", group: "knowledge", tier: "more", surfaces: BOTH, args: "", ko: "프롬프트 진화 제안", en: "Prompt-evolution proposals" },

  // ── 9 advanced ────────────────────────────────────────────────────────────
  { name: "route", group: "advanced", tier: "more", surfaces: BOTH, args: '"<request>"', argsKo: '"<요청>"', ko: "이 요청에 맞는 에이전트로 라우팅", en: "Route this request to the right agent" },
  { name: "swarm", group: "advanced", tier: "more", surfaces: BOTH, args: '"<goal>" [--parallel N]', argsKo: '"<목표>" [--parallel N]', ko: "창발형 에이전트 스웜", en: "Emergent agent swarm" },
  { name: "hep-network", group: "advanced", tier: "more", surfaces: BOTH, aliases: ["legacy-network"], args: '"<request>"', argsKo: '"<요청>"', ko: "로컬+오너 클라우드+공개 Hub 연합 편성 (로컬 Core 필요)", en: "Staff across Local + owner Cloud + public Hub (needs local Core)" },
  { name: "hep-local", group: "advanced", tier: "more", surfaces: BOTH, args: '"<request>"', argsKo: '"<요청>"', ko: "등록된 로컬 에이전트만으로 편성 (로컬 Core 필요)", en: "Staff from registered Local agents only (needs local Core)" },
  { name: "hep-cloud", group: "advanced", tier: "more", surfaces: BOTH, args: '"<request>"', argsKo: '"<요청>"', ko: "오너 Agent Cloud만으로 편성 (로그인·로컬 Core 필요)", en: "Staff from owner Agent Cloud only (needs sign-in + local Core)" },
  { name: "hep-hub", group: "advanced", tier: "more", surfaces: BOTH, args: '"<request>"', argsKo: '"<요청>"', ko: "공개 Hub 에이전트만으로 편성 (로컬 Core 필요)", en: "Staff from public Hub agents only (needs local Core)" },
  { name: "firm", group: "advanced", tier: "more", surfaces: CLI, args: "<firm> [task]", argsKo: "<회사> [작업]", ko: "회사 CEO에게 위임", en: "Delegate to a company CEO" },
  { name: "import", group: "advanced", tier: "more", surfaces: BOTH, args: "<path>", argsKo: "<경로>", ko: "로컬 폴더 에이전트 가져오기", en: "Import a local folder agent" },
  { name: "cd", group: "advanced", tier: "more", surfaces: BOTH, args: "<agent>", argsKo: "<에이전트>", ko: "그 에이전트의 폴더 경로를 출력", en: "Print that agent's folder path" },
  { name: "native", group: "advanced", tier: "more", surfaces: BOTH, args: "prepare <agent>", argsKo: "prepare <에이전트>", ko: "네이티브 CLI 컨텍스트 생성", en: "Prepare native CLI context" },
  // CLI only: stdout is the protocol wire, so it cannot run inside the REPL.
  { name: "acp", group: "advanced", tier: "more", surfaces: CLI, args: "[--info]", ko: "에디터(Zed·JetBrains)용 ACP 에이전트로 실행", en: "Serve Agentlas as an ACP agent for editors (Zed, JetBrains)" },
  { name: "mcp", group: "advanced", tier: "more", surfaces: BOTH, args: "[list|probe <id>]", ko: "MCP 서버", en: "MCP servers" },
  { name: "plugin", group: "advanced", tier: "more", surfaces: BOTH, args: "<add <slug>|list|remove>", ko: "Hub 플러그인 (MCP 서버)", en: "Hub plugins (MCP servers)" },
  { name: "creds", group: "advanced", tier: "more", surfaces: BOTH, args: "<list|save|file>", ko: "API 키 보관 (값은 절대 표시 안 함)", en: "API keys (values are never printed)" },
  { name: "env", group: "advanced", tier: "more", surfaces: BOTH, args: "", ko: "공유 환경 변수 이름", en: "Shared env key names" },
  { name: "multimodal", group: "advanced", tier: "more", surfaces: BOTH, args: "[set <kind> <provider>]", ko: "이미지·영상·음성 제공자", en: "Image, video and audio providers" },
  { name: "telegram", group: "advanced", tier: "more", surfaces: BOTH, args: "[sub]", ko: "텔레그램 연결", en: "Telegram bindings" },
  { name: "connect", group: "advanced", tier: "more", surfaces: BOTH, aliases: ["hep-connect"], args: "<target>", argsKo: "<대상>", ko: "에이전트·팀 연결", en: "Connect an agent or team" },
  { name: "browser", group: "advanced", tier: "more", surfaces: BOTH, aliases: ["hep-browser"], args: "<url|status|sites|login>", ko: "브라우저 하드포인트", en: "Browser hardpoint" },
  { name: "research", group: "advanced", tier: "more", surfaces: BOTH, args: "<subcommand> [args]", argsKo: "<하위-명령> [인자]", ko: "Research Engine (전체 목록: research --help)", en: "Research Engine (full list: research --help)" },
  { name: "document", group: "advanced", tier: "more", surfaces: BOTH, args: "pdf <html|url>", ko: "문서 PDF 내보내기", en: "Export a document to PDF" },
  { name: "oberon", group: "advanced", tier: "more", surfaces: BOTH, aliases: ["film"], args: "<scaffold|render|list|open>", ko: "AI 필름 렌더", en: "AI film render" },
  { name: "variant", group: "advanced", tier: "more", surfaces: BOTH, args: "resolve --base-release", ko: "로컬 변형 선택", en: "Local variant selection" },
  { name: "netadmin", group: "advanced", tier: "more", surfaces: BOTH, args: "<init|status|reindex|...>", ko: "로컬 에이전트 네트워크 관리", en: "Local agent network administration" },
  { name: "hep", group: "advanced", tier: "more", surfaces: BOTH, aliases: ["hep-storm"], args: "<sub...>", ko: "Hephaestus 패스스루 (전문가용)", en: "Hephaestus passthrough (expert)" },
];
/* eslint-enable max-len */

const BY_NAME = new Map();
const ALIAS_TO_NAME = new Map();
for (const entry of CATALOG) {
  BY_NAME.set(entry.name, entry);
  for (const alias of entry.aliases || []) ALIAS_TO_NAME.set(alias, entry.name);
}

function byName(name) {
  const key = String(name || "").replace(/^\//, "");
  return BY_NAME.get(key) || BY_NAME.get(ALIAS_TO_NAME.get(key)) || null;
}
function aliasMap() { return Object.fromEntries(ALIAS_TO_NAME); }
function argsFor(entry, lang) { return (lang === "ko" && entry.argsKo) || entry.args || ""; }
function descFor(entry, lang) { return lang === "ko" ? entry.ko : entry.en; }
function usageFor(entry, lang) {
  const args = argsFor(entry, lang);
  return entry.name + (args ? " " + args : "");
}
function forSurface(surface) { return CATALOG.filter((e) => e.surfaces.includes(surface)); }

const padVis = (text, width) => text + " ".repeat(Math.max(0, width - visWidth(text)));

/*
 * 정렬은 visWidth 로 잰다 — String.length 로 재면 한글 한 글자를 1칸으로 세어
 * 설명 열이 어긋난다(현행 palette.cjs 의 결함).
 */
function renderHelp(options = {}) {
  const lang = options.lang === "ko" ? "ko" : "en";
  const surface = options.surface === "repl" ? "repl" : "cli";
  const all = options.all === true;
  const ko = lang === "ko";
  const rows = forSurface(surface).filter((e) => all || e.tier === "core");
  if (!rows.length) return "";
  /*
   * 머리말은 명령표가 아니라 "이게 무엇이고 어떻게 시작하나"다. 예전 HELP_KO 가
   * 들고 있던 제품 한 줄(터미널 속 에이전트 운영체제)을 여기로 옮겼다 —
   * 그 문장이 사라지면 첫 화면이 명령 나열로만 시작한다.
   */
  const head = [];
  {
    let version = "";
    try { version = require("../agentlas-banner.cjs").readVersion(); } catch { version = ""; }
    head.push(`agentlas${version ? " " + version : ""} — ${ko ? "터미널 속 에이전트 운영체제" : "the agent operating system in your terminal"}`);
    head.push("");
    if (surface === "cli") {
      head.push(ko ? '  agentlas                     셸 열기' : '  agentlas                     open the shell');
      head.push(ko ? '  agentlas "<하고 싶은 일>"     한 번 실행' : '  agentlas "<what you want>"   run once');
    }
    head.push(ko
      ? "  셸 안에서는 그냥 문장을 치면 실행됩니다 · / 를 누르면 명령이 뜹니다"
      : "  In the shell, plain words run a task · press / for commands");
  }
  // 셸에서 셸 전용 명령은 슬래시를 붙여 보여준다 — 그게 실제로 치는 문자열이다.
  const label = (e) => (surface === "repl" && e.surfaces.length === 1 ? "/" : "") + usageFor(e, lang);
  /*
   * 라벨 열에 상한을 둔다. 상한이 없으면 가장 긴 한 줄(automation 의 서브명령 나열)이
   * 전체 열을 밀어 80칸 터미널에서 설명이 통째로 줄바꿈되고, 이어지는 줄은 들여쓰기를
   * 잃는다. 상한을 넘는 소수 행만 자기 열을 넘어가고 나머지는 정렬을 지킨다.
   */
  const LABEL_CAP = 34;
  const width = Math.min(LABEL_CAP, Math.max(...rows.map((e) => visWidth(label(e)))));
  const out = head.slice();
  for (const group of GROUPS) {
    const inGroup = rows.filter((e) => e.group === group.key);
    if (!inGroup.length) continue;
    out.push("", ko ? group.ko : group.en);
    for (const e of inGroup) {
      const text = label(e);
      // 상한을 넘는 라벨은 정렬을 포기하되 설명과 붙지는 않게 최소 두 칸을 보장한다.
      const gap = visWidth(text) >= width ? "  " : " ".repeat(width + 2 - visWidth(text));
      out.push(`  ${text}${gap}${descFor(e, lang)}`);
    }
  }
  if (!all) {
    const hidden = forSurface(surface).length - rows.length;
    if (hidden > 0) {
      out.push("", ko
        ? `  나머지 ${hidden}개 명령: ${surface === "repl" ? "/help all" : "agentlas help all"}`
        : `  ${hidden} more: ${surface === "repl" ? "/help all" : "agentlas help all"}`);
    }
  } else {
    const withAliases = CATALOG.filter((e) => (e.aliases || []).length);
    if (withAliases.length) {
      out.push("", ko ? "  같은 명령의 다른 이름" : "  Other names for the same command");
      out.push("  " + withAliases.map((e) => `${e.name} (= ${e.aliases.join(", ")})`).join(" · "));
    }
  }
  return out.join("\n").replace(/^\n/, "");
}

module.exports = { GROUPS, CATALOG, byName, aliasMap, argsFor, descFor, usageFor, forSurface, renderHelp };
