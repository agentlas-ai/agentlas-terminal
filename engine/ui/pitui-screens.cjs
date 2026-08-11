"use strict";
/*
 * ui/pitui-screens — 데스크탑 화면의 터미널 대응물 (D3 Phase 3).
 *
 * 대조 원본: docs/2026-08-11-terminal-tui-overhaul/D1-데스크탑-기능-인벤토리.md
 * 각 화면은 데스크탑이 IPC로 읽는 것과 같은 로컬 저장소를 직접 읽는다.
 *
 * 규칙:
 *  - 없는 데이터를 지어내지 않는다. 표면이 데스크탑 전용이면 그렇게 말한다.
 *  - 실패·미결은 눈에 띄게. "조용히 멈춘 실행"이 정상처럼 보이면 안 된다(D1 숨은 계약 2).
 *  - 모든 화면은 ctx.out 이 아니라 ui 를 직접 받아 pi 프레임 안에 그린다.
 */

function table(ui, rows, opts = {}) {
  // rows: [[col, col, …]] — 첫 행이 헤더. 폭은 CJK 셀 폭으로 계산한다.
  const { visWidth, truncateWidth } = require("./width.cjs");
  if (!rows.length) return;
  const cols = rows[0].length;
  const max = Number(opts.maxWidth) || 78;
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.min(opts.cap?.[i] || 40, Math.max(...rows.map((r) => visWidth(String(r[i] ?? ""))))));
  const total = widths.reduce((a, b) => a + b + 2, 0);
  if (total > max && widths.length) widths[0] = Math.max(8, widths[0] - (total - max));
  rows.forEach((row, index) => {
    const line = row.map((cell, i) => {
      const text = truncateWidth(String(cell ?? ""), widths[i]);
      return text + " ".repeat(Math.max(0, widths[i] - visWidth(text)));
    }).join("  ");
    ui.line(index === 0 && opts.header !== false ? ui.c.dim(line) : "  " + line);
  });
}

function count(db, sql, fallback = 0) {
  try { return db.prepare(sql).get()?.n ?? fallback; } catch { return fallback; }
}
function rows(db, sql, args = []) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}
const shortTs = (v) => (v ? String(v).replace("T", " ").slice(0, 16) : "");

