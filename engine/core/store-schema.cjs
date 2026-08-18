"use strict";
/*
 * core/store-schema — 공유 저장소의 **스키마 버전 계약**. 터미널은 읽기만 한다.
 *
 * ★단일 마이그레이션 권위 (Phase 0, docs/DAEMON-ARCHITECTURE-DESIGN-2026-08-18.md §2/§6).
 *
 * `~/Library/Application Support/Agentlas/agentlas.sqlite` 는 락 없는 다중 쓰기 파일인데
 * 마이그레이션 주인이 **둘**이었다:
 *   1) 데스크탑의 사다리(electron/store/db.ts SCHEMA_VERSION),
 *   2) 그 사다리를 그대로 다시 도는 터미널의 벤더 코어 경로(core/desktop-core.cjs initStore).
 * 그리고 터미널의 가벼운 드라이버(core/db.cjs)는 user_version 을 **읽지도 않으면서** 쓰기
 * 트랜잭션(seedBuiltins → BEGIN IMMEDIATE)을 열었다. 즉 "검사 없음 + 거절 없음 + 쓰기 있음".
 *
 * 이제 규칙은 하나다: **터미널은 절대 승급하지 않는다.** 파일이 이 배포가 아는 버전보다
 * 낮으면 조용히 진행하지도, 몰래 마이그레이션하지도 않고 **정직하게 거절**한다.
 *
 * 왜 "없으면 터미널이 주인" 이 아닌가: 데스크탑의 부재는 경합 없이 관측할 수 없다 —
 * 터미널이 사다리를 도는 도중에 데스크탑이 켜질 수 있다. 잘못 추측한 비용은 117MB 저장소
 * 손상(db.ts 의 run_events 사고 주석)이고, 거절의 비용은 데스크탑 한 번 실행이다.
 *
 * 기대 버전의 출처: 이 패키지가 함께 배포하는 engine/bootstrap-schema.sql 의
 * `PRAGMA user_version=` 이 곧 "이 배포가 아는 사다리 머리"다. 그 파일은 데스크탑 사다리를
 * 빈 DB 에 끝까지 돌려 생성한 것이므로(scripts/gen-bootstrap-schema.cjs) 손으로 맞출 숫자가
 * 따로 없다 — 재생성하면 자동으로 같이 움직인다.
 */
const fs = require("node:fs");
const path = require("node:path");

const BOOTSTRAP_SCHEMA_FILE = path.join(path.dirname(__dirname), "bootstrap-schema.sql");

let _expected;

/** 이 배포가 아는 스키마 버전. 부트스트랩 SQL 헤더에서 읽는다(정본은 데스크탑 사다리). */
function expectedStoreSchemaVersion() {
  if (_expected !== undefined) return _expected;
  let header = "";
  try {
    const fd = fs.openSync(BOOTSTRAP_SCHEMA_FILE, "r");
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      header = buf.slice(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    header = "";
  }
  const match = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(header);
  // 부트스트랩 SQL 을 못 읽으면 기대 버전을 **모른다**. 0 은 "검사 불가"를 뜻하고,
  // 아래 단언은 그때 통과시킨다 — 모르는 것을 근거로 사용자를 막지 않는다.
  _expected = match ? Number(match[1]) : 0;
  return _expected;
}

/** 열린 커넥션의 user_version. 못 읽으면 null(모름). */
function readStoreSchemaVersion(db) {
  try {
    if (typeof db.pragma === "function") {
      const value = db.pragma("user_version", { simple: true });
      return Number.isFinite(Number(value)) ? Number(value) : null;
    }
    const row = db.prepare("PRAGMA user_version").get();
    if (!row) return null;
    const value = row.user_version ?? Object.values(row)[0];
    return Number.isFinite(Number(value)) ? Number(value) : null;
  } catch {
    return null;
  }
}

/** 정직하고 실행 가능한 거절문. 두 가지 해결책을 모두 이름으로 말한다. */
function storeSchemaRefusalMessage(found, expected, file) {
  return [
    `Agentlas store schema is v${found}, but this Agentlas CLI needs v${expected}.`,
    `Store: ${file}`,
    "The Agentlas CLI never migrates the shared database — the Desktop app owns the migration ladder,",
    "and a second migrator on this lock-free file is how the store was corrupted before.",
    "",
    "Fix it once, either way:",
    "  • Launch (or update) the Agentlas Desktop app once, then re-run this command.",
    "  • No Desktop app on this machine? Close every Agentlas process, then run this command once with",
    "    AGENTLAS_STORE_MIGRATION_ROLE=owner set, so the upgrade is a deliberate act rather than a race.",
  ].join("\n");
}

class StoreSchemaTooOldError extends Error {
  constructor(found, expected, file) {
    super(storeSchemaRefusalMessage(found, expected, file));
    this.name = "StoreSchemaTooOldError";
    this.code = "AGENTLAS_STORE_SCHEMA_TOO_OLD";
    this.found = found;
    this.expected = expected;
    this.file = file;
  }
}

/**
 * 공유 저장소를 이 프로세스가 써도 되는가.
 * 낮으면 던진다. 같거나 높으면 통과 — 더 높은 것은 데스크탑이 앞서간 것이고, 터미널은
 * columnExists 기반 방어적 읽기로 전진 호환한다(기존 계약 유지).
 */
function assertStoreSchemaCompatible(db, file) {
  const expected = expectedStoreSchemaVersion();
  if (!expected) return; // 기대 버전을 모르면 막지 않는다.
  const found = readStoreSchemaVersion(db);
  if (found === null) return; // 읽을 수 없으면 판단하지 않는다(가짜 거절 금지).
  if (found >= expected) return;
  throw new StoreSchemaTooOldError(found, expected, file);
}

module.exports = {
  BOOTSTRAP_SCHEMA_FILE,
  StoreSchemaTooOldError,
  assertStoreSchemaCompatible,
  expectedStoreSchemaVersion,
  readStoreSchemaVersion,
  storeSchemaRefusalMessage,
};
