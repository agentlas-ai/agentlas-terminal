"use strict";

const assert = require("node:assert/strict");
const { create, _test } = require("../engine/agentlas-workforce.cjs");

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function slot(slotId, title, communities, roles, skills) {
  return {
    slotId,
    title,
    task: `Own the ${title} responsibility`,
    cardinality: 1,
    criticality: "required",
    requiredCommunities: communities,
    optionalCommunities: [],
    excludedCommunities: ["community:travel"],
    requiredRoles: roles,
    requiredSkills: skills,
    optionalSkills: [],
    requiredKnowledge: [],
    requiredToolCapabilities: [],
    consumes: [],
    produces: [],
    requiredAuthorities: [],
    forbiddenAuthorities: [],
    runtimes: ["runtime:terminal"],
    languages: ["language:en"],
    modalities: [],
    allowedEntityKinds: ["agent"],
  };
}

function fixture() {
  const workOrder = {
    schemaVersion: "agentlas.workforce-work-order.v1",
    workOrderId: "work-order:hard-payment",
    taskBrief: "Build and adversarially verify an idempotent payment API.",
    redacted: true,
    ontologyVersion: "awo:2026-07-15.2",
    roleSlots: [
      slot("slot:backend", "payment backend", ["community:backend-engineering"], ["role:backend-engineer"], ["skill:api-design"]),
      slot("slot:verification", "independent verifier", ["community:quality-engineering"], ["role:quality-engineer"], ["skill:test-design"]),
    ],
    edges: [{ from: "slot:verification", to: "slot:backend", relation: "reviews", artifactKinds: ["artifact:source-code"] }],
    forbiddenCommunities: ["community:travel"],
    selectionPolicy: { minimumCandidatesPerSlot: 3, maximumCandidatesPerSlot: 20, allowHistoryEvidence: false },
  };
  const candidates = {
    schemaVersion: "agentlas.workforce-candidate-set.v1",
    selectionSessionId: "selection-session:hard-payment",
    workOrderId: workOrder.workOrderId,
    ontologyVersion: "awo:2026-07-15.2",
    candidateSetDigest: HASH_A,
    decisionOwner: "host_llm",
    historyInfluence: "none",
    issuedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-16T00:00:00.000Z",
    slots: [
      {
        slotId: "slot:backend",
        candidates: [{
          agentDefinitionId: "definition:backend",
          agentReleaseId: "release:backend-v3",
          releaseVersion: "3.0.0",
          packageHash: HASH_B,
          contentDigest: HASH_C,
          entityKind: "agent",
          name: "Backend Architect",
          communities: ["community:backend-engineering", "community:payments-engineering"],
          fitEvidence: ["fit:api-design"],
          qualificationEvidence: ["eval:backend-hard"],
          optionalGaps: [],
          operational: { callable: true, installable: true, unavailableReasons: [] },
          semanticSnapshot: {
            summaries: ["Payment API and transaction-boundary specialist"],
            roles: ["role:backend-engineer"],
            skills: [{ concept: "skill:api-design", level: "demonstrated" }],
            toolCapabilities: [], consumes: [], produces: [], authorities: [], runtimes: ["terminal"], languages: ["en"],
          },
        }],
        coverageGaps: [],
      },
      {
        slotId: "slot:verification",
        candidates: [{
          agentDefinitionId: "definition:verifier",
          agentReleaseId: "release:verifier-v7",
          releaseVersion: "7.1.0",
          packageHash: HASH_C,
          contentDigest: HASH_D,
          entityKind: "agent",
          name: "Adversarial Verifier",
          communities: ["community:quality-engineering", "community:security-engineering"],
          fitEvidence: ["fit:test-design"],
          qualificationEvidence: ["eval:verifier-hard"],
          optionalGaps: [],
          operational: { callable: true, installable: true, unavailableReasons: [] },
          semanticSnapshot: {
            summaries: ["Independent adversarial correctness verifier"],
            roles: ["role:quality-engineer"],
            skills: [{ concept: "skill:test-design", level: "demonstrated" }],
            toolCapabilities: [], consumes: [], produces: [], authorities: [], runtimes: ["terminal"], languages: ["en"],
          },
        }],
        coverageGaps: [],
      },
    ],
  };
  const selection = {
    schemaVersion: "agentlas.workforce-selection.v1",
    selectionSessionId: candidates.selectionSessionId,
    candidateSetDigest: candidates.candidateSetDigest,
    decisionAuthor: { kind: "host_llm", modelId: "model:ollama/qwen3:30b-a3b", runtimeId: "runtime:ollama" },
    assignments: [
      { slotId: "slot:backend", agentReleaseId: "release:backend-v3", reasonCodes: ["reason:contract-fit"] },
      { slotId: "slot:verification", agentReleaseId: "release:verifier-v7", reasonCodes: ["reason:independent-review"] },
    ],
    edges: [{ fromSlot: "slot:verification", toSlot: "slot:backend", relation: "reviews", artifactKinds: ["artifact:source-code"] }],
    alternativesConsidered: [],
    requestExpansionForSlots: [],
  };
  const validationReceipt = {
    schemaVersion: "agentlas.workforce-selection-validation.v1",
    status: "accepted",
    issues: [],
    selectionReceiptId: "workforce-selection:accepted-hard-payment",
    decisionOwner: "host_llm",
    historyInfluence: "none",
    ontologyVersion: candidates.ontologyVersion,
    candidateSetDigest: candidates.candidateSetDigest,
    idealTeam: selection.assignments.map((row) => {
      const candidate = candidates.slots.find((slotRow) => slotRow.slotId === row.slotId).candidates
        .find((candidateRow) => candidateRow.agentReleaseId === row.agentReleaseId);
      return {
        slotId: row.slotId,
        agentDefinitionId: candidate.agentDefinitionId,
        agentReleaseId: candidate.agentReleaseId,
        releaseVersion: candidate.releaseVersion,
        packageHash: candidate.packageHash,
        contentDigest: candidate.contentDigest,
        entityKind: candidate.entityKind,
        reasonCodes: row.reasonCodes,
      };
    }),
    executableTeam: selection.assignments.map((row) => {
      const candidate = candidates.slots.find((slotRow) => slotRow.slotId === row.slotId).candidates
        .find((candidateRow) => candidateRow.agentReleaseId === row.agentReleaseId);
      return {
        slotId: row.slotId,
        agentDefinitionId: candidate.agentDefinitionId,
        agentReleaseId: candidate.agentReleaseId,
        releaseVersion: candidate.releaseVersion,
        packageHash: candidate.packageHash,
        contentDigest: candidate.contentDigest,
        entityKind: candidate.entityKind,
        reasonCodes: row.reasonCodes,
      };
    }),
    unfilledPosts: [],
    substitutions: [],
    edges: selection.edges,
    receipt: { workOrderId: workOrder.workOrderId, selectionSessionId: candidates.selectionSessionId },
  };
  const prepared = {
    schemaVersion: "agentlas.workforce-execution-plan.v1",
    status: "prepared",
    issues: [],
    preparationReceiptId: "workforce-preparation:hard-payment",
    candidateSetDigest: candidates.candidateSetDigest,
    selectionReceiptId: validationReceipt.selectionReceiptId,
    decisionOwner: "host_llm",
    substitutions: [],
    executionRoster: [
      {
        slotId: "slot:backend",
        agentDefinitionId: "definition:backend",
        agentReleaseId: "release:backend-v3",
        releaseVersion: "3.0.0",
        packageHash: HASH_B,
        contentDigest: HASH_C,
        entityKind: "agent",
        bundleDigest: HASH_D,
        directiveBundle: { systemPrompt: "You are the exact backend release. Design and implement transaction-safe APIs." },
      },
      {
        slotId: "slot:verification",
        agentDefinitionId: "definition:verifier",
        agentReleaseId: "release:verifier-v7",
        releaseVersion: "7.1.0",
        packageHash: HASH_C,
        contentDigest: HASH_D,
        entityKind: "agent",
        bundleDigest: HASH_A,
        directiveBundle: { agentMd: "You are the exact verifier release. Try to falsify all correctness claims." },
      },
    ],
  };
  const plan = {
    schemaVersion: "agentlas.workforce-delegation-plan.v1",
    planId: "workforce-plan:hard-payment",
    packets: [
      { packetId: "packet:backend", slotId: "slot:backend", agentReleaseId: "release:backend-v3", objective: "Produce the transaction design", inputs: ["work order"], expectedOutput: "design artifact" },
      { packetId: "packet:verify", slotId: "slot:verification", agentReleaseId: "release:verifier-v7", objective: "Create adversarial cases", inputs: ["work order"], expectedOutput: "test artifact" },
    ],
    synthesis: { slotId: "slot:backend", agentReleaseId: "release:backend-v3", brief: "Integrate design and adversarial findings" },
    verifier: { slotId: "slot:verification", agentReleaseId: "release:verifier-v7", brief: "Check the integrated answer", criteria: ["idempotency", "rollback", "authorization"] },
  };
  return { workOrder, candidates, selection, validationReceipt, prepared, plan };
}

