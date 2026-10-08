"use strict";
/*
 * billing — active usage and historical earnings: agentlas billing
 *
 * GET /api/billing/credits is the active hosted usage balance. Historical
 * creator earnings must be read from GET /api/billing/earnings, never inferred
 * from the spendable balance. New settlement and ledger transfers are closed.
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
      ? "  현재 월 제공량을 표시합니다."
      : "  Shows the current monthly allowance.",
    ko
      ? "  과거 구매 잔액이 있으면 표시합니다."
      : "  Shows any remaining past purchases.",
    ko
      ? "  과거 창작자 수익을 별도로 표시합니다."
      : "  Shows historical creator earnings separately.",
  ].join("\n");
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    ctx.out(usage(ko));
    return 0;
  }
  if (args.length) {
    const error = new Error(usage(ko).split("\n")[0]);
    error.code = "INVALID_ARGUMENT";
    throw error;
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
  if (balance.monthlyRemainingCredits != null && balance.planCreditLimit != null) {
    ctx.out(`${a(ko ? "월 제공량" : "Monthly allowance")}: ${fmtCredits(balance.monthlyRemainingCredits)} / ${fmtCredits(balance.planCreditLimit)} ${ko ? "크레딧" : "credits"}`);
    if (Number(balance.additionalUsageCredits) > 0) {
      ctx.out(`${a(ko ? "과거 구매 잔액" : "Legacy purchased usage")}: ${fmtCredits(balance.additionalUsageCredits)} ${ko ? "크레딧" : "credits"}`);
    }
    ctx.out(dim(`${ko ? "사용 가능" : "Available"}: ${fmtCredits(balance.remainingCredits)} ${ko ? "크레딧" : "credits"}`));
  } else {
    // Older server responses expose only the combined balance.
    ctx.out(`${a(ko ? "사용 가능" : "Available")}: ${fmtCredits(balance.remainingCredits)} ${ko ? "크레딧" : "credits"}`);
  }

  // Historical earnings are read-only and do not contribute to "Available".
  let earningsResponse;
  try {
    earningsResponse = await fetchHub(`${webBaseUrl()}/api/billing/earnings`, { headers: { cookie } });
  } catch (error) {
    ctx.err((ko ? "과거 수익 조회 실패: " : "Failed to fetch historical earnings: ") + ((error && error.message) || error));
    return 1;
  }
  if (earningsResponse.status === 401) {
    ctx.err(ko ? "세션이 만료되었습니다. `agentlas login` 으로 다시 로그인하세요." : "Session expired. Sign in again with `agentlas login`.");
    return 1;
  }
  if (!earningsResponse.ok) {
    ctx.err((ko ? "과거 수익 조회 실패: " : "Failed to fetch historical earnings: ") + `HTTP ${earningsResponse.status}`);
    return 1;
  }
  let earnings;
  try {
    earnings = parseHubJson(earningsResponse, "billing/earnings");
  } catch (error) {
    ctx.err(String((error && error.message) || error));
    return 1;
  }
  if (!earnings || earnings.authenticated === false || earnings.earningsCredits == null || !Number.isFinite(Number(earnings.earningsCredits))) {
    ctx.err(ko ? "과거 수익 응답을 확인할 수 없습니다." : "Historical earnings response is unavailable.");
    return 1;
  }
  ctx.out(`${a(ko ? "과거 창작자 수익" : "Historical creator earnings")}: ${fmtCredits(earnings.earningsCredits)} ${ko ? "크레딧" : "credits"}`);
  return 0;
}

module.exports = { run };
