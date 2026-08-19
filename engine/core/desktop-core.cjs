"use strict";
/*
 * core/desktop-core — 데스크탑의 이미-컴파일된 코어를 터미널이 **재사용**한다 (2026-08-06).
 *
 * 배경(오너: "더 어려운 Electron 을 만들었는데 왜 더 쉬운 터미널을 못 만드냐 — 그래프 하나
 * 문제가 아니다"): 정상 패턴은 CLI 를 먼저 만들고 그 위에 GUI 를 얹는 것이다. Agentlas 는
 * 거꾸로 갔고, 터미널이 데스크탑 엔진을 손으로 재구현한 별도 사본이라 늘 뒤처졌다. 근본
 * 수리는 기능을 하나씩 베끼는 게 아니라 **데스크탑의 컴파일된 코어를 그대로 불러 쓰는 것**이다.
 *
 * 그 코어(electron/workflow/run-graph.js + electron/mcp/* + electron/store/*)는 Electron 의존이
 * 0이라(실측: `from "electron"`·BrowserWindow·app 전무, store/db 의 유일한 app.getPath 는
 * AGENTLAS_STORE_PATH 로 이미 오버라이드 가능) 순수 Node 에서 그대로 require 된다.
 *
 * 이 로더는 컴파일된 코어의 위치를 찾아, **공유 DB 경로를 코어가 읽기 전에** 세팅하고 로드한다.
 * 찾지 못하면 null 을 준다 — 호출부가 정직하게 멈춘다(가짜 성공 금지).
 *
 * 해석 순서:
 *   1. env AGENTLAS_DESKTOP_CORE — 코어 루트(…/dist/electron 를 담는 디렉터리, 즉 dist)
 *   2. 벤더본: <pkg>/engine/vendor/desktop-core/dist  (pack 시 복사되는 자립본)
 *   3. 개발(동일 저장소 체크아웃): <pkg>/../agentlas_desktop/dist
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dbPath, packageRoot, userDataDir } = require("./paths.cjs");

/*
 * 재사용 코어를 electron 없이 돌리는 셰임(2026-08-06).
 * 재사용 클로저(200파일)의 electron 사용은 거의 전부 app.getPath(...) — 디렉터리 해석뿐이고,
 * 나머지(BrowserWindow·dialog·session)는 헤드리스 실행 경로에서 쓰이지 않는다. 그래서 작은
 * 가짜 electron 을 require 훅으로 돌려주면, electron 도 데스크탑 앱도 설치하지 않은 순수 Node
 * 에서 데스크탑 코어가 그대로 돈다. GUI 전용 심볼은 실제로 불릴 때만 "CLI 에선 불가"로 던진다
 * (조용히 no-op 하지 않는다 — 가짜 성공 금지).
 */
function makeElectronShim() {
  const base = userDataDir();
  const paths = {
    userData: base,
    appData: path.dirname(base),
    home: os.homedir(),
    temp: os.tmpdir(),
    downloads: path.join(os.homedir(), "Downloads"),
    documents: path.join(os.homedir(), "Documents"),
    logs: path.join(base, "logs"),
    sessionData: base,
    exe: process.execPath,
    module: process.execPath,
  };
  const app = {
    getPath: (name) => paths[name] || base,
    getName: () => "agentlas",
    getVersion: () => { try { return require(path.join(packageRoot(), "package.json")).version; } catch { return "0.0.0"; } },
    getLocale: () => "en-US",
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    isPackaged: true,
    on() { return app; }, once() { return app; }, off() { return app; },
    quit() {}, exit() {}, setPath() {},
  };
  const notAvailable = (what) => () => { throw new Error(`electron.${what} is not available in the Agentlas CLI (headless).`); };
  const safeStorage = { isEncryptionAvailable: () => false, encryptString: notAvailable("safeStorage.encryptString"), decryptString: notAvailable("safeStorage.decryptString") };
  class Notification { constructor() {} show() {} close() {} static isSupported() { return false; } }
  const gui = new Proxy({}, { get: (_t, prop) => notAvailable(String(prop)) });
  return { app, safeStorage, Notification, BrowserWindow: gui, dialog: gui, shell: gui, session: gui, ipcMain: gui, nativeTheme: {}, powerMonitor: gui };
}

