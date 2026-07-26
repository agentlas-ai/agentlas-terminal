#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// v1 모놀리스의 curateCliReply/finalizeExperienceExecutionCli 는 v2에서
// memory-cli/experience 모듈로 분리 이식됐다 — 계약(어서션)은 동일하다.
const core = {
  ...require("../engine/memory-cli/curate.cjs"),
  ...require("../engine/experience/runtime.cjs"),
};
const exchange = require("../engine/agentlas-experience-exchange.cjs");
const intake = require("../engine/agentlas-experience-intake.cjs");

function makeDb() {
  let db;
  try {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(":memory:");
  }
  db.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      project_id TEXT, project_path TEXT, agent_id TEXT, chat_id TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium', sensitivity TEXT NOT NULL DEFAULT 'internal',
      evidence_json TEXT NOT NULL DEFAULT '[]', context_json TEXT NOT NULL DEFAULT '{}',
      superseded_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL,
      kind TEXT NOT NULL, chat_id TEXT, automation_id TEXT, node_id TEXT, agent_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}', UNIQUE(run_id, seq)
    );
    CREATE TABLE installed_agents (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE installed_agent_hub_bindings (
      installed_agent_id TEXT PRIMARY KEY, agent_definition_id TEXT NOT NULL, agent_release_id TEXT NOT NULL
    );
    INSERT INTO installed_agents (id,slug,builtin) VALUES ('agent:test','test-agent',0);
    INSERT INTO installed_agent_hub_bindings (installed_agent_id,agent_definition_id,agent_release_id)
      VALUES ('agent:test','agent-definition:test','agent-release:test:1.0.0');
  `);
  return db;
}

function baseInput({ db, userDataDir, cwd, runId, curatedMemories, outcome = "succeeded" }) {
  return {
    db,
    userDataDir,
    cwd,
    agent: { id: "agent:test", slug: "test-agent", builtin: 0 },
    exactBase: {
      agentDefinitionId: "agent-definition:test",
      agentReleaseId: "agent-release:test:1.0.0",
      packageHash: `sha256:${"a".repeat(64)}`,
      authority: "test-exact-base",
    },
    environment: { runtime: "codex", os: "macos", arch: "arm64" },
    model: { provider: "codex", modelId: "gpt-5.6-terra" },
    outcome: { status: outcome, failureCode: outcome === "failed" ? "test-failure" : null },
    curatedMemories,
    taskHint: "debug a TypeScript module and run focused tests",
    taskSignatures: ["agentlas.task.v1/debugging"],
    runId,
    createdAt: "2026-07-13T00:00:00.000Z",
    locale: "en",
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-experience-intake-"));
  const userDataDir = path.join(tmp, "userdata");
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const db = makeDb();
  const previousUserDataDir = process.env.AGENTLAS_USER_DATA_DIR;
  process.env.AGENTLAS_USER_DATA_DIR = userDataDir;

  // Real Terminal curator output is the only source material accepted by auto
  // intake. The user prompt and assistant transcript never enter the bundle.
  const curatorContext = { projectPath: cwd, agentId: "agent:test", curatedMemories: [], requestContext: { userIntent: "debug TypeScript" } };
  const curatedReply = core.curateCliReply(db, [
    "Implemented and verified the repair.",
    "## Memory Events",
    "```json",
    JSON.stringify([{
      memory_kind: "procedure",
      content: "For TypeScript debugging, run focused typechecking before the full regression suite.",
      suggested_scope: "project",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: [],
    }]),
    "```",
  ].join("\n"), curatorContext);
  assert.equal(curatedReply, "Implemented and verified the repair.");
  assert.equal(curatorContext.curatedMemories.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_entries").get().n, 1);

  const successfulTurn = {
    agentId: "agent:test",
    cwd,
    runtime: { mode: "cli", kind: "codex" },
    model: "gpt-5.6-terra",
    runtimeExperience: { taskSignatures: ["agentlas.task.v1/debugging"] },
    curatedMemories: curatorContext.curatedMemories,
    taskHint: "debug a TypeScript module and run focused tests",
    outcome: { status: "succeeded", failureCode: null },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 3 },
    runId: "terminal-run:safe",
    createdAt: "2026-07-13T00:00:00.000Z",
    lang: "en",
  };
  const first = core.finalizeExperienceExecutionCli(db, successfulTurn);
  assert.equal(first.receipt.schemaVersion, "agentlas.run-receipt.v1");
  assert.equal(first.receipt.outcome.status, "succeeded");
  assert.equal(first.receipt.metricsEligible, false);
  assert.equal(first.receipt.metrics.totalTokens, 15, "Core totalTokens must never be smaller than input plus output");
  assert.equal(first.receipt.privacy.rawPromptIncluded, false);
  assert.equal(intake.validateRunReceipt(first.receipt), first.receipt);
  assert.throws(
    () => intake.validateRunReceipt({ ...first.receipt, outcome: { ...first.receipt.outcome, status: "failed" } }),
    /hash does not match/,
  );
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].status, "candidate-created");
  assert.equal(first.networkUsed, false);
  assert.equal(first.published, false);
  assert.equal(first.attached, false);
  assert.equal(first.promoted, false);

  const receiptCountBeforeDirect = db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind='experience-run-receipt'").get().n;
  assert.equal(core.finalizeExperienceExecutionCli(db, { ...successfulTurn, agentId: null, runId: "terminal-run:direct" }), null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind='experience-run-receipt'").get().n,
    receiptCountBeforeDirect,
    "generic no-agent turns must not mint agent Experience evidence",
  );

  // Retry of the exact run/memory/base/environment is idempotent: one receipt,
  // one candidate bundle and one intake decision event remain.
  const second = core.finalizeExperienceExecutionCli(db, successfulTurn);
  assert.equal(second.candidates[0].status, "existing");
  assert.equal(exchange.loadExchangeState(userDataDir).bundles.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind='experience-run-receipt'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind='experience-intake-decision'").get().n, 1);

  let output = "";
  const listed = await exchange.cmdExperienceExchange({
    args: ["list", "--json"], userDataDir, cwd, out: (line) => { output += String(line); },
  });
  assert.equal(listed.networkUsed, false);
  assert.equal(listed.bundles.length, 1);
  assert.equal(listed.bundles[0].reviewState, "candidate-review");
  assert.equal(listed.bundles[0].itemStatusCounts.candidate, 1);
  assert.doesNotMatch(output, /TypeScript debugging|focused typechecking/);

  output = "";
  const inspected = await exchange.cmdExperienceExchange({
    args: ["inspect", listed.bundles[0].bundleId, "--json"], userDataDir, cwd, out: (line) => { output += String(line); },
  });
  assert.equal(inspected.reviewState, "candidate-review");
  assert.equal(inspected.remote, null);
  assert.equal(inspected.publicActivationClaimed, false);
  assert.equal(inspected.evaluatorAuthority, false);
  assert.doesNotMatch(output, /TypeScript debugging|focused typechecking/);

  const stored = exchange.readStoredBundle(userDataDir, inspected.bundleId).bundle;
  assert.equal(stored.requestedVisibility, "private");
  assert.equal(stored.pack.status, "draft");
  assert.equal(stored.items[0].status, "candidate");
  assert.equal(stored.items[0].privacyScope, "private");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(exchange.bundleStorePath(userDataDir, inspected.bundleId)).mode & 0o777, 0o600);
  }
  assert.deepEqual(stored.items[0].environmentConstraints, [...intake.runtimeEnvironment({ runtime: "codex" }).constraints].sort());
  assert.deepEqual(stored.items[0].evidenceReceiptIds, [first.receipt.receiptId]);
  const advisory = exchange.buildLocalExperienceAdvisory({
    userDataDir,
    cwd,
    baseAgentReleaseId: "agent-release:test:1.0.0",
    agentDefinitionId: "agent-definition:test",
    experiencePackReleaseIds: [stored.pack.releaseId],
    taskSignatures: ["agentlas.task.v1/debugging"],
    environmentTags: stored.items[0].environmentConstraints,
  });
  assert.equal(advisory.itemIds.length, 0, "candidate must never auto-attach before explicit promotion");

  // Unsafe evidence is blocked before any bundle write. Decision receipts are
  // value-free and contain only privacy reason codes.
  const unsafeMemories = [
    { id: "memory:path", kind: "procedure", content: "Read /Users/mason/customer/private.csv before retrying.", confidence: "high", sensitivity: "internal" },
    { id: "memory:email", kind: "procedure", content: "Contact owner@example.com before retrying.", confidence: "high", sensitivity: "internal" },
    { id: "memory:secret", kind: "procedure", content: "Use sk-proj-abcdefghijklmnopqrstuvwxyz before retrying.", confidence: "high", sensitivity: "internal" },
    { id: "memory:customer", kind: "decision", content: "customer_name: Alice must receive the private report.", confidence: "medium", sensitivity: "private" },
    { id: "memory:private", kind: "procedure", content: "Keep this organization-specific exception in the retry flow.", confidence: "medium", sensitivity: "private" },
    { id: "memory:user-scope", scope: "user_identity", kind: "procedure", content: "Always use the owner's preferred review order.", confidence: "high", sensitivity: "internal" },
  ];
  for (const [index, memory] of unsafeMemories.entries()) {
    const blocked = intake.finalizeAgentExecution(baseInput({
      db, userDataDir, cwd, runId: `terminal-run:unsafe-${index}`, curatedMemories: [memory],
    }));
    assert.equal(blocked.blocked, 1, `unsafe memory ${index} must be blocked`);
    assert.equal(blocked.candidates.length, 0);
  }
  assert.equal(exchange.loadExchangeState(userDataDir).bundles.length, 1);
  const decisionPayloads = intake.listRunEvents(db, "experience-intake-decision");
  const decisionsJson = JSON.stringify(decisionPayloads);
  assert.doesNotMatch(decisionsJson, /\/Users\/mason|owner@example\.com|sk-proj|Alice|private\.csv/);
  assert.match(decisionsJson, /local-path/);
  assert.match(decisionsJson, /personal-or-customer-identifier/);
  assert.match(decisionsJson, /secret-or-credential/);
  assert.match(decisionsJson, /customer-data/);
  assert.match(decisionsJson, /sensitive-memory/);
  assert.match(decisionsJson, /user-specific-memory-scope/);

  // Preference stays in the local Taste lane and cannot become an Operational
  // bundle. The observation keeps only an opaque source-reference hash and
  // awaits pairwise/A-B evidence.
  const taste = intake.finalizeAgentExecution(baseInput({
    db,
    userDataDir,
    cwd,
    runId: "terminal-run:taste",
    curatedMemories: [{ id: "memory:preference", kind: "preference", content: "Prefer restrained editorial spacing.", confidence: "high", sensitivity: "private" }],
  }));
  assert.equal(taste.tasteObservations, 1);
  assert.equal(taste.candidates.length, 0);
  assert.equal(exchange.loadExchangeState(userDataDir).bundles.length, 1);
  const tasteEvents = intake.listRunEvents(db, "taste-draft-observation");
  assert.equal(tasteEvents.length, 1);
  assert.match(JSON.stringify(tasteEvents), /preference-private-taste-only/);
  assert.doesNotMatch(JSON.stringify(tasteEvents), /editorial spacing/);

  // A failed execution and a successful run with no curated evidence both
  // produce honest RunReceipts but no candidate.
  const failed = intake.finalizeAgentExecution(baseInput({
    db,
    userDataDir,
    cwd,
    runId: "terminal-run:failed",
    curatedMemories: [{ id: "memory:failed", kind: "procedure", content: "Run focused tests after repair.", confidence: "high", sensitivity: "internal" }],
    outcome: "failed",
  }));
  assert.equal(failed.receipt.outcome.status, "failed");
  assert.equal(failed.candidates.length, 0);
  const noEvidence = intake.finalizeAgentExecution(baseInput({
    db, userDataDir, cwd, runId: "terminal-run:no-evidence", curatedMemories: [],
  }));
  assert.equal(noEvidence.receipt.outcome.status, "succeeded");
  assert.equal(noEvidence.candidates.length, 0);
  assert.equal(exchange.loadExchangeState(userDataDir).bundles.length, 1);

  const allReceiptsJson = JSON.stringify(intake.listRunEvents(db, "experience-run-receipt"));
  assert.doesNotMatch(allReceiptsJson, /debug a TypeScript|Memory Events|focused typechecking|raw prompt|transcript body/i);
  assert.ok(intake.listRunEvents(db, "experience-run-receipt").every((receipt) =>
    receipt.privacy.rawPromptIncluded === false && receipt.privacy.rawTranscriptIncluded === false));

  db.close();
  if (previousUserDataDir === undefined) delete process.env.AGENTLAS_USER_DATA_DIR;
  else process.env.AGENTLAS_USER_DATA_DIR = previousUserDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("experience-auto-intake-contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
