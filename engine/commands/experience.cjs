"use strict";
// Historical exchange records remain on disk; this product feature is retired.
function run() {
  throw Object.assign(new Error("experience_chips_retired: use agentlas evolve to review memory-backed file changes. Legacy receipts remain read-only."), { code: "experience_chips_retired" });
}
module.exports = { run };
