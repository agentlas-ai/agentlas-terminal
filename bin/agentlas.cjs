#!/usr/bin/env node
/*
 * agentlas — Agentlas를 터미널에서 쓰는 독립 CLI (Claude Code 방식).
 *
 * `npm install -g agentlas` 후 `agentlas` 하나로 완결된다. 데스크탑 앱은 필요 없다:
 * 엔진(engine/agentlas.cjs — REPL·라우팅·클라우드·자격증명 포함 전체 터미널
 * 클라이언트)이 이 패키지에 들어 있고(정본), 첫 실행 시 앱과 동일한 SQLite 스키마를
 * 직접 부트스트랩한 뒤 빌트인 에이전트를 시드한다. 데스크탑 앱이 설치돼 있으면
 * 같은 userData(SQLite)를 자동으로 공유한다 — 별도 설정 없이 데이터가 한 몸이다.
 *
 * SQLite: better-sqlite3(optionalDependency, npm이 빌드해주면 네이티브) →
 * 실패 시 Node 22+의 node:sqlite 폴백.
 *
 * env 오버라이드:
 *   AGENTLAS_USER_DATA_DIR 데이터 폴더 (기본: 앱과 동일한 userData)
 *
 * 런처 자체 명령: `agentlas --where` → 해석 결과 JSON 출력 후 종료.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { configureSqliteConnection } = require("../engine/agentlas-sqlite-policy.cjs");

const REAL_SELF = (() => {
  try { return fs.realpathSync(__filename); } catch { return __filename; }
})();
const PKG_ROOT = path.dirname(path.dirname(REAL_SELF));
const ENGINE = path.join(PKG_ROOT, "engine", "agentlas.cjs");

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ── userData / DB 경로 (engine/agentlas.cjs의 userDataDir와 동일 규칙) ──
function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

function dbPath() {
  return path.join(userDataDir(), "agentlas.sqlite");
}

function securePrivateMode(target, mode) {
  if (process.platform === "win32") return;
  fs.chmodSync(target, mode);
}

// ── SQLite 로더 (부트스트랩용): better-sqlite3 → node:sqlite ──
// require.resolve가 아니라 실제 로드로 판별한다 — ABI가 깨진 better-sqlite3나
// node:sqlite가 아직 없는/플래그가 필요한 Node(≤22.4 등)를 정확히 걸러낸다.
function probeSqliteDriver() {
  try {
    const Database = require("better-sqlite3");
    // Loading the JS wrapper alone does not prove that its native binding matches
    // this Node ABI. Exercise the constructor before reporting it to --where.
    const db = new Database(":memory:");
    db.close();
    return "better-sqlite3";
  } catch { /* absent or ABI-broken */ }
  try {
    const { DatabaseSync } = loadNodeSqliteQuietly();
    if (DatabaseSync) {
      const db = new DatabaseSync(":memory:");
      db.close();
      return "node:sqlite";
    }
  } catch { /* not available without a flag on this Node */ }
  return null;
}

function loadNodeSqliteQuietly() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function agentlasSqliteWarningFilter(warning, ...args) {
    const message = typeof warning === "string" ? warning : String((warning && warning.message) || warning || "");
    const type = typeof args[0] === "string" ? args[0] : "";
    if (type === "ExperimentalWarning" && /SQLite/i.test(message)) return;
    if (/SQLite is an experimental feature/i.test(message)) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function openSqlite(p) {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(p);
    configureSqliteConnection(db);
    return { exec: (sql) => db.exec(sql), close: () => db.close(), driver: "better-sqlite3" };
  } catch { /* optional dep 미설치/ABI 불일치 */ }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(`Node ${process.version} — Node 22+ (node:sqlite) is required when better-sqlite3 is unavailable.`);
  }
  const { DatabaseSync } = loadNodeSqliteQuietly();
  const db = new DatabaseSync(p);
  configureSqliteConnection(db);
  return { exec: (sql) => db.exec(sql), close: () => db.close(), driver: "node:sqlite" };
}

