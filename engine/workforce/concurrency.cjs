"use strict";
/*
 * workforce/concurrency — 워크포스 워커 동시 실행 수(스웜 크기)의 사양 기반 추천값.
 *
 * 워커 1명 = captureRuntime을 통해 스폰되는 실제 CLI 자식 프로세스(engine/workforce/
 * capture.cjs)다. 이전에는 사용자가 --parallel/-n을 안 주면 컴퓨터 사양과 무관하게
 * 고정 3(상한 8)을 썼다 — 코어 2개짜리 저사양 기기에서 3개 CLI 자식이 한꺼번에 뜨면
 * 과다 산정, 32코어 워크스테이션에서도 항상 3으로 저평가되는 양방향 문제였다.
 *
 * 데스크탑(electron/store/concurrency.ts)과 동일한 원리(코어 2개는 OS/자식 자신에게
 * 남기고, 에이전트당 RAM ~2GB + 여유 4GB로 추정)를 쓰되, 상한(HARD_MAX)은 터미널
 * 자체의 기존 안전선(8)을 그대로 유지한다 — 이건 provider가 바뀌어도 변하지 않는
 * Agentlas 자체 정책 상수이지, 하드코딩 금지 대상인 "외부에서 바뀌는 값"이 아니다.
 */
const os = require("node:os");

const HARD_MAX = 8;

function getSystemSpecs() {
  let cores = 4;
  let totalMemGB = 8;
  try {
    cores = Math.max(1, os.cpus().length);
  } catch {
    // fall back
  }
  try {
    totalMemGB = os.totalmem() / 1024 ** 3;
  } catch {
    // fall back
  }
  return { cores, totalMemGB };
}

function recommendedConcurrency(specs = getSystemSpecs()) {
  const coreBound = Math.max(1, specs.cores - 2);
  const memBound = Math.max(1, Math.floor((specs.totalMemGB - 4) / 2));
  return Math.max(1, Math.min(coreBound, memBound, HARD_MAX));
}

module.exports = { HARD_MAX, getSystemSpecs, recommendedConcurrency };
