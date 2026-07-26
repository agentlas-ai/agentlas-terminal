"use strict";
/*
 * cloud-assets/cargo — Agent Cloud(cargo.*) MCP tool 얇은 래퍼.
 *
 * cargo.*는 소유자 세션이 필요한 유일한 도구군이다(마켓 검색과 달리).
 * 여기서는 어떤 폴백/로컬 위장도 하지 않는다 — 서버 거절(insufficient_credits,
 * agent_not_found 등)은 그대로 중계한다.
 */
const { callHubTool } = require("../cloud/hub-client.cjs");

function ownerCall(name, args) {
  return callHubTool(name, args, { requireSession: true });
}

/** 소유 자산 검색 (q="" = 전체 나열). */
function cargoSearchAgents(args = {}) {
  return ownerCall("cargo.search_agents", args);
}

/** 소유 자산 나열 — 서버에 별도 list 도구가 없으면 빈 질의 검색과 동치다. */
function cargoListAgents(limit = 100) {
  const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 100));
  return ownerCall("cargo.search_agents", { q: "", limit: safeLimit });
}

function cargoGetManifest(slug) {
  return ownerCall("cargo.get_manifest", { slug });
}

function cargoRestorePackage(slug) {
  return ownerCall("cargo.restore_package", { slug });
}

function cargoSaveCombination(payload) {
  return ownerCall("cargo.save_combination", payload || {});
}

function cargoDeleteAgent(slug) {
  return ownerCall("cargo.delete_agent", { slug });
}

module.exports = {
  cargoSearchAgents,
  cargoListAgents,
  cargoGetManifest,
  cargoRestorePackage,
  cargoSaveCombination,
  cargoDeleteAgent,
};
