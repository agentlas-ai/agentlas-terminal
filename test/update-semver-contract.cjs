"use strict";
/*
 * update 명령의 SemVer 계약 (v1 semver-precedence 후계).
 * 핵심: 0.9.10 vs 0.9.9 는 문자열이 아니라 SemVer로 비교돼야 한다.
 * fetch 주입으로 오프라인 검증.
 */
const assert = require("node:assert/strict");
const { checkNpmLatest } = require("../engine/commands/update.cjs");
const { compareSemVer } = require("../engine/semver.cjs");

function fakeFetch(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

(async () => {
  // SemVer 유틸 자체의 자리수 함정
  assert.equal(compareSemVer("0.9.9", "0.9.10"), -1, "0.9.9 < 0.9.10");
  assert.equal(compareSemVer("0.9.10", "0.9.9"), 1, "0.9.10 > 0.9.9");

  const current = require("../engine/agentlas-banner.cjs").readVersion();

  const same = await checkNpmLatest({ fetch: fakeFetch(current) });
  assert.equal(same.updateAvailable, false, "same version → no update");

  const newer = await checkNpmLatest({ fetch: fakeFetch("999.0.0") });
  assert.equal(newer.updateAvailable, true, "newer on npm → update available");

  const older = await checkNpmLatest({ fetch: fakeFetch("0.0.1") });
  assert.equal(older.updateAvailable, false, "older on npm → no downgrade prompt");

  const offline = await checkNpmLatest({ fetch: async () => { throw new Error("offline"); } });
  assert.equal(offline.latestVersion, null, "offline → honest null, no fake latest");
  assert.equal(offline.updateAvailable, null);

  const garbage = await checkNpmLatest({ fetch: fakeFetch("not-a-version") });
  assert.equal(garbage.updateAvailable, null, "unparseable latest → null, not false-positive");

  console.log("update-semver-contract: OK");
})().catch((e) => { console.error(e); process.exit(1); });