function leaderSearchEnvelope(workOrder) {
  return JSON.stringify({
    schemaVersion: "agentlas.workforce-leader-call.v1",
    toolCall: { name: "workforce.search_candidates", arguments: { workOrder } },
  });
}

function unfilledCandidateSet(workOrder, suffix = "initial") {
  return {
    schemaVersion: "agentlas.workforce-candidate-set.v1",
    selectionSessionId: `selection-session:${suffix}`,
    workOrderId: workOrder.workOrderId,
    ontologyVersion: workOrder.ontologyVersion,
    candidateSetDigest: HASH_B,
    decisionOwner: "host_llm",
    historyInfluence: "none",
    issuedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-16T00:00:00.000Z",
    slots: workOrder.roleSlots.map((slotRow) => ({
      slotId: slotRow.slotId,
      candidates: [],
      coverageGaps: [
        "gap:minimum-candidate-count",
        "gap:no-hard-eligible-candidate",
        "gap:excluded:missing-required-role",
        "gap:excluded:missing-required-skill",
        "gap:excluded:missing-required-tool",
      ],
    })),
  };
}

function relaxedWorkOrder(workOrder) {
  const revised = structuredClone(workOrder);
  revised.forbiddenCommunities = ["community:travel", "community:marketing"];
  for (const slotRow of revised.roleSlots) {
    slotRow.optionalSkills = [...new Set([...(slotRow.optionalSkills || []), ...slotRow.requiredSkills])];
    slotRow.requiredRoles = [];
    slotRow.requiredSkills = [];
    slotRow.requiredToolCapabilities = [];
    slotRow.excludedCommunities = [...revised.forbiddenCommunities];
  }
  return revised;
}

