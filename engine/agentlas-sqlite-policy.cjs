"use strict";

// Terminal processes may share the Desktop application's SQLite file. Keep
// lock waits bounded, and acquire writer authority before a transaction reads
// state that it may subsequently update. A deferred read-to-write upgrade can
// fail immediately with SQLITE_BUSY even when busy_timeout is configured.
//
// ★This value must stay identical to `STORE_BUSY_TIMEOUT_MS` in
// agentlas_desktop/electron/store/db.ts. Until 2026-08-18 the Desktop waited 5s
// and the terminal 15s on the very same file, so under contention the Desktop
// was always the first to give up with SQLITE_BUSY — even when the terminal was
// the slow writer. That asymmetry made shared-file contention look like a
// Desktop-only bug. 15s is the agreed value: nothing holds a transaction on this
// file for long (the longest writer is the migration ladder), so it is a ceiling
// that is essentially never reached rather than added latency.
const SQLITE_BUSY_TIMEOUT_MS = 15_000;

// `foreign_keys` 는 파일이 아니라 **커넥션** 속성이다. 데스크탑은
// `electron/store/db.ts` 에서 `foreign_keys = ON` 으로 열고, 터미널은 켜지 않아
// **같은 테이블인데 터미널이 쓰는 행만 참조 무결성 검사를 건너뛰고 있었다**
// (2026-07-28 확인). journal_mode 처럼 파일에 박히는 값이 아니라서 한쪽이 켠 것이
// 다른 쪽에 전파되지 않는다. 스키마 소유는 데스크탑이므로 그 규칙을 그대로 따른다.
const SQLITE_CONNECTION_PRAGMAS = [
  `busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`,
  "foreign_keys = ON",
];

function configureSqliteConnection(db) {
  if (!db) throw new TypeError("SQLite connection is required");
  const applyPragma =
    typeof db.pragma === "function"
      ? (statement) => db.pragma(statement)
      : typeof db.exec === "function"
        ? (statement) => db.exec(`PRAGMA ${statement}`)
        : null;
  if (!applyPragma) throw new TypeError("SQLite connection must expose pragma() or exec()");
  for (const statement of SQLITE_CONNECTION_PRAGMAS) applyPragma(statement);
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
