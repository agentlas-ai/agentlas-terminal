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
    ontologyVersion: "awo:2026-07-15.1",
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
    ontologyVersion: "awo:2026-07-15.1",
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
  let modelIndex = 0;
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
      if (name === "workforce.search_candidates") return f.candidates;
      if (name === "workforce.validate_selection") return f.validationReceipt;
      if (name === "workforce.prepare_execution") {
        const prepared = structuredClone(f.prepared);
        if (overrides.prepareMutation) overrides.prepareMutation(prepared);
        return prepared;
      }
      throw new Error(`unexpected Hub tool ${name}`);
    },
    appendReceipt: (receipt) => receipts.push(structuredClone(receipt)),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  return { ...f, runtime, modelCalls, hubCalls, receipts };
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
  assert.match(h.modelCalls[0].system, /awo:2026-07-15\.1/);
  assert.match(h.modelCalls[0].system, /role:payments-engineer/);
  assert.match(h.modelCalls[0].system, /role:quality-engineer/);
  assert.match(h.modelCalls[0].system, /community:payments-engineering/);
  assert.equal(h.modelCalls.some((call) => /travel/i.test(call.system) && /PINNED_RELEASE/.test(call.system)), false);
  assert.match(h.modelCalls.find((call) => /PINNED_RELEASE=release:backend-v3/.test(call.system)).system, /exact backend release/i);
  assert.match(h.modelCalls.find((call) => /PINNED_RELEASE=release:verifier-v7/.test(call.system)).system, /exact verifier release/i);
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
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
      "I refuse to emit the requested plan JSON",
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "model_json_missing");
  assert.equal(result.receipt.planner.status, "failed");
  assert.equal(result.receipt.planner.fallbackUsed, false);
  assert.deepEqual(result.receipt.workers, []);
  assert.equal(result.receipt.benchmarkAudit.passed, false);
}

async function outsideCandidateNeverReachesHubValidation() {
  const f = fixture();
  f.selection.assignments[0].agentReleaseId = "release:travel-agent";
  const h = harness({
    modelOutputs: [
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.search_candidates", arguments: { workOrder: f.workOrder } } }),
      JSON.stringify({ schemaVersion: "agentlas.workforce-leader-call.v1", toolCall: { name: "workforce.validate_selection", arguments: { selection: f.selection } } }),
    ],
  });
  const result = await h.runtime.workforceRun({}, "hard payment benchmark", { silent: true, benchmark: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "selection_outside_candidate_set");
  assert.deepEqual(h.hubCalls.map((row) => row.name), ["workforce.search_candidates"]);
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
  assert.match(source, /Hard requirements mean catalog-proof-required eligibility/);
}

function workforcePreferenceDefaults() {
  const { applyPreferenceDefaults } = require("../engine/agentlas-repl.cjs");
  assert.equal(applyPreferenceDefaults({}).autoNetwork, true, "new and untouched installs must use Workforce by default");
  assert.equal(applyPreferenceDefaults({ autoNetwork: false }).autoNetwork, false, "explicit opt-out must survive upgrades");
  assert.equal(applyPreferenceDefaults({ autoNetwork: true }).autoNetwork, true);
}

async function main() {
  await successContract();
  await digestMismatchFailsClosed();
  await invalidPlannerNeverFallsBack();
  await outsideCandidateNeverReachesHubValidation();
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
