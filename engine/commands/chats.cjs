"use strict";
/* chats [n] — 최근 대화 목록 (공유 DB, 데스크탑과 동일 데이터). */

function run(ctx, args) {
  const n = Math.max(1, Math.min(100, Number(args[0]) || 15));
  const db = ctx.db();
  if (!ctx.tableExists(db, "chats")) {
    ctx.out(ctx.lang === "en" ? "No chats yet." : "대화가 아직 없습니다.");
    return 0;
  }
  const rows = db.prepare(
    `SELECT c.id, c.title, c.updated_at, a.slug AS agent_slug
       FROM chats c LEFT JOIN installed_agents a ON a.id = c.agent_id
      WHERE c.archived_at IS NULL AND (c.kind IS NULL OR c.kind = 'user')
      ORDER BY c.updated_at DESC LIMIT ?`,
  ).all(n);
  if (!rows.length) {
    ctx.out(ctx.lang === "en" ? "No chats yet." : "대화가 아직 없습니다.");
    return 0;
  }
  for (const r of rows) {
    const when = String(r.updated_at || "").replace("T", " ").slice(0, 16);
    ctx.out(`  ${ctx.ui.dim(when)}  ${ctx.ui.accent((r.agent_slug || "?").padEnd(20))} ${r.title}`);
  }
  return 0;
}

module.exports = { run };
