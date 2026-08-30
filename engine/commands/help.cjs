"use strict";
/*
 * commands/help — 정본은 ui/commands-catalog.cjs 하나다(2026-08-11 재작성).
 *
 * 이 파일에는 EN 61줄 + KO 133줄의 손유지 블록 두 벌이 있었다. 팔레트와 어긋나
 * 같은 명령이 표면마다 다른 인자·설명을 광고했고(`search "<what you need>"` vs
 * `"<필요한 것>"`), `agentlas help doctor` 는 인자를 무시하고 전체를 쏟아냈다.
 * 이제 CLI·기본 REPL·새 셸이 같은 renderHelp 를 부른다 — 다시 갈라질 수 없다.
 */
const catalog = require("../ui/commands-catalog.cjs");

function run(ctx, args = []) {
  if (!Array.isArray(args) || args.length > 1) {
    const error = new Error("usage: agentlas help [all|<command>]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const first = String((args && args[0]) || "").trim();
  if (first.startsWith("-")) {
    const error = new Error("usage: agentlas help [all|<command>]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const all = first.toLowerCase() === "all";
  const name = !all && first ? first : null;
  if (name) return runForCommand(ctx, name);
  ctx.out(catalog.renderHelp({ lang: ctx.lang, surface: "cli", all }));
  return 0;
}

function runForCommand(ctx, command) {
  const name = String(command || "").trim().replace(/^\//, "");
  const entry = catalog.byName(name);
  const ko = ctx && ctx.lang === "ko";
  if (!entry) {
    // 없는 이름을 지어내지 않는다 — 전체 목록으로 보낸다.
    ctx.out(`Usage: agentlas ${name}`);
    ctx.out(ko ? '  전체 목록: agentlas help all' : '  Full list: agentlas help all');
    return 0;
  }
  const replOnly = !entry.surfaces.includes("cli");
  ctx.out(`Usage: agentlas ${catalog.usageFor(entry, ctx.lang)}`);
  ctx.out(`  ${catalog.descFor(entry, ctx.lang)}`);
  if (entry.aliases && entry.aliases.length) {
    ctx.out(ko ? `  다른 이름: ${entry.aliases.join(", ")}` : `  Also: ${entry.aliases.join(", ")}`);
  }
  if (replOnly) {
    ctx.out(ko
      ? `  이 명령은 터미널 안에서 씁니다: agentlas 를 실행한 뒤 /${entry.name}`
      : `  This one runs inside the terminal: start agentlas, then /${entry.name}`);
  }
  return 0;
}

module.exports = { run, runForCommand };
