#!/usr/bin/env node
/*
 * agentlas — Agentlas를 터미널에서 쓰는 독립 CLI (Claude Code 방식).
 *
 * `npm install -g` 후 `agentlas` 하나로 완결된다. 데스크탑 앱은 필요 없다:
 * 엔진(engine/agentlas.cjs — REPL·라우팅·클라우드·자격증명 포함 전체 터미널
 * 클라이언트)이 패키지에 번들되어 있고, 첫 실행 시 앱과 동일한 SQLite 스키마를
 * 직접 부트스트랩한 뒤 빌트인 에이전트를 시드한다. 앱이 설치돼 있으면 같은
 * userData(SQLite/keychain)를 자동으로 공유한다 — 앱과 CLI가 한 몸으로 움직인다.
 *
 * 엔진 소스 (AGENTLAS_CLI_SOURCE=bundled|app|repo|auto, 기본 auto):
 *   bundled → 이 패키지의 engine/ (기본; 시스템 Node로 실행)
 *   app     → 설치 앱의 app.asar CLI를 앱 Electron(ELECTRON_RUN_AS_NODE)으로 실행
 *   repo    → 개발 리포 agentlas_desktop/cli (개발용)
 *   auto    → bundled → app → repo 순서로 가능한 것
 *
 * SQLite: better-sqlite3(optionalDependency, npm이 빌드해주면 네이티브) →
 * 실패 시 Node 22+의 node:sqlite 폴백. 앱 모드는 앱 번들 네이티브를 쓴다.
 *
 * env 오버라이드:
 *   AGENTLAS_APP_PATH      앱 경로(.app 번들, 설치 폴더, 또는 실행 파일)
 *   AGENTLAS_DESKTOP_REPO  개발 리포 루트
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

// ── 설치 앱 탐색 ─────────────────────────────────────────────
function resolveAppFrom(base) {
  if (!base || !exists(base)) return null;
  let root = base;
  try {
    const st = fs.statSync(base);
    if (st.isFile()) {
      const dir = path.dirname(base);
      root = path.basename(dir) === "MacOS" ? path.dirname(path.dirname(dir)) : dir;
      if (process.platform === "darwin" && !root.endsWith(".app")) root = dir;
    }
  } catch { return null; }

  if (process.platform === "darwin") {
    const app = root.endsWith(".app") ? root : path.join(root, "Agentlas.app");
    const exec = path.join(app, "Contents", "MacOS", "Agentlas");
    const asar = path.join(app, "Contents", "Resources", "app.asar");
    if (exists(exec) && exists(asar)) return { exec, asar };
    return null;
  }
  const execNames = process.platform === "win32" ? ["Agentlas.exe"] : ["agentlas", "Agentlas"];
  for (const name of execNames) {
    const exec = path.join(root, name);
    const asar = path.join(root, "resources", "app.asar");
    if (exists(exec) && exists(asar)) return { exec, asar };
  }
  return null;
}

function findApp() {
  const candidates = [];
  if (process.env.AGENTLAS_APP_PATH) candidates.push(process.env.AGENTLAS_APP_PATH);
  if (process.platform === "darwin") {
    candidates.push("/Applications/Agentlas.app", path.join(os.homedir(), "Applications", "Agentlas.app"));
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(path.join(localAppData, "Programs", "Agentlas"));
  } else {
    candidates.push("/opt/Agentlas", "/usr/lib/agentlas", "/usr/local/lib/agentlas");
  }
  for (const c of candidates) {
    const found = resolveAppFrom(c);
    if (found) return found;
  }
  return null;
}

function findRepo() {
  const candidates = [];
  if (process.env.AGENTLAS_DESKTOP_REPO) candidates.push(process.env.AGENTLAS_DESKTOP_REPO);
  candidates.push(path.join(PKG_ROOT, "..", "agentlas_desktop"));
  for (const c of candidates) {
    const script = path.join(c, "cli", "agentlas.cjs");
    if (exists(script)) return { root: path.resolve(c), script };
  }
  return null;
}

function findBundled() {
  const script = path.join(PKG_ROOT, "engine", "agentlas.cjs");
  return exists(script) ? { script } : null;
}

// ── SQLite 로더 (부트스트랩용): better-sqlite3 → node:sqlite ──
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

// ── 엔진 선택 ────────────────────────────────────────────────
function pickEngine() {
  const source = (process.env.AGENTLAS_CLI_SOURCE || "auto").toLowerCase();
  const bundled = findBundled();
  const app = findApp();
  const repo = findRepo();

  // standalone(시스템 Node) 실행이 가능한가: better-sqlite3 로드 또는 Node 22+
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let nativeSqlite = false;
  try { require.resolve("better-sqlite3"); nativeSqlite = true; } catch { /* absent */ }
  const standaloneOk = nativeSqlite || nodeMajor >= 22;

  const bundledEngine = bundled
    ? { source: "bundled", exec: process.execPath, script: bundled.script, standalone: true }
    : null;
  const appEngine = app
    ? { source: "app", exec: app.exec, script: path.join(app.asar, "cli", "agentlas.cjs"), standalone: false }
    : null;
  const repoEngine = repo
    ? { source: "repo", exec: app ? app.exec : process.execPath, script: repo.script, standalone: !app }
    : null;

  const meta = { app, repo, bundled, nativeSqlite, standaloneOk };
  if (source === "bundled") return { engine: bundledEngine, ...meta, error: bundledEngine ? null : "번들 엔진이 없습니다 (engine/agentlas.cjs). scripts/sync-engine.mjs 를 실행하세요." };
  if (source === "app") return { engine: appEngine, ...meta, error: appEngine ? null : "설치된 Agentlas 앱을 찾지 못했습니다 (AGENTLAS_APP_PATH 로 지정 가능)." };
  if (source === "repo") return { engine: repoEngine, ...meta, error: repoEngine ? null : "agentlas_desktop 리포를 찾지 못했습니다 (AGENTLAS_DESKTOP_REPO 로 지정 가능)." };

  // auto: bundled(standalone 가능할 때) → app → repo
  const ladder = [];
  if (bundledEngine && standaloneOk) ladder.push(bundledEngine);
  if (appEngine) ladder.push(appEngine);
  if (bundledEngine && !standaloneOk) ladder.push(bundledEngine); // 마지막 시도라도 해 본다
  if (repoEngine) ladder.push(repoEngine);
  return {
    engine: ladder[0] || null,
    ...meta,
    error: ladder[0] ? null : [
      "Agentlas 엔진을 찾지 못했습니다.",
      "  1) npm 설치가 손상됐다면 재설치: npm i -g agentlas-terminal",
      "  2) 또는 데스크탑 앱 설치: https://agentlas.cloud",
    ].join("\n"),
  };
}

