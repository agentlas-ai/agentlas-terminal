"use strict";

/*
 * experience/build — /build 공용 핸들러 (REPL·상위 build 명령이 같은 코드를 호출).
 *
 * v1 engine/agentlas-experience-mcp.cjs의 cmdBuild/parseBuildArgs/
 * tokenizeBuildCommandLine 슬라이스를 이식했다. MCP 계획·동의·런타임
 * allowlist는 v2 engine/mcp/* 서브시스템을 "소비만" 한다(재구현 금지).
 *
 * 계약(v1 그대로):
 *  - MCP는 시스템 전역 레지스트리 메타데이터에서만 해소한다. 네트워크 발견/설치
 *    폴백 없음. 부족(shortage)은 빌드를 중단시키지 않고 능력별로 degrade한다.
 *  - 로컬 Experience 자문은 exact base release + 정확히 1개 pack release +
 *    task signature가 모두 명시된 때에만 붙는다. 서버 rental-resolution
 *    영수증을 로컬에서 주장하지 않는다.
 */

const mcp = require("../mcp/index.cjs");
const { assertId } = require("./intents.cjs");

function parseIdList(value) {
  if (!value || value === true) return [];
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function tokenizeBuildCommandLine(value) {
  const tokens = [];
  let current = "";
  let quote = null;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && quote !== "'") {
      const next = source[index + 1];
      if (next && (/\s/.test(next) || next === "\\" || next === '"' || next === "'")) {
        current += next;
        index += 1;
      } else {
        // Windows 경로/일반 백슬래시 보존. 이 파서는 토큰 묶기에 필요한
        // 이스케이프만 소비하며 셸 확장/명령 치환은 절대 적용하지 않는다.
        current += "\\";
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current), (current = "");
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote in /build command");
  if (current) tokens.push(current);
  return tokens;
}

function parseBuildArgs(args) {
  const buildArgs = args;
  const options = {
    task: [], requiredIds: [], recommendedIds: [], approvedIds: [],
    experienceTaskSignatures: [], experienceEnvironmentTags: [],
    experiencePackReleaseIds: [], experienceBaseReleaseId: null, experienceAgentDefinitionId: null,
    approveAll: false, noMcp: false, noExperience: false, planOnly: false, json: false,
  };
  for (let index = 0; index < buildArgs.length; index += 1) {
    const token = String(buildArgs[index]);
    const take = () => (index + 1 < buildArgs.length ? String(buildArgs[++index]) : "");
    if (token === "--mcp-plan-only") options.planOnly = true;
    else if (token === "--mcp-json") options.json = true;
    else if (token === "--approve-all-mcp") options.approveAll = true;
    else if (token === "--no-mcp") options.noMcp = true;
    else if (token === "--no-experience") options.noExperience = true;
    else if (token === "--experience-base-release") options.experienceBaseReleaseId = take();
    else if (token.startsWith("--experience-base-release=")) options.experienceBaseReleaseId = token.slice(26);
    else if (token === "--experience-pack-release") options.experiencePackReleaseIds.push(...parseIdList(take()));
    else if (token.startsWith("--experience-pack-release=")) options.experiencePackReleaseIds.push(...parseIdList(token.slice(26)));
    else if (token === "--experience-agent-definition") options.experienceAgentDefinitionId = take();
    else if (token.startsWith("--experience-agent-definition=")) options.experienceAgentDefinitionId = token.slice(30);
    else if (token === "--experience-task-signature") options.experienceTaskSignatures.push(...parseIdList(take()));
    else if (token.startsWith("--experience-task-signature=")) options.experienceTaskSignatures.push(...parseIdList(token.slice(28)));
    else if (token === "--experience-environment") options.experienceEnvironmentTags.push(...parseIdList(take()));
    else if (token.startsWith("--experience-environment=")) options.experienceEnvironmentTags.push(...parseIdList(token.slice(25)));
    else if (token === "--approve-mcp") options.approvedIds.push(...parseIdList(take()));
    else if (token.startsWith("--approve-mcp=")) options.approvedIds.push(...parseIdList(token.slice(14)));
    else if (token === "--require-mcp") options.requiredIds.push(...parseIdList(take()));
    else if (token.startsWith("--require-mcp=")) options.requiredIds.push(...parseIdList(token.slice(14)));
    else if (token === "--recommend-mcp") options.recommendedIds.push(...parseIdList(take()));
    else if (token.startsWith("--recommend-mcp=")) options.recommendedIds.push(...parseIdList(token.slice(16)));
    else options.task.push(token);
  }
  options.request = options.task.join(" ").trim();
  options.requiredIds = [...new Set(options.requiredIds)];
  options.recommendedIds = [...new Set(options.recommendedIds)];
  options.approvedIds = [...new Set(options.approvedIds)];
  options.experienceTaskSignatures = [...new Set(options.experienceTaskSignatures)];
  options.experienceEnvironmentTags = [...new Set(options.experienceEnvironmentTags)];
  options.experiencePackReleaseIds = [...new Set(options.experiencePackReleaseIds)];
  if (options.experienceBaseReleaseId) assertId(options.experienceBaseReleaseId, "--experience-base-release");
  if (options.experienceAgentDefinitionId) assertId(options.experienceAgentDefinitionId, "--experience-agent-definition");
  options.experiencePackReleaseIds.forEach((id) => assertId(id, "--experience-pack-release"));
  return options;
}

async function cmdBuild(options) {
  const parsed = parseBuildArgs(options.args || []);
  const emit = options.out || console.log;
  const inventory = mcp.collectSystemMcpInventory(options.db, { userDataDir: options.userDataDir, env: options.env || process.env });
  const policy = mcp.loadProjectMcpPolicy(options.cwd || process.cwd());
  // 명시적 요구(정책/플래그)가 하나도 없을 때만 추론 — 판정기(연결 모델) 경유이며,
  // 판정 불가면 빈 목록(중립)이다. 휴리스틱 정규식은 판정 힌트로만 실린다.
  const explicitRequirementCount =
    ((policy && policy.requirements) || []).length + parsed.requiredIds.length + parsed.recommendedIds.length;
  const inferredRequirements = explicitRequirementCount === 0
    ? await mcp.inferRequirements(parsed.request, inventory)
    : [];
  const plan = mcp.buildMcpPlan({
    inventory, policy, request: parsed.request,
    requiredIds: parsed.requiredIds, recommendedIds: parsed.recommendedIds,
    inferredRequirements,
  });
  emit(parsed.json ? JSON.stringify(plan, null, 2) : mcp.renderMcpPlan(plan));
  if (parsed.planOnly) return { plan, approvedIds: [], invoked: false };

  let approvedIds = [];
  if (!parsed.noMcp) {
    if (parsed.approveAll) approvedIds = [...plan.availableCatalogIds];
    else if (parsed.approvedIds.length) approvedIds = mcp.normalizeConsentAnswer(parsed.approvedIds.join(","), plan.availableCatalogIds);
    else approvedIds = await mcp.askMcpConsentOnce(plan, {
      db: options.db,
      input: options.input,
      output: options.promptOutput,
    });
  }
  approvedIds = mcp.fitApprovedMcpIds(plan, approvedIds);
  const runtimeAllowlist = await mcp.resolveApprovedMcpRuntimeAllowlist({
    db: options.db,
    plan,
    approvedIds,
    cwd: options.cwd || process.cwd(),
    userDataDir: options.userDataDir,
    env: options.runtimeEnv || options.env || process.env,
    probeServer: options.probeMcpServer,
  });
  const attachedIds = runtimeAllowlist.attached.map((item) => item.catalogId);
  const directive = mcp.buildMcpDirective(plan, attachedIds);
  let experienceContext = { text: "", itemIds: [], estimatedTokens: 0, authority: "local-advisory", serverRentalResolutionReceiptPresent: false };
  if (
    !parsed.noExperience &&
    parsed.experienceBaseReleaseId &&
    parsed.experienceTaskSignatures.length &&
    parsed.experiencePackReleaseIds.length === 1
  ) {
    const exchange = require("../agentlas-experience-exchange.cjs");
    experienceContext = exchange.buildLocalExperienceAdvisory({
      userDataDir: options.userDataDir,
      cwd: options.cwd || process.cwd(),
      baseAgentReleaseId: parsed.experienceBaseReleaseId,
      agentDefinitionId: parsed.experienceAgentDefinitionId,
      experiencePackReleaseIds: parsed.experiencePackReleaseIds,
      taskSignatures: parsed.experienceTaskSignatures,
      environmentTags: parsed.experienceEnvironmentTags.length
        ? parsed.experienceEnvironmentTags
        : exchange.defaultEnvironmentTags(),
    });
  }
  const builderRequest = [parsed.request, directive, experienceContext.text].filter(Boolean).join("\n\n");
  if (typeof options.invokeBuild === "function") {
    await options.invokeBuild(builderRequest, {
      plan,
      approvedIds,
      experienceContext,
      mcpRuntimeAllowlist: runtimeAllowlist,
      mcpServers: runtimeAllowlist.servers,
    });
  }
  emit(mcp.renderBuildMcpResult(plan, approvedIds, runtimeAllowlist));
  if (experienceContext.itemIds.length) emit(`Local Experience advisory attached: ${experienceContext.itemIds.length} item(s), ~${experienceContext.estimatedTokens} tokens · no server rental-resolution receipt.`);
  return { plan, approvedIds, mcpRuntimeAllowlist: runtimeAllowlist, experienceContext, invoked: typeof options.invokeBuild === "function" };
}

module.exports = {
  tokenizeBuildCommandLine,
  parseBuildArgs,
  cmdBuild,
};