/* ── /dashboard — 데스크탑 dashboard 의 관제 패널 집합 ── */
function dashboard(ui, db, en) {
  const chip = (paint, s) => paint(` ${s} `);
  const local = count(db, "SELECT COUNT(*) n FROM installed_agents WHERE COALESCE(builtin,0)=0 AND COALESCE(visibility,'')!='background'");
  const builtin = count(db, "SELECT COUNT(*) n FROM installed_agents WHERE COALESCE(builtin,0)=1");
  const firms = count(db, "SELECT COUNT(*) n FROM firms");
  const marks = count(db, "SELECT COUNT(*) n FROM hub_agent_bookmarks");
  const borrowed = count(db, "SELECT COUNT(*) n FROM borrowed_agent_careers");

  ui.ensureNl();
  ui.line(ui.c.bold(en ? "Dashboard" : "대시보드"));
  ui.line(`  ${chip(ui.c.inverse, `${en ? "agents" : "에이전트"} ${local}`)} ${chip(ui.c.dim, `builtin ${builtin}`)} ${chip(ui.c.inverse, `${en ? "firms" : "회사"} ${firms}`)} ${chip(ui.c.dim, `${en ? "bookmarks" : "북마크"} ${marks}`)} ${chip(ui.c.dim, `${en ? "borrowed" : "대여"} ${borrowed}`)}`);

  // ── 확인 필요 (D1 숨은 계약 2: 없으면 실행이 조용히 멈춘 채 정상처럼 보인다) ──
  const pending = count(db, "SELECT COUNT(*) n FROM automation_node_approvals WHERE decision NOT IN ('approved','rejected')");
  const stalled = rows(db,
    `SELECT r.id, a.name, r.status, r.last_activity_at
       FROM automation_runs r LEFT JOIN automations a ON a.id = r.automation_id
      WHERE r.status NOT IN ('ok','error','cancelled') ORDER BY COALESCE(r.last_activity_at,'') DESC LIMIT 5`);
  ui.line("");
  ui.line(ui.c.bold(en ? "Needs attention" : "확인 필요"));
  if (!pending && !stalled.length) {
    ui.line(ui.c.dim(en ? "  none — nothing is waiting on you" : "  없음 — 당신을 기다리는 실행이 없습니다"));
  } else {
    if (pending) ui.line(`  ${ui.c.amber("!")} ${en ? `${pending} approval(s) waiting` : `승인 대기 ${pending}건`}`);
    for (const s of stalled) {
      ui.line(`  ${ui.c.amber("!")} ${s.name || s.automation_id} ${ui.c.dim(`· ${s.status} · ${shortTs(s.last_activity_at)}`)}`);
    }
  }

  // ── 실행 활동 — 실패를 숨기지 않는다 ──
  const runAgg = rows(db, "SELECT status, COUNT(*) n FROM automation_runs GROUP BY status");
  const recent = rows(db,
    `SELECT r.status, r.started_at, a.name FROM automation_runs r
       LEFT JOIN automations a ON a.id = r.automation_id
      ORDER BY COALESCE(r.started_at,'') DESC LIMIT 5`);
  if (runAgg.length) {
    const failed = runAgg.find((r) => r.status === "error")?.n || 0;
    const total = runAgg.reduce((a, b) => a + b.n, 0);
    ui.line("");
    ui.line(ui.c.bold(en ? "Run activity" : "실행 활동") + " " +
      (failed ? ui.c.amber(en ? `${failed}/${total} failed` : `${total}건 중 ${failed}건 실패`) : ui.c.dim(`${total}`)));
    for (const r of recent) {
      const mark = r.status === "ok" ? ui.c.green("✓") : r.status === "error" ? ui.c.amber("✗") : ui.c.dim("·");
      ui.line(`  ${mark} ${r.name || "—"} ${ui.c.dim(shortTs(r.started_at))}`);
    }
  }

  // ── 자동화 ──
  const autoTotal = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(enabled),0) e FROM automations").get();
  const autos = rows(db, "SELECT name, enabled, next_run_at FROM automations ORDER BY enabled DESC, COALESCE(next_run_at,'') LIMIT 5");
  ui.line("");
  ui.line(ui.c.bold(en ? `Automations ${autoTotal.e}/${autoTotal.n} on` : `자동화 ${autoTotal.e}/${autoTotal.n} 켜짐`));
  for (const a of autos) {
    ui.line(`  ${a.enabled ? ui.c.green("●") : ui.c.faint("○")} ${a.name}${a.next_run_at ? ui.c.dim(`  ·  ${en ? "next" : "다음"} ${shortTs(a.next_run_at)}`) : ""}`);
  }
  if (!autos.length) ui.line(ui.c.dim(en ? "  (none — /automation add)" : "  (없음 — /automation add)"));

  // ── 사용량 상위 ──
  const usage = rows(db, "SELECT agent_key, use_count, last_used_at FROM agent_usage ORDER BY use_count DESC LIMIT 5");
  if (usage.length) {
    ui.line("");
    ui.line(ui.c.bold(en ? "Most used" : "많이 쓴 에이전트"));
    table(ui, [[en ? "agent" : "에이전트", en ? "runs" : "실행", en ? "last" : "마지막"],
      ...usage.map((u) => [u.agent_key, String(u.use_count), shortTs(u.last_used_at)])], { cap: [34, 6, 16] });
  }

  // ── 진화 제안 (승인형) ──
  const props = rows(db, "SELECT status, COUNT(*) n FROM agent_evolution_proposals GROUP BY status");
  if (props.length) {
    ui.line("");
    ui.line(ui.c.bold(en ? "Evolution proposals" : "진화 제안") + " " +
      ui.c.dim(props.map((p) => `${p.status} ${p.n}`).join(" · ")));
  }

  ui.line("");
  ui.line(ui.c.dim(en
    ? "more: /library · /marketplace · /automation list · /usage · /sessions"
    : "더 보기: /library · /marketplace · /automation list · /usage · /sessions"));
}

/* ── /library — 데스크탑 library/agents + env + mcps 를 한 화면으로 ── */
function library(ui, db, en, ctx) {
  ui.ensureNl();
  ui.line(ui.c.bold(en ? "Library" : "라이브러리"));

  const agents = rows(db,
    `SELECT slug, COALESCE(local_display_name, name) nm, role, entity_kind, builtin, trust_grade
       FROM installed_agents WHERE COALESCE(visibility,'')!='background'
      ORDER BY COALESCE(builtin,0), slug LIMIT 12`);
  const total = count(db, "SELECT COUNT(*) n FROM installed_agents WHERE COALESCE(visibility,'')!='background'");
  ui.line("");
  ui.line(ui.c.bold(en ? `Agents (${total})` : `에이전트 (${total})`));
  table(ui, [[en ? "slug" : "슬러그", en ? "name" : "이름", en ? "role" : "역할", en ? "kind" : "종류"],
    ...agents.map((a) => [a.slug, a.nm || "", a.role || "", a.builtin ? "builtin" : (a.entity_kind || "agent")])],
    { cap: [26, 24, 12, 10] });
  if (total > agents.length) ui.line(ui.c.dim(en ? `  … ${total - agents.length} more — /agents` : `  … ${total - agents.length}개 더 — /agents`));

  const mcps = rows(db, "SELECT DISTINCT agent_id FROM agent_mcp_servers LIMIT 1");
  const mcpCount = count(db, "SELECT COUNT(*) n FROM agent_mcp_servers");
  ui.line("");
  ui.line(ui.c.bold(en ? "MCP servers" : "MCP 서버") + " " + ui.c.dim(String(mcpCount)) +
    ui.c.dim(mcps.length ? "  ·  /mcp" : en ? "  ·  none configured — /mcp" : "  ·  설정 없음 — /mcp"));

  ui.line("");
  ui.line(ui.c.dim(en
    ? "env vars: /env  ·  credentials: /creds list  ·  plugins: /plugin list"
    : "환경변수: /env  ·  자격증명: /creds list  ·  플러그인: /plugin list"));
  void ctx;
}

