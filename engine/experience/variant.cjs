"use strict";

/*
 * experience/variant — `agentlas variant resolve` 로컬 자문 해소기.
 *
 * v1 engine/agentlas-experience-mcp.cjs의 cmdVariant 슬라이스 이식.
 * 결정 어휘는 계약이라 절대 변경 금지: selected | fallback | base-only | error.
 *
 * 권위 경계(v1 그대로):
 *  - authority는 항상 "local-advisory"다. executionAuthorized/reputationAccepted/
 *    serverResolutionReceiptPresent 는 로컬에서 절대 true가 될 수 없다 —
 *    Hub 렌탈은 Web 서버 해소 영수증을 요구한다.
 *  - required MCP 부족은 해당 variant만 제외한다(에이전트 전체 부족으로
 *    승격 금지, requiredMcpFailureScope: "variant-only").
 */

const path = require("node:path");
const { collectSystemMcpInventory } = require("../mcp/inventory.cjs");
const { indexInventory, resolveMcpRequirement } = require("../mcp/plan.cjs");
const {
  assertObject,
  assertExactKeys,
  assertId,
  assertSafeText,
  validateMcpRequirement,
  readJsonFile,
} = require("./intents.cjs");

const MAX_VARIANT_CANDIDATES = 512;

function parseVariantFlags(args) {
  const flags = { _: [] };
  const seen = new Set();
  const valueFlags = new Set(["base-release", "prefer", "candidates"]);
  const booleanFlags = new Set(["json", "no-base-only"]);
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (positionalOnly) {
      flags._.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }
    const at = token.indexOf("=");
    const key = token.slice(2, at < 0 ? undefined : at);
    if (!valueFlags.has(key) && !booleanFlags.has(key)) throw new Error(`unknown variant option: --${key}`);
    if (seen.has(key)) throw new Error(`duplicate variant option: --${key}`);
    seen.add(key);
    if (booleanFlags.has(key)) {
      if (at >= 0) throw new Error(`--${key} does not take a value`);
      flags[key] = true;
      continue;
    }
    const value = at >= 0 ? token.slice(at + 1) : String(args[++index] ?? "");
    if (!value || (at < 0 && value.startsWith("--"))) throw new Error(`--${key} requires a value`);
    flags[key] = value;
  }
  if (flags._.length > 1) throw new Error("variant resolve accepts at most one candidates.json path");
  if (flags.candidates && flags._.length) throw new Error("choose either --candidates or a positional candidates.json path");
  return flags;
}

function validateVariantCandidate(candidate, index) {
  const allowed = new Set(["variantId", "baseAgentReleaseId", "experiencePackReleaseId", "status", "compatibilityStatus", "score", "mcpRequirements"]);
  assertExactKeys(candidate, allowed, ["variantId", "baseAgentReleaseId", "experiencePackReleaseId", "status", "compatibilityStatus", "score", "mcpRequirements"], `candidate[${index}]`);
  for (const key of ["variantId", "baseAgentReleaseId", "experiencePackReleaseId"]) assertId(candidate[key], `candidate[${index}].${key}`);
  const requirements = candidate.mcpRequirements == null ? [] : candidate.mcpRequirements;
  if (!Array.isArray(requirements) || requirements.length > 64) throw new Error(`candidate[${index}].mcpRequirements is invalid`);
  requirements.forEach((requirement, requirementIndex) => validateMcpRequirement(requirement, `candidate[${index}].mcpRequirements[${requirementIndex}]`));
  const score = Number(candidate.score);
  if (!Number.isFinite(score) || score < 0 || score > 1_000_000) throw new Error(`candidate[${index}].score is outside the local-preview range`);
  return {
    variantId: candidate.variantId,
    baseAgentReleaseId: candidate.baseAgentReleaseId,
    experiencePackReleaseId: candidate.experiencePackReleaseId,
    status: assertSafeText(candidate.status || "draft", `candidate[${index}].status`, 64),
    compatibilityStatus: assertSafeText(candidate.compatibilityStatus || "unverified", `candidate[${index}].compatibilityStatus`, 64),
    score,
    mcpRequirements: requirements,
  };
}

