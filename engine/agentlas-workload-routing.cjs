"use strict";

/*
 * AI-authored workload allocation for Terminal system agents.
 *
 * Important boundary: this module NEVER judges a task from words or regexes. A
 * parent LLM writes the exact live-inventory decision. Host policy code only
 * validates that decision and applies pins/policy/capability constraints. It
 * never manufactures a provider model id from a tier.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const ALLOCATION_SCHEMA = "agentlas.workload-allocation.v1";
const TIERS = Object.freeze(["economy", "balanced", "frontier"]);
const TIER_RANK = Object.freeze({ economy: 0, balanced: 1, frontier: 2 });
const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CAPABILITIES = new Set(["code", "image", "tools", "long-context"]);
const PHASES = new Set(["plan", "delegate", "synthesize"]);

function cleanText(value, max = 240) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeTier(value) {
  const v = String(value || "").toLowerCase().trim();
  return TIERS.includes(v) ? v : null;
}

function normalizeEffort(value) {
  const v = String(value || "").toLowerCase().trim();
  return EFFORTS.includes(v) ? v : null;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").toLowerCase().trim()).filter((item) => CAPABILITIES.has(item)))].slice(0, 8);
}

function normalizeReasonCodes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const code = cleanText(item, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeAllocation(value, expectedPhase = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tier = normalizeTier(value.tier || value.modelTier || value.model_tier);
  const effort = normalizeEffort(value.effort);
  const reason = cleanText(value.rationale || value.reason, 240);
  if (!tier || !effort || !reason) return null;
  const rawPhase = cleanText(value.phase, 20).toLowerCase();
  const phase = PHASES.has(rawPhase) ? rawPhase : expectedPhase && PHASES.has(expectedPhase) ? expectedPhase : null;
  if (expectedPhase && phase !== expectedPhase) return null;
  const contextTokensRaw = value.estimatedContextTokens ?? value.estimated_context_tokens ?? value.contextTokens;
  const contextTokens = Number.isSafeInteger(Number(contextTokensRaw)) && Number(contextTokensRaw) >= 0
    ? Math.min(Number(contextTokensRaw), 10_000_000)
    : null;
  const reasonCodes = normalizeReasonCodes(value.reasonCodes || value.reason_codes);
  return {
    schema: ALLOCATION_SCHEMA,
    decisionId: cleanText(value.decisionId || value.decision_id, 255) || null,
    selectorVersion: cleanText(value.selectorVersion || value.selector_version, 255) || "agentlas-terminal.parent-ai.v1",
    inputFeatureHash: /^sha256:[0-9a-f]{64}$/.test(String(value.inputFeatureHash || value.input_feature_hash || ""))
      ? String(value.inputFeatureHash || value.input_feature_hash)
      : null,
    tier,
    modelClass: cleanText(value.modelClass || value.model_class, 32) || null,
    runtimeId: cleanText(value.runtimeId || value.runtime_id || value.sessionId || value.session_id, 255) || null,
    exactModelId: cleanText(value.exactModelId || value.exact_model_id || value.modelId, 255) || null,
    effort,
    phase,
    reasonCodes: reasonCodes.length ? reasonCodes : ["ai-assigned"],
    reason,
    requiredCapabilities: normalizeCapabilities(value.requiredCapabilities || value.required_capabilities),
    estimatedContextTokens: contextTokens,
  };
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function normalizePlan(raw, { maxTasks = 12 } = {}) {
  const value = typeof raw === "string" ? extractJsonObject(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.tasks) || !value.tasks.length) return null;
  const tasks = [];
  for (const item of value.tasks.slice(0, Math.max(1, Math.min(24, maxTasks)))) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const brief = cleanText(item.brief, 8_000);
    const title = cleanText(item.title || brief, 120);
    const allocation = normalizeAllocation(item.allocation || item, "delegate");
    if (!brief || !title || !allocation) continue;
    tasks.push({ title, brief, role: cleanText(item.role, 80) || undefined, allocation });
  }
  const synthesis = normalizeAllocation(value.synthesis, "synthesize");
  if (!tasks.length || !synthesis) return null;
  return { schemaVersion: SCHEMA_VERSION, tasks, synthesis };
}

function runtimeProvider(runtime) {
  if (!runtime) return "";
  if (runtime.mode === "cli") return String(runtime.kind || "");
  if (runtime.backend === "anthropic") return "anthropic-api";
  if (runtime.backend === "openai") return "openai-api";
  return String(runtime.backend || "");
}

function defaultAvailableModels(runtime) {
  const provider = runtimeProvider(runtime);
  const current = runtime && runtime.model ? {
    id: runtime.model,
    tier: runtime.modelTier || runtime.tier || null,
    capabilities: runtime.capabilities || [],
    contextWindow: runtime.contextWindow || null,
    efforts: runtime.efforts || [],
    description: runtime.modelDescription || "host-selected current model",
  } : null;
  if (provider === "codex") {
    const detected = readCodexModelInventory();
    const currentIndex = current ? detected.findIndex((model) => model.id === current.id) : -1;
    if (current && currentIndex < 0) {
      detected.push(...normalizeAvailableModels([current]));
    } else if (current && currentIndex >= 0) {
      detected[currentIndex] = {
        ...detected[currentIndex],
        tier: detected[currentIndex].tier || current.tier,
        capabilities: [...new Set([...detected[currentIndex].capabilities, ...normalizeCapabilities(current.capabilities)])],
        contextWindow: detected[currentIndex].contextWindow || current.contextWindow,
        efforts: [...new Set([...detected[currentIndex].efforts, ...current.efforts.map(normalizeEffort).filter(Boolean)])],
      };
    }
    return detected;
  }
  if (current) return normalizeAvailableModels([current]);
  return [];
}

function readCodexModelInventory(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  const file = path.join(codexHome, "models_cache.json");
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed.models)) return [];
    const out = [];
    const seen = new Set();
    for (const model of parsed.models) {
      if (!model || model.visibility !== "list" || typeof model.slug !== "string") continue;
      const id = model.slug.trim();
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const contextWindow = Number.isSafeInteger(model.context_window) && model.context_window > 0
        ? model.context_window
        : Number.isSafeInteger(model.max_context_window) && model.max_context_window > 0
          ? model.max_context_window
          : null;
      const capabilities = ["code"];
      if (model.tool_mode || model.shell_type || model.supports_parallel_tool_calls) capabilities.push("tools");
      if (Array.isArray(model.input_modalities) && model.input_modalities.includes("image")) capabilities.push("image");
      if (contextWindow) capabilities.push("long-context");
      out.push({
        id,
        tier: normalizeTier(model.tier || model.cost_tier),
        capabilities,
        contextWindow,
        efforts: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((item) => normalizeEffort(item && item.effort)).filter(Boolean)
          : [],
        description: cleanText(model.description, 300) || null,
        priority: Number.isFinite(Number(model.priority)) ? Number(model.priority) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeAvailableModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const item of models) {
    const value = typeof item === "string" ? { id: item } : item;
    if (!value || typeof value !== "object") continue;
    const id = cleanText(value.id || value.model, 160);
    const tier = normalizeTier(value.tier || value.costTier || value.cost_tier);
    if (!id) continue;
    const contextWindow = Number.isSafeInteger(Number(value.contextWindow)) && Number(value.contextWindow) > 0
      ? Number(value.contextWindow)
      : null;
    out.push({
      id,
      tier,
      capabilities: normalizeCapabilities(value.capabilities),
      costTier: normalizeTier(value.costTier) || tier,
      contextWindow,
      efforts: Array.isArray(value.efforts) ? value.efforts.map(normalizeEffort).filter(Boolean) : [],
      description: cleanText(value.description, 300) || null,
      priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : null,
    });
  }
  return out;
}

// This is intentionally a small, privacy-safe inventory.  The parent LLM sees
// only executable runtime ids, model ids and supported effort levels; never a
// path, account, prompt, credential, or transcript.
function runtimeInventory(runtimes) {
  return (Array.isArray(runtimes) ? runtimes : []).map((runtime, index) => ({
    runtimeId: cleanText(runtime && (runtime.runtimeId || runtime.id), 255) || `runtime-${index + 1}`,
    kind: cleanText(runtime && runtime.kind, 80) || null,
    backend: cleanText(runtime && runtime.backend, 80) || null,
    mode: cleanText(runtime && runtime.mode, 24) || null,
    models: normalizeAvailableModels(runtime && runtime.availableModels || defaultAvailableModels(runtime)).map((model) => ({
      id: model.id,
      efforts: model.efforts,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      tier: model.tier,
      description: model.description,
      priority: model.priority,
    })),
  }));
}

function resolveEffort(provider, requested, supported = []) {
  if (provider === "claude-code") {
    if (requested === "none") return null;
    const mapped = requested === "minimal" ? "low" : requested === "xhigh" ? "max" : requested;
    const available = Array.isArray(supported) ? supported : [];
    return available.includes(mapped) ? mapped : null;
  }
  if (provider === "codex") {
    if (requested === "none") return null;
    const available = Array.isArray(supported) ? supported : [];
    if (!available.length) return null;
    if (available.includes(requested)) return requested;
    const requestedRank = EFFORTS.indexOf(requested);
    const lower = available
      .filter((item) => EFFORTS.indexOf(item) <= requestedRank)
      .sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0];
    return lower || available[0] || null;
  }
  return null;
}

function resolveAllocation(options = {}) {
  const runtime = options.runtime || null;
  const provider = runtimeProvider(runtime);
  const decision = normalizeAllocation(options.decision);
  const modelPin = cleanText(options.modelPin, 160) || null;
  const effortPinPresent = options.effortPin !== undefined && options.effortPin !== null;
  const effortPin = effortPinPresent ? normalizeEffort(options.effortPin) : null;
  const reasons = [];

  if (!decision) {
    const pinnedEffort = effortPinPresent && effortPin !== "none" ? resolveEffort(provider, effortPin) : null;
    const pinReasons = ["invalid_ai_allocation"];
    if (modelPin) pinReasons.push("explicit_model_pin");
    if (effortPinPresent) pinReasons.push("explicit_effort_pin");
    return {
      ok: Boolean(modelPin),
      tier: null,
      model: modelPin,
      effort: pinnedEffort,
      provider,
      source: modelPin || effortPinPresent ? "user-pin" : "fallback",
      fallbackReason: pinReasons.join(","),
      aiReason: null,
    };
  }

  let tier = decision.tier;
  const maxTier = normalizeTier(options.maxTier);
  const invalidCostPolicy = Boolean(options.maxTier && !maxTier);
  if (invalidCostPolicy) reasons.push("invalid_cost_policy");
  if (maxTier && TIER_RANK[tier] > TIER_RANK[maxTier]) {
    tier = maxTier;
    reasons.push("cost_policy_clamped");
  }

  const available = normalizeAvailableModels(options.availableModels || runtime && runtime.availableModels || defaultAvailableModels(runtime));
  // A live parent decision names an exact model. Validate it against inventory;
  // never choose the first model in a tier or sort models into a hidden fallback.
  let selected = decision.exactModelId
    ? available.find((item) => item.id === decision.exactModelId) || null
    : null;
  if (decision.exactModelId && !selected) reasons.push("parent_model_not_in_live_inventory");
  if (!decision.exactModelId) reasons.push("parent_exact_model_required");
  const candidateIssue = (candidate, prefix) => {
    if (!candidate) return `${prefix}_not_in_live_inventory`;
    if (invalidCostPolicy) return "invalid_cost_policy";
    const caps = new Set(candidate.capabilities);
    if (decision.requiredCapabilities.some((required) => !caps.has(required))) return `${prefix}_capability_mismatch`;
    if (decision.estimatedContextTokens != null && decision.estimatedContextTokens > 0) {
      if (candidate.contextWindow == null) return `${prefix}_context_window_unknown`;
      if (decision.estimatedContextTokens > candidate.contextWindow) return `${prefix}_context_window_exceeded`;
    }
    if (maxTier && !candidate.tier) return `${prefix}_cost_tier_unknown`;
    if (maxTier && TIER_RANK[candidate.tier] > TIER_RANK[maxTier]) return `${prefix}_exceeds_cost_policy`;
    if (candidate.tier && candidate.tier !== tier) return `${prefix}_tier_mismatch`;
    return null;
  };
  if (selected) {
    const issue = candidateIssue(selected, "selected_model");
    if (issue) {
      selected = null;
      if (!reasons.includes(issue)) reasons.push(issue);
    }
  }

  let model = selected && selected.id;
  let effectiveModelEntry = selected;
  let source = decision.exactModelId ? "parent-ai-exact" : "fallback";
  if (modelPin) {
    model = modelPin;
    effectiveModelEntry = available.find((item) => item.id === modelPin) || null;
    source = "user-pin";
    reasons.push("explicit_model_pin");
  } else if (!model) {
    source = "fallback";
    const activeId = cleanText(runtime && runtime.model, 160) || null;
    const active = activeId ? available.find((item) => item.id === activeId) || null : null;
    const issue = activeId ? candidateIssue(active, "active_model") : "active_model_unavailable";
    if (issue) {
      if (!reasons.includes(issue)) reasons.push(issue);
    } else {
      model = active.id;
      effectiveModelEntry = active;
      reasons.push("compliant_active_model_fallback");
    }
  }

  let effort;
  if (effortPinPresent) {
    effort = effortPin === "none" ? null : resolveEffort(provider, effortPin, effectiveModelEntry && effectiveModelEntry.efforts || []);
    if (effort == null && effortPin !== "none" && modelPin) {
      if (provider === "codex") effort = effortPin;
      if (provider === "claude-code") effort = effortPin === "minimal" ? "low" : effortPin === "xhigh" ? "max" : effortPin;
    }
    source = source === "user-pin" ? source : "user-pin";
    reasons.push("explicit_effort_pin");
    if (effortPin !== "none" && effort == null) reasons.push("effort_pin_unsupported_by_provider");
  } else {
    effort = resolveEffort(provider, decision.effort, effectiveModelEntry && effectiveModelEntry.efforts || []);
    if (effort == null && decision.effort !== "none") reasons.push("effort_unsupported_by_provider");
  }

  return {
    ok: Boolean(model),
    tier,
    model,
    effort: effort || null,
    provider,
    source,
    fallbackReason: reasons.join(",") || null,
    aiReason: decision.reason,
    requested: decision,
  };
}

function resolveAllocationAcrossRuntimes(options = {}) {
  const runtimes = Array.isArray(options.runtimes) ? options.runtimes : [];
  const decision = normalizeAllocation(options.decision);
  const fallbackRuntime = options.fallbackRuntime || options.runtime || runtimes[0] || null;
  const fallbackId = cleanText(fallbackRuntime && (fallbackRuntime.runtimeId || fallbackRuntime.id), 255) || null;
  const requestedId = decision && decision.runtimeId;
  const chosen = requestedId
    ? runtimes.find((runtime, index) => (cleanText(runtime && (runtime.runtimeId || runtime.id), 255) || `runtime-${index + 1}`) === requestedId) || null
    : fallbackRuntime;
  const runtime = chosen || fallbackRuntime;
  const resolution = resolveAllocation({ ...options, runtime, decision, availableModels: runtime && runtime.availableModels });
  const requestedExact = Boolean(decision && decision.runtimeId && decision.exactModelId);
  const runtimeId = cleanText(runtime && (runtime.runtimeId || runtime.id), 255) || fallbackId;
  if (requestedExact && chosen && resolution.model === decision.exactModelId) {
    resolution.source = "parent-selected-live-runtime-model";
  } else if (requestedExact) {
    resolution.fallbackReason = [resolution.fallbackReason, chosen ? "parent_model_not_in_live_inventory" : "parent_runtime_not_in_live_inventory"].filter(Boolean).join(",");
    if (resolution.source !== "user-pin") resolution.source = "fallback";
  }
  return { ...resolution, runtime, runtimeId, requestedRuntimeId: requestedId || null };
}

function modelRoleForStage(stage) {
  return ["plan", "planner", "leader", "verify", "verifier", "synthesize", "synthesis", "route", "clarify"]
    .includes(cleanText(stage, 80).toLowerCase())
    ? "orchestrator"
    : "worker";
}

function normalizeObservedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  return Number.isInteger(inputTokens) && inputTokens >= 0
    && Number.isInteger(outputTokens) && outputTokens >= 0
    ? { inputTokens, outputTokens }
    : null;
}

function createDecisionReceipt({ taskId, stage, decision, resolution, role, usage }) {
  const normalized = normalizeAllocation(decision);
  const validationIssues = [];
  const decisionProvided = decision != null;
  if (!decisionProvided) validationIssues.push("allocation_not_provided");
  else if (!normalized) validationIssues.push("invalid_ai_allocation");
  const resolvedRole = role === "worker" || role === "orchestrator"
    ? role
    : modelRoleForStage(stage);
  const resolutionCodes = cleanText(resolution && resolution.fallbackReason, 500)
    .split(",")
    .map((code) => cleanText(code, 120))
    .filter(Boolean);
  const reasonCodes = [...new Set([
    ...(normalized ? normalized.reasonCodes : []),
    ...resolutionCodes,
  ])].slice(0, 32);
  const featurePayload = JSON.stringify(normalized ? {
    phase: normalized.phase,
    role: resolvedRole,
    tier: normalized.tier,
    effort: normalized.effort,
    reasonCodes: normalized.reasonCodes,
    requiredCapabilities: normalized.requiredCapabilities,
    estimatedContextTokens: normalized.estimatedContextTokens,
  } : { phase: cleanText(stage, 80) || null, role: resolvedRole, allocation: null });
  const featureHash = `sha256:${crypto.createHash("sha256").update(featurePayload, "utf8").digest("hex")}`;
  const source = resolution && resolution.source;
  const hasResolvedCurrent = Boolean(
    resolution
    && resolution.ok
    && cleanText(resolution.model, 255)
    && cleanText(resolution.runtimeId, 255),
  );
  const status = source === "user-pin" && hasResolvedCurrent
    ? "user-pin"
    : source === "fallback" && hasResolvedCurrent
      ? "fallback-current"
      : normalized && resolution && resolution.ok
        ? "resolved"
        : "unresolved";
  const riskCodes = new Set(normalized ? normalized.reasonCodes : []);
  return {
    schemaVersion: "agentlas.model-allocation-receipt.v1",
    decisionId: normalized && normalized.decisionId
      ? normalized.decisionId
      : `terminal:model-allocation:${featureHash.slice("sha256:".length, "sha256:".length + 24)}`,
    packetId: cleanText(taskId, 255) || null,
    role: resolvedRole,
    status,
    requested: {
      tier: normalized ? normalized.tier : null,
      modelClass: normalized ? normalized.modelClass : null,
      modelId: normalized && normalized.exactModelId
        ? normalized.exactModelId
        : source === "user-pin" ? cleanText(resolution && resolution.model, 255) || null : null,
      effort: normalized ? normalized.effort : "none",
    },
    resolved: {
      tier: resolution && resolution.tier ? cleanText(resolution.tier, 32) : normalized ? normalized.tier : null,
      provider: cleanText(resolution && resolution.provider, 80) || null,
      modelId: cleanText(resolution && resolution.model, 255) || null,
      sessionId: cleanText(resolution && resolution.runtimeId, 255) || null,
      effort: cleanText(resolution && resolution.effort, 16) || "none",
    },
    reasonCodes,
    inputFeatureHash: normalized && normalized.inputFeatureHash ? normalized.inputFeatureHash : featureHash,
    selectorVersion: normalized ? normalized.selectorVersion : "deterministic-host-fallback",
    independentVerificationRequired:
      riskCodes.has("high-risk") || riskCodes.has("critical-risk") || riskCodes.has("independent-verification"),
    usage: normalizeObservedUsage(usage),
    validationIssues,
    privacy: { rawPromptIncluded: false, rawTranscriptIncluded: false },
  };
}

function defaultReceiptPath() {
  return path.join(os.homedir(), ".agentlas", "model-routing-receipts.jsonl");
}

function appendDecisionReceipt(receipt, file = defaultReceiptPath()) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows/best effort */ }
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("model routing receipt path must not be a symlink");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(receipt) + "\n", null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/best effort */ }
  return file;
}

