"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** Called only after the explicit graph command completes its owner/input admission. */
async function runOwnerGraphOccurrence(core, automation, graph, initialVars, signal) {
  const custodyFile = typeof core.root === "string"
    ? path.join(core.root, "shared", "graph-occurrence-custody.js") : null;
  // Older compatible bundles retain their existing reconciliation fences.
  if (!custodyFile || !fs.existsSync(custodyFile)) {
    return core.runGraph(automation, graph, { initialVars, ...(signal ? { signal } : {}) });
  }
  const custody = require(custodyFile);
  if (typeof custody.withGraphOccurrenceCustody !== "function"
    || typeof core.getAutomation !== "function" || typeof core.graphExecutionDigest !== "function") {
    throw new Error("terminal_graph_occurrence_contract_unavailable");
  }
  const graphDigest = core.graphExecutionDigest(automation, graph);
  const assertCurrent = () => {
    if (signal?.aborted) throw signal.reason || new Error("terminal_graph_owner_request_cancelled");
    const current = core.getAutomation(automation.id);
    if (current?.id !== automation.id || !current.graph
      || core.graphExecutionDigest(current, current.graph) !== graphDigest) {
      throw new Error("terminal_graph_owner_request_changed");
    }
  };
  assertCurrent();
  // A new native command invocation is a new logical request even with identical input.
  // Neither caller JSON nor historical receipt ids may choose this occurrence.
  const occurrenceId = `owner-request:${crypto.randomUUID()}`;
  return custody.withGraphOccurrenceCustody({ automationId: automation.id, occurrenceId, graphDigest },
    assertCurrent, occurrenceCustody => core.runGraph(automation, graph,
      { initialVars, occurrenceId, occurrenceCustody, ...(signal ? { signal } : {}) }));
}

module.exports = { runOwnerGraphOccurrence };
