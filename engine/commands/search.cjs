"use strict";
/*
 * search — Hub 에이전트 디렉터리 검색 (hep-search 표면).
 * 로그인 없이도 동작한다(쿠키는 있으면 첨부). 결과 위장/폴백 카탈로그 금지 —
 * Hub가 실패하면 그 실패를 그대로 보고한다.
 */
const { callHubTool, HubError } = require("../cloud/hub-client.cjs");

/** 엔진 내부 에이전트는 제품이 아니므로 검색 결과에서 숨긴다 (v1과 동일 규칙). */
function isInternalAgentSlug(slug) {
  const s = String(slug || "").toLowerCase();
  return /^researcher-\d+/.test(s) || s === "research-intelligence-desk" || s.startsWith("hephaestus-");
}

async function run(ctx, args) {
  let limit = 10;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = Math.max(1, Math.min(30, Number(args[++i]) || 10));
    else rest.push(args[i]);
  }
  const query = rest.join(" ").trim();
  if (!query) {
    ctx.err('usage: agentlas search "<what you need>" [--limit 10]');
    return 1;
  }

  let result;
  try {
    // Hub 파라미터 이름은 `q` — 데스크탑 mcp-source.ts와 동일하게 q/query 둘 다 전송.
    result = await callHubTool("marketplace.search_agents", { q: query, query, limit });
  } catch (e) {
    ctx.err(e instanceof HubError ? e.message : `Marketplace connection failed: ${(e && e.message) || e}`);
    return 1;
  }

  const raw = (result && (result.results || result.agents || result.items)) || (Array.isArray(result) ? result : null);
  const items = Array.isArray(raw) ? raw.filter((it) => !isInternalAgentSlug(it && (it.slug || it.id))) : [];
  if (!items.length) {
    ctx.out(`No results for "${query}"`);
    return 0;
  }
  for (const it of items.slice(0, limit)) {
    const slug = it.slug || it.id || "?";
    const name = it.name || it.title || slug;
    const kind = it.kind || it.entity_kind || "";
    const tagline = it.tagline || it.description || "";
    ctx.out(`${ctx.ui.accent(String(slug).padEnd(34).slice(0, 34))} ${String(name).slice(0, 26).padEnd(27)} ${ctx.ui.dim(String(kind).padEnd(14))} ${String(tagline).slice(0, 60)}`);
  }
  ctx.out("");
  ctx.out(ctx.ui.dim("Install: agentlas install <slug>"));
  return 0;
}

module.exports = { run, isInternalAgentSlug };
