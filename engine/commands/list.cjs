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

function run(ctx, args = []) {
  const db = ctx.db();
  // 프라이버시 정책(웹 전용/백그라운드 제외)은 registry가 소유한다 — 직접 SQL 금지.
  const agents = listAgents(db).map((a) => ({
    slug: a.slug, name: a.name, name_en: a.nameEn, tagline: a.tagline, tagline_en: a.taglineEn, builtin: a.builtin,
  }));
  const firms = ctx.tableExists(db, "firms")
    ? db.prepare("SELECT id, slug, name FROM firms ORDER BY name").all()
    : [];

  // clig.dev: 스크립트 소비자는 사람용 표를 파싱하게 두지 말 것 — --json 은
  // 사람용 출력과 같은 사실을 기계 계약으로 준다.
  if (ctx.output?.format === "json" || args.includes("--json")) {
    const orchestrator = resolvedModelRole(db, "orchestrator");
    const worker = resolvedModelRole(db, "worker");
    ctx.out(JSON.stringify({ agents, firms, modelRoles: { orchestrator, worker } }, null, 2));
    return 0;
  }

  const en = ctx.lang === "en";
  ctx.out(ctx.ui.bold(en ? "Installed agents" : "설치된 에이전트"));
  if (!agents.length) {
    ctx.out("  " + (en ? "(none yet — try: agentlas search \"what you need\")" : "  (아직 없음 — agentlas search \"필요한 것\" 으로 찾아보세요)"));
  }
  // padEnd alone does not align: a slug longer than the pad pushes that row's
  // description out, and an unbounded tagline wraps and gets cut mid-word by the
  // terminal with no marker, so the user cannot tell a short description from a
  // truncated one. Clamp the slug column to the widest slug present (bounded),
  // and truncate the tagline on a word boundary with an explicit ellipsis.
  const SLUG_MAX = 32;
  const slugWidth = Math.min(
    SLUG_MAX,
    agents.reduce((w, a) => Math.max(w, String(a.slug || "").length), 0) || 24,
  );
  const clampSlug = (slug) => {
    const s = String(slug || "");
    return s.length > slugWidth ? `${s.slice(0, slugWidth - 1)}…` : s.padEnd(slugWidth);
  };
  // CJK renders two columns wide while String.length counts one, so a Korean
  // tagline measured by length overflows the terminal and gets cut by the
  // terminal itself — exactly the unmarked mid-word break this fix removes.
  const cellWidth = (ch) => {
    const cp = ch.codePointAt(0);
    return (cp >= 0x1100 && (
      cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f64f)
      || (cp >= 0x20000 && cp <= 0x3fffd)
    )) ? 2 : 1;
  };
  const displayWidth = (text) => [...String(text || "")].reduce((w, ch) => w + cellWidth(ch), 0);
  const clampTag = (text, budget) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (displayWidth(t) <= budget) return t;
    let out = "";
    let w = 0;
    for (const ch of t) {
      const next = w + cellWidth(ch);
      if (next > budget - 1) break;
      out += ch;
      w = next;
    }
    const lastSpace = out.lastIndexOf(" ");
    return `${(lastSpace > out.length * 0.6 ? out.slice(0, lastSpace) : out).trimEnd()}…`;
  };
  // Not a TTY (piped, redirected, CI) leaves process.stdout.columns undefined.
  // Honour COLUMNS the way ordinary Unix tools do before falling back, so the
  // output is reproducible and testable outside a terminal.
  const cols = Number(process.stdout.columns) || Number(process.env.COLUMNS) || 100;
  for (const a of agents) {
    const name = en && a.name_en ? a.name_en : a.name;
    const tag = en && a.tagline_en ? a.tagline_en : a.tagline;
    // 2 indent + slug + space + name + " — " + tagline must fit one line.
    const budget = Math.max(20, cols - (2 + slugWidth + 1 + displayWidth(name) + 3));
    const shown = tag ? clampTag(tag, budget) : "";
    ctx.out(`  ${ctx.ui.accent(clampSlug(a.slug))} ${name}${shown ? ctx.ui.dim(" — " + shown) : ""}`);
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
