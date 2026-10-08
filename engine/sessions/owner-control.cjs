"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const PROCESS_EPOCH = crypto.randomUUID();
const ownedSessions = new Map();
let ownerClient = null;
const { findCoreRoot } = require("../core/desktop-core.cjs");

// Pure canonical modules only. Importing the graph/store loader would open or
// migrate a second database; the Session already owns its SQLite connection.
function loadOwnerControlCore() {
  const root = findCoreRoot();
  if (!root) throw new Error("terminal_owner_control_core_unavailable");
  const store = require(path.join(root, "electron/store/current-turn-steer-core.js"));
  const pump = require(path.join(root, "electron/runtime/owner-control-pump.js"));
  const custody = require(path.join(root, "electron/store/invocation-owner-core.js"));
  if (typeof store.createCurrentTurnSteerStore !== "function" || typeof pump.runWithOwnerControl !== "function" || typeof custody.createInvocationRunOwnerStore !== "function") {
    throw new Error("terminal_owner_control_core_contract_invalid");
  }
  return { ...store, ...pump, ...custody, root };
}

function createSessionOwnerControl(session, runId, options = {}) {
  const core = loadOwnerControlCore();
  const custodyStore = core.createInvocationRunOwnerStore({ getDb: () => session.db });
  const claimed = custodyStore.claim({ chatId: session.chatId, runId, ownerId: PROCESS_EPOCH, ownerKind: "terminal" });
  if (claimed.kind !== "claimed") throw new Error("invocation_chat_owned_by_other_run");
  const owner = claimed.owner;
  ownedSessions.set(session.chatId, { session, runId, leaseId: owner.leaseId });
  const assertOwned = (allowSettling = false) => {
    const current = custodyStore.getActiveOwner(session.chatId);
    if (!current || current.runId !== runId || current.ownerId !== owner.ownerId
      || current.leaseId !== owner.leaseId || (current.state !== "active" && !(allowSettling && current.state === "settling"))) {
      throw new Error("invocation_owner_custody_unavailable");
    }
  };
  const controlStore = core.createCurrentTurnSteerStore({
    getDb: () => session.db,
    appendUserMessage(chatId, text) {
      const id = crypto.randomUUID(), timestamp = new Date().toISOString();
      session.db.prepare("INSERT INTO chat_messages (id, chat_id, role, text, created_at) VALUES (?,?,?,?,?)")
        .run(id, chatId, "user", text, timestamp);
      session.db.prepare("UPDATE chats SET updated_at=?, used_at=? WHERE id=?").run(timestamp, timestamp, chatId);
      return { id };
    },
  });
  const binding = Object.freeze({ schemaVersion: 1, owner: "terminal", processId: process.pid,
    chatId: session.chatId, runId, ownerId: owner.ownerId, leaseId: owner.leaseId, agentId: session.agent.id, runtime: session.runtime.kind,
    model: session.runtime.model ?? null, permission: session.permission, cwd: session.cwd });
  const inbox = {
    take: () => { assertOwned(); return controlStore.takeCurrentTurnSteers(session.chatId, runId); },
    settle(ids, status, code) {
      for (const id of ids) controlStore.settleCurrentTurnSteer(session.chatId, id, status, code);
    },
    pendingCount: () => controlStore.countPendingCurrentTurnSteers(session.chatId, runId),
  };
  connectOwnerClient(core.root, session, options);
  return {
    runId, inbox, owner, assertOwned, markSettling: () => custodyStore.markSettling(owner),
    release: () => {
      const released = custodyStore.release(owner);
      if (released && ownedSessions.get(session.chatId)?.leaseId === owner.leaseId) ownedSessions.delete(session.chatId);
      if (ownedSessions.size === 0 && ownerClient) {
        try { ownerClient.close(); } finally { ownerClient = null; }
      }
      return released;
    }, store: controlStore, runWithOwnerControl: core.runWithOwnerControl,
    accept(input) {
      const existing = controlStore.existingCurrentTurnSteer(input);
      if (existing) return existing;
      if (input.chatId !== session.chatId || input.expectedRunId !== runId || !session.isBusy()
        || session._apiAbort?.signal.aborted) throw new Error("invocation_current_turn_steer_no_active_run");
      assertOwned();
      if (controlStore.countPendingCurrentTurnSteers(session.chatId, runId) >= 64) {
        throw new Error("invocation_current_turn_steer_limit");
      }
      const receipt = controlStore.claimCurrentTurnSteer(input, binding);
      try { session._record({ type: "owner-control-intake", at: Date.now(), ...receipt }); }
      catch (error) {
        // Presentation cannot undo durable intake or manufacture a failed ACK.
        session._privateRecoveryEvidence.push(String(error?.message || error).slice(0, 4000));
        if (session._privateRecoveryEvidence.length > 16) session._privateRecoveryEvidence.shift();
      }
      return receipt;
    },
    finish(code) {
      // No restart/next-turn replay. Unclaimed work never crossed the brain;
      // a claimed direction whose reply was lost retains uncertain custody.
      const rows = session.db.prepare(`SELECT intent_id, status FROM invocation_current_turn_steers
        WHERE chat_id=? AND run_id=? AND status IN ('queued','dispatching')`).all(session.chatId, runId);
      for (const row of rows) controlStore.settleCurrentTurnSteer(session.chatId, row.intent_id,
        row.status === "queued" ? "rejected" : "uncertain", code);
    },
  };
}
// Observe the existing daemon only. Foreign delivery may fail closed while the
// already-owned local Session remains responsive and accepts its own controls.
function connectOwnerClient(root, session, options) {
  if (options.disableConnection || ownerClient) return;
  try {
    const { userDataDir } = require("../core/paths.cjs");
    const createClient = options.createClient
      || require(path.join(root, "electron/daemon/invocation-owner-client.js")).createInvocationOwnerClient;
    ownerClient = createClient({ userDataDir: userDataDir(), storePath: session.db.name,
      requiredSchemaVersion: 129, ownerId: PROCESS_EPOCH, ownerKind: "terminal", onControl: handleOwnerControl });
    void Promise.resolve(ownerClient.connect()).catch(() => { /* Foreign owner transport stays unavailable. */ });
  } catch { ownerClient = null; }
}

