"use strict";
/*
 * ui/palette — v2 슬래시 명령 정본 + readline 완성기.
 *
 * 왜 v1 input 모듈의 SLASH_COMMANDS를 쓰지 않는가: 그 목록은 v1 REPL 전용이라
 * v2에 없는 명령(/status /team /model /effort …)을 광고하고, v2의 오르카 명령
 * (/spawn /sessions /s /steer /kill /broadcast …)은 빠져 있었다. 팔레트가
 * 거짓말하면 사용자는 없는 기능을 부른다(실사용 Tab 테스트에서 실증).
 * 경로 완성만 v1 모듈의 completePath를 재사용한다.
 */
const { completePath, isAbsolutePathTask } = require("../agentlas-input.cjs");

// command, 인자 힌트, 한 줄 설명 — /help 팔레트와 Tab 완성이 같은 정본을 쓴다.
const SLASH_COMMANDS = [
  { command: "/help", args: "", ko: "명령·단축키 보기", en: "Show commands and shortcuts" },
  { command: "/sessions", args: "", ko: "세션 표", en: "Session table" },
  { command: "/tree", args: "", ko: "세션 트리", en: "Session tree" },
  { command: "/s", args: "<n>", ko: "활성 세션 전환", en: "Switch active session" },
  { command: "/switch", args: "<n>", ko: "활성 세션 전환", en: "Switch active session" },
  { command: "/spawn", args: "<agent> [task]", ko: "서브에이전트 세션 생성", en: "Spawn a subagent session" },
  { command: "/steer", args: "<n> <msg>", ko: "해당 세션에 지시 큐잉", en: "Queue steering for a session" },
  { command: "/kill", args: "<n>", ko: "실행 중 턴 중단", en: "Interrupt a running turn" },
  { command: "/rm", args: "<n>", ko: "세션 제거", en: "Remove a session" },
  { command: "/broadcast", args: "<msg>", ko: "모든 세션에 지시", en: "Send to every session" },
  { command: "/use", args: "<agent>", ko: "메인 세션 에이전트 교체", en: "Switch the main agent" },
  { command: "/agents", args: "", ko: "설치 에이전트 목록", en: "List installed agents" },
  { command: "/list", args: "", ko: "설치 에이전트 목록", en: "List installed agents" },
  { command: "/chats", args: "[n]", ko: "최근 대화", en: "Recent conversations" },
  { command: "/mcp", args: "", ko: "MCP 서버 목록", en: "MCP servers" },
  { command: "/doctor", args: "", ko: "런타임·데이터 점검", en: "Health check" },
  { command: "/runtime", args: "<kind>", ko: "새 세션 런타임 지정", en: "Set runtime for new sessions" },
  { command: "/model", args: "<id|default>", ko: "새 세션 모델 지정", en: "Set model for new sessions" },
  { command: "/effort", args: "<level|none>", ko: "새 세션 추론 강도 지정", en: "Set effort for new sessions" },
  { command: "/permission", args: "<level>", ko: "새 세션 권한 지정", en: "Set permission for new sessions" },
  { command: "/login", args: "", ko: "Agentlas Cloud 로그인", en: "Sign in to Agentlas Cloud" },
  { command: "/whoami", args: "", ko: "로그인 상태", en: "Signed-in account" },
  { command: "/search", args: "\"<what you need>\"", ko: "Hub 에이전트 검색", en: "Search Hub agents" },
  { command: "/install", args: "<slug>", ko: "Hub 에이전트 설치", en: "Install a Hub agent" },
  { command: "/usage", args: "", ko: "로컬 사용 현황", en: "Local usage" },
  { command: "/billing", args: "", ko: "크레딧 잔액", en: "Credit balance" },
  { command: "/automation", args: "[sub]", ko: "자동화", en: "Automations" },
  { command: "/storm", args: "<goal>", ko: "Goal+UltraCode 하니스", en: "Goal+UltraCode harness" },
  { command: "/swarm", args: "<goal>", ko: "에이전트 스웜", en: "Agent swarm" },
  { command: "/network", args: "<request>", ko: "Workforce 라우트", en: "Workforce route" },
  { command: "/workforce", args: "<request>", ko: "Workforce 라우트", en: "Workforce route" },
  { command: "/taskforce", args: "<request>", ko: "임시 태스크포스 편성", en: "Assemble a task force" },
  { command: "/build", args: "\"<request>\"", ko: "에이전트·팀 제작/수리/패키징", en: "Build, repair or package an agent or team" },
  { command: "/call", args: "\"a,b\" \"<ctx>\"", ko: "지정 에이전트 호출", en: "Call named agents" },
  { command: "/route", args: "\"<req>\"", ko: "최적 에이전트 라우팅", en: "Route to the best agent" },
  { command: "/browser", args: "[sub]", ko: "브라우저 하드포인트", en: "Browser hardpoint" },
  { command: "/connect", args: "<target>", ko: "에이전트·팀 연결", en: "Connect an agent or team" },
  { command: "/research", args: "<sub>", ko: "리서치", en: "Research" },
  { command: "/upload", args: "<path>", ko: "Agent Cloud에 저장·발행", en: "Save to Agent Cloud or publish" },
  { command: "/cloud", args: "<sub>", ko: "클라우드 자산 관리", en: "Cloud assets" },
  { command: "/import", args: "<path>", ko: "로컬 폴더 에이전트 가져오기", en: "Import a local folder agent" },
  { command: "/cd", args: "[path]", ko: "작업 폴더 이동", en: "Change working folder" },
  { command: "/native", args: "prepare <agent>", ko: "네이티브 CLI 컨텍스트 생성", en: "Prepare native CLI context" },
  { command: "/plugin", args: "<sub>", ko: "Hub 플러그인(MCP)", en: "Hub plugins (MCP servers)" },
  { command: "/plugins", args: "", ko: "설치된 플러그인", en: "Installed plugins" },
  { command: "/experience", args: "<sub>", ko: "이식 가능한 Experience", en: "Portable Experience" },
  { command: "/variant", args: "resolve", ko: "로컬 변형 선택", en: "Local variant selection" },
  { command: "/memory", args: "<sub>", ko: "메모리", en: "Memory" },
  { command: "/evolve", args: "", ko: "프롬프트 진화 제안", en: "Prompt-evolution proposals" },
  { command: "/ontology", args: "", ko: "프로젝트 지식", en: "Project knowledge" },
  { command: "/career-graph", args: "", ko: "소스 라우팅 그래프", en: "Source routing graph" },
  { command: "/journal", args: "<sub>", ko: "Stormbreaker 실행 일지", en: "Stormbreaker run journal" },
  { command: "/project", args: "[status|init]", ko: ".agentlas 프로젝트 상태", en: "Private project state" },
  { command: "/context", args: "<sub>", ko: "의존성 맵", en: "Dependency map" },
  { command: "/creds", args: "<sub>", ko: "자격증명", en: "Credentials" },
  { command: "/env", args: "", ko: "공유 환경 키", en: "Shared env keys" },
  { command: "/multimodal", args: "", ko: "이미지·영상·음성 설정", en: "Image/video/audio providers" },
  { command: "/telegram", args: "[sub]", ko: "텔레그램 연결", en: "Telegram bindings" },
  { command: "/oberon", args: "[sub]", ko: "AI 필름", en: "AI film" },
  { command: "/film", args: "<sub>", ko: "필름 렌더", en: "Film render" },
  { command: "/hep", args: "<sub…>", ko: "Hephaestus 패스스루", en: "Hephaestus passthrough" },
  { command: "/netadmin", args: "[sub]", ko: "로컬 네트워크 관리", en: "Local network admin" },
  { command: "/update", args: "", ko: "npm 업데이트 확인", en: "npm update check" },
  { command: "/version", args: "", ko: "버전", en: "Version" },
  { command: "/logout", args: "", ko: "로그아웃", en: "Sign out" },
  { command: "/uninstall", args: "<slug>", ko: "에이전트 제거", en: "Uninstall an agent" },
  { command: "/quit", args: "", ko: "종료", en: "Quit" },
  { command: "/exit", args: "", ko: "종료", en: "Quit" },
];