function harness(overrides = {}) {
  const f = fixture();
  const modelOutputs = overrides.modelOutputs || [
    JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
    `<think>compare qualified candidates only</think>\n\`\`\`json\n${JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } })}\n\`\`\``,
    JSON.stringify(f.plan),
    "Backend handoff: idempotency key state machine and serializable transaction boundary.",
    "Verifier handoff: replay, partial-failure, forged-key, and concurrent-commit adversarial cases.",
    "Integrated deliverable with transaction design, adversarial tests, and explicit limitations.",
    JSON.stringify({
      schemaVersion: "agentlas.workforce-verification.v1",
      status: "passed",
      checks: [
        { checkId: "check:idempotency", status: "passed", evidence: "state machine present" },
        { checkId: "check:rollback", status: "passed", evidence: "atomic boundary present" },
        { checkId: "check:authorization", status: "passed", evidence: "forged-key test present" },
      ],
      issues: [],
    }),
  ];
  const modelCalls = [];
  const hubCalls = [];
  const receipts = [];
  const benchmarkArtifacts = [];
  let modelIndex = 0;
  let searchIndex = 0;
  const runtime = create({
    resolveRuntime: () => ({ mode: "api", backend: "ollama", model: "qwen3:30b-a3b" }),
    buildChildEnv: async () => ({}),
    runModel: async (call) => {
      modelCalls.push(call);
      if (modelIndex >= modelOutputs.length) throw new Error("unexpected model call");
      return modelOutputs[modelIndex++];
    },
    callHubTool: async (name, args) => {
      hubCalls.push({ name, args });
      if (typeof overrides.callHubTool === "function") {
        return overrides.callHubTool(name, args, { fixture: f, callIndex: hubCalls.length - 1 });
      }
      if (name === "workforce.search_candidates") {
        if (Array.isArray(overrides.searchResults)) {
          if (searchIndex >= overrides.searchResults.length) throw new Error("unexpected extra candidate search");
          return structuredClone(overrides.searchResults[searchIndex++]);
        }
        return f.candidates;
      }
      if (name === "workforce.validate_selection") return f.validationReceipt;
      if (name === "workforce.prepare_execution") {
        const prepared = structuredClone(f.prepared);
        if (overrides.prepareMutation) overrides.prepareMutation(prepared);
        return prepared;
      }
      throw new Error(`unexpected Hub tool ${name}`);
    },
    appendReceipt: (receipt) => receipts.push(structuredClone(receipt)),
    persistBenchmarkArtifact: (artifact) => {
      benchmarkArtifacts.push(structuredClone(artifact));
      return "/tmp/workforce-benchmark-fixture.json";
    },
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  return { ...f, runtime, modelCalls, hubCalls, receipts, benchmarkArtifacts };
}

async function successContract() {
  const h = harness();
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true, concurrency: 2 });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.deepEqual(h.hubCalls.map((row) => row.name), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.equal(result.receipt.hubTools[1].authorityReceiptId, h.validationReceipt.selectionReceiptId);
  assert.equal(result.receipt.hubTools[2].authorityReceiptId, h.prepared.preparationReceiptId);
  assert.equal(result.receipt.planner.fallbackUsed, false);
  assert.equal(result.receipt.planner.parseStatus, "schema-validated-json");
  assert.deepEqual(result.receipt.workers.map((row) => row.agentReleaseId).sort(), ["release:backend-v3", "release:verifier-v7"]);
  assert.equal(result.receipt.synthesis.agentReleaseId, "release:backend-v3");
  assert.equal(result.receipt.verifier.agentReleaseId, "release:verifier-v7");
  assert.equal(result.receipt.benchmarkAudit.passed, true);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].status, "passed");
  assert.equal(h.receipts[0].workOrderId, h.workOrder.workOrderId);
  assert.equal(h.receipts[0].selectionReceiptId, h.validationReceipt.selectionReceiptId);
  assert.equal(h.receipts[0].preparationReceiptId, h.prepared.preparationReceiptId);
  assert.equal(h.receipts[0].orchestrator.status, "completed");
  assert.equal(h.receipts[0].planner.parseSuccess, true);
  assert.equal(h.receipts[0].workers.every((row) => row.status === "completed" && row.modelId && row.invocationId && row.handoffArtifactRefs.length), true);
  assert.match(h.modelCalls[0].system, /awo:2026-07-15\.2/);
  assert.match(h.modelCalls[0].system, /role:payments-engineer/);
  assert.match(h.modelCalls[0].system, /role:quality-engineer/);
  assert.match(h.modelCalls[0].system, /community:payments-engineering/);
  assert.equal(h.modelCalls.some((call) => /travel/i.test(call.system) && /PINNED_RELEASE/.test(call.system)), false);
  assert.match(h.modelCalls.find((call) => /PINNED_RELEASE=release:backend-v3/.test(call.system)).system, /exact backend release/i);
  assert.match(h.modelCalls.find((call) => /PINNED_RELEASE=release:verifier-v7/.test(call.system)).system, /exact verifier release/i);
  assert.equal(result.benchmarkArtifactPath, "/tmp/workforce-benchmark-fixture.json");
  assert.equal(h.benchmarkArtifacts.length, 1);
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.mcpCalls.map((row) => row.tool), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.leaderInvocations.map((row) => row.phase), ["work-order", "selection"]);
  assert.equal(h.benchmarkArtifacts[0].executionReceipt.status, "passed");
}

