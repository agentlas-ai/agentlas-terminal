"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

/** Resolve the host's memory facade without inventing a migration authority. */
function runtimeMemoryDb(productDb) {
  const name = productDb && productDb.name;
  // In-memory fixtures have no product-store custody or migration lineage.
  if (!name || name === ":memory:") return productDb;
  const source = path.resolve(name);
  const marker = "memory-store-cutover:" + crypto.createHash("sha256").update(source).digest("hex");
  let moved = false;
  const meta = productDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (meta) moved = !!productDb.prepare("SELECT 1 FROM meta WHERE key=?").get(marker);
  const core = require("./desktop-core.cjs").loadDesktopCore();
  if (core && !core.error && typeof core.getMemoryDb === "function") {
    const hostDb = core.getDb();
    if (!hostDb || !hostDb.name || path.resolve(hostDb.name) !== source) {
      throw new Error("memory_product_store_binding_mismatch");
    }
    // The host facade keeps memory and Terminal receipts on one connection,
    // routes only memory_* tables, and validates owner changes on every call.
    return core.getMemoryDb();
  }
  if (moved) throw new Error("memory_store_moved_upgrade_required: refresh the Desktop Core bundle before memory intake or recall");
  return productDb;
}

module.exports = { runtimeMemoryDb };