// 첫 실행 부트스트랩: DB가 없으면 앱과 동일한 스키마를 만든다.
// (엔진의 openDb는 파일이 없으면 하드 실패하므로, 여기서 미리 만들어 준다.
//  스키마가 생기면 엔진의 seedBuiltins가 빌트인 에이전트를 채운다.)
function bootstrapDbIfMissing() {
  const p = dbPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  securePrivateMode(dir, 0o700);
  // 존재 여부만 보면 **0바이트 파일이 부트스트랩을 영구히 막는다.** 실측 2026-07-28:
  // `sqlite3 <없는경로> 'PRAGMA user_version;'` 같은 무해한 명령 하나가 빈 파일을 남기고,
  // 그 뒤 모든 실행이 "이미 있음"으로 판단해 스키마 없이 진행하다 `no such table` 로
  // 죽는다. 사용자에게는 원인이 전혀 안 보이는 상태다.
  //
  // SQLite 파일은 최소 한 페이지(512바이트)를 갖는다. 0바이트는 DB 가 아니라 자리만
  // 잡힌 파일이므로 없는 것으로 취급해 정상 부트스트랩 경로를 태운다. 내용이 있는데
  // 손상된 경우는 여기서 판단하지 않는다 — 그건 복구지 부트스트랩이 아니고, 멀쩡한
  // DB 를 빈 것으로 오판해 덮어쓰는 위험이 훨씬 크다.
  if (exists(p)) {
    let empty = false;
    try { empty = fs.statSync(p).size === 0; } catch { empty = false; }
    if (!empty) {
      securePrivateMode(p, 0o600);
      return { created: false, path: p };
    }
    try { fs.rmSync(p, { force: true }); } catch { /* 지울 수 없으면 아래 link 가 EEXIST 로 알려준다 */ }
  }
  const schemaFile = path.join(PKG_ROOT, "engine", "bootstrap-schema.sql");
  if (!exists(schemaFile)) {
    throw new Error(`Bootstrap schema not found: ${schemaFile}`);
  }
  const sql = fs.readFileSync(schemaFile, "utf8");
  // DB를 정식 경로에서 직접 만들면 두 첫 실행이 모두 exists=false를 본 뒤 한 프로세스의
  // 실패 cleanup이 다른 프로세스의 정상 DB까지 지울 수 있다. 각자 같은 볼륨의 임시 DB를
  // 완성하고 hard-link(EEXIST=다른 프로세스 승리)로만 정식 이름을 원자 획득한다.
  const temp = `${p}.bootstrap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const db = openSqlite(temp);
  try {
    db.exec(sql);
  } catch (e) {
    db.close();
    try { fs.rmSync(temp, { force: true }); } catch { /* leave temp for inspection */ }
    throw new Error(`Database bootstrap failed: ${e.message}`);
  }
  db.close();
  // chmod the inode before it can become visible at the final hard-link path.
  // The winning and losing processes both harden the final path below.
  securePrivateMode(temp, 0o600);
  let created = false;
  try {
    fs.linkSync(temp, p);
    created = true;
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      throw new Error(`Atomic database bootstrap failed: ${e && e.message ? e.message : e}`);
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
    try { fs.rmSync(temp + "-journal", { force: true }); } catch { /* noop */ }
    try { fs.rmSync(temp + "-wal", { force: true }); } catch { /* noop */ }
    try { fs.rmSync(temp + "-shm", { force: true }); } catch { /* noop */ }
  }
  securePrivateMode(p, 0o600);
  return { created, path: p };
}

function main() {
  const args = process.argv.slice(2);
  const metadataOnly = args.some((arg) => arg === "help" || arg === "--help" || arg === "-h")
    || args[0] === "version"
    || args[0] === "--version"
    || args[0] === "-V";
  const sqliteDriver = probeSqliteDriver();
  const engineFound = exists(ENGINE);

  let error = null;
  if (!engineFound) {
    error = "Engine not found (engine/agentlas.cjs). Reinstall with: npm i -g agentlas";
  } else if (!sqliteDriver && !metadataOnly) {
    error = `Node ${process.version} — no SQLite driver. Upgrade to Node 22.5+ or reinstall with 'npm i -g agentlas' to build better-sqlite3.`;
  }

  if (args[0] === "--where" || args[0] === "terminal-where") {
    process.stdout.write(JSON.stringify({
      launcher: REAL_SELF,
      packageRoot: PKG_ROOT,
      engine: ENGINE,
      engineFound,
      db: dbPath(),
      dbExists: exists(dbPath()),
      sqliteDriver,
      node: process.version,
      error,
    }, null, 2) + "\n");
    process.exit(error ? 1 : 0);
  }

  if (error) {
    process.stderr.write(error + "\n");
    process.exit(1);
  }

  if (!metadataOnly) {
    try {
      const boot = bootstrapDbIfMissing();
      if (boot.created) {
        process.stderr.write("First run: Agentlas data initialized.\n");
      }
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
  }

  const child = spawn(process.execPath, [ENGINE, ...args], { stdio: "inherit" });

  // 시그널 처리:
  //  - 터미널 Ctrl-C(SIGINT)는 포그라운드 프로세스 그룹으로 자식(REPL)에게 이미 전달된다.
  //    런처가 한 번 더 전달하면 REPL의 "Ctrl-C 두 번이면 종료"가 오작동하므로 전달하지 않는다.
  //  - PID로 직접 온 SIGTERM/SIGHUP(kill·프로세스 매니저·timeout(1))은 자식에게 전달한다.
  try { process.on("SIGINT", () => { /* group delivery already reached the child */ }); } catch { /* ignore */ }
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        try { child.kill(sig); } catch { /* already dead */ }
      });
    } catch { /* win32 SIGHUP 등 */ }
  }

  child.on("error", (err) => {
    process.stderr.write(`Failed to start the Agentlas engine: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // 자식의 시그널 종료를 그대로 전파 — 자체 핸들러를 걷어내야 재raise가 먹는다.
      try {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } catch { /* fall through to numeric exit */ }
      const num = os.constants.signals[signal];
      process.exit(num ? 128 + num : 1);
    }
    process.exit(code == null ? 0 : code);
  });
}

if (require.main === module) main();

module.exports = { bootstrapDbIfMissing, dbPath, userDataDir, probeSqliteDriver };
