"use strict";
/*
 * update — npm 레지스트리에서 새 agentlas 확인.
 *
 * v2 경계: 이 CLI는 자기 자신(npm 패키지)만 업데이트 안내한다. v1이 여기 섞어놓았던
 * 데스크탑 .app 다운로드/서명검증/교체기는 데스크탑 제품 소관으로 반환했다
 * (터미널에서 hdiutil로 앱을 갈아끼우는 코드는 관심사 혼합의 대표 사례였다).
 * 버전 비교는 반드시 compareSemVer — 문자열 비교는 0.9.10 < 0.9.9 오판을 낳는다.
 */
const { compareSemVer } = require("../semver.cjs");
const { readVersion } = require("../agentlas-banner.cjs");

async function checkNpmLatest({ fetch: fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const currentVersion = readVersion();
  let latestVersion = null;
  try {
    const resp = await f("https://registry.npmjs.org/agentlas/latest", { headers: { accept: "application/json" } });
    if (resp.ok) latestVersion = String((await resp.json()).version || "");
  } catch { /* offline 등 — 호출부에서 안내 */ }
  const comparison = latestVersion ? compareSemVer(currentVersion, latestVersion) : null;
  return {
    currentVersion,
    latestVersion,
    updateAvailable: comparison == null ? null : comparison < 0,
    channel: "npm",
  };
}

async function run(ctx, args) {
  const json = args.includes("--json");
  const status = await checkNpmLatest();
  if (json) {
    ctx.out(JSON.stringify(status, null, 2));
    return 0;
  }
  ctx.out(`Current version: ${status.currentVersion}`);
  if (!status.latestVersion) {
    ctx.out("Could not check the latest version on the npm registry (offline or not published yet).");
    ctx.out("Manual update: npm i -g agentlas@latest");
    return 0;
  }
  ctx.out(`Latest version: ${status.latestVersion}`);
  if (status.updateAvailable == null) {
    ctx.out("Could not compare version formats. Manual update: npm i -g agentlas@latest");
  } else if (status.updateAvailable) {
    ctx.out("Update: npm i -g agentlas@latest");
  } else {
    ctx.out("Already on the latest version.");
  }
  return 0;
}

module.exports = { run, checkNpmLatest };
