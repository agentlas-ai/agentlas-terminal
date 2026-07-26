"use strict";
/* usage — 로컬 사용 현황 요약 (공유 DB 읽기 전용). 공급자 쿼터 대시보드는 데스크탑 소관. */
const { listAgents } = require("../agents/registry.cjs");

function run(ctx) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  const day = new Date(Date.now() - 86400000).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const q = (sql, ...p) => {
    try { return db.prepare(sql).get(...p) || {}; } catch { return {}; }
  };
  const ar = q("SELECT kind FROM active_runtime WHERE id=1");
  const agents = { n: listAgents(db).length };
  const chats = q("SELECT COUNT(*) AS n FROM chats WHERE archived_at IS NULL");
  const msg24 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", day);
  const msg7 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", week);
  const auto = q("SELECT COUNT(*) AS n FROM automations WHERE enabled=1");
  const runs7 = q("SELECT COUNT(*) AS n, SUM(CASE WHEN status='error' OR error IS NOT NULL THEN 1 ELSE 0 END) AS err FROM run_history WHERE ran_at > ?", week);
  ctx.out(ko ? `활성 런타임      ${ar.kind || "(없음)"}` : `Active runtime    ${ar.kind || "(none)"}`);
  ctx.out(ko ? `설치 에이전트    ${agents.n ?? "?"}` : `Installed agents  ${agents.n ?? "?"}`);
  ctx.out(ko ? `활성 대화        ${chats.n ?? "?"}` : `Active chats      ${chats.n ?? "?"}`);
  ctx.out(ko ? `메시지           24시간 ${msg24.n ?? 0}  ·  7일 ${msg7.n ?? 0}` : `Messages          24h ${msg24.n ?? 0}  ·  7d ${msg7.n ?? 0}`);
  ctx.out(ko ? `자동화           ${auto.n ?? 0}` : `Automations       ${auto.n ?? 0}`);
  ctx.out(ko
    ? `실행(7일)        ${runs7.n ?? 0}${runs7.err ? `  (실패 ${runs7.err})` : ""}`
    : `Runs (7d)         ${runs7.n ?? 0}${runs7.err ? `  (${runs7.err} failed)` : ""}`);
  ctx.out("");
  ctx.out(ctx.ui.dim(ko
    ? "세션 토큰·비용은 대화에서 /cost로 확인합니다. 공급자 할당량 대시보드는 Desktop에 있습니다."
    : "Session tokens/cost: /cost in chat. Provider quota dashboards are in Desktop."));
  return 0;
}

module.exports = { run };
