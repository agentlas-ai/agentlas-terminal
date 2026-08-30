"use strict";

/**
 * Successful-run -> private Operational Experience candidate bridge.
 *
 * Storage boundary:
 * - Run/evidence and value-free intake decisions use the existing shared
 *   `run_events` ledger.
 * - Candidates use the existing Portable Experience exchange store.
 * - Preferences never enter Operational Experience; they remain local Taste
 *   observations referencing curated Memory, with no copied preference text.
 */
const crypto = require("node:crypto");
const exchange = require("./agentlas-experience-exchange.cjs");

const RUN_RECEIPT_SCHEMA = "agentlas.run-receipt.v1";
const INTAKE_POLICY_VERSION = "agentlas-terminal-operational-intake.v1";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const OPERATIONAL_KINDS = new Set(["procedure", "decision", "risk"]);

function canonicalHash(value) {
  return exchange.canonicalHash(value);
}

function digestHex(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(String(part ?? "")).update("\0");
  return hash.digest("hex");
}

function opaqueId(prefix, ...parts) {
  return `${prefix}:${digestHex(...parts).slice(0, 32)}`;
}

function cleanId(value, fallback) {
  const text = String(value || "").trim();
  return ID_RE.test(text) ? text : fallback;
}

function codePointSlice(value, max) {
  return Array.from(String(value || "").normalize("NFC").trim()).slice(0, max).join("");
}

function runtimeEnvironment(input = {}) {
  const platform = String(input.os || process.platform).toLowerCase();
  const arch = String(input.arch || process.arch).toLowerCase();
  const runtime = String(input.runtime || "terminal").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
  const osName = platform === "darwin" || platform === "macos"
    ? "macos"
    : platform === "win32" || platform === "windows"
      ? "windows"
      : platform === "linux" ? "linux" : "unknown";
  const archName = arch === "arm64" || arch === "aarch64" ? "arm64" : arch === "x64" || arch === "x86_64" ? "x64" : "unknown";
  if (osName === "unknown" || archName === "unknown" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtime)) return null;
  const constraints = [
    `agentlas.env.v1/os/${osName}`,
    `agentlas.env.v1/arch/${archName}`,
    `agentlas.env.v1/runtime/${runtime}`,
  ];
  return {
    runtime,
    os: osName,
    arch: archName,
    constraints,
    fingerprintHash: canonicalHash({ runtime, os: osName, arch: archName }),
  };
}

