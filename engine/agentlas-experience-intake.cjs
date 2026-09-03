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

function receiptOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function receiptObject(value, label, required, allowed, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return null;
  }
  const missing = required.filter((key) => !receiptOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (missing.length) issues.push(`${label} missing required fields: ${missing.join(", ")}`);
  if (unknown.length) issues.push(`${label} contains unknown fields: ${unknown.join(", ")}`);
  return value;
}

function receiptId(value, label, issues, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !ID_RE.test(value)) issues.push(`${label} must be an opaque stable id`);
}

function receiptHash(value, label, issues) {
  if (typeof value !== "string" || !HASH_RE.test(value)) issues.push(`${label} must be sha256:<64 lowercase hex>`);
}

function receiptString(value, label, issues, options = {}) {
  if (options.nullable && value === null) return;
  if (typeof value !== "string" || (options.maxLength != null && value.length > options.maxLength)) {
    const suffix = options.maxLength == null ? "string" : `string of at most ${options.maxLength} characters`;
    issues.push(`${label} must be a ${suffix}${options.nullable ? " or null" : ""}`);
  }
}

function receiptEnum(value, label, values, issues) {
  if (!values.includes(value)) issues.push(`${label} is invalid`);
}

function receiptBoolean(value, label, issues) {
  if (typeof value !== "boolean") issues.push(`${label} must be a boolean`);
}

function receiptIso(value, label, issues) {
  if (typeof value !== "string") {
    issues.push(`${label} must be an RFC3339 date-time`);
    return;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    issues.push(`${label} must be an RFC3339 date-time`);
    return;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[7];
  const offsetValid = offset === "Z" || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month] || hour > 23 || minute > 59 || second > 59 || !offsetValid || !Number.isFinite(Date.parse(value))) {
    issues.push(`${label} must be a valid RFC3339 date-time`);
  }
}

function receiptIdList(value, label, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    receiptId(item, `${label}[${index}]`, issues);
    if (seen.has(item)) issues.push(`${label} must not contain duplicates`);
    seen.add(item);
  });
}

function receiptMetric(value, label, issues) {
  if (!Number.isInteger(value) || value < 0) issues.push(`${label} must be a non-negative integer`);
}

