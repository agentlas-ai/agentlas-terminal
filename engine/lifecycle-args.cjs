"use strict";

// Validate lifecycle intent before any launcher bootstrap or prompt fallback.
// Rollback/restore have no original database/package recovery owner here.
function unsupportedLifecycleFlag(arg) {
  return typeof arg === "string" && /^--(?:rollback|restore)(?:=|$)/.test(arg);
}
function validateUpdateArgs(args) {
  if (args.some((arg) => arg !== "--json") || args.filter((arg) => arg === "--json").length > 1) {
    const error = new Error("usage: agentlas update [--json]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
}
function assertLifecycleInvocation(argv, { helpRequested = false } = {}) {
  const [command, ...args] = argv;
  if (unsupportedLifecycleFlag(command)
      || (["update", "migrate", "restore", "rollback"].includes(command) && args.some(unsupportedLifecycleFlag))) {
    const error = new Error("This CLI does not support package or database rollback/restore flags. No lifecycle operation was started.");
    error.code = "UNSUPPORTED_LIFECYCLE_OPERATION";
    throw error;
  }
  if (command === "update" && !helpRequested) validateUpdateArgs(args);
}
module.exports = { assertLifecycleInvocation, validateUpdateArgs };
