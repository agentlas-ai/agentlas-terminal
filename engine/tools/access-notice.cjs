// 도구 접근 고지 — Desktop `shared/tool-access-notice.ts`의 터미널 미러.
//
// 정본은 Desktop 쪽이고, 이 파일은 **같은 문장을 내야 한다**. 두 벌이 갈라지면 같은
// 제품이 표면마다 다른 말을 하게 되고, 사용자는 어느 쪽이 맞는지 알 수 없다.
// `test/tool-access-notice-parity.cjs`가 두 구현을 같은 입력으로 돌려 대조한다.
//
// 터미널에는 이 고지가 **아예 없었다**. 도구가 붙지 않은 실행에서 CLI는 아무 말도 하지
// 않았고, 에이전트는 "이 기계엔 도구가 없다"고 단정하거나 없는 도구를 부르거나 그냥
// 침묵했다. 도구가 없을 때가 안내가 가장 필요한 순간이다.

"use strict";

const DEFAULT_RESOLVE_TOOL = "agentlas_resolve_plugins";

/**
 * 모든 표면이 공유하는 도구 접근 고지.
 * 절대 빈 문자열을 반환하지 않는다 — 붙은 도구가 없다는 사실 자체가 정보다.
 *
 * @param {{
 *   availableTools: string[],
 *   blockedTools?: string[],
 *   pendingApprovalTools?: string[],
 *   hubCatalogAvailable: boolean,
 *   hubCatalogError?: string|null,
 *   resolveToolName?: string,
 * }} input
 * @returns {string}
 */
function buildToolAccessNotice(input) {
  const resolveTool = (input.resolveToolName || "").trim() || DEFAULT_RESOLVE_TOOL;
  const clean = (list) => (Array.isArray(list) ? list : []).filter((name) => String(name || "").trim().length > 0);
  const available = clean(input.availableTools);
  const blocked = clean(input.blockedTools);
  const pending = clean(input.pendingApprovalTools);
  const lines = [];

  lines.push(
    available.length > 0
      ? `Tools available in this run: ${available.join(", ")}.`
      : "No tools are connected in this run.",
  );

  if (pending.length > 0) {
    lines.push(
      `Already attached but switched off, waiting for the user to approve local execution: ${pending.join(", ")}. ` +
      "Ask the user to approve it instead of installing anything new.",
    );
  }

  if (input.hubCatalogAvailable) {
    lines.push(
      `Before telling the user a capability is unavailable, call ${resolveTool} with the capability you need. ` +
      "The Agentlas Hub catalog covers integrations that are not installed here yet.",
    );
  } else if (input.hubCatalogError) {
    lines.push(
      `The Agentlas Hub catalog could not be reached this run (${input.hubCatalogError}). ` +
      "Say that the catalog is unreachable rather than that no such tool exists.",
    );
  } else {
    lines.push(
      "The Agentlas Hub catalog is not reachable from this surface. " +
      "Say what you cannot do and why; do not claim a capability that is not connected.",
    );
  }

  lines.push(
    "Never install or enable a tool on your own. Show the slug, what it will be allowed to do, " +
    "and whether it needs credentials, then let the user decide.",
  );

  if (blocked.length > 0) {
    lines.push(
      `Matched but unusable until credentials are set: ${blocked.join(", ")}. ` +
      "Ask for those only if this task actually needs them.",
    );
  }

  lines.push(
    "If nothing covers the need, say so plainly. Do not describe a tool call you did not make.",
  );

  return lines.join("\n");
}

module.exports = { buildToolAccessNotice, DEFAULT_RESOLVE_TOOL };
