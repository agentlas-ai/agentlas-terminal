"use strict";
/*
 * mcp/index — v1 engine/agentlas-experience-mcp.cjs의 MCP 서브시스템 후계 표면.
 *
 * v1 모놀리스가 export하던 MCP 관련 이름/동작을 그대로 재수출한다(계약 테스트가
 * 이 이름에 의존한다). 경험(Experience) 인텐트·빌드 인자 파싱·variant 해소는
 * MCP 관심사가 아니므로 여기 없다 — 각자의 v2 모듈로 이관된다.
 */
const inventory = require("./inventory.cjs");
const probe = require("./probe.cjs");
const plan = require("./plan.cjs");
const consent = require("./consent.cjs");

module.exports = {
  // inventory — 시스템 전역 레지스트리 + 프로젝트 정책
  TOKEN_BUDGET: inventory.TOKEN_BUDGET,
  validateMcpRequirement: inventory.validateMcpRequirement,
  validateMcpPolicy: inventory.validateMcpPolicy,
  loadProjectMcpPolicy: inventory.loadProjectMcpPolicy,
  collectSystemMcpInventory: inventory.collectSystemMcpInventory,
  materializeTrustedSystemMcpServer: inventory.materializeTrustedSystemMcpServer,
  readApprovedSystemMcpServer: inventory.readApprovedSystemMcpServer,
  // probe — stdio 연결 프리플라이트
  MCP_PROBE_CONCURRENCY: probe.MCP_PROBE_CONCURRENCY,
  MCP_PROBE_PER_SERVER_TIMEOUT_MS: probe.MCP_PROBE_PER_SERVER_TIMEOUT_MS,
  MCP_PROBE_TOTAL_TIMEOUT_MS: probe.MCP_PROBE_TOTAL_TIMEOUT_MS,
  probeSystemMcpServerConnection: probe.probeSystemMcpServerConnection,
  // plan — 요구사항 해소 + 빌드 플랜 + 빌더 지시문
  resolveMcpRequirement: plan.resolveMcpRequirement,
  buildMcpPlan: plan.buildMcpPlan,
  renderMcpPlan: plan.renderMcpPlan,
  fitApprovedMcpIds: plan.fitApprovedMcpIds,
  buildMcpDirective: plan.buildMcpDirective,
  renderBuildMcpResult: plan.renderBuildMcpResult,
  // consent — 1회 동의 + 영수증 + 런타임 allowlist
  mcpConsentStatePath: consent.mcpConsentStatePath,
  loadMcpConsentState: consent.loadMcpConsentState,
  persistMcpConsentReceipts: consent.persistMcpConsentReceipts,
  readConsentedSystemMcpServers: consent.readConsentedSystemMcpServers,
  normalizeConsentAnswer: consent.normalizeConsentAnswer,
  askMcpConsentOnce: consent.askMcpConsentOnce,
  resolveApprovedMcpRuntimeAllowlist: consent.resolveApprovedMcpRuntimeAllowlist,
};
