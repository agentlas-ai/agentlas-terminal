"use strict";
/*
 * core/schema-ensure — 공유 SQLite 에 대한 스키마 보정을 **커넥션당 한 번만** 한다.
 *
 * 왜 (2026-07-28 실측):
 *   `agentlas.sqlite` 는 데스크탑 앱과 공유하는 파일이다(제품 계약, `core/paths.cjs`).
 *   그런데 터미널이 **매 턴** 그 파일에 DDL 을 날리고 있었다 —
 *     · `ALTER TABLE memory_entries ADD COLUMN context_json` (사본 3벌)
 *     · `CREATE TABLE IF NOT EXISTS terminal_memory_*` 4개 + 인덱스 5개
 *   전부 `IF NOT EXISTS`/조건부라 결과는 멱등이지만, **쓰기 락을 잡는 것은 매번**이다.
 *   데스크탑이 마이그레이션 트랜잭션 중이면 15초 busy_timeout 을 소진하고, 호출부가
 *   전부 빈 catch 라 그 실패가 조용히 사라진다.
 *
 *   스키마 소유자는 데스크탑이다(`core/db.cjs:7-9`). 터미널의 이 보정은 "앱보다 먼저
 *   깔린 DB" 같은 경우를 위한 안전망이지 상시 작업이 아니다. 프로세스가 사는 동안
 *   한 번이면 충분하다.
 *
 * 왜 커넥션당인가 (프로세스당이 아니라):
 *   테스트와 일부 명령이 임시 DB 를 따로 연다. 프로세스 단위로 기억하면 두 번째
 *   DB 가 보정을 건너뛰어 조용히 깨진다. WeakMap 이면 커넥션이 사라질 때 같이 사라진다.
 */
const applied = new WeakMap();

/**
 * `key` 작업을 이 커넥션에서 아직 안 했으면 실행한다.
 * 실패는 삼키되 **기억하지 않는다** — 다음 호출이 다시 시도할 수 있어야 한다.
 * (일시적 락 경합으로 실패한 것을 "완료"로 기억하면 스키마가 영구히 안 맞는다.)
 */
function ensureOnce(db, key, fn) {
  if (!db) return false;
  let done = applied.get(db);
  if (!done) {
    done = new Set();
    applied.set(db, done);
  }
  if (done.has(key)) return true;
  try {
    fn(db);
    done.add(key);
    return true;
  } catch {
    return false;
  }
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

/**
 * `memory_entries.context_json` 보정. 이전에는 이 함수가 세 파일에 각각 복제돼 있었고
 * (`sessions/prompt.cjs`, `project/memory-context.cjs`, `memory-cli/curate.cjs`)
 * 그중 하나는 매 턴 호출됐다. 하나로 합치고 커넥션당 1회로 줄인다.
 */
function ensureMemoryContextColumn(db) {
  return ensureOnce(db, "memory_entries.context_json", (conn) => {
    if (tableExists(conn, "memory_entries") && !columnExists(conn, "memory_entries", "context_json")) {
      conn.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  });
}

module.exports = { ensureOnce, ensureMemoryContextColumn, tableExists, columnExists };
