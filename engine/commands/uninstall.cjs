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

/**
 * 이 DB 에서 에이전트를 지우면 그 대화도 함께 사라지는가.
 *
 * `chats.agent_id` 의 삭제 동작이 답이다. 좌석-세션 이전 스키마는 `CASCADE`(대화도 삭제),
 * 이후는 `SET NULL`(자리만 비고 대화는 보존). 이 CLI 는 데스크탑과 같은 파일을 쓰고 그
 * 파일의 사다리 위치는 기기마다 다르므로, 스키마 번호나 코드가 쓰인 시점이 아니라
 * **열려 있는 파일**에 물어야 한다.
 */
function chatDeletionCascadesFromAgent(db) {
  try {
    const rows = db.prepare("SELECT \"table\" AS parent, \"from\" AS child, \"on_delete\" AS onDelete FROM pragma_foreign_key_list('chats')").all();
    const link = rows.find((row) => row.child === "agent_id" && row.parent === "installed_agents");
    // 관계가 없으면 지워도 대화가 따라가지 않는다 — 파괴를 예고하지 않는다.
    return String(link && link.onDelete || "").toUpperCase() === "CASCADE";
  } catch {
    // 물어볼 수 없으면 보수적으로 파괴한다고 본다 — 동의를 한 번 더 묻는 쪽이 안전하다.
    return true;
  }
}

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const consentFlags = new Set(["--yes", "-y", "--force"]);
  const unknownOptions = args.filter((arg) => String(arg).startsWith("-") && !consentFlags.has(arg));
  const tokens = args.filter((arg) => !String(arg).startsWith("-"));
  const confirmations = args.filter((arg) => consentFlags.has(arg));
  if (unknownOptions.length || tokens.length !== 1 || confirmations.length > 1) {
    const error = new Error(ko
      ? "사용법: agentlas uninstall <agent> [--yes]"
      : "Usage: agentlas uninstall <agent> [--yes]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const token = tokens[0];
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
   * 대화 파괴 게이트 — **파괴가 실제로 일어나는 스키마에서만.**
   *
   * 예전에는 `chats.agent_id` 가 `ON DELETE CASCADE` 였다. 그래서 에이전트 한 행을 지우면
   * 그 대화와 메시지가 함께 사라졌고, 이 명령은 그 사실을 한 줄도 알리지 않고 `✓ 제거됨`만
   * 찍었다 — 되돌릴 수 없는 삭제가 무고지로 일어나던 자리였고, 그래서 이 게이트가 생겼다.
   *
   * 좌석-세션 이후 그 제약은 `ON DELETE SET NULL` 로 내려갔다. 에이전트를 지우는 것은
   * 이제 **자리를 비우는 일**이고 대화는 그대로 남는다(오너 정본: 봇 삭제 = 자리 비우기).
   * 그런데 이 명령은 계속 "영구 삭제합니다" 라고 경고하고 "삭제됨" 이라고 보고했다 —
   * 지켜지지 않는 약속의 반대, 즉 **일어나지 않은 파괴를 보고하는 거짓말**이다. 사용자는
   * 남아 있는 이력을 잃었다고 믿고, 잃지 않아도 될 동의를 강요받는다.
   *
   * 그래서 문구를 새 스키마에 맞춰 바꿔 쓰지 않는다. 이 CLI 는 데스크탑과 **같은 파일**을
   * 쓰고 그 파일의 스키마는 기기마다 다르다 — 아직 옛 사다리에 있는 기기에서는 파괴가
   * 여전히 사실이다. 판단은 열려 있는 DB 의 외래키에서 읽는다.
   */
  const consented = confirmations.length === 1;
  const cascades = ctx.tableExists(db, "chats") && chatDeletionCascadesFromAgent(db);
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
  if (chatCount && cascades && !consented) {
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
    // 실제로 무엇이 일어났는지만 적는다 — 지웠으면 지웠다고, 남겼으면 남겼다고.
    const cascade = !chatCount
      ? ""
      : cascades
        ? (ko ? ` (대화 ${chatCount}개 · 메시지 ${messageCount}개 삭제됨)` : ` (deleted ${chatCount} chat(s), ${messageCount} message(s))`)
        : (ko ? ` (대화 ${chatCount}개 · 메시지 ${messageCount}개는 그대로 남습니다 — 자리만 비었습니다)` : ` (kept ${chatCount} chat(s) and ${messageCount} message(s) — the seat is now empty)`);
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "제거됨" : "Uninstalled"}: ${agent.slug}${cascade}`);
    return 0;
  }
  ctx.err(ko ? "제거하지 못했습니다." : "Nothing was uninstalled.");
  return 1;
}

module.exports = { run };
