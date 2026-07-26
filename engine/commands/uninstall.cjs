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
  const token = args[0];
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
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "제거됨" : "Uninstalled"}: ${agent.slug}`);
    return 0;
  }
  ctx.err(ko ? "제거하지 못했습니다." : "Nothing was uninstalled.");
  return 1;
}

module.exports = { run };
