"use strict";
/*
 * doctor — 런타임·데이터·자격증명 건강 점검.
 * 진단/수리 규칙 자체는 engine/agentlas-doctor.cjs(3제품 패리티 계약)에 있고,
 * 이 명령은 "현재 상태 관측"만 한다. 여기서 관측 항목을 바꿔도 패리티 게이트와
 * 무관하지만, 실패 분류·수리 로직을 건드리려면 반드시 sync-runtime-doctor.sh를 통과시켜라.
 */
const fs = require("node:fs");
const path = require("node:path");
const { dbPath, userDataDir } = require("../core/paths.cjs");
const { listAvailableCliRuntimes, activeRuntimeRow } = require("../runtimes/detect.cjs");

function run(ctx) {
  const en = ctx.lang === "en";
  let failures = 0;
  const ok = (label, detail) => ctx.out(`  ${ctx.ui.green("✓")} ${label}${detail ? ctx.ui.dim(" — " + detail) : ""}`);
  const bad = (label, detail) => { failures += 1; ctx.out(`  ${ctx.ui.red("✗")} ${label}${detail ? ctx.ui.dim(" — " + detail) : ""}`); };

  // 1) 데이터
  const p = dbPath();
  if (fs.existsSync(p)) {
    try {
      const db = ctx.db();
      const agents = db.prepare("SELECT COUNT(*) AS n FROM installed_agents").get();
      ok(en ? "database" : "데이터베이스", `${p} (${agents ? agents.n : 0} agents)`);
    } catch (e) {
      bad(en ? "database" : "데이터베이스", e.message);
    }
  } else {
    bad(en ? "database" : "데이터베이스", (en ? "missing: " : "없음: ") + p);
  }

  // 2) 런타임
  const clis = listAvailableCliRuntimes();
  if (clis.length) {
    ok(en ? "runtimes" : "런타임", clis.map((c) => `${c.kind}`).join(", "));
  } else {
    bad(en ? "runtimes" : "런타임", en
      ? "no agent CLI on PATH (claude / codex / gemini / kimi / grok / cursor-agent)"
      : "PATH에 에이전트 CLI 없음 (claude / codex / gemini / kimi / grok / cursor-agent)");
    // 막다른 길 방지: 무엇을 설치해야 하는지 그 자리에서 알려준다.
    ctx.out(ctx.ui.dim("      npm i -g @anthropic-ai/claude-code  ·  @openai/codex  ·  @google/gemini-cli"));
  }
  try {
    const active = activeRuntimeRow(ctx.db());
    if (active) ok(en ? "active runtime" : "활성 런타임", `${active.kind}${active.model ? ` (${active.model})` : ""}`);
  } catch { /* db issue already reported */ }

  // 3) 로그인 상태 (세션 파일 관측만 — 네트워크 호출 없음)
  const sessionFile = path.join(userDataDir(), "auth", "cli-session.v1.json");
  if (process.env.AGENTLAS_SESSION) {
    ok(en ? "cloud session" : "클라우드 세션", "AGENTLAS_SESSION env");
  } else if (fs.existsSync(sessionFile)) {
    ok(en ? "cloud session" : "클라우드 세션", sessionFile);
  } else {
    ctx.out(`  ${ctx.ui.dim("·")} ${en ? "cloud session" : "클라우드 세션"}${ctx.ui.dim(en ? " — not signed in (agentlas login)" : " — 로그인 안 됨 (agentlas login)")}`);
  }

  ctx.out("");
  if (failures) {
    ctx.out(en ? `doctor: ${failures} problem(s) found` : `doctor: 문제 ${failures}건`);
    return 1;
  }
  ctx.out(en ? "doctor: all clear" : "doctor: 이상 없음");
  return 0;
}

module.exports = { run };