async function malformedStructuredStagesRepairOnceAndSucceed() {
  const f = fixture();
  const malformedWorkOrder = structuredClone(f.workOrder);
  delete malformedWorkOrder.roleSlots[0].requiredRoles;
  const malformedSelection = structuredClone(f.selection);
  delete malformedSelection.edges;
  const malformedPlan = structuredClone(f.plan);
  delete malformedPlan.packets[0].expectedOutput;
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: malformedWorkOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: malformedSelection } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      JSON.stringify(malformedPlan),
      JSON.stringify(f.plan),
      "Backend handoff: idempotency key state machine and serializable transaction boundary.",
      "Verifier handoff: replay, partial-failure, forged-key, and concurrent-commit adversarial cases.",
      "Integrated deliverable with transaction design, adversarial tests, and explicit limitations.",
      JSON.stringify({
        schemaVersion: "agentlas.workforce-verification.v1",
        status: "passed",
        checks: [{ checkId: "check:repair", status: "passed", evidence: "all repaired stages retained exact releases" }],
        issues: [],
      }),
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true, concurrency: 2 });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.equal(h.modelCalls.length, 10);
  assert.deepEqual(h.hubCalls.map((row) => row.name), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  for (const phase of ["leader-work-order", "leader-selection", "planner"]) {
    const attempts = result.receipt.structuredModelAttempts.filter((row) => row.phase === phase);
    assert.deepEqual(attempts.map((row) => row.status), ["rejected", "accepted"]);
    assert.deepEqual(attempts.map((row) => row.attempt), [1, 2]);
    assert.equal(attempts[0].retryScheduled, true);
    assert.equal(attempts[1].repairAttempt, true);
    assert.equal(attempts[1].priorOutputIncluded, true);
    assert.equal(attempts.every((row) => row.hostMutationApplied === false && row.fallbackUsed === false), true);
  }
  for (const repairCall of [h.modelCalls[1], h.modelCalls[3], h.modelCalls[5]]) {
    assert.match(repairCall.system, /STRUCTURED OUTPUT REPAIR MODE/);
    assert.match(repairCall.prompt, /^VALIDATION=/);
    assert.match(repairCall.prompt, /EXACT_SCHEMA_REQUIREMENTS=/);
    assert.match(repairCall.prompt, /PRIOR_MODEL_OUTPUT_DATA=/);
    assert.doesNotMatch(repairCall.prompt, /ORIGINAL_STAGE_INPUT|error\.details/i);
  }
  assert.doesNotMatch(h.modelCalls[3].prompt, /WORK_ORDER_DATA=|CANDIDATE_SET_DATA=/);
  assert.doesNotMatch(h.modelCalls[5].prompt, /ACCEPTED_SELECTION_DATA=|PREPARED_RELEASE_PINS=/);
  assert.equal(result.receipt.planner.structuredAttemptCount, 2);
  assert.equal(result.receipt.planner.structuredRepairCount, 1);
  assert.equal(result.receipt.benchmarkAudit.structuredAttemptAuditPassed, true);
  assert.equal(result.receipt.benchmarkAudit.structuredRepairCount, 3);
  assert.equal(result.receipt.benchmarkAudit.passed, true);
  assert.equal(h.benchmarkArtifacts.length, 1);
  assert.equal(h.benchmarkArtifacts[0].executionReceipt.structuredModelAttempts.length, 6);
  assert.deepEqual(
    h.benchmarkArtifacts[0].selectionReceipt.leaderInvocations.filter((row) => row.status === "completed").map((row) => row.phase),
    ["work-order", "selection"],
  );
}

async function terraEdgeEnumRepairUsesExactContract() {
  const f = fixture();
  const malformed = structuredClone(f.workOrder);
  malformed.edges[0].relation = "hands_off";
  const h = harness({
    modelOutputs: [
      leaderSearchEnvelope(malformed),
      leaderSearchEnvelope(f.workOrder),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      JSON.stringify(f.plan),
      "Backend handoff.",
      "Verifier handoff.",
      "Integrated deliverable.",
      JSON.stringify({
        schemaVersion: "agentlas.workforce-verification.v1",
        status: "passed",
        checks: [{ checkId: "check:edge-contract", status: "passed", evidence: "allowed relation repaired" }],
        issues: [],
      }),
    ],
  });
  const result = await h.runtime.workforceRun({}, "cross-role handoff benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.deepEqual(
    result.receipt.structuredModelAttempts.filter((row) => row.phase === "leader-work-order").map((row) => row.status),
    ["rejected", "accepted"],
  );
  assert.match(h.modelCalls[1].prompt, /relation must be exactly one of reportsTo, handsOffTo, reviews, coordinatesWith/);
  assert.equal(result.receipt.benchmarkAudit.passed, true);
}

