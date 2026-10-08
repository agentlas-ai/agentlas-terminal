"use strict";
// Exact file proposals use the shared revision service and owner receipt boundary.
const { runWorkspaceCommand } = require("../agent-workspace.cjs");

function run(ctx, args) {
  return runWorkspaceCommand(ctx, args);
}

module.exports = { run };