const SLASH_NAMES = SLASH_COMMANDS.map((c) => c.command);
const RUNTIME_KINDS = ["claude-code", "codex", "gemini"];
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const PERM_LEVELS = ["read", "write", "full"];
// 세션 인자를 받는 명령 — 완성 후보를 살아있는 세션 키(s1, s2…)로 채운다.
const SESSION_ARG_COMMANDS = new Set(["/s", "/switch", "/steer", "/kill", "/rm"]);
const AGENT_ARG_COMMANDS = new Set(["/use", "/spawn"]);

function uniqStartsWith(list, prefix) {
  const p = String(prefix || "");
  const hits = [...new Set(list)].filter((v) => v.startsWith(p));
  return hits.length ? hits : [];
}

/**
 * ctx: { getAgentSlugs, getFirmSlugs, getSessionKeys, getCwd }
 * readline completer 계약: [candidates, prefix] 반환.
 */
function makeCompleter(ctx = {}) {
  const getAgents = ctx.getAgentSlugs || (() => []);
  const getFirms = ctx.getFirmSlugs || (() => []);
  const getSessions = ctx.getSessionKeys || (() => []);
  const getCwd = ctx.getCwd || (() => process.cwd());
  return function completer(line) {
    const lineStr = line || "";
    const tokens = lineStr.split(/\s+/);
    const last = tokens[tokens.length - 1] || "";

    // @경로 멘션은 어느 위치에서나 파일 완성
    if (last.startsWith("@")) return [completePath(last.slice(1), getCwd(), "@"), last];

    if (tokens.length === 1) {
      if (isAbsolutePathTask(lineStr)) return [completePath(lineStr, getCwd(), ""), last];
      if (lineStr.startsWith("/")) return [uniqStartsWith(SLASH_NAMES, last), last];
      // 첫 토큰이 자유 텍스트면 에이전트 이름을 제안한다(에이전트 점프 UX).
      return [uniqStartsWith(getAgents().concat(getFirms()), last), last];
    }

    const cmd = tokens[0];
    if (cmd === "/runtime") return [uniqStartsWith(RUNTIME_KINDS, last), last];
    if (cmd === "/effort") return [uniqStartsWith(EFFORT_LEVELS, last), last];
    if (cmd === "/permission") return [uniqStartsWith(PERM_LEVELS, last), last];
    if (SESSION_ARG_COMMANDS.has(cmd) && tokens.length === 2) return [uniqStartsWith(getSessions(), last), last];
    if (AGENT_ARG_COMMANDS.has(cmd) && tokens.length === 2) {
      return [uniqStartsWith(getAgents().concat(getFirms()), last), last];
    }
    return [[], last];
  };
}

