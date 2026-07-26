"use strict";

// Terminal processes may share the Desktop application's SQLite file. Keep
// lock waits bounded, and acquire writer authority before a transaction reads
// state that it may subsequently update. A deferred read-to-write upgrade can
// fail immediately with SQLITE_BUSY even when busy_timeout is configured.
const SQLITE_BUSY_TIMEOUT_MS = 15_000;

function configureSqliteConnection(db) {
  if (!db) throw new TypeError("SQLite connection is required");
  if (typeof db.pragma === "function") {
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  } else if (typeof db.exec === "function") {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  } else {
    throw new TypeError("SQLite connection must expose pragma() or exec()");
  }
  return db;
}

function runWriteTransaction(db, fn, ...args) {
  if (!db || typeof db.transaction !== "function") return fn(...args);
  const transaction = db.transaction(fn);
  if (typeof transaction.immediate === "function") {
    return transaction.immediate(...args);
  }
  return transaction(...args);
}

module.exports = {
  SQLITE_BUSY_TIMEOUT_MS,
  configureSqliteConnection,
  runWriteTransaction,
};
