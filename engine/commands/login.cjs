"use strict";
/*
 * login — Agentlas Cloud 로그인 (데스크탑과 동일한 loopback 브라우저 플로우).
 * 웹 /account?desktop=1&callback=<loopback+state> 이 유효 세션이면 callback의 state를
 * 보존한 채 session을 추가해 302한다. Terminal은 state를 1회 검증한 뒤에만 저장한다.
 * 보안 속성(1회용 state guard, GET-only, no-store)은 cloud/auth.cjs 가 소유한다.
 */
const auth = require("../cloud/auth.cjs");

async function run(ctx, args = []) {
  const ko = ctx.lang === "ko";
  const force = args.includes("--force");
  if (!force) {
    const existing = auth.cloudSessionCookie();
    if (existing) {
      try {
        const j = await auth.fetchSessionMeta(existing);
        if (j && j.authenticated) {
          ctx.out(ko
            ? `이미 로그인되어 있습니다 (${(j.user && j.user.email) || "?"}). 다시 인증하려면: agentlas login --force`
            : `Already signed in (${(j.user && j.user.email) || "?"}). Re-authenticate with agentlas login --force`);
          return 0;
        }
      } catch { /* 확인 실패 — 새로 로그인 진행 */ }
    }
  }

  let value;
  try {
    value = await auth.waitForLoopbackSession({
      onLoginUrl(url) {
        ctx.out(ko
          ? "브라우저에서 Agentlas에 로그인하세요 (자동으로 열립니다):"
          : "Sign in to Agentlas in the browser (opening automatically):");
        ctx.out("  " + ctx.ui.accent(url));
        auth.openInBrowser(url);
      },
    });
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }

  const p = auth.saveCliSession(value);
  ctx.out((ko ? "세션 저장됨: " : "Session saved: ") + ctx.ui.dim(p));

  // 저장 직후 세션 유효성 확인 (whoami 와 동일한 출력 — 명령끼리 참조 금지 규칙 때문에 인라인)
  try {
    const j = await auth.fetchSessionMeta(auth.cloudSessionCookie());
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
  } catch (e) {
    ctx.err((ko ? "세션 확인 실패: " : "Session check failed: ") + String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