async function candidateGapRefinementRemainsTopLlmAuthored() {
  const f = fixture();
  const initial = structuredClone(f.workOrder);
  initial.forbiddenCommunities = [];
  for (const slotRow of initial.roleSlots) {
    slotRow.excludedCommunities = [];
    slotRow.requiredToolCapabilities = ["tool:database"];
  }
  const revised = relaxedWorkOrder(initial);
  const h = harness({
    modelOutputs: [
      leaderSearchEnvelope(initial),
      leaderSearchEnvelope(revised),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      JSON.stringify(f.plan),
      "Backend handoff.",
      "Verifier handoff.",
      "Integrated deliverable.",
      JSON.stringify({
        schemaVersion: "agentlas.workforce-verification.v1",
        status: "passed",
        checks: [{ checkId: "check:refinement", status: "passed", evidence: "same leader authored revised job analysis" }],
        issues: [],
      }),
    ],
    searchResults: [unfilledCandidateSet(initial), f.candidates],
  });
  const result = await h.runtime.workforceRun({}, "staff a difficult cross-domain project", { silent: true, benchmark: true });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.deepEqual(result.workOrder, revised, "the host must execute the replacement WorkOrder exactly as authored by the same LLM");
  assert.deepEqual(h.hubCalls.map((row) => row.name), [
    "workforce.search_candidates",
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.deepEqual(h.hubCalls[0].args.workOrder, initial);
  assert.deepEqual(h.hubCalls[1].args.workOrder, revised);
  assert.equal(result.receipt.workOrderRefinements.length, 1);
  assert.equal(result.receipt.workOrderRefinements[0].status, "accepted");
  assert.equal(result.receipt.workOrderRefinements[0].hostMutationApplied, false);
  assert.equal(result.receipt.workOrderRefinements[0].fallbackUsed, false);
  assert.deepEqual(result.receipt.workOrderRefinements[0].gapSlotIds, ["slot:backend", "slot:verification"]);
  const refinementAttempt = result.receipt.structuredModelAttempts.find((row) => row.phase === "leader-work-order-refinement" && row.status === "accepted");
  assert.ok(refinementAttempt);
  assert.equal(result.receipt.workOrderRefinements[0].invocationId, refinementAttempt.invocationId);
  assert.match(h.modelCalls[1].system, /one bounded job-analysis refinement/);
  assert.match(h.modelCalls[1].prompt, /PREVIOUS_WORK_ORDER_DATA=/);
  assert.match(h.modelCalls[1].prompt, /CANDIDATE_GAP_SUMMARY_DATA=/);
  assert.match(h.modelCalls[1].prompt, /gap:no-hard-eligible-candidate/);
  assert.doesNotMatch(h.modelCalls[1].prompt, /Backend Architect|Adversarial Verifier|release:backend-v3|release:verifier-v7/);
  const searchObservations = result.receipt.hubTools.filter((row) => row.tool === "workforce.search_candidates");
  assert.equal(searchObservations[0].authoritativeChain, false);
  assert.equal(searchObservations[0].supersededByWorkOrderRefinement, true);
  assert.equal(searchObservations[1].authoritativeChain, true);
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.mcpCalls.map((row) => row.tool), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.leaderInvocations.map((row) => row.phase), ["work-order", "selection"]);
  assert.equal(h.benchmarkArtifacts[0].selectionReceipt.leaderInvocations[0].invocationId, refinementAttempt.invocationId);
  assert.equal(result.receipt.benchmarkAudit.passed, true);
}

async function candidateGapRefinementIsBoundedAndFailsClosed() {
  const f = fixture();
  const initial = structuredClone(f.workOrder);
  const revised = relaxedWorkOrder(initial);
  const h = harness({
    modelOutputs: [leaderSearchEnvelope(initial), leaderSearchEnvelope(revised)],
    searchResults: [unfilledCandidateSet(initial, "first-gap"), unfilledCandidateSet(revised, "final-gap")],
  });
  const result = await h.runtime.workforceRun({}, "staff a project with scarce eligible workers", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "workforce_unfilled");
  assert.equal(h.modelCalls.length, 2, "only one semantic WorkOrder refinement may run");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates", "workforce.search_candidates"]);
  assert.equal(result.receipt.workOrderRefinements.length, 1);
  assert.equal(result.receipt.workOrderRefinements[0].status, "accepted");
  assert.deepEqual(h.benchmarkArtifacts[0].workOrder, revised);
  assert.equal(h.benchmarkArtifacts[0].candidateSet.selectionSessionId, "selection-session:final-gap");
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.mcpCalls.map((row) => row.tool), ["workforce.search_candidates"]);
}

