"use strict";
/*
 * research — Agentlas OS Research Engine.
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas research <sub…>` → cmdHep(["research", ...rest])
 *   → runHephaestusInteractive가 research를 사람용 렌더러
 *     (runHephaestusResearch, --json 원본 모드 포함)로 넘긴다.
 *
 * v1 가드 그대로:
 *   - help 토큰 → 로컬 usage가 아니라 Hephaestus 네이티브 help 패스스루
 *     (v1: parity().cmdHep(null, ["research", ...rest]) 특례).
 *   - 첫 인자가 현재 Agentlas OS Research 명령 밖 → usage 실패 exit 1
 *     (자연어가 리서치 서브커맨드 자리로 새는 것 방지; ko 문구 v1 그대로).
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

// Agentlas OS 1.2.37의 공개 `hephaestus research --help` 표면. Terminal이
// 옛 다섯 개만 허용하면 설치된 Core의 진단·검증·하드포인트·loadout 명령이
// 물리적으로 도달 불가능해진다. 알 수 없는 값은 계속 로컬에서 fail-closed 한다.
const RESEARCH_SUBCOMMANDS = new Set([
  "doctor", "status", "credentials", "social-fallbacks", "proofs", "verify",
  "hardpoints", "modules", "armory", "profile", "recommend", "preflight",
  "bridge-contract", "browser-candidates", "bridge-check", "platform-contract",
  "platform-check", "loadouts", "plan", "read", "search", "gather",
]);

async function run(ctx, args) {
  const runtime = create(ctx);
  if (args.some(isHelpToken)) {
    // The top-level router canonicalizes `<command> --help` to the command's
    // `help` branch. argparse behind Agentlas OS expects `--help`, not a
    // positional `help` research subcommand.
    return runtime.cmdHep(["research", ...args.map((arg) => arg === "help" ? "--help" : arg)]);
  }
  if (!RESEARCH_SUBCOMMANDS.has(args[0])) {
    ctx.err(
      "✖ " + (ctx.lang === "ko"
        ? "사용법: agentlas research <하위-명령> [인자] (전체 목록: agentlas research --help)"
        : usageFor("research", ctx.lang)),
    );
    return 1;
  }
  return runtime.cmdHep(["research", ...args]);
}

module.exports = { run, RESEARCH_SUBCOMMANDS };