function handleOwnerControl(input) {
  const entry = ownedSessions.get(input?.chatId);
  if (!entry || input.ownerId !== PROCESS_EPOCH || input.runId !== entry.runId || input.leaseId !== entry.leaseId) {
    throw new Error("invocation_owner_custody_unavailable");
  }
  if (String(input.method).replace(/^invoke\./, "") !== "cancel") entry.session._ownerControl.assertOwned(true);
  const params = input.params && typeof input.params === "object" ? input.params : {};
  if (params.chatId !== undefined && params.chatId !== input.chatId) throw new Error("invocation_owner_custody_unavailable");
  return dispatchOwnerControlRequest(input.method, { ...params, chatId: input.chatId });
}

function dispatchOwnerControlRequest(method, input) {
  const entry = ownedSessions.get(input?.chatId);
  if (!entry) throw new Error("invocation_owner_custody_unavailable");
  const action = String(method).replace(/^invoke\./, "");
  if (action !== "cancel") entry.session._ownerControl.assertOwned(true);
  if (action === "currentTurn") return entry.session.currentTurn();
  if (action === "steerCurrentTurn") return entry.session.steerCurrentTurn(input);
  if (action === "currentTurnSteerReceipt") return entry.session.currentTurnSteerReceipt(input);
  if (action === "cancel") {
    if (input.runId !== undefined && input.runId !== entry.runId) throw new Error("invocation_owner_custody_unavailable");
    entry.session.kill();
    return { runId: entry.runId, status: "requested" };
  }
  throw new Error("invocation_owner_control_method_invalid");
}
module.exports = { createSessionOwnerControl, loadOwnerControlCore,
  getProcessOwnerId: () => PROCESS_EPOCH, dispatchOwnerControlRequest };