function validateRunReceiptNested(receipt) {
  const issues = [];
  receiptId(receipt.receiptId, "receiptId", issues);
  receiptId(receipt.idempotencyKey, "idempotencyKey", issues);
  receiptId(receipt.runId, "runId", issues);
  receiptId(receipt.agentDefinitionReleaseId, "agentDefinitionReleaseId", issues);
  receiptId(receipt.experiencePackReleaseId, "experiencePackReleaseId", issues, true);
  receiptId(receipt.variantId, "variantId", issues, true);
  receiptHash(receipt.receiptHash, "receiptHash", issues);

  const taskSignature = receiptObject(
    receipt.taskSignature,
    "taskSignature",
    ["kind", "hash"],
    ["kind", "hash", "locale"],
    issues,
  );
  if (taskSignature) {
    receiptId(taskSignature.kind, "taskSignature.kind", issues);
    receiptHash(taskSignature.hash, "taskSignature.hash", issues);
    if (receiptOwn(taskSignature, "locale")) receiptString(taskSignature.locale, "taskSignature.locale", issues, { maxLength: 20 });
  }

  const environment = receiptObject(
    receipt.environment,
    "environment",
    ["runtime", "os", "arch", "fingerprintHash"],
    ["runtime", "os", "arch", "fingerprintHash"],
    issues,
  );
  if (environment) {
    for (const key of ["runtime", "os", "arch"]) receiptId(environment[key], `environment.${key}`, issues);
    receiptHash(environment.fingerprintHash, "environment.fingerprintHash", issues);
  }

  const resources = receiptObject(
    receipt.resources,
    "resources",
    ["mcp", "skills", "model"],
    ["mcp", "skills", "model"],
    issues,
  );
  if (resources) {
    if (!Array.isArray(resources.mcp)) {
      issues.push("resources.mcp must be an array");
    } else {
      resources.mcp.forEach((item, index) => {
        const mcp = receiptObject(
          item,
          `resources.mcp[${index}]`,
          ["catalogId", "status"],
          ["catalogId", "status", "resolvedVersion", "fallbackFor"],
          issues,
        );
        if (!mcp) return;
        receiptId(mcp.catalogId, `resources.mcp[${index}].catalogId`, issues);
        receiptEnum(mcp.status, `resources.mcp[${index}].status`, ["recommended", "approved", "connected", "skipped", "missing-key", "failed", "degraded"], issues);
        if (receiptOwn(mcp, "resolvedVersion")) receiptString(mcp.resolvedVersion, `resources.mcp[${index}].resolvedVersion`, issues, { nullable: true });
        if (receiptOwn(mcp, "fallbackFor")) receiptId(mcp.fallbackFor, `resources.mcp[${index}].fallbackFor`, issues, true);
      });
    }
    if (!Array.isArray(resources.skills)) {
      issues.push("resources.skills must be an array");
    } else {
      resources.skills.forEach((item, index) => {
        const skill = receiptObject(item, `resources.skills[${index}]`, ["id"], ["id", "version"], issues);
        if (!skill) return;
        receiptId(skill.id, `resources.skills[${index}].id`, issues);
        if (receiptOwn(skill, "version")) receiptString(skill.version, `resources.skills[${index}].version`, issues, { nullable: true });
      });
    }
    const model = receiptObject(resources.model, "resources.model", ["provider", "modelId"], ["provider", "modelId"], issues);
    if (model) {
      receiptId(model.provider, "resources.model.provider", issues);
      receiptId(model.modelId, "resources.model.modelId", issues);
    }
  }

  const outcome = receiptObject(receipt.outcome, "outcome", ["status"], ["status", "failureCode"], issues);
  if (outcome) {
    receiptEnum(outcome.status, "outcome.status", ["succeeded", "partial", "failed", "cancelled"], issues);
    if (receiptOwn(outcome, "failureCode")) receiptString(outcome.failureCode, "outcome.failureCode", issues, { nullable: true, maxLength: 120 });
  }

  const verification = receiptObject(
    receipt.verification,
    "verification",
    ["verdict", "method", "verifierRef", "evidenceRefs"],
    ["verdict", "method", "verifierRef", "evidenceRefs"],
    issues,
  );
  if (verification) {
    receiptEnum(verification.verdict, "verification.verdict", ["pass", "fail", "unverified"], issues);
    receiptEnum(verification.method, "verification.method", ["automated", "human", "third-party", "self-report", "none"], issues);
    receiptString(verification.verifierRef, "verification.verifierRef", issues, { nullable: true, maxLength: 255 });
    receiptIdList(verification.evidenceRefs, "verification.evidenceRefs", issues);
  }

  receiptBoolean(receipt.metricsEligible, "metricsEligible", issues);
  const metrics = receiptObject(
    receipt.metrics,
    "metrics",
    ["promptTokens", "completionTokens", "totalTokens", "durationMs", "retryCount"],
    ["promptTokens", "completionTokens", "totalTokens", "durationMs", "retryCount"],
    issues,
  );
  if (metrics) {
    for (const key of ["promptTokens", "completionTokens", "totalTokens", "durationMs", "retryCount"]) receiptMetric(metrics[key], `metrics.${key}`, issues);
    if (["promptTokens", "completionTokens", "totalTokens"].every((key) => Number.isInteger(metrics[key]) && metrics[key] >= 0) && metrics.totalTokens < metrics.promptTokens + metrics.completionTokens) {
      issues.push("metrics.totalTokens cannot be less than promptTokens + completionTokens");
    }
  }

  const sideEffects = receiptObject(
    receipt.sideEffects,
    "sideEffects",
    ["occurred", "adverse", "evidenceRefs"],
    ["occurred", "adverse", "evidenceRefs"],
    issues,
  );
  if (sideEffects) {
    receiptBoolean(sideEffects.occurred, "sideEffects.occurred", issues);
    receiptBoolean(sideEffects.adverse, "sideEffects.adverse", issues);
    receiptIdList(sideEffects.evidenceRefs, "sideEffects.evidenceRefs", issues);
  }

  const privacy = receiptObject(
    receipt.privacy,
    "privacy",
    ["rawPromptIncluded", "rawTranscriptIncluded", "rawLocalPathsIncluded", "credentialValuesIncluded"],
    ["rawPromptIncluded", "rawTranscriptIncluded", "rawLocalPathsIncluded", "credentialValuesIncluded"],
    issues,
  );
  if (privacy) {
    for (const key of ["rawPromptIncluded", "rawTranscriptIncluded", "rawLocalPathsIncluded", "credentialValuesIncluded"]) {
      if (privacy[key] !== false) issues.push(`privacy.${key} must be false`);
    }
  }
  receiptIso(receipt.createdAt, "createdAt", issues);
  return issues;
}

function validateRunReceipt(receipt) {
  const required = [
    "schemaVersion", "kind", "receiptId", "idempotencyKey", "receiptHash", "runId",
    "agentDefinitionReleaseId", "experiencePackReleaseId", "variantId", "taskSignature",
    "environment", "resources", "outcome", "verification", "metricsEligible", "metrics",
    "sideEffects", "privacy", "createdAt",
  ];
  const allowed = new Set([...required, "signature"]);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).some((key) => !allowed.has(key)) || required.some((key) => !receiptOwn(receipt, key))) {
    throw new Error("Terminal RunReceipt shape drifted from Core v1.");
  }
  if (receipt.schemaVersion !== RUN_RECEIPT_SCHEMA || receipt.kind !== "agentlas-run-receipt") throw new Error("Terminal RunReceipt schema is invalid.");
  const nestedIssues = validateRunReceiptNested(receipt);
  if (nestedIssues.length) throw new Error(`Terminal RunReceipt schema is invalid: ${nestedIssues.join("; ")}`);
  const { receiptHash: claimedHash, signature: _signature, ...hashPayload } = receipt;
  if (claimedHash !== canonicalHash(hashPayload)) throw new Error("RunReceipt hash does not match the Core canonical payload.");
  if (receipt.signature !== undefined && receipt.signature !== null) throw new Error("Portable RunReceipt signature must be null.");
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