async function ambiguousSearchResponseRetriesExactRequestOnce() {
  let searchCalls = 0;
  const h = harness({
    callHubTool: async (name, args, { fixture: f }) => {
      if (name === "workforce.search_candidates") {
        searchCalls += 1;
        if (searchCalls === 1) {
          const error = new Error("invalid JSON");
          error.code = "hub_invalid_response";
          error.details = { retryClass: "ambiguous_search_transport" };
          throw error;
        }
        return f.candidates;
      }
      if (name === "workforce.validate_selection") return f.validationReceipt;
      if (name === "workforce.prepare_execution") return f.prepared;
      throw new Error(`unexpected Hub tool ${name}`);
    },
  });
  const result = await h.runtime.workforceRun({}, "retry-safe candidate discovery", { silent: true, benchmark: true });
  assert.equal(result.ok, true, result.error && result.error.message);
  assert.deepEqual(h.hubCalls.map((row) => row.name), [
    "workforce.search_candidates",
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.deepEqual(h.hubCalls[0].args, h.hubCalls[1].args);
  assert.deepEqual(result.receipt.hubTools.slice(0, 2).map((row) => row.status), ["failed", "succeeded"]);
  assert.equal(result.receipt.hubTools[0].retryScheduled, true);
  assert.equal(result.receipt.hubTools[0].attempt, 1);
  assert.equal(result.receipt.hubTools[1].attempt, 2);
  assert.equal(result.receipt.hubTools[0].requestDigest, result.receipt.hubTools[1].requestDigest);
  assert.equal(result.receipt.hubTools[0].replaySafety, "deterministic-selection-session-replace-upsert");
  assert.deepEqual(h.benchmarkArtifacts[0].selectionReceipt.mcpCalls.map((row) => row.tool), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
}

async function validMcpEnvelopeWithInvalidToolPayloadDoesNotRetry() {
  const h = harness({
    callHubTool: async (name) => {
      if (name === "workforce.search_candidates") {
        return { content: [{ type: "text", text: "not-json-tool-payload" }] };
      }
      throw new Error(`unexpected Hub tool ${name}`);
    },
  });
  const result = await h.runtime.workforceRun({}, "malformed tool payload is not transport ambiguity", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "hub_tool_invalid");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates"]);
  assert.equal(result.receipt.hubTools[0].retryScheduled, false);
}

async function ambiguousSearchRetryExhaustionStopsAfterTwoExactCalls() {
  const h = harness({
    callHubTool: async (name) => {
      if (name === "workforce.search_candidates") {
        const error = new Error("still no valid response");
        error.code = "hub_transport_error";
        error.details = { retryClass: "ambiguous_search_transport" };
        throw error;
      }
      throw new Error(`unexpected Hub tool ${name}`);
    },
  });
  const result = await h.runtime.workforceRun({}, "bounded search replay", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "hub_transport_error");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates", "workforce.search_candidates"]);
  assert.deepEqual(result.receipt.hubTools.map((row) => row.retryScheduled), [true, false]);
  assert.deepEqual(result.receipt.hubTools.map((row) => row.attempt), [1, 2]);
  assert.equal(result.receipt.hubTools[0].requestDigest, result.receipt.hubTools[1].requestDigest);
}

async function validationAndPreparationMutationsNeverRetry() {
  for (const failingTool of ["workforce.validate_selection", "workforce.prepare_execution"]) {
    const h = harness({
      callHubTool: async (name, args, { fixture: f }) => {
        if (name === "workforce.search_candidates") return f.candidates;
        if (name === failingTool) {
          const error = new Error("ambiguous mutation response");
          error.code = "hub_invalid_response";
          error.details = { retryClass: "ambiguous_search_transport" };
          throw error;
        }
        if (name === "workforce.validate_selection") return f.validationReceipt;
        if (name === "workforce.prepare_execution") return f.prepared;
        throw new Error(`unexpected Hub tool ${name}`);
      },
    });
    const result = await h.runtime.workforceRun({}, `do not retry ${failingTool}`, { silent: true, benchmark: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "hub_invalid_response");
    assert.equal(h.hubCalls.filter((row) => row.name === failingTool).length, 1);
    const failed = result.receipt.hubTools.find((row) => row.tool === failingTool && row.status === "failed");
    assert.equal(failed.maxAttempts, 1);
    assert.equal(failed.retryScheduled, false);
    assert.equal(failed.replaySafety, "not-retried");
  }
}

function cardinalityShortfallTriggersRefinementButPolicyMinimumDoesNot() {
  const f = fixture();
  const twoRequired = structuredClone(f.workOrder);
  twoRequired.roleSlots[0].cardinality = 2;
  const short = structuredClone(f.candidates);
  short.slots[0].coverageGaps = ["gap:minimum-candidate-count"];
  const summary = _test.candidateGapSummary(short, twoRequired);
  assert.deepEqual(summary.gaps.map((row) => row.slotId), ["slot:backend"]);
  assert.equal(summary.gaps[0].eligibleCandidateCount, 1);
  assert.deepEqual(summary.gaps[0].coverageGapCodes, ["gap:minimum-candidate-count"]);

  const policyOnly = _test.candidateGapSummary(short, f.workOrder);
  assert.deepEqual(policyOnly.gaps, [], "policy minimum shortage must not trigger refinement when cardinality is filled");
}

async function structuredRepairExhaustionFailsBeforeHubAndPersistsArtifact() {
  const f = fixture();
  const malformedWorkOrder = structuredClone(f.workOrder);
  delete malformedWorkOrder.roleSlots[0].requiredRoles;
  const invalidEnvelope = JSON.stringify({
    schemaVersion: "agentlas.workforce-leader-call.v1",
    toolCall: { name: "workforce.search_candidates", arguments: { workOrder: malformedWorkOrder } },
  });
  const h = harness({ modelOutputs: [invalidEnvelope, invalidEnvelope] });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_contract");
  assert.equal(result.error.details.structuredRetryExhausted, true);
  assert.equal(result.error.details.phase, "leader-work-order");
  assert.equal(result.error.details.attempts, 2);
  assert.deepEqual(h.hubCalls, []);
  assert.deepEqual(result.receipt.structuredModelAttempts.map((row) => row.status), ["rejected", "rejected"]);
  assert.equal(result.receipt.structuredModelAttempts[1].retryScheduled, false);
  assert.equal(result.receipt.benchmarkAudit.passed, false);
  assert.equal(result.receipt.benchmarkAudit.structuredAttemptAuditPassed, false);
  assert.equal(h.benchmarkArtifacts.length, 1);
  assert.equal(result.benchmarkArtifactPath, "/tmp/workforce-benchmark-fixture.json");
  assert.equal(h.benchmarkArtifacts[0].workOrder, null);
  assert.equal(h.benchmarkArtifacts[0].executionReceipt.status, "failed");
  assert.equal(h.benchmarkArtifacts[0].executionReceipt.structuredModelAttempts.length, 2);
}

async function digestMismatchFailsClosed() {
  const h = harness({ prepareMutation: (prepared) => { prepared.executionRoster[0].packageHash = HASH_D; } });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "execution_bundle_digest_mismatch");
  assert.equal(h.modelCalls.length, 2, "no planner or worker may run after a pin mismatch");
  assert.equal(h.receipts[0].status, "failed");
}

async function invalidPlannerNeverFallsBack() {
  const f = fixture();
  const rawPriorMarker = "RAW_PRIOR_MUST_NOT_BE_PERSISTED_7419";
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      `I refuse to emit the requested plan JSON ${rawPriorMarker}`,
      `I still refuse to emit the requested plan JSON ${rawPriorMarker}`,
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "model_json_missing");
  assert.equal(result.receipt.planner.status, "failed");
  assert.equal(result.receipt.planner.fallbackUsed, false);
  assert.deepEqual(result.receipt.workers, []);
  assert.equal(result.receipt.benchmarkAudit.passed, false);
  assert.equal(result.receipt.planner.structuredAttemptCount, 2);
  assert.equal(result.receipt.planner.structuredRepairCount, 1);
  assert.deepEqual(result.receipt.structuredModelAttempts.filter((row) => row.phase === "planner").map((row) => row.status), ["rejected", "rejected"]);
  assert.equal(h.benchmarkArtifacts.length, 1);
  assert.deepEqual(h.benchmarkArtifacts[0].selection, f.selection);
  assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(rawPriorMarker));
  assert.doesNotMatch(JSON.stringify(h.benchmarkArtifacts[0]), new RegExp(rawPriorMarker));
}

async function outsideCandidateNeverReachesHubValidation() {
  const f = fixture();
  f.selection.assignments[0].agentReleaseId = "release:travel-agent";
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "selection_outside_candidate_set");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates"]);
}

