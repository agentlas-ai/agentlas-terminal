#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const routing = require("../engine/agentlas-workload-routing.cjs");
const { buildArgs, listAvailableRuntimes, resolveRuntime } = require("../engine/agentlas.cjs");
const { create: createParity } = require("../engine/agentlas-parity.cjs");
const { loadCoreStormbreakerHarness } = require("../engine/agentlas-core-harness.cjs");

function uiStub() {
  const id = (value) => String(value);
  return {
    lang: "en",
    c: { paw: id, bold: id, text: id, dim: id, emerald: id },
    line() {}, info() {}, warn() {}, error() {}, tool() {}, toolResult() {},
    startSpinner() {}, stopSpinner() {}, markdown() {}, beginTurn() {}, endTurn() {}, ok() {},
  };
}

async function main() {
  assert.equal(routing.normalizeTier("economy"), "economy");
  assert.equal(routing.normalizeTier("balanced"), "balanced");
  assert.equal(routing.normalizeTier("frontier"), "frontier");
  assert.equal(routing.normalizeTier("haiku"), null, "vendor model names must never imply cost tiers");
  assert.equal(routing.normalizeTier("terra"), null, "live model ids must never be parsed into cost tiers");
  assert.equal(routing.normalizeTier("opus"), null, "vendor model names must never imply cost tiers");

  const economy = { tier: "economy", exactModelId: "codex-live-economy", effort: "low", reason: "bounded independent verification" };
  const frontier = { tier: "frontier", exactModelId: "codex-live-frontier", effort: "max", reason: "high-risk cross-system synthesis" };
  const claudeFrontier = { tier: "frontier", exactModelId: "claude-live-frontier", effort: "max", reason: "high-risk cross-system synthesis" };
  const codexRuntime = {
    mode: "cli",
    kind: "codex",
    model: "codex-live-economy",
    availableModels: [
      { id: "codex-live-economy", tier: "economy", capabilities: ["code", "tools"], efforts: ["low", "high", "max"] },
      { id: "codex-live-balanced", tier: "balanced", capabilities: ["code", "tools"], efforts: ["low", "high", "max"] },
      { id: "codex-live-frontier", tier: "frontier", capabilities: ["code", "tools"], efforts: ["low", "high", "max"] },
    ],
  };
  const claudeRuntime = {
    mode: "cli",
    kind: "claude-code",
    model: "claude-live-frontier",
    availableModels: [
      { id: "claude-live-economy", tier: "economy", capabilities: ["code", "tools"], efforts: ["low", "high", "max"] },
      { id: "claude-live-frontier", tier: "frontier", capabilities: ["code", "tools"], efforts: ["low", "high", "max"] },
    ],
  };

  const storedRuntimeDb = {
    prepare(sql) {
      if (/FROM active_runtime/.test(sql)) {
        return { get: () => ({ id: 1, kind: "claude-code", model: "claude-host-current", long_context: 1 }) };
      }
      throw new Error(`unexpected test query: ${sql}`);
    },
  };
  const storedRuntime = resolveRuntime(storedRuntimeDb);
  assert.equal(storedRuntime.model, "claude-host-current", "stored CLI active model must survive runtime resolution");
  assert.deepEqual(storedRuntime.capabilities, ["code", "tools", "long-context"]);
  const storedInventory = listAvailableRuntimes(storedRuntimeDb, storedRuntime)
    .find((runtime) => runtime.kind === "claude-code");
  assert.ok(storedInventory.availableModels.some((model) => model.id === "claude-host-current"));
  const unknownTierCurrent = routing.resolveAllocation({
    runtime: storedInventory,
    decision: { tier: "balanced", exactModelId: "claude-host-current", effort: "none", reason: "host current model" },
  });
  assert.equal(unknownTierCurrent.ok, true, "a host current model may run without a cost ceiling even if its tier is unknown");
  const ceilingUnknownTier = routing.resolveAllocation({
    runtime: storedInventory,
    decision: { tier: "balanced", exactModelId: "claude-host-current", effort: "none", reason: "host current model" },
    maxTier: "balanced",
  });
  assert.equal(ceilingUnknownTier.ok, false, "unknown model cost tier must fail closed under a ceiling");
  assert.match(ceilingUnknownTier.fallbackReason, /cost_tier_unknown/);

  assert.deepEqual(
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }),
    {
      ok: true,
      tier: "economy",
      model: "codex-live-economy",
      effort: "low",
      provider: "codex",
      source: "parent-ai-exact",
      fallbackReason: null,
      aiReason: economy.reason,
      requested: {
        schema: "agentlas.workload-allocation.v1",
        decisionId: null,
        selectorVersion: "agentlas-terminal.parent-ai.v1",
        inputFeatureHash: null,
        ...economy,
        modelClass: null,
        runtimeId: null,
        exactModelId: "codex-live-economy",
        phase: null,
        reasonCodes: ["ai-assigned"],
        requiredCapabilities: [],
        estimatedContextTokens: null,
      },
    },
  );
  assert.equal(routing.resolveAllocation({ runtime: claudeRuntime, decision: claudeFrontier }).model, "claude-live-frontier");
  assert.equal(routing.resolveAllocation({ runtime: codexRuntime, decision: frontier }).effort, "max", "current Codex inventory advertises max directly");

  // The parent is given the live inventory and chooses an exact executable
  // runtime/model pair. The host validates that choice; it does not recreate a
  // model id from a tier or task keyword.
  const liveRuntimes = [
    { ...codexRuntime, runtimeId: "runtime-1" },
    { ...claudeRuntime, runtimeId: "runtime-2" },
  ];
  const exact = routing.resolveAllocationAcrossRuntimes({
    runtimes: liveRuntimes,
    fallbackRuntime: liveRuntimes[0],
    decision: { tier: "frontier", runtimeId: "runtime-2", exactModelId: "claude-live-frontier", effort: "high", reason: "cross-result synthesis" },
  });
  assert.equal(exact.runtime.kind, "claude-code");
  assert.equal(exact.model, "claude-live-frontier");
  assert.equal(exact.effort, "high");
  assert.equal(exact.source, "parent-selected-live-runtime-model");
  assert.ok(routing.runtimeInventory(liveRuntimes)[1].models.some((model) => model.id === "claude-live-frontier"));

  const pinned = routing.resolveAllocation({
    runtime: codexRuntime,
    decision: economy,
    modelPin: "my-explicit-model",
    effortPin: "high",
  });
  assert.equal(pinned.model, "my-explicit-model");
  assert.equal(pinned.effort, "high");
  assert.equal(pinned.source, "user-pin");
  assert.match(pinned.fallbackReason, /explicit_model_pin/);
  assert.match(pinned.fallbackReason, /explicit_effort_pin/);
  const effortOff = routing.resolveAllocation({ runtime: codexRuntime, decision: frontier, effortPin: "none" });
  assert.equal(effortOff.effort, null, "explicit /effort off must not pass an unsupported literal 'none' to Codex");
  assert.equal(effortOff.source, "user-pin");

  const costClamped = routing.resolveAllocation({ runtime: codexRuntime, decision: frontier, maxTier: "economy" });
  assert.equal(costClamped.tier, "economy");
  assert.equal(costClamped.model, "codex-live-economy");
  assert.match(costClamped.fallbackReason, /cost_policy_clamped/);
  assert.match(costClamped.fallbackReason, /selected_model_exceeds_cost_policy/);

  const contextAdjusted = routing.resolveAllocation({
    runtime: codexRuntime,
    decision: { ...economy, exactModelId: "tiny", estimatedContextTokens: 5_000, requiredCapabilities: ["long-context"] },
    availableModels: [
      { id: "tiny", tier: "economy", contextWindow: 2_000, capabilities: ["code"] },
      { id: "roomy", tier: "balanced", contextWindow: 10_000, capabilities: ["code", "long-context"] },
    ],
  });
  assert.equal(contextAdjusted.model, null, "host must not silently run a different model after capability rejection");
  assert.equal(contextAdjusted.ok, false);
  assert.equal(contextAdjusted.tier, "economy");
  assert.match(contextAdjusted.fallbackReason, /capability_mismatch/);

  const unsupported = routing.resolveAllocation({
    runtime: { mode: "cli", kind: "gemini", model: "gemini-current" },
    decision: { ...economy, exactModelId: "codex-live-economy" },
  });
  assert.equal(unsupported.model, "gemini-current", "unmapped provider must preserve the active model");
  assert.equal(unsupported.source, "fallback");
  assert.match(unsupported.fallbackReason, /parent_model_not_in_live_inventory/);

  const inventoryUnavailable = routing.resolveAllocation({
    runtime: { mode: "cli", kind: "codex", model: "codex-current", availableModels: [] },
    decision: { tier: "balanced", exactModelId: "not-advertised", effort: "high", reason: "use current if inventory is unavailable" },
  });
  assert.equal(inventoryUnavailable.model, null, "an unadvertised active model is not a verified fallback");
  assert.equal(inventoryUnavailable.ok, false);
  assert.equal(inventoryUnavailable.effort, null, "an unavailable inventory must not invent effort support");
  assert.match(inventoryUnavailable.fallbackReason, /parent_model_not_in_live_inventory/);
  assert.match(inventoryUnavailable.fallbackReason, /active_model_not_in_live_inventory/);

  const noExactChoice = routing.resolveAllocation({
    runtime: codexRuntime,
    decision: { tier: "economy", effort: "low", reason: "parent omitted exact live model" },
  });
  assert.equal(noExactChoice.model, "codex-live-economy");
  assert.equal(noExactChoice.source, "fallback");
  assert.match(noExactChoice.fallbackReason, /parent_exact_model_required/);

  const invalid = routing.resolveAllocation({ runtime: codexRuntime, decision: { tier: "frontier" } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.fallbackReason, "invalid_ai_allocation");
  const explicitInvalidPin = routing.resolveAllocation({ runtime: codexRuntime, decision: null, modelPin: "operator-pinned-model" });
  assert.equal(explicitInvalidPin.ok, true, "an explicit operator model pin is the only unresolved-allocation escape hatch");
  assert.equal(explicitInvalidPin.model, "operator-pinned-model");
  const invalidWithOff = routing.resolveAllocation({ runtime: codexRuntime, decision: null, effortPin: "none" });
  assert.equal(invalidWithOff.effort, null);
  assert.equal(invalidWithOff.source, "user-pin");

  const plan = routing.normalizePlan(JSON.stringify({
    tasks: [
      { title: "audit", brief: "audit exact files", allocation: economy },
      { title: "repair", brief: "repair cross-system issue", allocation: frontier },
    ],
    synthesis: { tier: "balanced", effort: "high", reason: "reconcile evidence" },
  }));
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].allocation.tier, "economy");
  assert.equal(plan.tasks[1].allocation.tier, "frontier");
  assert.equal(plan.synthesis.tier, "balanced");

  // Policy validation receives a parent decision, not task text. The exact live
  // model choice is authored by the parent, never reconstructed from keywords.
  assert.equal(
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }).model,
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }).model,
  );
  const source = fs.readFileSync(require.resolve("../engine/agentlas-workload-routing.cjs"), "utf8");
  assert.doesNotMatch(source, /TASK_KEYWORDS|ROLE_TO_MODEL|keyword.*tier/i);
  assert.doesNotMatch(source, /gpt-5\.6-(?:luna|terra|sol)|\bid:\s*["'](?:haiku|sonnet|opus)["']/, "Terminal allocator must not embed provider model ids");
  assert.doesNotMatch(source, /MODEL_FAMILY_TIER|available\.find\(\(item\) => item\.tier === tier\)/, "Terminal allocator must not map vendor classes or choose the first model in a tier");
  const terminalSource = fs.readFileSync(require.resolve("../engine/agentlas.cjs"), "utf8");
  assert.doesNotMatch(
    terminalSource,
    /createDecisionReceipt\(\{[^}]*\btaskText\s*:/g,
    "Terminal allocation call sites must never pass raw task text into a receipt builder",
  );
  const paritySource = fs.readFileSync(require.resolve("../engine/agentlas-parity.cjs"), "utf8");
  const coreHarnessSource = fs.readFileSync(require.resolve("../engine/agentlas-core-harness.cjs"), "utf8");
  assert.doesNotMatch(paritySource, /["']--auto-run["']/, "agentlas storm must execute in its own harness, not Hephaestus CLI auto-run");
  assert.match(paritySource, /stormbreaker:\s*true/);
  assert.match(paritySource, /typeof D\.projectCwd === "function" \? D\.projectCwd\(\) : D\.runCwd\(\)/, "storm/swarm workers must execute in the user's actual project folder");
  assert.match(paritySource, /WORK ALREADY ASSIGNED TO PEERS/, "workers must see sibling ownership before spawning more work");
  assert.match(paritySource, /HOST-VERIFIED ALLOCATION:/, "final gate must receive the host-resolved runtime, model, and effort evidence");
  assert.match(paritySource, /if \(!resolution\.ok\)[\s\S]*?model allocation failed closed/, "swarm workers must not silently run a CLI default after allocation rejection");
  assert.match(terminalSource, /if \(!resolution\.ok\)[\s\S]*?builder model allocation failed closed/, "builder execution must fail before silently using a CLI default model");
  const stormPlanner = routing.plannerSystemPrompt({
    mode: "stormbreaker-goal-ultracode",
    liveRuntimeInventory: routing.runtimeInventory(liveRuntimes),
  });
  assert.doesNotMatch(stormPlanner, /GOAL MODE|ULTRACODE MODE/, "Terminal planner helpers must not redefine the Core harness");
  assert.match(stormPlanner, /runtimeId.*exactModelId/s);
  assert.doesNotMatch(paritySource, /["']GOAL MODE:/, "Terminal workers must not define a local Goal mode prompt");
  assert.doesNotMatch(paritySource, /["']ULTRACODE MODE:/, "Terminal workers must not define a local UltraCode mode prompt");
  assert.match(paritySource, /loadCoreStormbreakerHarness/, "Terminal storm must load its prompt from Agentlas Core");
  assert.match(coreHarnessSource, /\["stormbreaker", "harness"\]/, "Core bridge must call the canonical harness command");
  assert.match(coreHarnessSource, /process\.platform === "win32" \? \["python", "py", "python3"\]/, "Core bridge must resolve Python on Windows");
  assert.doesNotMatch(coreHarnessSource, /["']GOAL MODE:\s+[^"']+/, "Terminal Core bridge must not copy the Goal mode prompt");
  assert.doesNotMatch(coreHarnessSource, /["']ULTRACODE MODE:\s+[^"']+/, "Terminal Core bridge must not copy the UltraCode mode prompt");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-workload-routing-"));
  const codexHome = path.join(tmp, "codex-home");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({
    models: [
      { slug: "gpt-5.6-luna", visibility: "list", context_window: 123_456, supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "gpt-5.6-sol", visibility: "hide", context_window: 999_999 },
      { slug: "../../bad", visibility: "list" },
    ],
  }));
  assert.deepEqual(routing.readCodexModelInventory(codexHome).map((item) => ({ id: item.id, contextWindow: item.contextWindow, efforts: item.efforts })), [
    { id: "gpt-5.6-luna", contextWindow: 123_456, efforts: ["low", "max"] },
  ]);
  const receiptFile = path.join(tmp, "routing.jsonl");
  const secretPrompt = "private task /Users/example/secret.txt";
  const receipt = routing.createDecisionReceipt({
    taskId: "worker-1",
    taskText: secretPrompt,
    stage: "worker",
    decision: economy,
    resolution: routing.resolveAllocation({ runtime: codexRuntime, decision: economy }),
    now: new Date("2026-07-13T00:00:00.000Z"),
  });
  routing.appendDecisionReceipt(receipt, receiptFile);
  const stored = fs.readFileSync(receiptFile, "utf8");
  assert.doesNotMatch(stored, /private task|secret\.txt|\/Users\/example/);
  assert.equal(receipt.schemaVersion, "agentlas.model-allocation-receipt.v1");
  assert.deepEqual(Object.keys(receipt).sort(), [
    "decisionId", "independentVerificationRequired", "inputFeatureHash", "packetId", "privacy",
    "reasonCodes", "requested", "resolved", "schemaVersion", "selectorVersion", "status", "validationIssues",
  ].sort(), "Terminal receipt must have exactly the Core public schema fields");
  assert.equal(receipt.privacy.rawPromptIncluded, false);
  assert.equal(receipt.privacy.rawTranscriptIncluded, false);
  assert.match(receipt.inputFeatureHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.packetId, "worker-1");
  assert.equal(receipt.status, "resolved");
  const redactedReceipt = routing.createDecisionReceipt({
    taskId: "worker-private-reason",
    taskText: "another task",
    stage: "worker",
    decision: { tier: "economy", effort: "low", reason: "inspect /Users/example/private.txt for user@example.com and sk-abcdefghijklmnop" },
    resolution: routing.resolveAllocation({ runtime: codexRuntime, decision: economy }),
  });
  const redactedJson = JSON.stringify(redactedReceipt);
  assert.doesNotMatch(redactedJson, /\/Users\/example|user@example\.com|sk-abcdefghijklmnop|another task/);
  assert.doesNotMatch(redactedJson, /userPrompt|brief|history|systemPrompt|toolData/i);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
    const target = path.join(tmp, "target.jsonl");
    fs.writeFileSync(target, "");
    const link = path.join(tmp, "link.jsonl");
    fs.symlinkSync(target, link);
    assert.throws(() => routing.appendDecisionReceipt(receipt, link), /symlink/);
  }

  const claudeArgs = buildArgs("claude-code", "system", "work", "write", { model: "haiku", effort: "high" });
  assert.deepEqual(claudeArgs.slice(0, 2), ["-p", "Think hard. work"]);
  assert.ok(claudeArgs.includes("--model"));
  assert.ok(claudeArgs.includes("haiku"));
  assert.ok(claudeArgs.includes("--effort"));
  assert.ok(claudeArgs.includes("high"));
  const codexArgs = buildArgs("codex", "system", "work", "write", { model: "gpt-5.6-sol", effort: "xhigh" });
  assert.ok(codexArgs.includes("gpt-5.6-sol"));
  assert.ok(codexArgs.includes('model_reasoning_effort="xhigh"'));

  // End-to-end Terminal swarm contract: the higher-level planner can assign
  // different worker and synthesis models, and each execution gets a receipt.
  const calls = [];
  const integratedReceiptFile = path.join(tmp, "swarm-receipts.jsonl");
  const fixtureHarnessPrompt = [
    "You are executing inside the Agentlas-owned STORMBREAKER GOAL + ULTRACODE HARNESS.",
    "GOAL MODE: fixture goal contract.",
    "ULTRACODE MODE: fixture implementation contract.",
    "CORE_TERMINAL_HARNESS_FIXTURE_EXACT_A921",
  ].join("\n");
  let executionHarness = {
    schema_version: "agentlas.stormbreaker.goal-ultracode-harness.v1",
    harness_id: "agentlas-core/stormbreaker-goal-ultracode",
    mode: "stormbreaker-goal-ultracode",
    system_prompt: fixtureHarnessPrompt,
    prompt_sha256: require("node:crypto").createHash("sha256").update(fixtureHarnessPrompt).digest("hex"),
  };
  if (process.env.HEPHAESTUS_RUNTIME_ROOT) {
    executionHarness = await loadCoreStormbreakerHarness(tmp, process.env.HEPHAESTUS_RUNTIME_ROOT);
  }
  const coreHarnessPrompt = executionHarness.system_prompt;
  const parity = createParity({
    prefsLang: () => "en",
    resolveRuntime: () => codexRuntime,
    listAvailableRuntimes: () => [
      { ...codexRuntime, runtimeId: "runtime-1" },
      { ...claudeRuntime, runtimeId: "runtime-2" },
    ],
    runCwd: () => tmp,
    buildChildEnvCli: async () => ({}),
    captureRuntime: async (kind, system, prompt, options) => {
      calls.push({ kind, system, prompt, options });
      if (/higher-level workload allocator/.test(system)) {
        return JSON.stringify({
          tasks: [
            { title: "cheap audit", brief: "audit fixtures", allocation: { ...economy, runtimeId: "runtime-1", exactModelId: "codex-live-economy" } },
            { title: "hard repair", brief: "repair architecture", allocation: { ...frontier, runtimeId: "runtime-2", exactModelId: "claude-live-frontier" } },
          ],
          synthesis: { tier: "balanced", effort: "high", reason: "merge conflicting evidence", runtimeId: "runtime-1", exactModelId: "codex-live-balanced" },
        });
      }
      if (/synthesizer of an agent swarm/.test(system)) return "integrated answer";
      return "worker result";
    },
    runApi: async () => "",
  });
  const callsBeforeMissingHarness = calls.length;
  const missingHarness = await parity.swarmRun({}, "must not use a local Stormbreaker prompt", {
    ui: uiStub(),
    cwd: tmp,
    permission: "write",
    runtime: codexRuntime,
    stormbreaker: true,
  });
  assert.equal(missingHarness.ok, false);
  assert.equal(missingHarness.error, "stormbreaker-core-harness-unavailable");
  assert.equal(calls.length, callsBeforeMissingHarness, "missing Core harness must fail before any model runs");
  const result = await parity.swarmRun({}, "ship a safe fix", {
    ui: uiStub(),
    cwd: tmp,
    permission: "write",
    runtime: codexRuntime,
    concurrency: 2,
    receiptFile: integratedReceiptFile,
    stormbreaker: true,
    executionHarness,
  });
  assert.equal(result.ok, true);
  const executionCalls = calls.filter((call) => !/higher-level workload allocator/.test(call.system));
  assert.deepEqual(executionCalls.map((call) => call.options.model).sort(), ["codex-live-economy", "codex-live-balanced", "claude-live-frontier"].sort());
  assert.deepEqual(executionCalls.map((call) => call.kind).sort(), ["claude-code", "codex", "codex"].sort(), "each exact parent runtime selection invokes that runtime CLI");
  const synthesisCall = calls.find((call) => /synthesizer of an agent swarm/.test(call.system));
  assert.match(synthesisCall.prompt, /HOST-VERIFIED ALLOCATION:/);
  assert.match(synthesisCall.prompt, /"runtimeKind":"claude-code"/);
  const workerCalls = calls.filter((call) => /EMERGENT AGENT SWARM/.test(call.system));
  assert.ok(workerCalls.every((call) => /WORK ALREADY ASSIGNED TO PEERS/.test(call.system)), "every planned worker must see sibling ownership before spawning");
  assert.ok(calls.every((call) => call.system.split(coreHarnessPrompt).length - 1 === 1), "planner, workers, and synthesis must receive the exact Core harness once");
  const receiptLines = fs.readFileSync(integratedReceiptFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receiptLines.length, 3);
  assert.deepEqual(new Set(receiptLines.map((item) => item.packetId)), new Set(["worker-1", "worker-2", "synthesis-final"]));
  assert.ok(receiptLines.every((item) => item.schemaVersion === "agentlas.model-allocation-receipt.v1"));
  assert.ok(receiptLines.every((item) => item.privacy.rawPromptIncluded === false && item.privacy.rawTranscriptIncluded === false));
  assert.doesNotMatch(fs.readFileSync(integratedReceiptFile, "utf8"), /audit fixtures|repair architecture|ship a safe fix/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("workload-routing-contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