/* ── /marketplace · /bookmarks — Hub 북마크(로컬)와 검색 안내 ── */
function marketplace(ui, db, en) {
  ui.ensureNl();
  ui.line(ui.c.bold(en ? "Hub" : "Hub 마켓플레이스"));
  const marks = rows(db,
    "SELECT slug, entity_kind, bookmarked_at, sync_state FROM hub_agent_bookmarks ORDER BY COALESCE(bookmarked_at,'') DESC LIMIT 10");
  const borrowed = rows(db,
    "SELECT slug, COALESCE(name_ko, name_en) nm, use_count, last_used_at FROM borrowed_agent_careers ORDER BY COALESCE(last_used_at,'') DESC LIMIT 5");

  ui.line("");
  ui.line(ui.c.bold(en ? `Bookmarks (${marks.length})` : `북마크 (${marks.length})`));
  if (marks.length) {
    table(ui, [[en ? "slug" : "슬러그", en ? "kind" : "종류", en ? "saved" : "저장"],
      ...marks.map((m) => [m.slug, m.entity_kind || "agent", shortTs(m.bookmarked_at)])], { cap: [34, 10, 16] });
  } else {
    ui.line(ui.c.dim(en ? "  none yet" : "  아직 없음"));
  }

  if (borrowed.length) {
    ui.line("");
    ui.line(ui.c.bold(en ? "Borrowed (Hub careers)" : "빌려 쓴 에이전트"));
    table(ui, [[en ? "slug" : "슬러그", en ? "name" : "이름", en ? "runs" : "실행", en ? "last" : "마지막"],
      ...borrowed.map((b) => [b.slug, b.nm || "", String(b.use_count || 0), shortTs(b.last_used_at)])],
      { cap: [26, 22, 6, 16] });
  }

  ui.line("");
  ui.line(ui.c.dim(en
    ? 'search: /search "<what you need>"  ·  install: /install <slug>  ·  credits: /billing'
    : '검색: /search "<필요한 것>"  ·  설치: /install <slug>  ·  크레딧: /billing'));
}

/* ── /settings — 데스크탑 settings 의 터미널 관측 (변경은 기존 명령으로) ── */
function settings(ui, db, en, ctx) {
  const { activeRuntimeRow, listAvailableCliRuntimes } = require("../runtimes/detect.cjs");
  const { resolvedModelRole } = require("../runtimes/roles.cjs");
  const prefs = ctx.prefs || {};
  ui.ensureNl();
  ui.line(ui.c.bold(en ? "Settings" : "설정"));

  const active = (() => { try { return activeRuntimeRow(db); } catch { return null; } })();
  const clis = (() => { try { return listAvailableCliRuntimes(); } catch { return []; } })();
  const orch = (() => { try { return resolvedModelRole(db, "orchestrator"); } catch { return null; } })();
  const worker = (() => { try { return resolvedModelRole(db, "worker"); } catch { return null; } })();
  const describe = (sel) => (sel ? `${sel.kind === "byok" ? sel.backend || "byok" : sel.kind}${sel.model ? `/${sel.model}` : ""}` : en ? "not set" : "미설정");

  table(ui, [
    [en ? "setting" : "항목", en ? "value" : "값"],
    [en ? "language" : "언어", prefs.language || ctx.lang || "en"],
    [en ? "permission" : "권한", prefs.permission || "write"],
    [en ? "active runtime" : "활성 런타임", active ? active.kind : (prefs.runtime || (en ? "auto" : "자동"))],
    [en ? "installed CLIs" : "설치된 CLI", clis.map((c) => c.kind).join(", ") || (en ? "none" : "없음")],
    ["orchestrator", describe(orch)],
    ["worker", describe(worker)],
  ], { cap: [18, 52] });

  ui.line("");
  ui.line(ui.c.dim(en
    ? "change: /setup (wizard) · /runtime · /model · /effort · /permission · roles set · creds · env"
    : "변경: /setup (마법사) · /runtime · /model · /effort · /permission · roles set · creds · env"));
  ui.line(ui.c.dim(en
    ? "Desktop-only here: theme, mobile pairing QR, auto-update, multimodal providers"
    : "여기서 불가(데스크탑 전용): 테마, 모바일 페어링 QR, 자동 업데이트, 멀티모달 프로바이더"));
}

module.exports = { dashboard, library, marketplace, settings, table };
