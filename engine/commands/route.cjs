"use strict";
/*
 * route — 라우팅 미리보기, 실행 없음 (사람용 렌더 + --json 원본 모드).
 *
 * v1 디스패처 매핑 그대로 (legacy-v1-engine-snapshot engine/agentlas.cjs ~13160):
 *   query 있음 → cmdHep(["route", query, "--project", projectCwd(),
 *                        "--runtime", "terminal", ...(--json ? ["--json"] : [])])
 *   → runHephaestusInteractive가 route를 사람용 렌더러(runHephaestusRoute)로
 *     넘기고, --json이면 human:false 원본 패스스루로 내려간다.
 *
 * v1 인자 가드 그대로:
 *   - 단독 help 토큰 → usage, exit 0
 *   - 인자가 없거나 --json뿐 → usage 실패 exit 1
 *     (빈 쿼리가 라우터로 새는 것 방지)
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

async function run(ctx, args) {
  if (args.length === 1 && isHelpToken(args[0])) {
    ctx.out(usageFor("route", ctx.lang));
    return 0;
  }
  if (!args.some((value) => value !== "--json")) {
    ctx.err("✖ " + usageFor("route", ctx.lang));
    return 1;
  }
  const runtime = create(ctx);
  // Global output flags are consumed by the top-level parser before this
  // command sees argv. Preserve JSON mode for the downstream Hephaestus
  // renderer so `agentlas route <query> --json` cannot become a human preview.
  const raw = args.includes("--json") || ctx.output?.format === "json";
  const query = args.filter((value) => value !== "--json").join(" ").trim();
  return runtime.cmdHep(
    query
      ? ["route", query, "--project", runtime.projectCwd(), "--runtime", "terminal", ...(raw ? ["--json"] : [])]
      : ["route"],
  );
}

module.exports = { run };