function plannerSystemPrompt({ language = "English", maxTasks = 12, mode = "swarm", liveRuntimeInventory = [] } = {}) {
  return [
    `You are the higher-level workload allocator for an Agentlas ${mode}.`,
    "Judge each child task using the full goal and planned dependency graph. Do not use a keyword lookup or fixed role-to-model table.",
    "LIVE_RUNTIME_INVENTORY below is authoritative. For every child and synthesis, choose an exact runtimeId and exactModelId only from it. Do not infer, rename, or invent a model from a tier. If an exact choice cannot be justified, select the current-runtime fallback from the inventory.",
    `LIVE_RUNTIME_INVENTORY=${JSON.stringify(liveRuntimeInventory)}`,
    "Choose effort none|minimal|low|medium|high|xhigh|max. Spend frontier/high effort only when the task's complexity, risk, context, or synthesis burden justifies it.",
    `Return strict JSON only with at most ${Math.max(1, Math.min(24, maxTasks))} tasks:`,
    '{"tasks":[{"title":"short","brief":"concrete child task","role":"optional","allocation":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-1","exactModelId":"model-from-inventory","tier":"economy|balanced|frontier","effort":"none|minimal|low|medium|high|xhigh|max","phase":"delegate","reasonCodes":["bounded-scope|parallel-throughput|complex-reasoning|large-context|high-risk"],"rationale":"short observable rationale","requiredCapabilities":["code|image|tools|long-context"],"estimatedContextTokens":0}}],"synthesis":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-1","exactModelId":"model-from-inventory","tier":"economy|balanced|frontier","effort":"none|minimal|low|medium|high|xhigh|max","phase":"synthesize","reasonCodes":["cross-result-synthesis"],"rationale":"short observable rationale","requiredCapabilities":["code|image|tools|long-context"],"estimatedContextTokens":0}}',
    "Every task and synthesis MUST include an allocation. Keep tasks independent where safe and sequential where dependencies require it.",
    `Write task text and reasons in ${language}.`,
  ].filter(Boolean).join("\n");
}

module.exports = {
  SCHEMA_VERSION,
  ALLOCATION_SCHEMA,
  TIERS,
  EFFORTS,
  normalizeTier,
  normalizeEffort,
  normalizeAllocation,
  normalizePlan,
  extractJsonObject,
  runtimeProvider,
  defaultAvailableModels,
  runtimeInventory,
  readCodexModelInventory,
  resolveAllocation,
  resolveAllocationAcrossRuntimes,
  createDecisionReceipt,
  modelRoleForStage,
  appendDecisionReceipt,
  defaultReceiptPath,
  plannerSystemPrompt,
};
