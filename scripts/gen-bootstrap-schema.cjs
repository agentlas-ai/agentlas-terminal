"use strict";
/*
 * engine/bootstrap-schema.sql 재생성 — **정본 사다리에서** 만든다.
 *
 *   node scripts/gen-bootstrap-schema.cjs [--desktop <agentlas_desktop 경로>]
 *
 * ★왜 다시 썼나 (Phase 0, docs/DAEMON-ARCHITECTURE-DESIGN-2026-08-18.md §2).
 * 예전 scripts/gen-bootstrap-schema.sh 는 **사용자의 라이브 DB** 를 기본 소스로 읽어
 * `.schema` 를 덤프했다. 그래서 부트스트랩 버전은 "그날 그 머신의 상태"였고, 실제로
 * user_version=94 로 고정된 채 데스크탑 사다리는 97 까지 올라가 있었다. 그 간극이
 * 곧 "터미널이 만든 DB 를 데스크탑이 나중에 승급해야 하는 창" = 마이그레이션 주인이
 * 둘인 창이었다. 또한 기본값이 라이브 파일이라는 것 자체가 사고 표면이다.
 *
 * 지금은 결정적이다: 빈 임시 DB 에 데스크탑의 컴파일된 사다리를 끝까지 돌린 결과를
 * 덤프한다. 라이브 저장소는 열지도 않는다. 결과의 user_version 은 언제나 데스크탑
 * SCHEMA_VERSION 과 같고, 그 동일성은 test/store-migration-authority.cjs 가 단언한다.
 *
 * 전제: agentlas_desktop 에서 `npm run build:electron` 이 끝나 dist/ 가 최신일 것.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PKG_ROOT = path.dirname(__dirname);

function desktopRootFromArgs() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--desktop");
  if (flag >= 0 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  if (process.env.AGENTLAS_DESKTOP_REPO) return path.resolve(process.env.AGENTLAS_DESKTOP_REPO);
  return path.resolve(PKG_ROOT, "..", "agentlas_desktop");
}

function main() {
  const desktopRoot = desktopRootFromArgs();
  const coreDb = path.join(desktopRoot, "dist", "electron", "store", "db.js");
  if (!fs.existsSync(coreDb)) {
    throw new Error(
      `Compiled Desktop core not found: ${coreDb}\n` +
      "Run `npm run build:electron` in agentlas_desktop first, or pass --desktop <path>.",
    );
  }

  // 임시 저장소에서만 돈다. 라이브 경로는 어떤 경우에도 열지 않는다.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-bootstrap-gen-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmpDir, "agentlas.sqlite");
  process.env.AGENTLAS_USER_DATA_DIR = tmpDir;
  // 이 스크립트는 빈 DB 를 처음부터 만든다 — 여기서는 owner 가 정상이다.
  process.env.AGENTLAS_STORE_MIGRATION_ROLE = "owner";

  const BetterSqlite3 = require("better-sqlite3"); // 터미널 ABI
  const electronShim = makeElectronShim(tmpDir);
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "better-sqlite3") return BetterSqlite3;
    if (request === "electron") return electronShim;
    return origLoad.apply(this, arguments);
  };

  let db;
  let version;
  let rows;
  try {
    const core = require(coreDb);
    core.initStore();
    db = core.getDb();
    version = Number(db.pragma("user_version", { simple: true }));
    const declared = Number(core.STORE_SCHEMA_VERSION);
    if (Number.isFinite(declared) && declared !== version) {
      throw new Error(`ladder produced user_version=${version} but core declares ${declared}`);
    }
    rows = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,
                   name`,
      )
      .all();
  } finally {
    Module._load = origLoad;
    try { db && db.close(); } catch { /* noop */ }
  }

  const out = path.join(PKG_ROOT, "engine", "bootstrap-schema.sql");
  const header = [
    `-- Agentlas 첫 실행 부트스트랩 스키마 (생성: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")})`,
    "--",
    "-- ★생성물이다. 손으로 고치지 말고 재생성하라:",
    "--     node scripts/gen-bootstrap-schema.cjs",
    "--",
    "-- 정본은 Desktop 의 마이그레이션 사다리(agentlas_desktop/electron/store/db.ts, SCHEMA_VERSION).",
    "-- 이 파일은 그 사다리를 **빈 DB** 에 끝까지 돌린 결과의 덤프이므로, 터미널이 만든 DB 는",
    "-- 처음부터 사다리 머리에 있다 — 데스크탑이 나중에 승급할 것이 남지 않는다.",
    `PRAGMA user_version=${version};`,
  ].join("\n");
  const body = rows.map((r) => `${String(r.sql).trim()};`).join("\n");
  fs.writeFileSync(out, `${header}\n${body}\n`, "utf8");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`written: ${out} (user_version=${version}, ${rows.length} objects)`);
}

function makeElectronShim(base) {
  const notAvailable = (what) => () => {
    throw new Error(`electron.${what} is not available in the bootstrap-schema generator.`);
  };
  const app = {
    getPath: () => base,
    getName: () => "agentlas",
    getVersion: () => "0.0.0",
    getLocale: () => "en-US",
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    isPackaged: true,
    on() { return app; }, once() { return app; }, off() { return app; },
    quit() {}, exit() {}, setPath() {},
  };
  const gui = new Proxy({}, { get: (_t, prop) => notAvailable(String(prop)) });
  return {
    app,
    safeStorage: { isEncryptionAvailable: () => false },
    Notification: class { static isSupported() { return false; } show() {} close() {} },
    BrowserWindow: gui, dialog: gui, shell: gui, session: gui, ipcMain: gui,
    nativeTheme: {}, powerMonitor: gui,
  };
}

main();
