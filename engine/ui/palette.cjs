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
  { command: "/quit", args: "", ko: "종료", en: "Quit" },
  { command: "/exit", args: "", ko: "종료", en: "Quit" },
];

const SLASH_NAMES = SLASH_COMMANDS.map((c) => c.command);
const RUNTIME_KINDS = ["claude-code", "codex", "gemini"];
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
    if (cmd === "/permission") return [uniqStartsWith(PERM_LEVELS, last), last];
    if (SESSION_ARG_COMMANDS.has(cmd) && tokens.length === 2) return [uniqStartsWith(getSessions(), last), last];
    if (AGENT_ARG_COMMANDS.has(cmd) && tokens.length === 2) {
      return [uniqStartsWith(getAgents().concat(getFirms()), last), last];
    }
    return [[], last];
  };
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

module.exports = { SLASH_COMMANDS, SLASH_NAMES, makeCompleter, renderPalette };
