"use strict";
/*
 * logout — CLI 세션 파일 삭제. 네트워크 호출 없음(서버 세션은 웹에서 관리).
 * AGENTLAS_SESSION env 는 파일과 별개 경로라 삭제 후에도 로그인 상태로 보일 수 있다 — 경고만 한다.
 */
const auth = require("../cloud/auth.cjs");

function run(ctx) {
  const ko = ctx.lang === "ko";
  let result;
  try {
    result = auth.deleteCliSession();
  } catch (e) {
    ctx.err((ko ? "세션 파일을 삭제하지 못했습니다: " : "Could not delete the session file: ") + String((e && e.message) || e));
    return 1;
  }
  ctx.out(result.existed
    ? (ko ? "로그아웃되었습니다 (CLI 세션 삭제)." : "Signed out (CLI session deleted).")
    : (ko ? "저장된 CLI 세션이 없습니다." : "No saved CLI session."));
  if (process.env.AGENTLAS_SESSION) {
    ctx.out(ko
      ? "경고: AGENTLAS_SESSION 이 아직 설정되어 있어 CLI가 로그인 상태로 보일 수 있습니다."
      : "Warning: AGENTLAS_SESSION is still set, so the CLI may appear signed in.");
  }
  return 0;
}

module.exports = { run };