async function candidateExpansionRemainsLeaderDecision() {
  const f = fixture();
  f.selection.requestExpansionForSlots = ["slot:backend"];
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "candidate_expansion_required");
  assert.equal(h.modelCalls.length, 2, "a valid leader expansion decision must not be coerced through schema repair");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates"]);
  const attempt = result.receipt.structuredModelAttempts.find((row) => row.phase === "leader-selection");
  assert.equal(attempt.status, "rejected");
  assert.equal(attempt.repairEligible, false);
  assert.equal(attempt.retryScheduled, false);
}

function benchmarkAuditFailsForMissingReceipts() {
  const audit = _test.auditBenchmarkReceipt({
    planner: { fallbackUsed: false, expectedPacketIds: ["packet:a", "packet:b"] },
    workers: [{ packetId: "packet:a", status: "completed" }],
    synthesis: null,
    verifier: null,
  });
  assert.equal(audit.passed, false);
  assert.deepEqual(audit.missingChildPacketIds, ["packet:b"]);
  assert.equal(audit.synthesisReceiptPresent, false);
  assert.equal(audit.verifierReceiptPresent, false);
}

function portableContractFailsClosed() {
  const f = fixture();
  const observedAt = new Date("2026-07-15T00:00:00.000Z");
  assert.throws(
    () => _test.validateWorkOrder({ ...f.workOrder, ontologyVersion: "awo:stale" }),
    (error) => error.code === "work_order_ontology_stale",
  );
  const missingExplicitOptionalArray = structuredClone(f.workOrder);
  delete missingExplicitOptionalArray.roleSlots[0].excludedCommunities;
  assert.throws(
    () => _test.validateWorkOrder(missingExplicitOptionalArray),
    (error) => error.code === "invalid_contract" && /excludedCommunities/.test(error.message),
  );
  const missingSelectionPolicy = structuredClone(f.workOrder);
  delete missingSelectionPolicy.selectionPolicy;
  assert.throws(
    () => _test.validateWorkOrder(missingSelectionPolicy),
    (error) => error.code === "invalid_contract" && /selectionPolicy/.test(error.message),
  );
  const missingEdgeArtifacts = structuredClone(f.workOrder);
  delete missingEdgeArtifacts.edges[0].artifactKinds;
  assert.throws(
    () => _test.validateWorkOrder(missingEdgeArtifacts),
    (error) => error.code === "invalid_contract" && /artifactKinds/.test(error.message),
  );
  assert.throws(
    () => _test.validateCandidateSet({ ...f.candidates, issuedAt: undefined }, f.workOrder, observedAt),
    (error) => error.code === "invalid_contract" && /issuedAt/.test(error.message),
  );
  assert.throws(
    () => _test.validateCandidateSet({ ...f.candidates, issuedAt: f.candidates.expiresAt }, f.workOrder, observedAt),
    (error) => error.code === "candidate_set_invalid" && /issuance window/.test(error.message),
  );
  const withRating = structuredClone(f.candidates);
  withRating.slots[0].candidates[0].rating = 5;
  assert.throws(
    () => _test.validateCandidateSet(withRating, f.workOrder, observedAt),
    (error) => error.code === "candidate_set_invalid" && /forbidden fit signal/.test(error.message),
  );
  const badValidation = structuredClone(f.validationReceipt);
  badValidation.idealTeam[0].packageHash = HASH_D;
  assert.throws(
    () => _test.validateSelectionReceipt(badValidation, f.selection, f.candidates, f.workOrder),
    (error) => error.code === "selection_validation_invalid" && /frozen candidate release/.test(error.message),
  );
}

