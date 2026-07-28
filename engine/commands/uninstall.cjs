"use strict";
/*
 * uninstall — 설치 에이전트 제거 (데스크탑 registry.uninstallAgent 동형).
 * 게이트: 설치된 회사(firm)에 속한 에이전트는 회사 관계를 먼저 정리해야 한다
 * (에이전트/챗은 그대로 남는다는 안내 포함 — 데스크탑 문구 동일).
 * 로컬 임포트 라우트도 정리하되 원본 폴더는 건드리지 않는다. 빌트인은 거부.
 */
const { findAgent } = require("../agents/registry.cjs");
const { routesMap, saveRoutes } = require("../agents/routes.cjs");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  // 동의 플래그를 슬러그보다 앞에 써도 되도록 첫 번째 비플래그 인자를 대상으로 본다.
  const token = args.find((a) => !String(a).startsWith("-"));
  if (!token) {
    ctx.err(ko ? "사용법: agentlas uninstall <agent>" : "Usage: agentlas uninstall <agent>");
    return 1;
  }
  const db = ctx.db();
  const agent = findAgent(db, token);
  if (!agent) {
    ctx.err((ko ? "에이전트를 찾을 수 없음: " : "agent not found: ") + token);
    return 1;
  }
  if (agent.builtin) {
    ctx.err(ko ? "빌트인 아키텍처 에이전트는 제거할 수 없습니다." : "Built-in architecture agents cannot be uninstalled.");
    return 1;
  }

  if (ctx.tableExists(db, "firms")) {
    const firmRows = db.prepare("SELECT id, name, ceo_agent_id, org_chart_json FROM firms").all();
    const membership = firmRows.find((firm) => {
      if (firm.ceo_agent_id === agent.id) return true;
      try {
        return JSON.parse(firm.org_chart_json || "[]").some((node) => node && node.agentId === agent.id);
      } catch {
        return false;
      }
    });
    if (membership) {
      ctx.err(ko
        ? `설치된 회사 "${membership.name}"에 속한 에이전트입니다. 회사 관계를 먼저 정리하세요; 에이전트와 대화는 그대로 남습니다.`
        : `Agent belongs to installed firm "${membership.name}". Remove the firm relationship first; the agent and its chats will stay installed.`);
      return 1;
    }
  }

  /*
   * 대화 파괴 게이트 — bootstrap-schema.sql:50 chats.agent_id 는
   * `ON DELETE CASCADE`, :61 chat_messages.chat_id 도 CASCADE 다. 즉
   * installed_agents 행 하나를 지우면 그 에이전트의 모든 챗과 메시지가 같이
   * 사라진다(데스크탑과 공유하는 SQLite라 데스크탑 쪽 이력도 함께 증발한다).
   * 그런데 이 명령은 그 사실을 한 줄도 알리지 않고 `✓ 제거됨`만 찍었다 —
   * 되돌릴 수 없는 삭제가 무고지·무확인으로 일어나던 자리다.
   * 그래서 지우기 "전에" 파급 건수를 세고, 대화가 있으면 명시적 동의
   * (--yes/-y/--force) 없이는 아무것도 지우지 않는다. 대화가 0건이면
   * 파괴할 이력이 없으므로 종전대로 그냥 진행한다(불필요한 마찰 금지).
   */
  const consented = args.some((a) => a === "--yes" || a === "-y" || a === "--force");
  let chatCount = 0;
  let messageCount = 0;
  if (ctx.tableExists(db, "chats")) {
    chatCount = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE agent_id=?").get(agent.id).n;
    if (chatCount && ctx.tableExists(db, "chat_messages")) {
      messageCount = db.prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE agent_id=?)",
      ).get(agent.id).n;
    }
  }
  if (chatCount && !consented) {
    ctx.err(ko
      ? `"${agent.slug}" 제거는 대화 ${chatCount}개와 메시지 ${messageCount}개를 함께 영구 삭제합니다 (데스크탑 앱과 공유하는 DB이며 되돌릴 수 없습니다).\n계속하려면: agentlas uninstall ${agent.slug} --yes`
      : `Uninstalling "${agent.slug}" will also permanently delete ${chatCount} chat(s) and ${messageCount} message(s) (shared with the Desktop app; this cannot be undone).\nRe-run to confirm: agentlas uninstall ${agent.slug} --yes`);
    return 1;
  }

  let deleted = false;
  runWriteTransaction(db, () => {
    deleted = db.prepare("DELETE FROM installed_agents WHERE id=?").run(agent.id).changes > 0;
  });
  if (deleted) {
    // 로컬 임포트 라우팅도 정리 (원본 폴더는 건드리지 않음) — 데스크탑 removeRoute 동형.
    try {
      const routes = routesMap();
      if (routes[agent.id]) {
        delete routes[agent.id];
        saveRoutes(routes);
      }
    } catch { /* 라우트 정리는 best-effort */ }
    // 실제로 무엇이 사라졌는지 성공 줄에 남긴다 — 조용한 파괴 금지.
    const cascade = chatCount
      ? (ko ? ` (대화 ${chatCount}개 · 메시지 ${messageCount}개 삭제됨)` : ` (deleted ${chatCount} chat(s), ${messageCount} message(s))`)
      : "";
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "제거됨" : "Uninstalled"}: ${agent.slug}${cascade}`);
    return 0;
  }
  ctx.err(ko ? "제거하지 못했습니다." : "Nothing was uninstalled.");
  return 1;
}

module.exports = { run };
