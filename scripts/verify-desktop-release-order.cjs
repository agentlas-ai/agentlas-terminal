#!/usr/bin/env node
"use strict";
/*
 * verify-desktop-release-order — 릴리스 순서 게이트 (2026-09-06).
 *
 * 문제(오너 실측). 터미널은 데스크탑의 컴파일된 코어를 벤더링해서 쓴다
 * (engine/core/desktop-core.cjs, scripts/vendor-desktop-core.cjs). 오늘 데스크탑 코어를
 * 다시 벤더링하면 engine/bootstrap-schema.sql 의 PRAGMA user_version 이 데스크탑의
 * **지금 체크아웃** 사다리 머리로 올라간다(scripts/gen-bootstrap-schema.cjs). 그런데
 * npm 에 발행되는 건 터미널뿐이고, 데스크탑 앱은 별도의 수동 서명 릴리스
 * (agentlas_desktop/.github/workflows/release-signed-mac.yml) 라 시점이 다르다.
 *
 * 터미널이 "데스크탑 vX 가 이미 사용자 손에 있다"고 가정하고 그보다 새 스키마를
 * 요구하는 코어를 실으면, vX 만 설치한 모든 CLI 사용자가 실행 전에
 * AGENTLAS_STORE_SCHEMA_TOO_OLD 로 막힌다(engine/core/store-schema.cjs) — 거절 자체는
 * 정직하고 의도된 것이지만, 그 순서를 지키는 장치가 지금까지 없었다.
 *
 * 이 게이트가 비교하는 두 값은 전부 **실측**이지 텍스트 매칭이 아니다:
 *   1) required  = engine/core/store-schema.cjs 의 expectedStoreSchemaVersion() 을 그대로
 *      호출한다(부트스트랩 SQL 헤더를 읽는 정본 함수 — 이 파일이 재구현하지 않는다).
 *   2) declared  = engine/vendor/desktop-core.manifest.json 에 박아 둔
 *      desktopCompatibleRelease/desktopCompatibleSchemaVersion — "터미널이 이미
 *      나가 있다고 선언하는 데스크탑 릴리스, 그 릴리스가 싣는 스키마".
 *      agentlas_desktop 체크아웃이 옆에 있으면 `git show <tag>:electron/store/db.ts`
 *      로 그 태그가 실제로 declared 스키마를 싣고 있는지 교차 검증한다 — 선언이
 *      낡았거나 손으로 잘못 적었으면 그 자체로 FAIL.
 *
 * required > declared 면 FAIL: 데스크탑이 그 스키마를 실은 릴리스를 먼저 내보내고
 * (release-signed-mac.yml), engine/vendor/desktop-core.manifest.json 의 선언을 갱신한
 * 뒤에야 이 터미널 코어를 발행해야 한다는 뜻이다.
 *
 * 테스트 전용 오버라이드(둘 다 store-schema.cjs/desktop-core-fetch.cjs 의 기존 관례):
 *   AGENTLAS_BOOTSTRAP_SCHEMA_FILE   — required 를 다른 부트스트랩 SQL 에서 읽는다.
 *   AGENTLAS_DESKTOP_CORE_MANIFEST   — declared 를 다른 매니페스트 JSON 에서 읽는다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = process.env.AGENTLAS_DESKTOP_CORE_MANIFEST
  || path.join(ROOT, "engine", "vendor", "desktop-core.manifest.json");
const DESKTOP_REPO = process.env.AGENTLAS_DESKTOP_REPO
  || path.resolve(ROOT, "..", "agentlas_desktop");

function fail(message) {
  console.error(`FAIL desktop-release-order: ${message}`);
  process.exit(1);
}

// 1) required — 정본 함수를 그대로 부른다.
const { expectedStoreSchemaVersion } = require(path.join(ROOT, "engine", "core", "store-schema.cjs"));
const required = expectedStoreSchemaVersion();
if (!required) {
  fail(
    "expectedStoreSchemaVersion() returned 0 — could not read PRAGMA user_version from "
    + "engine/bootstrap-schema.sql. Regenerate it with `node scripts/gen-bootstrap-schema.cjs` first.",
  );
}

// 2) declared — 벤더 매니페스트의 선언.
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  fail(`could not read ${MANIFEST_PATH}: ${error && error.message}`);
}

const declaredTag = typeof manifest?.desktopCompatibleRelease === "string" ? manifest.desktopCompatibleRelease.trim() : "";
const declaredSchema = Number(manifest?.desktopCompatibleSchemaVersion);
if (!declaredTag) {
  fail(
    `${path.relative(ROOT, MANIFEST_PATH)} has no "desktopCompatibleRelease" — the terminal must name the `
    + "Desktop release it assumes is already shipped before it can claim a required schema is safe to publish.",
  );
}
if (!Number.isFinite(declaredSchema) || declaredSchema <= 0) {
  fail(`${path.relative(ROOT, MANIFEST_PATH)} has no valid "desktopCompatibleSchemaVersion" for ${declaredTag}.`);
}

// 교차검증(선택) — 데스크탑 체크아웃이 옆에 있으면 선언이 실제 태그와 맞는지 실측한다.
if (fs.existsSync(DESKTOP_REPO)) {
  const show = spawnSync("git", ["show", `${declaredTag}:electron/store/db.ts`], {
    cwd: DESKTOP_REPO,
    encoding: "utf8",
  });
  if (show.status === 0 && show.stdout) {
    const m = /const\s+SCHEMA_VERSION\s*=\s*(\d+)/.exec(show.stdout);
    if (m) {
      const actualShipped = Number(m[1]);
      if (actualShipped !== declaredSchema) {
        fail(
          `manifest declares ${declaredTag} ships schema ${declaredSchema}, but that tag's `
          + `electron/store/db.ts actually has SCHEMA_VERSION=${actualShipped}. Fix the declaration in `
          + `${path.relative(ROOT, MANIFEST_PATH)} — it is stale or was never verified.`,
        );
      }
      console.log(`ok   ${declaredTag} cross-checked against agentlas_desktop: ships schema ${actualShipped}`);
    } else {
      console.log(`note could not find SCHEMA_VERSION in ${declaredTag}:electron/store/db.ts — skipping cross-check`);
    }
  } else {
    console.log(`note git tag ${declaredTag} not found in ${DESKTOP_REPO} — skipping cross-check (fetch tags to verify)`);
  }
} else {
  console.log(`note no agentlas_desktop checkout at ${DESKTOP_REPO} — skipping cross-check, trusting the declared manifest`);
}

console.log(`required schema (vendored core / engine/bootstrap-schema.sql): v${required}`);
console.log(`declared shipped schema (${declaredTag}): v${declaredSchema}`);

if (required > declaredSchema) {
  fail(
    `the vendored core requires store schema v${required}, but the terminal only declares ${declaredTag} `
    + `(schema v${declaredSchema}) as already shipped to users. Publishing this terminal core now would `
    + `AGENTLAS_STORE_SCHEMA_TOO_OLD-block every user on ${declaredTag}. Ship the Desktop release carrying `
    + `schema v${required} first (release-signed-mac.yml), then update desktopCompatibleRelease/`
    + `desktopCompatibleSchemaVersion in ${path.relative(ROOT, MANIFEST_PATH)}, before publishing this core.`,
  );
}

console.log(`PASS desktop-release-order: required v${required} <= declared shipped v${declaredSchema} (${declaredTag})`);
