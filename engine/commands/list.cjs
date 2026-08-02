"use strict";
/*
 * list — 설치 에이전트/회사 + 활성 런타임.
 * 공유 DB(데스크탑과 동일)를 읽는다. visibility='background'/'private' 빌트인은
 * 데스크탑과 동일하게 목록에서 숨긴다.
 */
const { activeRuntimeRow, listAvailableCliRuntimes } = require("../runtimes/detect.cjs");
const { resolvedModelRole } = require("../runtimes/roles.cjs");
const { listAgents } = require("../agents/registry.cjs");

function roleRuntimeLabel(selection, role, en) {
  if (!selection) return en ? "(not set)" : "(미설정)";
  const provider = selection.kind === "byok"
    ? selection.backend || "byok"
    : selection.kind;
  const bits = [
    provider,
    selection.model ? `(${selection.model})` : "",
    selection.effort ? `· effort ${selection.effort}` : "",
  ].filter(Boolean);
  if (role === "worker" && selection.inherit) {
    bits.push(en ? "· inherits orchestrator" : "· 오케스트레이터 상속");
  }
  return bits.join(" ");
}

function run(ctx) {
  const db = ctx.db();
  // 프라이버시 정책(웹 전용/백그라운드 제외)은 registry가 소유한다 — 직접 SQL 금지.
  const agents = listAgents(db).map((a) => ({
    slug: a.slug, name: a.name, name_en: a.nameEn, tagline: a.tagline, tagline_en: a.taglineEn, builtin: a.builtin,
  }));
  const firms = ctx.tableExists(db, "firms")
    ? db.prepare("SELECT id, slug, name FROM firms ORDER BY name").all()
    : [];

  const en = ctx.lang === "en";
  ctx.out(ctx.ui.bold(en ? "Installed agents" : "설치된 에이전트"));
  if (!agents.length) {
    ctx.out("  " + (en ? "(none yet — try: agentlas search \"what you need\")" : "  (아직 없음 — agentlas search \"필요한 것\" 으로 찾아보세요)"));
  }
  for (const a of agents) {
    const name = en && a.name_en ? a.name_en : a.name;
    const tag = en && a.tagline_en ? a.tagline_en : a.tagline;
    ctx.out(`  ${ctx.ui.accent(a.slug.padEnd(24))} ${name}${tag ? ctx.ui.dim(" — " + tag) : ""}`);
  }
  if (firms.length) {
    ctx.out("");
    ctx.out(ctx.ui.bold(en ? "Companies" : "회사"));
    for (const f of firms) {
      const callable = String(f.slug || f.id);
      ctx.out(`  ${ctx.ui.accent(callable.padEnd(28))} ${f.name}`);
    }
    ctx.out(ctx.ui.dim(en
      ? "  Run one with: agentlas firm <company-key> \"<task>\""
      : "  실행: agentlas firm <회사 키> \"<작업>\""));
  }

  const active = activeRuntimeRow(db);
  const clis = listAvailableCliRuntimes();
  ctx.out("");
  ctx.out(ctx.ui.bold(en ? "Model roles" : "모델 역할"));
  const orchestrator = resolvedModelRole(db, "orchestrator");
  const worker = resolvedModelRole(db, "worker");
  ctx.out(`  orchestrator: ${roleRuntimeLabel(orchestrator, "orchestrator", en)}`);
  ctx.out(`  worker:       ${roleRuntimeLabel(worker, "worker", en)}`);

  ctx.out("");
  ctx.out(ctx.ui.bold(en ? "Legacy runtime compatibility" : "레거시 런타임 호환"));
  if (active) {
    ctx.out(`  active: ${active.kind}${active.model ? ` (${active.model})` : ""}${active.backend ? ` via ${active.backend}` : ""}`);
  } else {
    ctx.out("  active: " + (en ? "(not set)" : "(미설정)"));
  }
  ctx.out(`  detected CLIs: ${clis.length ? clis.map((c) => c.kind).join(", ") : (en ? "none on PATH" : "PATH에 없음")}`);
  return 0;
}

module.exports = { run };