function resolveVariantCandidates(options) {
  if (!options || !Array.isArray(options.candidates || [])) throw new Error("variant candidates must be an array");
  if ((options.candidates || []).length > MAX_VARIANT_CANDIDATES) throw new Error("too many variant candidates");
  const candidates = (options.candidates || []).map(validateVariantCandidate);
  const candidateIds = candidates.map((candidate) => candidate.variantId);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error("variantId values must be unique");
  const inventoryById = indexInventory(options.inventory || []);
  if (!options.baseAgentReleaseId) {
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision: "error",
      code: "EXACT_BASE_RELEASE_REQUIRED",
      selectedVariantId: null,
      baseAgentReleaseId: null,
      experiencePackReleaseId: null,
      fallbackOrder: [],
      degradedMcpIds: [],
      excluded: [],
      requiredMcpFailureScope: "variant-only",
    };
  }
  assertId(options.baseAgentReleaseId, "baseAgentReleaseId");
  if (options.preferredVariantId) assertId(options.preferredVariantId, "preferredVariantId");
  const excluded = [];
  const eligible = [];
  for (const candidate of candidates) {
    const reasons = [];
    if (candidate.status !== "active") reasons.push(`variant-status:${candidate.status}`);
    if (candidate.compatibilityStatus !== "verified") reasons.push(`compatibility:${candidate.compatibilityStatus}`);
    if (options.baseAgentReleaseId && candidate.baseAgentReleaseId !== options.baseAgentReleaseId) reasons.push("base-release-mismatch");
    const degradedMcpIds = [];
    for (const requirement of candidate.mcpRequirements) {
      const resolution = resolveMcpRequirement(requirement, inventoryById);
      if (resolution.status !== "available" && requirement.required) reasons.push(`required-mcp-${resolution.status}:${requirement.catalogId}`);
      else if (resolution.status !== "available") degradedMcpIds.push(requirement.catalogId);
    }
    if (reasons.length) excluded.push({ variantId: candidate.variantId, reasons });
    else eligible.push({ ...candidate, degradedMcpIds });
  }
  eligible.sort((a, b) => b.score - a.score || a.variantId.localeCompare(b.variantId));
  const selected = eligible[0] || null;
  const baseRelease = options.baseAgentReleaseId;
  if (selected) {
    const decision = options.preferredVariantId && options.preferredVariantId !== selected.variantId ? "fallback" : "selected";
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision,
      selectedVariantId: selected.variantId,
      baseAgentReleaseId: selected.baseAgentReleaseId,
      experiencePackReleaseId: selected.experiencePackReleaseId,
      fallbackOrder: eligible.slice(1).map((candidate) => candidate.variantId),
      degradedMcpIds: selected.degradedMcpIds,
      excluded,
      requiredMcpFailureScope: "variant-only",
    };
  }
  if (options.allowBaseOnly !== false && baseRelease) {
    return {
      schemaVersion: "agentlas.terminal-variant-resolution.v1",
      authority: "local-advisory",
      executionAuthorized: false,
      reputationAccepted: false,
      serverResolutionReceiptPresent: false,
      decision: "base-only",
      selectedVariantId: null,
      baseAgentReleaseId: baseRelease,
      experiencePackReleaseId: null,
      fallbackOrder: [],
      degradedMcpIds: [],
      excluded,
      requiredMcpFailureScope: "variant-only",
    };
  }
  return {
    schemaVersion: "agentlas.terminal-variant-resolution.v1",
    authority: "local-advisory",
    executionAuthorized: false,
    reputationAccepted: false,
    serverResolutionReceiptPresent: false,
    decision: "error",
    code: "NO_ELIGIBLE_VARIANT_AND_NO_BASE_FALLBACK",
    selectedVariantId: null,
    baseAgentReleaseId: baseRelease,
    experiencePackReleaseId: null,
    fallbackOrder: [],
    degradedMcpIds: [],
    excluded,
    requiredMcpFailureScope: "variant-only",
  };
}

/*
 * usage/설명은 사람 출력 전용이다 — JSON 결과(schemaVersion v1)와 decision 어휘는
 * 손대지 않는다. README·`agentlas help`가 광고하는 `agentlas variant resolve`는
 * 인자 없이 부르면 항상 decision=error 로 끝나는데, 그동안 사람에게 보인 건
 * 내부 enum 한 줄(`error: EXACT_BASE_RELEASE_REQUIRED`) 뿐이라 필요한 플래그
 * 이름이 소스 주석에만 존재했다. 그래서 (1) error 코드마다 사람이 읽고 바로
 * 고칠 수 있는 사유 + usage 를 붙이고, (2) help 서브커맨드를 뚫는다.
 */
