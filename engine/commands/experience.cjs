"use strict";
/*
 * experience — Portable Experience Bundle 교환 표면
 *   (list|inspect|validate|save|publish|status|export|unpublish|withdraw,
 *    legacy-* 는 pack-only 로컬 의도 저장소).
 *
 * 복원된 계약 모듈 engine/agentlas-experience-exchange.cjs 가 전 로직을 소유하고,
 * 이 파일은 v1 모놀리스 디스패치가 하던 의존성 주입만 재현한다:
 *   getSessionCookie/fetchHub ← engine/cloud/hub-client.cjs (v1 D-bag의
 *   cloudSessionCookieCli/fetchHubCli 대응), legacyCommand ← experience/intents.
 * 폴백 없음: 서버 refusal/검증 실패 문구는 그대로 표면화된다(엔진이 stderr로
 * 출력하고 exit 1).
 */
const { userDataDir } = require("../core/paths.cjs");

async function run(ctx, args) {
  const { cmdExperienceExchange } = require("../agentlas-experience-exchange.cjs");
  const intents = require("../experience/intents.cjs");
  const { cloudSessionCookie, fetchHub } = require("../cloud/hub-client.cjs");
  await cmdExperienceExchange({
    args,
    userDataDir: userDataDir(),
    cwd: process.cwd(),
    out: ctx.out,
    env: process.env,
    getSessionCookie: cloudSessionCookie,
    // fetchHub 3중 타임아웃/16MB 상한 강화판을 그대로 사용(v1 timeout-regression 계약).
    fetchHub: (url, init) => fetchHub(url, init),
    legacyCommand: (legacyOptions) => intents.cmdExperience(legacyOptions),
  });
  return 0;
}

module.exports = { run };