function sourceBoundaryContract() {
  const source = require("node:fs").readFileSync(require.resolve("../engine/agentlas-workforce.cjs"), "utf8");
  assert.doesNotMatch(source, /marketplace\.search_agents/);
  assert.doesNotMatch(source, /lexicalScore|bm25|rerankMarketplaceCandidates|class R1Index/);
  assert.match(source, /workforce\.search_candidates[\s\S]*workforce\.validate_selection[\s\S]*workforce\.prepare_execution/);
  const cli = require("node:fs").readFileSync(require.resolve("../engine/agentlas.cjs"), "utf8");
  assert.match(cli, /case "network":[\s\S]*?cmdWorkforce/);
  assert.match(cli, /case "legacy-network"[\s\S]*?hep-network/);
  const repl = require("node:fs").readFileSync(require.resolve("../engine/agentlas-repl.cjs"), "utf8");
  assert.match(repl, /prefs\.autoNetwork && H\.workforceRun/);
  assert.doesNotMatch(repl, /prefs\.autoNetwork && H\.hepRun/);
  assert.match(source, /absence makes the assignment impossible/);
  assert.match(source, /distinct primary responsibility/);
  assert.match(source, /relation must be exactly one of reportsTo, handsOffTo, reviews, coordinatesWith/);
  assert.match(source, /A requiredToolCapabilities entry means the selected worker itself must invoke that exact host tool/);
}

function workforcePreferenceDefaults() {
  const { applyPreferenceDefaults } = require("../engine/agentlas-repl.cjs");
  assert.equal(applyPreferenceDefaults({}).autoNetwork, true, "new and untouched installs must use Workforce by default");
  assert.equal(applyPreferenceDefaults({ autoNetwork: false }).autoNetwork, false, "explicit opt-out must survive upgrades");
  assert.equal(applyPreferenceDefaults({ autoNetwork: true }).autoNetwork, true);
}

async function main() {
  await successContract();
  await malformedStructuredStagesRepairOnceAndSucceed();
  await terraEdgeEnumRepairUsesExactContract();
  await candidateGapRefinementRemainsTopLlmAuthored();
  await candidateGapRefinementIsBoundedAndFailsClosed();
  await ambiguousSearchResponseRetriesExactRequestOnce();
  await validMcpEnvelopeWithInvalidToolPayloadDoesNotRetry();
  await ambiguousSearchRetryExhaustionStopsAfterTwoExactCalls();
  await validationAndPreparationMutationsNeverRetry();
  cardinalityShortfallTriggersRefinementButPolicyMinimumDoesNot();
  await structuredRepairExhaustionFailsBeforeHubAndPersistsArtifact();
  await digestMismatchFailsClosed();
  await invalidPlannerNeverFallsBack();
  await outsideCandidateNeverReachesHubValidation();
  await candidateExpansionRemainsLeaderDecision();
  benchmarkAuditFailsForMissingReceipts();
  portableContractFailsClosed();
  sourceBoundaryContract();
  workforcePreferenceDefaults();
  process.stdout.write("workforce runtime contract: PASS\n");
}

module.exports = { fixture, harness };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