function candidateRoots() {
  const roots = [];
  if (process.env.AGENTLAS_DESKTOP_CORE) roots.push(process.env.AGENTLAS_DESKTOP_CORE);
  roots.push(path.join(packageRoot(), "engine", "vendor", "desktop-core", "dist"));
  // 코덱스 CLI 패턴: 무거운 실행부는 git/npm 패키지에 미리 담지 않고, 처음 필요할 때만 내려받아
  // 로컬에 캐시한다(userDataDir 아래) — 다음부턴 이 경로가 바로 잡힌다.
  try { const cached = require("./desktop-core-fetch.cjs").cachedCoreRoot(); if (cached) roots.push(cached); } catch { /* 매니페스트 없음 */ }
  roots.push(path.resolve(packageRoot(), "..", "agentlas_desktop", "dist"));
  return roots;
}

/** 컴파일된 코어의 dist 루트를 찾는다(run-graph.js 존재로 판정). 없으면 null. */
function findCoreRoot() {
  for (const root of candidateRoots()) {
    try {
      if (fs.existsSync(path.join(root, "electron", "workflow", "run-graph.js"))) return root;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/*
 * 재사용 코어가 네이티브 모듈(better-sqlite3·keytar)을 **터미널 것**으로 쓰게 한다.
 * 데스크탑 node_modules 의 것은 Electron ABI 로 빌드돼 순수 Node 와 호환되지 않는다
 * (NODE_MODULE_VERSION 불일치). require 를 한 번 가로채 터미널의 바인딩으로 돌린다 — 같은
 * 패키지의 ABI 만 맞추는 것이라 안전. ★다운로드 캐시(userDataDir 아래)는 터미널 패키지 트리
 * 밖이라 node_modules 디렉터리 walk-up으로 자연 해결되지 않는다 — 이 훅이 위치와 무관하게 잡는다.
 */
let _nativeHookInstalled = false;
let _projectProvisioningHookInstalled = false;

function stripRetiredProjectProvisioningSource(source) {
  const text = String(source || "");
  if (!text.includes("SUPER_ONTOLOGY_")) return text;
  const startMarker = "        const secureWriteMissing = (filePath, content, _encoding) => {";
  const endMarker = "        preflightProjectProvisionTargets(identity);";
  const start = text.indexOf(startMarker);
  const end = start < 0 ? -1 : text.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("desktop_core_retired_surface_patch_failed: project provisioning layout changed");
  }
  return `${text.slice(0, start)}        // Terminal keeps semantic ontology and career graph provisioning, but does not\n` +
    `        // load the retired project-file generation block from the Desktop bundle.\n${text.slice(end)}`;
}

function installRetiredProjectProvisioningHook() {
  if (_projectProvisioningHookInstalled) return;
  const Module = require("node:module");
  const jsLoader = Module._extensions[".js"];
  Module._extensions[".js"] = function loadTerminalDesktopCore(module, filename) {
    if (filename.endsWith(path.join("electron", "memory", "project-files.js"))) {
      const source = fs.readFileSync(filename, "utf8");
      module._compile(stripRetiredProjectProvisioningSource(source), filename);
      return;
    }
    return jsLoader(module, filename);
  };
  _projectProvisioningHookInstalled = true;
}

function installNativeModuleHook() {
  if (_nativeHookInstalled) return;
  const Module = require("node:module");
  const terminalBetterSqlite3 = require("better-sqlite3"); // 터미널 ABI 로 빌드된 것
  let terminalKeytar = null;
  try {
    terminalKeytar = require("keytar");
    // ★훅은 require 를 가로채지만 resolve 는 못 가로챈다. 코어의 키체인 호스트는 자식
    //   프로세스를 띄우려고 **경로**가 필요한데, 벤더 트리에는 keytar 가 일부러 없다
    //   (아래 skip 목록). 그래서 우리 것의 실물 경로를 봉투에 담아 넘긴다.
    //   실측 2026-08-20: 이게 없으면 `Cannot find module 'keytar'` 로 노드가 죽었다.
    if (!process.env.AGENTLAS_KEYTAR_PATH) {
      process.env.AGENTLAS_KEYTAR_PATH = require.resolve("keytar");
    }
  } catch { /* optionalDependency — 없을 수 있다 */ }
  const electronShim = makeElectronShim();                 // electron 없이 코어를 돌리는 셰임
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "better-sqlite3") return terminalBetterSqlite3;
    if (request === "keytar" && terminalKeytar) return terminalKeytar;
    if (request === "electron") return electronShim;
    return orig.apply(this, arguments);
  };
  _nativeHookInstalled = true;
}

