"use strict";
/*
 * whoami — Agentlas Cloud 세션 상태 확인.
 * 네트워크 계약: GET <web>/api/auth/session (cookie 헤더). 서명 아웃/만료는 exit 1.
 */
const auth = require("../cloud/auth.cjs");

async function run(ctx) {
  const ko = ctx.lang === "ko";
  const cookie = auth.cloudSessionCookie();
  if (!cookie) {
    ctx.out(ko
      ? "로그아웃 상태입니다. `agentlas login`으로 로그인하세요."
      : "You are signed out. Sign in with agentlas login.");
    return 1;
  }
  let j;
  try {
    j = await auth.fetchSessionMeta(cookie);
  } catch (e) {
    ctx.err((ko ? "세션 확인 실패: " : "Session check failed: ") + String((e && e.message) || e));
    return 1;
  }
  if (j && j.authenticated) {
    const email = (j.user && j.user.email) || "?";
    const ws = j.workspace || {};
    ctx.out(ko
      ? `로그인됨: ${ctx.ui.bold(email)}  ·  작업 공간: ${ws.name || "?"} (${ws.plan || "free"})`
      : `Signed in: ${ctx.ui.bold(email)}  ·  workspace: ${ws.name || "?"} (${ws.plan || "free"})`);
    return 0;
  }
  ctx.out(ko
    ? "세션이 만료되었거나 유효하지 않습니다. `agentlas login`으로 다시 로그인하세요."
    : "The session is expired or invalid. Sign in again with agentlas login.");
  return 1;
}

module.exports = { run };
