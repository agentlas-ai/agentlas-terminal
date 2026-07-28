"use strict";
/*
 * version — 터미널 버전과 함께 **지금 붙어 있는 Agentlas-OS Core** 를 보고한다.
 *
 * 왜 Core 도 같이 찍나 (2026-07-28):
 *   터미널의 계약 표면(build/upload/workforce/context/…)은 Core 릴리스가 소유한다.
 *   Core 는 스스로 갱신되고(agentlas_cloud/update.py), 셸은 그때그때 해석된 루트에
 *   붙는다. 그런데 `version`·`--where`·`doctor` 어디에서도 Core 를 찍지 않아서,
 *   사용자도 지원 담당도 **어떤 Core 위에서 돌고 있는지 알 방법이 없었다**.
 *   "최신인데 안 맞는다" 류의 오진이 그 공백에서 나온다. 붙은 대상을 보여주는 것이
 *   진단의 출발점이다.
 *
 * Core 가 없어도 실패하지 않는다 — 56개 명령은 Core 없이 동작한다. 없으면 없다고
 * 정직하게 적는다(조용한 생략 금지).
 */
const { readVersion } = require("../agentlas-banner.cjs");

function coreLine() {
  try {
    const core = require("../agentlas-core-harness.cjs");
    const root = core.resolveCoreRuntimeRoot();
    if (!root) return "agentlas-os  not attached (install: hephaestus update)";
    const version = core.readCoreRuntimeVersion(root);
    // 버전을 못 읽는 루트는 "낡음"이 아니라 "모름"이다. 두 상태를 구분해 적는다 —
    // 모름을 그럴듯한 값으로 메꾸면 그 순간 진단이 거짓이 된다.
    return `agentlas-os  ${version || "unknown version"}  (${root})`;
  } catch (error) {
    return `agentlas-os  unavailable (${(error && error.message) || error})`;
  }
}

function run(ctx) {
  ctx.out(`agentlas ${readVersion()}`);
  ctx.out(coreLine());
  return 0;
}

module.exports = { run };
