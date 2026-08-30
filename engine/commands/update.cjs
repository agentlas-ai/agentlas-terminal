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

async function checkNpmLatest({ fetch: fetchImpl, timeoutMs = 8_000 } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const currentVersion = readVersion();
  let latestVersion = null;
  const controller = new AbortController();
  const boundedTimeoutMs = Math.min(60_000, Math.max(10, Number(timeoutMs) || 8_000));
  let timeout;
  try {
    // Bound both the connection and body parse. Some injected/custom fetch
    // implementations ignore AbortSignal, so the explicit race is required to
    // keep `agentlas update` from hanging the entire CLI indefinitely.
    const request = Promise.resolve().then(async () => {
      const resp = await f("https://registry.npmjs.org/agentlas/latest", {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      return resp.ok ? String((await resp.json()).version || "") : null;
    });
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`npm update check timed out after ${boundedTimeoutMs}ms`);
        error.code = "AGENTLAS_UPDATE_TIMEOUT";
        try { controller.abort(error); } catch { controller.abort(); }
        reject(error);
      }, boundedTimeoutMs);
    });
    latestVersion = await Promise.race([request, expired]);
  } catch { /* offline/timeout 등 — 호출부에서 안내 */ }
  finally { if (timeout) clearTimeout(timeout); }
  const comparison = latestVersion ? compareSemVer(currentVersion, latestVersion) : null;
  return {
    currentVersion,
    latestVersion,
    updateAvailable: comparison == null ? null : comparison < 0,
    channel: "npm",
  };
}

async function run(ctx, args, deps = {}) {
  if (args.some((arg) => arg !== "--json") || args.filter((arg) => arg === "--json").length > 1) {
    const error = new Error("usage: agentlas update [--json]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const json = ctx.output?.format === "json" || args.includes("--json");
  const status = await checkNpmLatest(deps);
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
