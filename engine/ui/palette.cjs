"use strict";
/*
 * ui/palette — v2 슬래시 명령 정본 + readline 완성기.
 *
 * 왜 v1 input 모듈의 SLASH_COMMANDS를 쓰지 않는가: 그 목록은 v1 REPL 전용이라
 * v2에 없는 명령(/status /team /model /effort …)을 광고한다. 프로젝트 Work에서는
 * 컨트롤러만 서브에이전트를 배정하므로 사용자용 임의 spawn/steer/broadcast는 없다.
 * 거짓말하면 사용자는 없는 기능을 부른다(실사용 Tab 테스트에서 실증).
 * 경로 완성만 v1 모듈의 completePath를 재사용한다.
 */
const { completePath, isAbsolutePathTask } = require("../agentlas-input.cjs");

// command, 인자 힌트, 한 줄 설명 — /help 팔레트와 Tab 완성이 같은 정본을 쓴다.
const catalog = require("./commands-catalog.cjs");

/*
 * 정본은 ui/commands-catalog.cjs 하나다(2026-08-11). 여기 있던 71행 리터럴은
 * help.cjs 의 EN/KO 블록과 어긋나 언어 혼재·중복 숨김을 만들었다.
 */
const SLASH_COMMANDS = catalog.forSurface("repl").map((entry) => ({
  command: "/" + entry.name,
  args: entry.args || "",
  argsKo: entry.argsKo,
  ko: entry.ko,
  en: entry.en,
  group: entry.group,
  tier: entry.tier,
}));

const SLASH_NAMES = SLASH_COMMANDS.map((c) => c.command);
// /runtime 완성 후보 — 정본(runtimes/kinds.cjs)의 네이티브 스폰 러너 4종.
const RUNTIME_KINDS = require("../runtimes/kinds.cjs").NATIVE_CLI_KINDS;
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const PERM_LEVELS = ["read", "write", "full"];
// 세션 인자를 받는 명령 — 완성 후보를 살아있는 세션 키(s1, s2…)로 채운다.
const SESSION_ARG_COMMANDS = new Set(["/s", "/switch", "/kill", "/rm"]);

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
    usage: "/" + catalog.usageFor(catalog.byName(entry.command) || entry, lang),
    detail: "",
    category: entry.group || "",
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

/*
 * /help 팔레트 — CLI 와 완전히 같은 렌더러를 쓴다. 예전엔 여기서 설명 텍스트로
 * 중복 제거를 해서 `/switch` `/list` `/exit` 가 조용히 사라졌다. 별칭이 필드가 된
 * 지금은 중복 자체가 없으므로 그 필터도 없다.
 */
function renderPalette(lang, opts = {}) {
  return catalog.renderHelp({ lang, surface: "repl", all: opts.all === true });
}

module.exports = { SLASH_COMMANDS, SLASH_NAMES, makeCompleter, renderPalette, suggestions };