/**
 * 코어의 initStore 를 부르기 전에, 공유 저장소의 user_version 을 **우리 드라이버로** 확인한다.
 * 별도 커넥션을 잠깐 열고 닫을 뿐 아무것도 쓰지 않는다. 파일이 아직 없으면(첫 실행 부트스트랩
 * 이전) 판단할 것이 없으므로 통과 — 코어가 만들게 둔다.
 */
function assertSharedStoreSchemaBeforeCoreInit() {
  const file = process.env.AGENTLAS_STORE_PATH || dbPath();
  if (!fs.existsSync(file)) return;
  const { openRaw } = require("./db.cjs");
  const { assertStoreSchemaCompatible } = require("./store-schema.cjs");
  let probe = null;
  try {
    probe = openRaw(file);
    assertStoreSchemaCompatible(probe, file);
  } finally {
    try { probe && probe.close(); } catch { /* noop */ }
  }
}

let _cache = undefined;

/**
 * 재사용 코어를 로드한다. 반환: { root, require(rel), runGraph, ... } 또는 null.
 *  · require(rel): 코어 안의 임의 컴파일 모듈을 상대경로로 로드(예: "store/automations").
 *  · runGraph: electron/workflow/run-graph.js 의 runGraph(automation, graph, opts).
 * 공유 DB(AGENTLAS_STORE_PATH)를 코어 로드 전에 반드시 세팅한다 — store/db 가 모듈 로드 시 읽는다.
 *
 * ★마이그레이션 권위 (Phase 0, docs/DAEMON-ARCHITECTURE-DESIGN-2026-08-18.md §2/§6).
 *
 * 여기가 **두 번째 마이그레이션 주인**이었다. 이 셰임은 isPackaged:true 를 보고해
 * (설계상) db.ts 의 개발 샌드박스 가드를 무력화하고, 공유 라이브 파일에 데스크탑과
 * 같은 사다리를 돌렸다. 락이 없는 파일에서 두 프로세스가 사다리를 겹쳐 도는 것이
 * 정확히 run_events + 인덱스 4개를 malformed 로 만든 경로다.
 *
 * **선택: (a) 사다리를 돌리지 않는다.** initStore 를 follower 로 부른다 — 코어는 열고
 * 확인만 하며, 낮으면 정직하게 거절한다. (b)("데스크탑이 없으면 터미널이 주인")를 고르지
 * 않은 이유: 데스크탑의 부재는 경합 없이 관측할 수 없다. 터미널이 사다리를 도는 중에
 * 데스크탑이 켜질 수 있고, 틀렸을 때의 비용이 비대칭이다(손상 vs 앱 한 번 실행).
 * 데스크탑이 정말 없는 머신은 `AGENTLAS_STORE_MIGRATION_ROLE=owner` 로 **사람이 일부러**
 * 한 번 켠다 — 사고로 되는 일과 적어서 되는 일은 달라야 한다.
 */
function loadDesktopCore(options = {}) {
  if (_cache !== undefined) return _cache;
  const root = findCoreRoot();
  if (!root) { _cache = null; return null; }
  installRetiredProjectProvisioningHook();
  installNativeModuleHook();
  // 코어의 store 가 이 값을 모듈 로드 시점에 읽는다 — require 이전에 세팅해야 한다.
  if (!process.env.AGENTLAS_STORE_PATH) process.env.AGENTLAS_STORE_PATH = dbPath();
  const migrationRole = options.migrationRole
    || (String(process.env.AGENTLAS_STORE_MIGRATION_ROLE || "").trim().toLowerCase() === "owner"
      ? "owner"
      : "follower");
  const req = (rel) => require(path.join(root, "electron", rel.replace(/\.js$/, "") + ".js"));
  let kernel;
  try {
    const store = req("store/db");
    if (migrationRole === "follower") {
      // 옛 벤더 번들은 이 계약을 모른다(옵션·env 를 무시하고 사다리를 돈다). 조용히 넘어가지
      // 않고 무엇이 위험한지 말한다 — `npm run vendor:core` 로 갱신하면 사라진다.
      if (typeof store.STORE_SCHEMA_VERSION !== "number") {
        console.warn(
          "[store] vendored Desktop core predates the single-migration-authority contract "
          + "(no STORE_SCHEMA_VERSION export); it may migrate the shared database. "
          + "Refresh it with `npm run vendor:core`.",
        );
      }
      // 코어를 부르기 **전에** 우리 쪽에서 먼저 확인한다 — 옛 코어가 옵션을 무시해도
      // 최소한 낮은 스키마에서는 사다리에 닿지 않는다.
      assertSharedStoreSchemaBeforeCoreInit();
    }
    // 데스크탑은 app.whenReady 에서 initStore() 를 부른다 — 터미널도 코어를 쓰기 전에 부른다.
    store.initStore({ migrationRole });
    kernel = req("workflow/run-graph");
  } catch (e) { _cache = { root, error: e }; return _cache; }
  _cache = {
    root,
    require: req,
    initStore: req("store/db").initStore,
    getDb: req("store/db").getDb,
    runGraph: kernel.runGraph,
    graphFailureOf: kernel.graphFailureOf,
    planGraphLoops: kernel.planGraphLoops,
  };
  return _cache;
}