function createRunReceipt(input) {
  const environment = runtimeEnvironment(input.environment);
  if (!environment) throw new Error("RunReceipt requires a canonical runtime environment.");
  const taskSignature = exchange.canonicalSourceTaskId(input.taskSignature);
  if (!taskSignature) throw new Error("RunReceipt requires one canonical task signature.");
  if (!input.exactBase || !ID_RE.test(String(input.exactBase.agentReleaseId || ""))) {
    throw new Error("RunReceipt requires an exact agent definition release.");
  }
  const createdAt = input.createdAt || new Date().toISOString();
  const runId = cleanId(input.runId, opaqueId("run", input.exactBase.agentReleaseId, taskSignature, createdAt));
  const idempotencyKey = cleanId(input.idempotencyKey, opaqueId("run-key", runId));
  const provider = cleanId(input.model?.provider, "terminal-runtime");
  const modelId = cleanId(input.model?.modelId, provider);
  const outcome = ["succeeded", "partial", "failed", "cancelled"].includes(input.outcome?.status)
    ? input.outcome.status
    : "failed";
  const metrics = input.metrics || {};
  const promptTokens = Math.max(0, Math.trunc(Number(metrics.promptTokens) || 0));
  const completionTokens = Math.max(0, Math.trunc(Number(metrics.completionTokens) || 0));
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    Math.max(0, Math.trunc(Number(metrics.totalTokens) || 0)),
  );
  const draft = {
    schemaVersion: RUN_RECEIPT_SCHEMA,
    kind: "agentlas-run-receipt",
    receiptId: "pending:run-receipt",
    idempotencyKey,
    runId,
    agentDefinitionReleaseId: input.exactBase.agentReleaseId,
    experiencePackReleaseId: input.experiencePackReleaseId && ID_RE.test(input.experiencePackReleaseId) ? input.experiencePackReleaseId : null,
    variantId: null,
    taskSignature: {
      kind: taskSignature,
      hash: canonicalHash({ kind: taskSignature, locale: input.locale || "und" }),
      locale: String(input.locale || "und").slice(0, 20),
    },
    environment: {
      runtime: environment.runtime,
      os: environment.os,
      arch: environment.arch,
      fingerprintHash: environment.fingerprintHash,
    },
    resources: {
      mcp: (input.mcp || []).slice(0, 64).flatMap((item) => {
        const catalogId = cleanId(item?.catalogId, null);
        if (!catalogId) return [];
        const status = ["recommended", "approved", "connected", "skipped", "missing-key", "failed", "degraded"].includes(item.status)
          ? item.status
          : "approved";
        return [{ catalogId, status, resolvedVersion: item.resolvedVersion || null, fallbackFor: item.fallbackFor || null }];
      }),
      skills: [],
      model: { provider, modelId },
    },
    outcome: { status: outcome, failureCode: input.outcome?.failureCode ? codePointSlice(input.outcome.failureCode, 120) : null },
    verification: { verdict: "unverified", method: "none", verifierRef: null, evidenceRefs: [] },
    metricsEligible: false,
    metrics: {
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs: Math.max(0, Math.trunc(Number(metrics.durationMs) || 0)),
      retryCount: Math.max(0, Math.trunc(Number(metrics.retryCount) || 0)),
    },
    sideEffects: { occurred: input.sideEffects?.occurred === true, adverse: input.sideEffects?.adverse === true, evidenceRefs: [] },
    privacy: { rawPromptIncluded: false, rawTranscriptIncluded: false, rawLocalPathsIncluded: false, credentialValuesIncluded: false },
    createdAt,
    signature: null,
  };
  const receiptId = opaqueId("run-receipt", idempotencyKey, input.exactBase.agentReleaseId, taskSignature);
  // Core public RunReceipt hashes the canonical payload without receiptHash or
  // the optional transport signature. Keeping signature:null out of the hash
  // preserves Web/Desktop verification parity.
  const { signature: _signature, ...hashPayload } = { ...draft, receiptId };
  const receiptHash = canonicalHash(hashPayload);
  return { ...draft, receiptId, receiptHash };
}

function validateRunReceipt(receipt) {
  const required = [
    "schemaVersion", "kind", "receiptId", "idempotencyKey", "receiptHash", "runId",
    "agentDefinitionReleaseId", "experiencePackReleaseId", "variantId", "taskSignature",
    "environment", "resources", "outcome", "verification", "metricsEligible", "metrics",
    "sideEffects", "privacy", "createdAt", "signature",
  ];
  if (!receipt || Object.keys(receipt).some((key) => !required.includes(key)) || required.some((key) => !(key in receipt))) {
    throw new Error("Terminal RunReceipt shape drifted from Core v1.");
  }
  if (receipt.schemaVersion !== RUN_RECEIPT_SCHEMA || receipt.kind !== "agentlas-run-receipt") throw new Error("Terminal RunReceipt schema is invalid.");
  for (const key of ["receiptId", "idempotencyKey", "runId", "agentDefinitionReleaseId"]) if (!ID_RE.test(String(receipt[key] || ""))) throw new Error(`RunReceipt ${key} is invalid.`);
  if (!HASH_RE.test(receipt.receiptHash) || !HASH_RE.test(receipt.taskSignature?.hash) || !HASH_RE.test(receipt.environment?.fingerprintHash)) throw new Error("RunReceipt hash is invalid.");
  const { receiptHash: claimedHash, signature: _signature, ...hashPayload } = receipt;
  if (claimedHash !== canonicalHash(hashPayload)) throw new Error("RunReceipt hash does not match the Core canonical payload.");
  if (receipt.privacy?.rawPromptIncluded !== false || receipt.privacy?.rawTranscriptIncluded !== false || receipt.privacy?.rawLocalPathsIncluded !== false || receipt.privacy?.credentialValuesIncluded !== false) {
    throw new Error("RunReceipt privacy flags must all be false.");
  }
  if (receipt.signature !== null) throw new Error("Portable RunReceipt signature must be null.");
  return receipt;
}

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

