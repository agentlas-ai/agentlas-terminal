"use strict";
/*
 * ui/repl — v2 REPL (Claude Code 방식) 걷는 뼈대.
 *
 * 이 파일은 표시/입력 루프만 소유한다. 실행은 sessions/orchestrator(오르카 계층)로
 * 위임한다 — 포그라운드 턴도 세션 하나다(제2의 실행 경로 금지).
 * 러너가 배선되기 전까지 작업 입력에는 정직하게 미배선을 알린다.
 */
const readline = require("node:readline");
const { renderBanner, readVersion } = require("../agentlas-banner.cjs");

function startRepl(ctx) {
  return new Promise((resolve) => {
    const en = ctx.lang === "en";
    try {
      process.stdout.write(renderBanner({ version: readVersion(), lang: ctx.lang }) + "\n");
    } catch {
      ctx.out(`agentlas ${readVersion()}`);
    }
    ctx.out(ctx.ui.dim(en
      ? "v2 engine (rebuild in progress) — /help for commands, /quit to exit"
      : "v2 엔진 (재구축 진행 중) — /help 명령 보기, /quit 종료"));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
    rl.prompt();
    let sigints = 0;
    rl.on("SIGINT", () => {
      sigints += 1;
      if (sigints >= 2) { rl.close(); return; }
      ctx.out(ctx.ui.dim(en ? "(ctrl-c again to quit)" : "(한 번 더 ctrl-c 하면 종료)"));
      rl.prompt();
    });
    rl.on("line", (line) => {
      sigints = 0;
      const input = line.trim();
      if (!input) { rl.prompt(); return; }
      if (input === "/quit" || input === "/exit" || input === "exit") { rl.close(); return; }
      if (input.startsWith("/")) {
        handleSlash(ctx, input.slice(1));
      } else {
        ctx.out(ctx.ui.dim(en
          ? "The v2 runner is not wired yet — agent turns land with sessions/orchestrator."
          : "v2 러너가 아직 배선되지 않았습니다 — 에이전트 턴은 sessions/orchestrator와 함께 들어옵니다."));
      }
      rl.prompt();
    });
    rl.on("close", () => { ctx.out(""); resolve(0); });
  });
}

function handleSlash(ctx, cmdline) {
  const [cmd, ...rest] = cmdline.split(/\s+/);
  const table = {
    help: () => require("../commands/help.cjs").run(ctx, rest),
    agents: () => require("../commands/list.cjs").run(ctx, rest),
    list: () => require("../commands/list.cjs").run(ctx, rest),
    chats: () => require("../commands/chats.cjs").run(ctx, rest),
    doctor: () => require("../commands/doctor.cjs").run(ctx, rest),
    mcp: () => require("../commands/mcp.cjs").run(ctx, rest),
  };
  if (table[cmd]) { table[cmd](); return; }
  ctx.out(ctx.ui.dim(ctx.lang === "en" ? `unknown: /${cmd} (see /help)` : `알 수 없는 명령: /${cmd} (/help 참고)`));
}

module.exports = { startRepl };
