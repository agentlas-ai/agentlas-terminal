"use strict";
/*
 * career-graph — 커리어 그래프 상태/소스 등록 + 인덱스 실행 위임 (v1 cmdCareerGraph 포팅).
 *
 * ingest|query|verify|trace|public-card 는 파생 인덱스 실행이며 Agentlas OS /
 * Hephaestus 런타임(career_graph 파이썬 모듈)이 소유한다 — 런타임이 있으면
 * 그대로 위임 실행하고, 없으면 정직 정지(대신 계산하는 척 금지).
 */
const { runCareerGraphCli } = require("../project/career-graph.cjs");
const { resolveCoreRuntimeRoot, resolvePython, spawnCoreModule } = require("../agentlas-core-harness.cjs");

const INDEX_SUBCOMMANDS = new Set(["ingest", "query", "verify", "trace", "public-card"]);

async function run(ctx, args) {
  const sub = String((args && args[0]) || "status");
  if (INDEX_SUBCOMMANDS.has(sub)) {
    const coreRoot = resolveCoreRuntimeRoot();
    if (!coreRoot || !resolvePython()) {
      ctx.err(ctx.lang === "ko"
        ? "Career Graph 인덱스 실행은 Agentlas OS / Hephaestus 런타임이 필요합니다 (~/.agentlas/runtime/current). 런타임 없이 결과를 지어내지 않습니다."
        : "Career Graph index execution requires the Agentlas OS / Hephaestus runtime (~/.agentlas/runtime/current). No runtime — no fabricated result.");
      return 1;
    }
    const graphArgs = args.slice();
    if (!graphArgs.includes("--project")) graphArgs.push("--project", process.cwd());
    const child = spawnCoreModule("career_graph", graphArgs, { cwd: process.cwd(), stdio: "inherit" }, coreRoot);
    if (!child) {
      ctx.err("Agentlas Core runtime or Python 3.9+ is unavailable.");
      return 1;
    }
    return await new Promise((resolve) => {
      child.on("error", (e) => { ctx.err(String((e && e.message) || e)); resolve(1); });
      child.on("close", (code) => resolve(code == null ? 1 : code));
    });
  }
  try {
    const lines = runCareerGraphCli(args, {
      cwd: process.cwd(),
      projectPath: process.cwd(),
      lang: ctx.lang,
      notify: (line) => ctx.out(line),
    });
    for (const line of lines) ctx.out(line);
    return 0;
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