const VARIANT_USAGE_LINES = Object.freeze([
  "usage: agentlas variant resolve [candidates.json] [--base-release <agent-release-id>]",
  "                                [--prefer <variant-id>] [--no-base-only] [--json]",
  "  --base-release <id>  required: the exact base agent release to resolve against.",
  "                       May instead come from candidates.json's baseAgentReleaseId.",
  "  candidates.json      variant candidates: a JSON array, or {baseAgentReleaseId, candidates[]}.",
  "  --prefer <id>        preferred variant; picking another one reports decision=fallback.",
  "  --no-base-only       fail instead of falling back to the base release with no Experience Pack.",
  "  --json               emit the agentlas.terminal-variant-resolution.v1 document.",
  "Local advisory preview only: it never authorizes execution, rental, or reputation.",
]);

const VARIANT_ERROR_HINTS = Object.freeze({
  EXACT_BASE_RELEASE_REQUIRED:
    "no base agent release was given — pass --base-release <agent-release-id>, or a candidates.json carrying baseAgentReleaseId.",
  NO_ELIGIBLE_VARIANT_AND_NO_BASE_FALLBACK:
    "no candidate survived the checks above and --no-base-only forbids the base-only fallback.",
});

function variantUsage() {
  return VARIANT_USAGE_LINES.join("\n");
}

function renderVariantResolution(result) {
  const lines = [
    `VARIANT RESOLUTION: ${result.decision}`,
    "Local compatibility preview only; Hub rental requires a Web server resolution receipt.",
    "Candidate score/verified claims are not accepted as reputation, payment, rental, or execution authority.",
  ];
  if (result.decision === "selected") lines.push(`selected: ${result.selectedVariantId}`);
  else if (result.decision === "fallback") lines.push(`fallback selected: ${result.selectedVariantId}`);
  else if (result.decision === "base-only") lines.push(`base-only: ${result.baseAgentReleaseId} (no Experience Pack attached)`);
  else {
    lines.push(`error: ${result.code}`);
    const hint = VARIANT_ERROR_HINTS[result.code];
    if (hint) lines.push(hint);
  }
  if (result.fallbackOrder.length) lines.push(`next fallbacks: ${result.fallbackOrder.join(", ")}`);
  for (const excluded of result.excluded) lines.push(`excluded only ${excluded.variantId}: ${excluded.reasons.join(", ")}`);
  lines.push("Required MCP shortages exclude only the affected variant; they never create an agent-wide shortage.");
  // 실패했을 때만 usage를 붙인다 — 성공 출력은 v1과 바이트 동일하게 유지한다.
  if (result.decision === "error") lines.push("", variantUsage());
  return lines.join("\n");
}

function cmdVariant(options) {
  const args = options.args || [];
  const sub = args[0] || "resolve";
  // help 탈출구: 상위 라우터가 -h/--help 를 "help" 로 정규화하지만, 직접 호출도
  // 받도록 셋 다 인정한다. usage는 성공(exit 0)이지 알 수 없는 서브커맨드가 아니다.
  if (sub === "help" || sub === "--help" || sub === "-h") {
    (options.out || console.log)(variantUsage());
    return null;
  }
  if (sub !== "resolve") throw new Error(`unknown variant subcommand: ${sub} (resolve|help)`);
  const flags = parseVariantFlags(args.slice(1));
  let candidates = [];
  let baseAgentReleaseId = flags["base-release"] || null;
  const candidateFile = flags.candidates || flags._[0];
  if (candidateFile) {
    const { value } = readJsonFile(path.resolve(options.cwd || process.cwd(), candidateFile), "variant candidates");
    if (Array.isArray(value)) candidates = value;
    else {
      assertObject(value, "variant candidate document");
      assertExactKeys(
        value,
        new Set(["baseAgentReleaseId", "candidates"]),
        ["candidates"],
        "variant candidate document",
      );
      if (!Array.isArray(value.candidates)) throw new Error("variant candidate document must contain candidates[]");
      candidates = value.candidates;
      if (!baseAgentReleaseId && value.baseAgentReleaseId) baseAgentReleaseId = value.baseAgentReleaseId;
    }
  }
  if (baseAgentReleaseId) assertId(baseAgentReleaseId, "--base-release");
  const inventory = collectSystemMcpInventory(options.db, { userDataDir: options.userDataDir, env: options.env || process.env });
  const result = resolveVariantCandidates({
    candidates,
    inventory,
    baseAgentReleaseId,
    preferredVariantId: flags.prefer || null,
    allowBaseOnly: flags["no-base-only"] !== true,
  });
  const emit = options.out || console.log;
  emit(flags.json ? JSON.stringify(result, null, 2) : renderVariantResolution(result));
  if (result.decision === "error") (options.setExitCode || ((code) => { process.exitCode = code; }))(2);
  return result;
}

module.exports = {
  validateVariantCandidate,
  resolveVariantCandidates,
  renderVariantResolution,
  variantUsage,
  parseVariantFlags,
  cmdVariant,
};
