"use strict";
/*
 * mcp/plan — 요구사항 해소 + MCP 빌드 플랜 구성 + 빌더 지시문.
 *
 * 계약(v1 그대로):
 *  - 플랜은 추천일 뿐이다. 명시적 1회 동의 전에는 어떤 MCP도 attach되지 않는다.
 *  - 네트워크 발견/키 프로브/설치는 절대 수행하지 않는다.
 *  - 부족(shortage)은 요구사항 단위로 격리된다 — 빌드는 중단되지 않고 degrade만 한다.
 *  - 신뢰 레지스트리가 자격증명 매핑을 소유한다: 패키지가 env 메타데이터 선언만으로
 *    무자격 레지스트리 행을 "key present"로 둔갑시킬 수 없다.
 */
const crypto = require("node:crypto");
const {
  MAX_APPROVED_MCP_PER_BUILD,
  assertId,
} = require("./contract.cjs");

const MAX_BUILD_DIRECTIVE_CHARS = 1400;

function syntheticRequirement(catalogId, required, priority) {
  const suffix = crypto.createHash("sha256").update(catalogId).digest("hex").slice(0, 24);
  return {
    schemaVersion: "agentlas.mcp-requirement.v1",
    kind: "agentlas-mcp-requirement",
    requirementId: `terminal-requirement:${suffix}`,
    catalogId,
    reason: required ? "Explicitly required for this Terminal build" : "Explicitly recommended for this Terminal build",
    capabilities: [`terminal-mcp:${suffix}`],
    required,
    requiresKey: false,
    priority,
    permissions: [],
    alternatives: [],
    unavailablePolicy: {
      build: "degrade",
      rental: required ? "exclude-variant" : "continue-degraded",
      execution: required ? "use-alternative" : "continue-degraded",
    },
  };
}

// 이름 휴리스틱은 "회수 힌트"로만 강등되었다(2026-08-20) — 판정기에 참고로 전달될 뿐,
// 요구사항을 만들거나 선택 게이트로 동작하지 않는다. 데스크탑 need-resolver.ts가 폐기한
// 것과 같은 계약: 선택은 판정기(engine/agentlas-judgment.cjs) 경유, 판정 불가면
// 요구사항 없음(중립)이다.
const HEURISTIC_GROUPS = [
  [/(browser|playwright|chrome|web)/i, /(?:browser|website|web page|웹|브라우저|사이트|페이지|로그인)/i],
  [/(github|gitlab|source)/i, /(?:github|gitlab|repository|pull request|issue|깃허브|레포|저장소)/i],
  [/(figma|design)/i, /(?:figma|mockup|design|ui|ux|피그마|디자인)/i],
  [/(postgres|mysql|sqlite|database|mongo)/i, /(?:database|sql|query|schema|db|데이터베이스|쿼리)/i],
  [/(notion|docs|drive)/i, /(?:notion|document|docs|drive|노션|문서|드라이브)/i],
  [/(slack|teams|discord)/i, /(?:slack|teams|discord|message|슬랙|메시지)/i],
  [/(search|research)/i, /(?:search|research|lookup|검색|리서치|조사)/i],
];

/** 회수 힌트: 판정기 guidance에만 실린다. 선택·attach 권한이 없다. */
function lexicalRequirementHintIds(request, inventory) {
  const text = String(request || "").toLowerCase();
  const ids = [];
  for (const item of inventory) {
    const direct = text.includes(String(item.catalogId).toLowerCase()) || text.includes(String(item.name || "").toLowerCase());
    const heuristic = HEURISTIC_GROUPS.some(([nameRe, taskRe]) => nameRe.test(`${item.catalogId} ${item.name}`) && taskRe.test(text));
    if (direct || heuristic) ids.push(item.catalogId);
  }
  return ids.slice(0, 8);
}

/**
 * 요청 텍스트에서 MCP 요구사항을 추론한다 — 판정기(연결된 모델) 경유.
 * 정규식/이름 매칭은 힌트로만 전달되며, 판정이 없으면 빈 목록(중립)이다.
 * 반환: syntheticRequirement[] (전부 optional/recommended 등급).
 */