function appendRunEvent(db, input) {
  if (!db || !tableExists(db, "run_events")) return false;
  // Allocate seq and insert in one SQLite statement. The old SELECT(MAX)+INSERT
  // pair allowed two Terminal processes to choose the same (run_id, seq); one
  // INSERT OR IGNORE then vanished while this function still reported success.
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO run_events
       (id,run_id,seq,ts,kind,chat_id,automation_id,node_id,agent_id,payload_json)
     SELECT ?,?,COALESCE(MAX(seq) + 1, 0),?,?,NULL,NULL,NULL,?,?
       FROM run_events WHERE run_id=?`,
  ).run(
    input.id,
    input.runId,
    input.ts,
    input.kind,
    input.agentId || null,
    JSON.stringify(input.payload),
    input.runId,
  );
  return Number(inserted?.changes || 0) === 1;
}

function persistRunReceipt(db, receipt, agentId) {
  validateRunReceipt(receipt);
  appendRunEvent(db, {
    id: opaqueId("event", "experience-run-receipt", receipt.receiptId),
    runId: receipt.runId,
    ts: receipt.createdAt,
    kind: "experience-run-receipt",
    agentId,
    payload: receipt,
  });
  return receipt;
}

function recordIntakeDecision(db, input) {
  const sourceHash = digestHex(INTAKE_POLICY_VERSION, input.agentId, input.memoryId || "none", input.exactBase?.agentReleaseId || "none", input.environmentKey || "none");
  appendRunEvent(db, {
    // The same curated memory can be observed by many distinct runs. Preserve
    // retry idempotency within one run without collapsing later run evidence.
    id: opaqueId("event", "experience-intake", input.runId, sourceHash),
    runId: input.runId,
    ts: input.ts,
    kind: input.kind || "experience-intake-decision",
    agentId: input.agentId,
    payload: {
      schemaVersion: "agentlas.terminal-experience-intake-receipt.v1",
      sourceMemoryRefHash: `sha256:${sourceHash}`,
      status: input.status,
      reasonCodes: [...new Set(input.reasonCodes || [])].sort(),
      candidateId: input.candidateId || null,
      bundleId: input.bundleId || null,
      exactAgentReleaseId: input.exactBase?.agentReleaseId || null,
      environmentKey: input.environmentKey || null,
      privacy: { sourceContentIncluded: false, rawPromptIncluded: false, rawTranscriptIncluded: false },
      networkUsed: false,
      published: false,
      attached: false,
      promoted: false,
    },
  });
}

function existingCandidate(userDataDir, itemId) {
  const state = exchange.loadExchangeState(userDataDir);
  for (const row of state.bundles) {
    try {
      const validation = exchange.readStoredBundle(userDataDir, row.bundleId);
      if (validation.bundle.items.some((item) => item.experienceItemId === itemId)) return { row, validation };
    } catch { /* corrupted unrelated rows are surfaced by list/inspect; intake continues fail-closed */ }
  }
  return null;
}

function candidateType(memoryKind) {
  return memoryKind === "risk" ? "warning" : "procedure";
}

function buildCandidateBundle(input) {
  const summary = codePointSlice(input.memory.content, 320);
  const scopeHash = exchange.projectScopeHash(input.cwd);
  const packKey = digestHex(INTAKE_POLICY_VERSION, input.agentId, input.exactBase.agentDefinitionId, input.exactBase.agentReleaseId, scopeHash, ...input.environment.constraints);
  const candidateKey = digestHex(packKey, input.memory.id, summary, ...input.taskSignatures);
  const experiencePackId = `exp:${packKey.slice(0, 32)}`;
  const releaseId = `experience-release:${candidateKey.slice(0, 32)}`;
  const itemId = `experience-item:${candidateKey.slice(0, 32)}`;
  const createdAt = input.receipt.createdAt;
  const item = {
    schemaVersion: "agentlas.experience-item.v1",
    kind: "agentlas-experience-item",
    experienceItemId: itemId,
    experiencePackId,
    experiencePackReleaseId: releaseId,
    type: candidateType(input.memory.kind),
    summary,
    instructions: [summary],
    taskSignatures: [...new Set(input.taskSignatures)].sort(),
    environmentConstraints: [...input.environment.constraints],
    evidenceReceiptIds: [input.receipt.receiptId],
    supersedesItemIds: [],
    confidence: input.memory.confidence === "high" ? 0.85 : input.memory.confidence === "low" ? 0.4 : 0.65,
    status: "candidate",
    privacyScope: "private",
    createdAt,
  };
  const bundle = {
    schemaVersion: exchange.BUNDLE_SCHEMA,
    kind: "agentlas-experience-bundle",
    bundleId: "exb_" + "0".repeat(48),
    bundleHash: `sha256:${"0".repeat(64)}`,
    requestedVisibility: "private",
    pack: {
      schemaVersion: "agentlas.experience-pack.v1",
      kind: "agentlas-experience-pack",
      experiencePackId,
      releaseId,
      ownerRef: "owner:local-terminal",
      version: "0.0.1",
      baseCompatibility: {
        agentDefinitionId: input.exactBase.agentDefinitionId,
        compatibleBaseReleaseIds: [input.exactBase.agentReleaseId],
      },
      itemIds: [itemId],
      evidenceReceiptIds: [input.receipt.receiptId],
      mcpRequirements: [],
      containsBasePackageMaterial: false,
      contentHash: `sha256:${"0".repeat(64)}`,
      visibility: "private",
      status: "draft",
      createdAt,
    },
    items: [item],
    sourceAttestations: [],
    privacy: {
      basePackageMaterialIncluded: false,
      rawPromptIncluded: false,
      rawTranscriptIncluded: false,
      rawLocalPathsIncluded: false,
      credentialValuesIncluded: false,
    },
  };
  bundle.pack.contentHash = exchange.experiencePackContentHash(bundle);
  bundle.bundleHash = exchange.experienceBundleHash(bundle);
  bundle.bundleId = exchange.experienceBundleId(bundle);
  return { validation: exchange.validateExperienceBundle(bundle), itemId };
}

function captureOperationalCandidate(input) {
  const issues = exchange.portableExperienceSafetyIssues(input.memory.content);
  const sensitivity = String(input.memory.sensitivity || "internal").trim().toLowerCase();
  if (!["internal", "public"].includes(sensitivity)) issues.push("sensitive-memory");
  if (input.memory.scope === "user_identity") issues.push("user-specific-memory-scope");
  if (issues.length) return { status: "blocked", reasonCodes: [...new Set(issues)].sort() };
  const tasks = exchange.deriveCanonicalTaskClasses(input.taskHint, {
    declaredTaskClasses: input.taskSignatures,
  }).taskIds;
  if (!tasks.length) return { status: "skipped", reasonCodes: ["task-taxonomy-unavailable"] };
  const { validation, itemId } = buildCandidateBundle({ ...input, taskSignatures: tasks });
  const existing = existingCandidate(input.userDataDir, itemId);
  if (existing) return {
    status: "existing",
    reasonCodes: ["idempotent-existing-candidate"],
    candidateId: itemId,
    bundleId: existing.row.bundleId,
    row: existing.row,
  };
  const row = exchange.saveLocalBundle(input.userDataDir, validation, { cwd: input.cwd });
  return { status: "candidate-created", reasonCodes: [], candidateId: itemId, bundleId: row.bundleId, row };
}

function finalizeAgentExecution(input) {
  const now = input.createdAt || new Date().toISOString();
  const result = {
    receipt: null,
    candidates: [],
    blocked: 0,
    skipped: 0,
    tasteObservations: 0,
    networkUsed: false,
    published: false,
    attached: false,
    promoted: false,
  };
  if (!input.agent?.id || !input.exactBase?.agentDefinitionId || !input.exactBase?.agentReleaseId) return result;
  const environment = runtimeEnvironment(input.environment);
  const taskResolution = exchange.deriveCanonicalTaskClasses(input.taskHint, { declaredTaskClasses: input.taskSignatures });
  if (!environment || !taskResolution.taskIds.length) return result;
  const receipt = createRunReceipt({
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    exactBase: input.exactBase,
    experiencePackReleaseId: input.experiencePackReleaseId,
    taskSignature: taskResolution.taskIds[0],
    environment,
    model: input.model,
    mcp: input.mcp,
    outcome: input.outcome,
    metrics: input.metrics,
    sideEffects: input.sideEffects,
    locale: input.locale,
    createdAt: now,
  });
  persistRunReceipt(input.db, receipt, input.agent.id);
  result.receipt = receipt;
  if (receipt.outcome.status !== "succeeded") return result;

  const memories = Array.isArray(input.curatedMemories) ? input.curatedMemories : [];
  for (const memory of memories) {
    if (!memory?.id || !memory.kind) continue;
    if (memory.kind === "preference") {
      recordIntakeDecision(input.db, {
        runId: receipt.runId,
        ts: now,
        kind: "taste-draft-observation",
        agentId: input.agent.id,
        memoryId: memory.id,
        exactBase: input.exactBase,
        environmentKey: environment.fingerprintHash,
        status: "local-observation",
        reasonCodes: ["preference-private-taste-only", "pairwise-evidence-required"],
      });
      result.tasteObservations += 1;
      continue;
    }
    if (!OPERATIONAL_KINDS.has(memory.kind)) {
      recordIntakeDecision(input.db, {
        runId: receipt.runId, ts: now, agentId: input.agent.id, memoryId: memory.id,
        exactBase: input.exactBase, environmentKey: environment.fingerprintHash,
        status: "skipped", reasonCodes: ["non-operational-memory-kind"],
      });
      result.skipped += 1;
      continue;
    }
    const captured = captureOperationalCandidate({
      userDataDir: input.userDataDir,
      cwd: input.cwd,
      agentId: input.agent.id,
      exactBase: input.exactBase,
      environment,
      memory,
      receipt,
      taskHint: input.taskHint,
      taskSignatures: taskResolution.taskIds,
    });
    recordIntakeDecision(input.db, {
      runId: receipt.runId,
      ts: now,
      agentId: input.agent.id,
      memoryId: memory.id,
      exactBase: input.exactBase,
      environmentKey: environment.fingerprintHash,
      status: captured.status,
      reasonCodes: captured.reasonCodes,
      candidateId: captured.candidateId,
      bundleId: captured.bundleId,
    });
    if (captured.status === "blocked") result.blocked += 1;
    else if (captured.status === "skipped") result.skipped += 1;
    else result.candidates.push(captured);
  }
  return result;
}

function listRunEvents(db, kind, agentId = null) {
  if (!db || !tableExists(db, "run_events")) return [];
  const rows = agentId
    ? db.prepare("SELECT payload_json FROM run_events WHERE kind=? AND agent_id=? ORDER BY ts DESC,id ASC").all(kind, agentId)
    : db.prepare("SELECT payload_json FROM run_events WHERE kind=? ORDER BY ts DESC,id ASC").all(kind);
  return rows.flatMap((row) => { try { return [JSON.parse(row.payload_json)]; } catch { return []; } });
}

module.exports = {
  RUN_RECEIPT_SCHEMA,
  INTAKE_POLICY_VERSION,
  runtimeEnvironment,
  createRunReceipt,
  validateRunReceipt,
  persistRunReceipt,
  finalizeAgentExecution,
  captureOperationalCandidate,
  listRunEvents,
};
