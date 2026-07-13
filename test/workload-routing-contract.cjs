#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const routing = require("../engine/agentlas-workload-routing.cjs");
const { buildArgs } = require("../engine/agentlas.cjs");
const { create: createParity } = require("../engine/agentlas-parity.cjs");

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
  assert.equal(routing.normalizeTier("haiku"), "economy");
  assert.equal(routing.normalizeTier("luna"), "economy");
  assert.equal(routing.normalizeTier("sonnet"), "balanced");
  assert.equal(routing.normalizeTier("tera"), "balanced", "the common tera spelling aliases to terra's balanced tier");
  assert.equal(routing.normalizeTier("terra"), "balanced");
  assert.equal(routing.normalizeTier("opus"), "frontier");
  assert.equal(routing.normalizeTier("sol"), "frontier");

  const economy = { tier: "economy", effort: "low", reason: "bounded independent verification" };
  const frontier = { tier: "frontier", effort: "max", reason: "high-risk cross-system synthesis" };
  const codexRuntime = { mode: "cli", kind: "codex" };
  const claudeRuntime = { mode: "cli", kind: "claude-code" };

  assert.deepEqual(
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }),
    {
      ok: true,
      tier: "economy",
      model: "gpt-5.6-luna",
      effort: "low",
      provider: "codex",
      source: "ai",
      fallbackReason: null,
      aiReason: economy.reason,
      requested: {
        schema: "agentlas.workload-allocation.v1",
        decisionId: null,
        selectorVersion: "agentlas-terminal.parent-ai.v1",
        inputFeatureHash: null,
        ...economy,
        modelClass: null,
        exactModelId: null,
        phase: null,
        reasonCodes: ["ai-assigned"],
        requiredCapabilities: [],
        estimatedContextTokens: null,
      },
    },
  );
  assert.equal(routing.resolveAllocation({ runtime: claudeRuntime, decision: frontier }).model, "opus");
  assert.equal(routing.resolveAllocation({ runtime: codexRuntime, decision: frontier }).effort, "max", "current Codex inventory advertises max directly");

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
  assert.equal(costClamped.model, "gpt-5.6-luna");
  assert.match(costClamped.fallbackReason, /cost_policy_clamped/);

  const contextAdjusted = routing.resolveAllocation({
    runtime: codexRuntime,
    decision: { ...economy, estimatedContextTokens: 5_000, requiredCapabilities: ["long-context"] },
    availableModels: [
      { id: "tiny", tier: "economy", contextWindow: 2_000, capabilities: ["code"] },
      { id: "roomy", tier: "balanced", contextWindow: 10_000, capabilities: ["code", "long-context"] },
    ],
  });
  assert.equal(contextAdjusted.model, "roomy");
  assert.equal(contextAdjusted.tier, "balanced");
  assert.match(contextAdjusted.fallbackReason, /capability_or_context_adjusted/);

  const unsupported = routing.resolveAllocation({
    runtime: { mode: "cli", kind: "gemini", model: "gemini-current" },
    decision: economy,
  });
  assert.equal(unsupported.model, "gemini-current", "unmapped provider must preserve the active model");
  assert.equal(unsupported.source, "fallback");
  assert.match(unsupported.fallbackReason, /provider_family_unavailable/);

  const invalid = routing.resolveAllocation({ runtime: codexRuntime, decision: { tier: "frontier" } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.fallbackReason, "invalid_ai_allocation");
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

  // Deterministic routing receives a parent decision, not task text. Identical
  // decisions resolve identically for semantically unrelated tasks: no keyword heuristic.
  assert.equal(
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }).model,
    routing.resolveAllocation({ runtime: codexRuntime, decision: economy }).model,
  );
  const source = fs.readFileSync(require.resolve("../engine/agentlas-workload-routing.cjs"), "utf8");
  assert.doesNotMatch(source, /TASK_KEYWORDS|ROLE_TO_MODEL|keyword.*tier/i);
  const terminalSource = fs.readFileSync(require.resolve("../engine/agentlas.cjs"), "utf8");
  assert.doesNotMatch(
    terminalSource,
    /createDecisionReceipt\(\{[^}]*\btaskText\s*:/g,
    "Terminal allocation call sites must never pass raw task text into a receipt builder",
  );

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
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
  if (process.platform !== "win32") {
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
  const codexArgs = buildArgs("codex", "system", "work", "write", { model: "gpt-5.6-sol", effort: "xhigh" });
  assert.ok(codexArgs.includes("gpt-5.6-sol"));
  assert.ok(codexArgs.includes('model_reasoning_effort="xhigh"'));

  // End-to-end Terminal swarm contract: the higher-level planner can assign
  // different worker and synthesis models, and each execution gets a receipt.
  const calls = [];
  const integratedReceiptFile = path.join(tmp, "swarm-receipts.jsonl");
  const parity = createParity({
    prefsLang: () => "en",
    resolveRuntime: () => codexRuntime,
    runCwd: () => tmp,
    buildChildEnvCli: async () => ({}),
    captureRuntime: async (_kind, system, prompt, options) => {
      calls.push({ system, prompt, options });
      if (/higher-level workload allocator/.test(system)) {
        return JSON.stringify({
          tasks: [
            { title: "cheap audit", brief: "audit fixtures", allocation: economy },
            { title: "hard repair", brief: "repair architecture", allocation: frontier },
          ],
          synthesis: { tier: "balanced", effort: "high", reason: "merge conflicting evidence" },
        });
      }
      if (/synthesizer of an agent swarm/.test(system)) return "integrated answer";
      return "worker result";
    },
    runApi: async () => "",
  });
  const result = await parity.swarmRun({}, "ship a safe fix", {
    ui: uiStub(),
    cwd: tmp,
    permission: "write",
    runtime: codexRuntime,
    concurrency: 2,
    receiptFile: integratedReceiptFile,
  });
  assert.equal(result.ok, true);
  const executionCalls = calls.filter((call) => !/higher-level workload allocator/.test(call.system));
  assert.deepEqual(executionCalls.map((call) => call.options.model).sort(), ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"].sort());
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
