"use strict";
/*
 * firm — 회사(CEO) 위임: agentlas firm <slug> [task…]
 * 실행 경로는 세션 계층 하나다: 회사의 CEO 에이전트로 세션을 만든다.
 * 무인자: 회사 목록. task 없이 slug만: 그 CEO와 REPL.
 */
const { rowToAgent } = require("../agents/registry.cjs");

function findFirm(db, token) {
  const q = String(token || "").trim().toLowerCase();
  if (!q) return null;
  return db.prepare("SELECT * FROM firms WHERE lower(slug)=? OR lower(name)=?").get(q, q)
    || db.prepare("SELECT * FROM firms WHERE lower(slug) LIKE ? ORDER BY slug LIMIT 1").get(`%${q}%`)
    || null;
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  if (!ctx.tableExists(db, "firms")) {
    ctx.out(ko ? "회사가 없습니다." : "No companies yet.");
    return 0;
  }
  if (!args.length) {
    const firms = db.prepare("SELECT slug, name, tagline FROM firms ORDER BY name").all();
    if (!firms.length) {
      ctx.out(ko ? "회사가 없습니다. (팀 폴더를 import 하면 회사로 등록됩니다)" : "No companies yet. (import a team folder to register one)");
      return 0;
    }
    for (const f of firms) ctx.out(`  ${ctx.ui.accent(String(f.slug).padEnd(28))} ${f.name}${f.tagline ? ctx.ui.dim(" — " + f.tagline) : ""}`);
    return 0;
  }

  const firm = findFirm(db, args[0]);
  if (!firm) {
    ctx.err((ko ? "회사를 찾을 수 없음: " : "firm not found: ") + args[0]);
    return 1;
  }
  const ceoRow = firm.ceo_agent_id
    ? db.prepare("SELECT * FROM installed_agents WHERE id=?").get(firm.ceo_agent_id)
    : null;
  if (!ceoRow) {
    ctx.err(ko
      ? `회사 ${firm.slug} 의 CEO 에이전트가 없습니다 (ceo_agent_id 미해결). 팀 폴더를 다시 import 하세요.`
      : `Firm ${firm.slug} has no resolvable CEO agent. Re-import the team folder.`);
    return 1;
  }
  const ceo = rowToAgent(ceoRow);

  const task = args.slice(1).join(" ").trim();
  if (task) {
    // 원샷: run 명령과 동일 경로 (CEO 에이전트 지정)
    return require("./run.cjs").run(ctx, [ceo.slug, task]);
  }
  const { startRepl } = require("../ui/repl.cjs");
  return startRepl(ctx, { agent: ceo.slug });
}

module.exports = { run, findFirm };