async function inferRequirements(request, inventory, options = {}) {
  const text = String(request || "").trim();
  const items = Array.isArray(inventory) ? inventory : [];
  if (!text || !items.length) return [];
  const judgment = options.judgment || require("../agentlas-judgment.cjs");
  if (!judgment.hasJudgmentRunner()) return [];
  const hintIds = lexicalRequirementHintIds(text, items);
  const shelf = items
    .map((item) => `- ${item.catalogId}: ${item.name || item.catalogId}`)
    .join("\n");
  const verdict = await judgment.judgeLabels({
    kind: "terminal-mcp-need",
    question:
      "Which of the available MCP tools does this build request genuinely require in order to complete? Judge what the task actually does, not which words it contains.",
    labels: items.map((item) => String(item.catalogId)),
    input: `TASK:\n${text.slice(0, 4000)}\n\nAVAILABLE TOOLS:\n${shelf}`,
    guidance: [
      "Name a tool ONLY when the task cannot be completed without it.",
      "Mentioning a topic is not a need: a task that says 'research'/'조사' in passing does not need a web-search tool.",
      hintIds.length
        ? `A deterministic name-heuristic suggested [${hintIds.join(", ")}] — treat that as a hint, never a gate.`
        : "",
      "An empty list is a valid and often correct answer. Err toward fewer tools.",
    ].filter(Boolean).join(" "),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (verdict.source !== "llm") return []; // 판정 불가 → 요구사항 없음(중립)
  const known = new Set(items.map((item) => String(item.catalogId)));
  return verdict.labels
    .filter((catalogId) => known.has(catalogId))
    .slice(0, 8)
    .map((catalogId, index) => syntheticRequirement(catalogId, false, index + 100));
}

function indexInventory(inventory) {
  return new Map((inventory || []).map((item) => [item.catalogId, item]));
}

function resolveMcpRequirement(requirement, inventoryById) {
  const order = [requirement.catalogId, ...(requirement.alternatives || [])];
  const attempted = [];
  const candidates = [];
  for (const catalogId of order) {
    const item = inventoryById.get(catalogId);
    if (!item) {
      attempted.push({ catalogId, status: "unavailable" });
      continue;
    }
    if (item.transport !== "stdio") {
      attempted.push({ catalogId, status: "runtime-incompatible" });
      continue;
    }
    const keyRequired = requirement.requiresKey || item.keyRequired;
    // The trusted registry owns credential mapping. A package cannot turn an
    // uncredentialed registry row into "key present" merely by declaring env metadata.
    const keyPresent = keyRequired ? (item.keyRequired && item.keyPresent) : true;
    if (!keyPresent) {
      attempted.push({ catalogId, status: "missing-key" });
      continue;
    }
    candidates.push({ item, keyRequired, keyPresent: true });
  }
  if (candidates.length) {
    return {
      selected: candidates[0].item,
      candidates,
      status: "available",
      attempted,
      keyRequired: candidates[0].keyRequired,
      keyPresent: true,
    };
  }
  const primary = inventoryById.get(requirement.catalogId);
  const keyRequired = requirement.requiresKey || Boolean(primary && primary.keyRequired);
  const missingKey = attempted.some((attempt) => attempt.status === "missing-key");
  return { selected: null, candidates: [], status: missingKey ? "missing-key" : "unavailable", attempted, keyRequired, keyPresent: false };
}

function buildMcpPlan(options) {
  const inventory = options.inventory || [];
  const inventoryById = indexInventory(inventory);
  const policyRequirements = options.policy ? options.policy.requirements : [];
  const requirements = [...policyRequirements];
  const known = new Set(requirements.map((requirement) => requirement.catalogId));
  for (const catalogId of options.requiredIds || []) {
    assertId(catalogId, "--require-mcp");
    if (!known.has(catalogId)) { requirements.push(syntheticRequirement(catalogId, true, 1)); known.add(catalogId); }
  }
  for (const catalogId of options.recommendedIds || []) {
    assertId(catalogId, "--recommend-mcp");
    if (!known.has(catalogId)) { requirements.push(syntheticRequirement(catalogId, false, 500)); known.add(catalogId); }
  }
  // 2026-08-20: 휴리스틱 자동 추론이 여기서 직접 요구사항을 만들던 게이트를 제거.
  // 추론은 비동기 판정(inferRequirements — 판정기 경유, 판정 불가면 빈 목록)을
  // 호출자가 먼저 끝내고 그 결과를 넘긴다. 없으면 요구사항 없음(중립).
  if (!requirements.length && Array.isArray(options.inferredRequirements)) {
    for (const requirement of options.inferredRequirements.slice(0, 8)) {
      if (requirement && requirement.catalogId && !known.has(requirement.catalogId)) {
        requirements.push(requirement);
        known.add(requirement.catalogId);
      }
    }
  }
  const entries = requirements
    .map((requirement) => {
      const resolution = resolveMcpRequirement(requirement, inventoryById);
      const entry = {
        requirementId: requirement.requirementId,
        requestedCatalogId: requirement.catalogId,
        resolvedCatalogId: resolution.selected ? resolution.selected.catalogId : null,
        name: resolution.selected ? resolution.selected.name : requirement.catalogId,
        source: resolution.selected ? resolution.selected.source : null,
        required: requirement.required,
        priority: requirement.priority,
        reason: requirement.reason,
        status: resolution.status,
        keyRequired: resolution.keyRequired,
        keyPresent: resolution.keyRequired ? resolution.keyPresent : null,
        permissions: [...(requirement.permissions || [])],
        permissionBasis: "package-declared",
        permissionEnforced: false,
        fallbackCatalogIds: resolution.candidates.slice(1).map((candidate) => candidate.item.catalogId),
        alternativesTried: resolution.attempted.map((attempt) => ({ catalogId: attempt.catalogId, status: attempt.status })),
        unavailableBuildPolicy: "degrade",
      };
      // 레지스트리 행 id/지문은 post-consent 재검증 재료 — 공개 투영에서 제외.
      Object.defineProperty(entry, "registryServerId", {
        value: resolution.selected?.registryServerId || null,
        enumerable: false,
      });
      Object.defineProperty(entry, "credentialKeyFingerprint", {
        value: resolution.selected?.credentialKeyFingerprint || null,
        enumerable: false,
      });
      Object.defineProperty(entry, "runtimeCandidates", {
        value: resolution.candidates.map((candidate) => ({
          resolvedCatalogId: candidate.item.catalogId,
          registryServerId: candidate.item.registryServerId || null,
          credentialKeyFingerprint: candidate.item.credentialKeyFingerprint || null,
        })),
        enumerable: false,
      });
      return entry;
    })
    .sort((a, b) => Number(b.required) - Number(a.required) || a.priority - b.priority || a.requestedCatalogId.localeCompare(b.requestedCatalogId));
  return {
    schemaVersion: "agentlas.terminal-mcp-build-plan.v1",
    planId: crypto.randomUUID(),
    registryStatus: options.registryStatus || inventory.registryStatus || "complete",
    registryResolutionOrder: options.policy ? [...options.policy.registryResolutionOrder] : ["system-global"],
    discoveryNetworkUsed: false,
    consentMode: "one-pass",
    entries,
    availableCatalogIds: [...new Set(entries.flatMap((entry) =>
      entry.status === "available" ? (entry.runtimeCandidates || []).map((candidate) => candidate.resolvedCatalogId) : []
    ))],
    maxApprovedMcp: MAX_APPROVED_MCP_PER_BUILD,
    shortages: entries.filter((entry) => entry.status !== "available").map((entry) => ({
      requirementId: entry.requirementId,
      catalogId: entry.requestedCatalogId,
      required: entry.required,
      status: entry.status,
      effect: "build-degraded-only",
    })),
  };
}

function renderMcpPlan(plan) {
  const lines = [`MCP BUILD PLAN · system-global registry first · registry: ${plan.registryStatus} · no network discovery`];
  if (plan.registryStatus === "unavailable") lines.push("- System-global registry could not be read. Build continues safely in empty-MCP mode; no install/network fallback was attempted.");
  if (!plan.entries.length) lines.push("- No relevant MCP recommended. Build continues in empty-MCP mode.");
  for (const entry of plan.entries) {
    const key = entry.keyRequired ? (entry.keyPresent ? "key: present" : "key: missing") : "key: not needed";
    const requirement = entry.required ? "required" : "optional";
    const permissions = entry.permissions.length ? entry.permissions.join(",") : "none";
    lines.push(`- P${entry.priority} ${entry.name} [${entry.resolvedCatalogId || entry.requestedCatalogId}] · ${requirement} · ${entry.status} · ${key}`);
    lines.push(`  ${entry.reason}`);
    if (entry.fallbackCatalogIds?.length) lines.push(`  approved fallback order: ${entry.fallbackCatalogIds.join(",")}`);
    lines.push(`  permissions: ${permissions} · declared only; host enforcement not yet verified`);
  }
  if (plan.shortages.length) lines.push(`Shortages are isolated: ${plan.shortages.length} requirement(s) degrade only; the build does not abort.`);
  lines.push("Recommendation only: no MCP is attached until one explicit consent; this plan performs no network key probe or install.");
  return lines.join("\n");
}

function fitApprovedMcpIds(plan, requestedIds) {
  const available = new Set(plan.availableCatalogIds || []);
  const requested = [...new Set((requestedIds || []).filter((id) => available.has(id)))].slice(0, MAX_APPROVED_MCP_PER_BUILD);
  const accepted = [];
  const fixedReserve = 520; // frozen instruction + minimum shortage/degrade clause
  for (const id of requested) {
    const clause = `Approved catalog IDs: ${accepted.concat(id).join(",")}.`;
    if (clause.length + fixedReserve > MAX_BUILD_DIRECTIVE_CHARS) break;
    accepted.push(id);
  }
  return accepted;
}

function buildMcpDirective(plan, approvedIds) {
  const approved = fitApprovedMcpIds(plan, approvedIds);
  const shortages = plan.shortages.map((item) => item.catalogId);
  const base = [
    "[AGENTLAS_MCP_BUILD_CONTEXT v1]",
    "Resolve MCP only from the host system-global registry; package IDs/requirements only, never server definitions or credentials.",
  ].join(" ");
  const approvedClause = `Approved catalog IDs: ${approved.length ? approved.join(",") : "none"}.`;
  const shortagePrefix = "Unavailable or missing-key IDs: ";
  const shortageSuffix = "; degrade each capability independently and continue the build.";
  const fittedShortages = [];
  for (const id of shortages.slice(0, 16)) {
    const omitted = shortages.length - fittedShortages.length - 1;
    const proposal = `${shortagePrefix}${fittedShortages.concat(id).join(",")}${omitted > 0 ? ` (+${omitted} more)` : ""}${shortageSuffix}`;
    if (`${base} ${approvedClause} ${proposal}`.length > MAX_BUILD_DIRECTIVE_CHARS) break;
    fittedShortages.push(id);
  }
  const omittedShortages = shortages.length - fittedShortages.length;
  const shortageValue = shortages.length === 0
    ? "none"
    : fittedShortages.length
      ? `${fittedShortages.join(",")}${omittedShortages > 0 ? ` (+${omittedShortages} more)` : ""}`
      : `${shortages.length} unresolved (IDs omitted from prompt; declared policy remains source)`;
  const shortageClause = `${shortagePrefix}${shortageValue}${shortageSuffix}`;
  const line = `${base} ${approvedClause} ${shortageClause}`;
  if (line.length > MAX_BUILD_DIRECTIVE_CHARS) throw new Error("internal MCP builder directive exceeded its context limit");
  return line;
}

function renderBuildMcpResult(plan, approvedIds, runtimeAllowlist = null) {
  const approved = new Set(approvedIds || []);
  const attached = new Set((runtimeAllowlist?.attached || []).map((item) => item.catalogId));
  const failed = new Map((runtimeAllowlist?.failed || []).map((item) => [item.catalogId, item.reason]));
  const lines = ["MCP BUILD RESULT"];
  for (const entry of plan.entries) {
    let status = entry.status;
    if (entry.status === "available") {
      const candidateIds = [entry.resolvedCatalogId, ...(entry.fallbackCatalogIds || [])].filter(Boolean);
      const attachedId = candidateIds.find((id) => attached.has(id));
      const approvedId = candidateIds.find((id) => approved.has(id));
      const failedId = candidateIds.find((id) => failed.has(id));
      status = attachedId
        ? attachedId === entry.resolvedCatalogId ? "connected-and-allowlisted" : `fallback-connected-and-allowlisted:${attachedId}`
        : failedId
          ? `failed-isolated:${failedId}:${failed.get(failedId)}`
          : approvedId
            ? "approved-but-not-attached"
            : "skipped";
    }
    lines.push(`- ${entry.resolvedCatalogId || entry.requestedCatalogId}: ${status}`);
  }
  if (!runtimeAllowlist || runtimeAllowlist.emptyMode) lines.push("- Build continued in empty-MCP mode.");
  if (runtimeAllowlist && runtimeAllowlist.consentPersisted === false) lines.push("- Runtime consent was one-pass only because its local fingerprint receipt could not be saved.");
  lines.push("Only the post-consent host allowlist reached the builder; tool-call success is not implied by connection readiness.");
  return lines.join("\n");
}

module.exports = {
  MAX_BUILD_DIRECTIVE_CHARS,
  syntheticRequirement,
  lexicalRequirementHintIds,
  inferRequirements,
  indexInventory,
  resolveMcpRequirement,
  buildMcpPlan,
  renderMcpPlan,
  fitApprovedMcpIds,
  buildMcpDirective,
  renderBuildMcpResult,
};
