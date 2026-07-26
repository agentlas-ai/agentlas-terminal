"use strict";
/*
 * oberon — Oberon 필름 스튜디오 (터미널 헤드리스 렌더).
 * v1 모놀리스 §12213-12580 (cmdOberon + oberonHelp) 포팅 — 얇은 명령 래퍼.
 * GUI 없이 매니페스트 하나로 영상 렌더를 돌린다. 손으로 쓰던 JSON+env 노가다 대신:
 *   agentlas oberon scaffold my.json      → 편집 가능한 렌더 매니페스트 생성
 *   agentlas oberon render my.json        → 헤드리스 렌더 스폰 + 진행률 스트리밍
 *   agentlas oberon list                  → 최근 렌더 산출물
 *
 * v2 규칙: 기능 로직은 engine/oberon/*에만 있다. 이 파일은 서브커맨드 디스패치와
 * OberonFail → "✖ msg" + exit 1 변환(v1 fail 계약)만 담당한다.
 */
const { scaffold } = require("../oberon/manifest.cjs");
const { render } = require("../oberon/render.cjs");
const { list, open } = require("../oberon/outputs.cjs");

function help(io) {
  io.out(
    [
      "agentlas oberon — AI film rendering from the terminal",
      "",
      "  oberon scaffold [out.json] [--title T] [--aspect 16:9] [--shots N] [--titles] [--overwrite]",
      "                         create an editable manifest; existing files require explicit --overwrite",
      "  oberon render <manifest.json> [--delivery DIR] [--max-shots N] [--open] [--dry-run]",
      "                         spawn full Electron render + stream progress (GEMINI_API_KEY vault required)",
      "  oberon list            최근 렌더 산출물",
      "  oberon open [path]     산출물 폴더 열기",
      "",
      "Fill prompts directly, or ask an agent: agentlas run oberon-film-studio \"30-second fragrance ad\"",
    ].join("\n"),
  );
  return 0;
}

// deps는 테스트/장래 배선용 seam (render의 진입점·spawn 주입) — 일반 경로에서는 미사용.
async function run(ctx, args, deps) {
  const sub = args[0] || "help";
  const rest = args.slice(1);
  const io = { out: ctx.out, err: ctx.err };
  try {
    switch (sub) {
      case "scaffold":
      case "new":
        return scaffold(io, rest);
      case "render":
        return await render(io, rest, deps || {});
      case "list":
      case "ls":
        return list(io);
      case "open":
        return open(io, rest);
      case "help":
      case "--help":
      case "-h":
        return help(io);
      default:
        ctx.err(`✖ Unknown oberon subcommand: ${sub}  (scaffold|render|list|open|help)`);
        return 1;
    }
  } catch (e) {
    if (e && e.oberonFail) {
      // v1 fail() 계약: stderr에 "✖ " 접두 + exit 1. v2는 exit 대신 코드 반환.
      ctx.err(`✖ ${e.message}`);
      return 1;
    }
    throw e;
  }
}

module.exports = { run };
