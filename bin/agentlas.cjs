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

// ── SQLite 로더 (부트스트랩용): better-sqlite3 → node:sqlite ──
// require.resolve가 아니라 실제 로드로 판별한다 — ABI가 깨진 better-sqlite3나
// node:sqlite가 아직 없는/플래그가 필요한 Node(≤22.4 등)를 정확히 걸러낸다.
function probeSqliteDriver() {
  try { require("better-sqlite3"); return "better-sqlite3"; } catch { /* absent or ABI-broken */ }
  try {
    const { DatabaseSync } = require("node:sqlite");
    if (DatabaseSync) return "node:sqlite";
  } catch { /* not available without a flag on this Node */ }
  return null;
}

function openSqlite(p) {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(p);
    return { exec: (sql) => db.exec(sql), close: () => db.close(), driver: "better-sqlite3" };
  } catch { /* optional dep 미설치/ABI 불일치 */ }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error(`Node ${process.version} — better-sqlite3가 없으면 Node 22+ (node:sqlite)가 필요합니다.`);
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(p);
  return { exec: (sql) => db.exec(sql), close: () => db.close(), driver: "node:sqlite" };
}

// 첫 실행 부트스트랩: DB가 없으면 앱과 동일한 스키마를 만든다.
// (엔진의 openDb는 파일이 없으면 하드 실패하므로, 여기서 미리 만들어 준다.
//  스키마가 생기면 엔진의 seedBuiltins가 빌트인 에이전트를 채운다.)
function bootstrapDbIfMissing() {
  const p = dbPath();
  if (exists(p)) return { created: false, path: p };
  const schemaFile = path.join(PKG_ROOT, "engine", "bootstrap-schema.sql");
  if (!exists(schemaFile)) {
    throw new Error(`부트스트랩 스키마가 없습니다: ${schemaFile}`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sql = fs.readFileSync(schemaFile, "utf8");
  const db = openSqlite(p);
  try {
    db.exec(sql);
  } catch (e) {
    db.close();
    try { fs.rmSync(p); } catch { /* leave partial for inspection */ }
    throw new Error(`DB 부트스트랩 실패: ${e.message}`);
  }
  db.close();
  return { created: true, path: p };
}

function main() {
  const args = process.argv.slice(2);
  const sqliteDriver = probeSqliteDriver();
  const engineFound = exists(ENGINE);

  let error = null;
  if (!engineFound) {
    error = "엔진이 없습니다 (engine/agentlas.cjs). 재설치: npm i -g agentlas";
  } else if (!sqliteDriver) {
    error = `Node ${process.version} — SQLite 드라이버가 없습니다. Node 22.5+ 로 올리거나 'npm i -g agentlas'로 재설치(better-sqlite3 빌드)하세요.`;
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

  try {
    const boot = bootstrapDbIfMissing();
    if (boot.created) {
      process.stderr.write(`첫 실행: Agentlas 데이터 초기화 완료 (${boot.path})\n`);
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
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
    process.stderr.write(`Agentlas 엔진 실행 실패: ${err.message}\n`);
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

main();