function main() {
  const args = process.argv.slice(2);
  const picked = pickEngine();

  if (args[0] === "--where" || args[0] === "terminal-where") {
    process.stdout.write(JSON.stringify({
      launcher: REAL_SELF,
      packageRoot: PKG_ROOT,
      source: picked.engine ? picked.engine.source : null,
      exec: picked.engine ? picked.engine.exec : null,
      script: picked.engine ? picked.engine.script : null,
      db: dbPath(),
      dbExists: exists(dbPath()),
      nativeSqlite: picked.nativeSqlite,
      appFound: !!picked.app,
      repoFound: !!picked.repo,
      bundledFound: !!picked.bundled,
      node: process.version,
      error: picked.error || null,
    }, null, 2) + "\n");
    process.exit(picked.engine ? 0 : 1);
  }

  if (!picked.engine) {
    process.stderr.write(picked.error + "\n");
    process.exit(1);
  }

  // standalone 모드에서만 첫 실행 부트스트랩 (앱 모드는 앱이 DB를 만든다)
  if (picked.engine.standalone) {
    try {
      const boot = bootstrapDbIfMissing();
      if (boot.created) {
        process.stderr.write(`첫 실행: Agentlas 데이터 초기화 완료 (${boot.path})\n`);
      }
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
  }

  const child = spawn(picked.engine.exec, [picked.engine.script, ...args], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  // Ctrl-C 등은 포그라운드 프로세스 그룹 전체에 전달된다 — 자식(REPL)이 처리하게
  // 두고, 런처는 자식이 끝날 때까지 살아서 종료 코드를 그대로 넘긴다.
  const forward = () => { /* child receives it via the shared process group */ };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try { process.on(sig, forward); } catch { /* win32 SIGHUP 등 */ }
  }

  child.on("error", (err) => {
    process.stderr.write(`Agentlas 엔진 실행 실패: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); return; } catch { /* fall through */ }
    }
    process.exit(code == null ? 0 : code);
  });
}

main();