/**
 * 코어의 공용 ACP 러너(electron/runtime/acp.js)만 가볍게 로드한다 (PRD 2026-08-15 T-2).
 * initStore·그래프 커널을 끌지 않고, electron 셰임과 네이티브 모듈 훅만 건 뒤 require 한다 —
 * kimi/grok/cursor 실행에 DB가 필요 없기 때문. 코어가 없거나 acp.js가 없는 옛 코어면
 * { error } 를 준다(정직한 부재; 조용한 폴백 금지).
 */
let _acpCache = undefined;
function loadCoreAcpRuntime() {
  if (_acpCache !== undefined) return _acpCache;
  const root = findCoreRoot();
  if (!root) { _acpCache = null; return null; }
  const file = path.join(root, "electron", "runtime", "acp.js");
  if (!fs.existsSync(file)) { _acpCache = { root, error: new Error("desktop core predates the ACP runner (no electron/runtime/acp.js)") }; return _acpCache; }
  try {
    installRetiredProjectProvisioningHook();
    installNativeModuleHook();
    const mod = require(file);
    _acpCache = { root, module: mod };
  } catch (e) {
    _acpCache = { root, error: e };
  }
  return _acpCache;
}

/**
 * 코어의 **공유 순수 모듈**(dist/shared/*)만 가볍게 로드한다 (예: "agent-control-blocks").
 * shared/* 는 electron·DB 의존이 없는 순수 함수 모듈이라 initStore·그래프 커널·셰임 없이
 * require 만 한다. 코어가 없으면 null, 그 모듈이 없는 옛 벤더 번들이면 { root, error } —
 * 정직한 부재(조용한 폴백 금지는 호출부 계약; 표시 경로는 fail-open 해도 된다).
 */
const _sharedCache = new Map();
function loadCoreShared(rel) {
  const key = String(rel || "").replace(/\.js$/, "");
  if (_sharedCache.has(key)) return _sharedCache.get(key);
  let result = null;
  const root = findCoreRoot();
  if (root) {
    const file = path.join(root, "shared", key + ".js");
    if (!fs.existsSync(file)) {
      result = { root, error: new Error(`desktop core has no shared/${key}.js (older vendor bundle)`) };
    } else {
      try {
        result = { root, module: require(file) };
      } catch (e) {
        result = { root, error: e };
      }
    }
  }
  _sharedCache.set(key, result);
  return result;
}

/** 재사용 코어가 이 머신에서 가용한가(정직한 가부). */
function desktopCoreAvailable() {
  const c = loadDesktopCore();
  return !!(c && c.runGraph && !c.error);
}

/**
 * 로컬에서 코어를 못 찾으면(개발용 형제 저장소도, 캐시도 없음) 필요한 순간에만 내려받는다
 * (코덱스 CLI 패턴 — 조용히 안 받는다, onNotice 로 사용자에게 알린다). 매니페스트가 없으면
 * (그래프 실행 기능이 이 배포에 아직 안 실렸으면) null 을 준다 — 정직한 실패.
 */
async function loadDesktopCoreAsync({ onNotice } = {}) {
  const sync = loadDesktopCore();
  if (sync && sync.runGraph && !sync.error) return sync;
  const { fetchDesktopCore } = require("./desktop-core-fetch.cjs");
  const dist = await fetchDesktopCore({ onNotice });
  if (!dist) return null;
  _cache = undefined; // 방금 캐시가 채워졌으니 후보 목록을 다시 계산해 태운다.
  return loadDesktopCore();
}

module.exports = {
  findCoreRoot,
  loadDesktopCore,
  loadCoreAcpRuntime,
  loadCoreShared,
  loadDesktopCoreAsync,
  desktopCoreAvailable,
  _test: { stripRetiredProjectProvisioningSource },
};
