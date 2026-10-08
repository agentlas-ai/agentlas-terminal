"use strict";

// Independent Terminal consumes the same headless revision service as Desktop.
// An older vendored core must not fall back to legacy prompt writes or chips.
function workspaceService() {
  const core = require("./core/desktop-core.cjs").loadDesktopCore();
  if (!core || core.error) {
    const error = new Error("agent_workspace_upgrade_required: install a compatible Agentlas core to review and apply file revisions.");
    error.code = "agent_workspace_upgrade_required";
    throw error;
  }
  let service;
  try { service = core.require("agents/workspace-service"); } catch { /* checked below */ }
  const methods = ["getAgentWorkspace", "readAgentWorkspaceFile", "prepareAgentWorkspaceFromMemory", "prepareAgentWorkspaceProposal", "getAgentWorkspaceDiff", "applyAgentWorkspaceProposal", "listAgentWorkspaceRevisions", "acquireAgentWorkspaceRunLease", "releaseAgentWorkspaceRunLease"];
  if (!service || service.AGENT_WORKSPACE_CAPABILITY_VERSION !== 2 || methods.some((name) => typeof service[name] !== "function")) {
    const error = new Error("agent_workspace_upgrade_required: this core does not support the revision-v1/evolution-v2 approval contract.");
    error.code = "agent_workspace_upgrade_required";
    throw error;
  }
  return service;
}

function safeOutput(value) {
  return JSON.stringify(value, null, 2).replace(/[\u001b\u009b]/g, "");
}

async function runWorkspaceCommand(ctx, args) {
  const sub = args[0] || "help";
  if (["help", "--help", "-h"].includes(sub)) {
    ctx.out("agentlas evolve workspace <agent> | history <agent> | diff <proposal>\nagentlas evolve prepare <agent> <changes.json>\nagentlas evolve from-memory <agent> <memory-id>...\nagentlas evolve apply <proposal> --reviewed-hash <hash> --receipt <owner-approval-receipt>\nReview and approve the exact diff in Agent Workspace. Terminal cannot mint owner approval from a shell flag.");
    return 0;
  }
  const service = workspaceService();
  const value = args[1];
  if (!value) throw new Error("An exact agent or proposal ID is required. Run agentlas evolve help.");
  if (["list", "workspace", "history", "diff"].includes(sub)) {
    if (args.length !== 2) throw new Error("Unexpected evolve arguments");
    const result = await (sub === "history" ? service.listAgentWorkspaceRevisions(value) : sub === "diff" ? service.getAgentWorkspaceDiff(value) : service.getAgentWorkspace(value));
    ctx.out(safeOutput(result));
    return 0;
  }
  if (sub === "from-memory") {
    if (args.length < 3 || args.length > 14) throw new Error("usage: agentlas evolve from-memory <agent> <memory-id>...");
    ctx.out(safeOutput(await service.prepareAgentWorkspaceFromMemory({ agentId: value, memoryEntryIds: args.slice(2) })));
    return 0;
  }
  if (sub === "prepare") {
    if (args.length !== 3) throw new Error("usage: agentlas evolve prepare <agent> <changes.json>");
    const fs = require("node:fs");
    const fd = fs.openSync(args[2], fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let request;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 2 * 1024 * 1024) throw new Error("Unsafe or oversized proposal input");
      request = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
    if (!request || !Array.isArray(request.changes) || Object.keys(request).some((key) => !["changes", "memoryEntryIds", "summary"].includes(key))) throw new Error("Invalid proposal input");
    if (request.memoryEntryIds?.length) throw new Error("Use agentlas evolve from-memory for semantic memory review before preparing a file change.");
    ctx.out(safeOutput(await service.prepareAgentWorkspaceProposal({ ...request, agentId: value })));
    return 0;
  }
  if (sub === "apply") {
    if (args.length !== 6 || args[2] !== "--reviewed-hash" || args[4] !== "--receipt" || !/^[a-f0-9]{64}$/.test(args[3]) || !args[5]) throw new Error("usage: agentlas evolve apply <proposal> --reviewed-hash <hash> --receipt <owner-approval-receipt>");
    ctx.out(safeOutput(await service.applyAgentWorkspaceProposal({ proposalId: value, reviewedHash: args[3], approvalReceiptId: args[5] })));
    return 0;
  }
  throw new Error("Unsupported evolution action. Legacy automatic apply/revert is retired; review a new exact file proposal.");
}

function recordRevisionRun(db, { agentId, runId, revisionId, treeDigest, status }) {
  if (!db || !/^[a-f0-9]{64}$/.test(treeDigest) || !revisionId || !["started", "succeeded", "failed", "killed"].includes(status)) throw new Error("agent_revision_receipt_required");
  const payload = { schemaVersion: "agentlas.revision-run-receipt.v1", agentId, runId, revisionId, treeDigest, status, createdAt: new Date().toISOString() };
  const id = require("node:crypto").createHash("sha256").update(runId + "\0" + status).digest("hex");
  const result = db.prepare(`INSERT OR IGNORE INTO run_events
    (id,run_id,seq,ts,kind,chat_id,automation_id,node_id,agent_id,payload_json)
    SELECT ?,?,COALESCE(MAX(seq) + 1, 0),?,'agent-revision-run-receipt',NULL,NULL,NULL,?,?
    FROM run_events WHERE run_id=?`).run(id, runId, payload.createdAt, agentId, JSON.stringify(payload), runId);
  if (Number(result?.changes) !== 1) throw new Error("agent_revision_receipt_not_persisted");
  return payload;
}

module.exports = { workspaceService, runWorkspaceCommand, recordRevisionRun };
