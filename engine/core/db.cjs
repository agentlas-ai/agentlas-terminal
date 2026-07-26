"use strict";
/*
 * core/db — 공유 SQLite(데스크탑과 동일 DB) 열기 + 드라이버 사다리 + 빌트인 시드.
 *
 * 드라이버: better-sqlite3(네이티브, optionalDependency) → node:sqlite(Node 22.5+).
 * 두 드라이버 모두 prepare().get/all/run 표면이 같으므로 얇은 어댑터만 둔다.
 * 스키마 소유권: 정본 스키마는 데스크탑 앱. 터미널은 bootstrap-schema.sql로
 * 첫 부트스트랩만 하고(런처가 수행), 이후 마이그레이션은 앱이 한다.
 * 터미널은 "있으면 쓰는" 방어적 열 확인(columnExists)으로만 전진 호환한다.
 */
const fs = require("node:fs");
const { configureSqliteConnection } = require("../agentlas-sqlite-policy.cjs");
const { parseSemVer, compareSemVer } = require("../semver.cjs");
const { dbPath } = require("./paths.cjs");

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

function openRaw(file) {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(file);
    configureSqliteConnection(db);
    db.__driver = "better-sqlite3";
    return db;
  } catch { /* optional dep 미설치/ABI 불일치 → node:sqlite */ }
  const { DatabaseSync } = loadNodeSqliteQuietly();
  const db = new DatabaseSync(file);
  configureSqliteConnection(db);
  db.__driver = "node:sqlite";
  return db;
}

/**
 * DB 파일이 없으면 하드 실패한다. 부트스트랩은 런처(bin/agentlas.cjs)의 책임 —
 * 엔진이 임의 경로에 빈 DB를 만들면 데스크탑과의 공유 계약이 조용히 깨진다.
 */
function openDb() {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Agentlas database not found: ${file} (run via bin/agentlas.cjs)`);
  }
  return openRaw(file);
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}

function columnExists(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
}

function runWriteTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ── 빌트인 아키텍처 시드 (데스크탑 seedBuiltinAgents와 동일 멱등·버전 게이팅) ──
let _arch = null;
function loadArch() {
  if (_arch) return _arch;
  try {
    _arch = require("../architecture.data.json");
  } catch {
    _arch = { version: "0", agents: [] };
  }
  return _arch;
}

/**
 * 설치본 시드 버전이 번들보다 최신이거나 파싱 불가면 fail-closed(덮어쓰기 금지):
 * 더 새로운 데스크탑이 심은 공유 데이터를 옛 터미널이 되감으면 안 된다.
 */
function shouldApplyBuiltinArchitectureSeed(installedVersion, bundleVersion, installedCount, bundleCount) {
  if (!parseSemVer(bundleVersion)) return false;
  if (installedVersion == null || installedVersion === "") return true;
  const precedence = compareSemVer(installedVersion, bundleVersion);
  if (precedence == null || precedence > 0) return false;
  if (precedence < 0) return true;
  const have = Number.isSafeInteger(Number(installedCount)) ? Number(installedCount) : 0;
  const expected = Number.isSafeInteger(Number(bundleCount)) ? Number(bundleCount) : 0;
  return have < expected;
}

function seedBuiltins(db) {
  const arch = loadArch();
  if (!arch.agents || !arch.agents.length) return;
  if (!tableExists(db, "meta") || !columnExists(db, "installed_agents", "builtin")) return;
  const now = new Date().toISOString();
  try {
    runWriteTransaction(db, () => {
      const installed = db.prepare("SELECT value FROM meta WHERE key='architecture_version'").get();
      const have = db.prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE builtin=1").get();
      if (!shouldApplyBuiltinArchitectureSeed(
        installed ? installed.value : null,
        arch.version,
        have ? have.n : 0,
        arch.agents.length,
      )) return false;
      const hasVisibility = columnExists(db, "installed_agents", "visibility");
      for (const def of arch.agents) {
        const visibility = def.visibility || "background";
        const existing = db.prepare("SELECT id FROM installed_agents WHERE id=? OR slug=?").get(def.id, def.slug);
        if (existing) {
          if (hasVisibility) {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A', visibility=? WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, visibility, existing.id);
          } else {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A' WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, existing.id);
          }
        } else if (hasVisibility) {
          db.prepare(
            "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?,?)",
          ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role, visibility);
        } else {
          db.prepare(
            "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?)",
          ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role);
        }
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('architecture_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(arch.version);
      return true;
    });
  } catch { /* best-effort: 앱이 마이그레이션 중이면 다음 실행에서 재시도 */ }
}

module.exports = {
  openDb,
  openRaw,
  tableExists,
  columnExists,
  runWriteTransaction,
  seedBuiltins,
  shouldApplyBuiltinArchitectureSeed,
  loadArch,
};