/*
 * 입력 중 뜨는 슬래시 오버레이의 후보 — Tab 완성·/help 와 같은 정본에서 나온다.
 * v1 input 모듈의 slashCommandSuggestions 를 쓰면 오버레이만 v1 목록을 광고하게
 * 되므로(이 파일 상단 주석의 그 사고), 오버레이도 여기서 후보를 받는다.
 * 반환 모양은 input.renderSlashPalette 가 기대하는 행 계약을 따른다.
 */
function suggestions(line, limit = 12, lang = "en") {
  const value = String(line || "");
  if (!value.startsWith("/")) return [];
  if (isAbsolutePathTask(value)) return []; // /Users/… 같은 절대경로 작업은 명령이 아니다
  if (/\s/.test(value)) return []; // 인자를 타이핑하는 중이면 명령 목록은 방해다
  const ko = lang === "ko";
  const rows = SLASH_COMMANDS.map((entry) => ({
    command: entry.command,
    description: ko ? entry.ko : entry.en,
    usage: entry.command + (entry.args ? " " + entry.args : ""),
    detail: "",
    category: "",
    examples: [],
  }));
  const q = value.toLowerCase();
  if (q === "/") return rows.slice(0, limit);
  const starts = rows.filter((row) => row.command.toLowerCase().startsWith(q));
  const contains = rows.filter(
    (row) =>
      !row.command.toLowerCase().startsWith(q) &&
      (row.command.toLowerCase().includes(q.slice(1)) || row.description.toLowerCase().includes(q.slice(1))),
  );
  return starts.concat(contains).slice(0, limit);
}

/** /help 팔레트 렌더 — Tab 완성과 같은 정본에서 나온다. */
function renderPalette(lang) {
  const ko = lang === "ko";
  const width = Math.max(...SLASH_COMMANDS.map((c) => (c.command + " " + c.args).length));
  return SLASH_COMMANDS
    .filter((c, i, all) => all.findIndex((x) => (ko ? x.ko : x.en) === (ko ? c.ko : c.en)) === i)
    .map((c) => `  ${(c.command + (c.args ? " " + c.args : "")).padEnd(width + 2)}${ko ? c.ko : c.en}`)
    .join("\n");
}

module.exports = { SLASH_COMMANDS, SLASH_NAMES, makeCompleter, renderPalette, suggestions };
