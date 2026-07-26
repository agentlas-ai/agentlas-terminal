"use strict";
/*
 * billing — 크레딧 잔액 조회: agentlas billing
 *
 * 데스크탑 electron/billing.ts 와 같은 엔드포인트를 읽는다:
 *   GET {web}/api/billing/credits — 두 계좌 정책:
 *   · 구독 계좌(A): remainingCredits — 월 초기화 + 톱업 + 전송받은 렌트수익. 사용 가능.
 *   · 렌트수익 계좌(B): earningsCredits — 내 업로드를 남이 빌려 쓸 때만 쌓임.
 *   · 전송은 B → A 한 방향뿐이며 터미널에는 전송 명령이 없다(데스크탑 전용) —
 *     조용히 숨기지 않고 help/출력에 명시한다.
 *
 * 인증: cloud/hub-client.cjs 의 세션 쿠키. 미로그인/세션 만료는 정직 exit 1 —
 * 빈 잔액(0)으로 위장 출력하지 않는다(조용한 기본값 안티패턴 금지).
 */
const { cloudSessionCookie, fetchHub, webBaseUrl, parseHubJson } = require("../cloud/hub-client.cjs");

function fmtCredits(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

function usage(ko) {
  return [
    ko ? "사용법: agentlas billing" : "Usage: agentlas billing",
    ko
      ? "  구독 계좌(A)와 렌트수익 계좌(B) 잔액을 표시합니다."
      : "  Shows the subscription account (A) and rental-earnings account (B) balances.",
    ko
      ? "  참고: 렌트수익(B) → 구독(A) 전송은 Agentlas Desktop 에서만 가능합니다 (터미널 전송 명령 없음)."
      : "  Note: earnings (B) → subscription (A) transfer is Desktop-only (no transfer command in the terminal).",
  ].join("\n");
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (args.some((a) => a === "--help" || a === "-h" || a === "help")) {
    ctx.out(usage(ko));
    return 0;
  }

  const cookie = await cloudSessionCookie();
  if (!cookie) {
    ctx.err(ko
      ? "로그인이 필요합니다. `agentlas login` 을 먼저 실행하세요."
      : "Not signed in. Run `agentlas login` first.");
    return 1;
  }

  let resp;
  try {
    resp = await fetchHub(`${webBaseUrl()}/api/billing/credits`, { headers: { cookie } });
  } catch (e) {
    ctx.err((ko ? "크레딧 조회 실패: " : "Failed to fetch credits: ") + ((e && e.message) || e));
    return 1;
  }
  // 401 = 세션 무효 — 데스크탑과 동일하게 미인증으로 강등한다(만료 세션으로 잔액 표시 금지).
  if (resp.status === 401) {
    ctx.err(ko
      ? "세션이 만료되었습니다. `agentlas login` 으로 다시 로그인하세요."
      : "Session expired. Sign in again with `agentlas login`.");
    return 1;
  }
  if (!resp.ok) {
    ctx.err((ko ? "크레딧 조회 실패: " : "Failed to fetch credits: ") + `HTTP ${resp.status}`);
    return 1;
  }

  let balance;
  try {
    balance = parseHubJson(resp, "billing/credits");
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  if (!balance || balance.authenticated === false) {
    ctx.err(ko
      ? "세션이 유효하지 않습니다. `agentlas login` 으로 다시 로그인하세요."
      : "Session is not valid. Sign in again with `agentlas login`.");
    return 1;
  }

  const a = ctx.ui.accent;
  const dim = ctx.ui.dim;
  if (balance.plan) ctx.out(`${ko ? "플랜" : "Plan"}: ${balance.plan}`);
  ctx.out(`${a(ko ? "구독 계좌 (A)" : "Subscription account (A)")}: ${fmtCredits(balance.remainingCredits)} ${ko ? "크레딧" : "credits"}`);
  if (balance.limitCredits != null || balance.usedCredits != null) {
    ctx.out(dim(`  ${ko ? "사용" : "used"}: ${fmtCredits(balance.usedCredits)} / ${ko ? "한도" : "limit"}: ${fmtCredits(balance.limitCredits != null ? balance.limitCredits : balance.planCreditLimit)}${balance.topUpCredits ? `  (+${ko ? "톱업" : "top-up"} ${fmtCredits(balance.topUpCredits)})` : ""}`));
  }
  ctx.out(`${a(ko ? "렌트수익 계좌 (B)" : "Rental earnings account (B)")}: ${fmtCredits(balance.earningsCredits)} ${ko ? "크레딧" : "credits"}`);
  ctx.out(dim(ko
    ? "B → A 전송은 Agentlas Desktop 에서만 가능합니다 (터미널 전송 명령 없음)."
    : "B → A transfer is Desktop-only (no transfer command in the terminal)."));
  return 0;
}

module.exports = { run };
