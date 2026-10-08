"use strict";

const { cloudSessionCookie } = require("../cloud/auth.cjs");
const { fetchHub, parseHubJson, webBaseUrl } = require("../cloud/hub-client.cjs");

const PROJECT_AGENT_GRANT_MAX_AGE_MS = 10_000;

function entitlementError(code, message) {
  return Object.assign(new Error(message), { code, honestStop: true });
}

/** Only the signed-in Web workspace may grant additional project capacity. */
async function freshProjectAgentLimit() {
  const cookie = cloudSessionCookie();
  if (!cookie) {
    throw entitlementError("project-agent-sign-in-required", "Sign in with `agentlas login` before adding project agents or teams.");
  }
  let response;
  try {
    response = await fetchHub(`${webBaseUrl()}/api/billing/credits`, {
      headers: { cookie },
    }, { timeoutConfig: { connectMs: 8_000, idleMs: 8_000, totalMs: 8_000 } });
  } catch {
    throw entitlementError("project-agent-entitlement-unavailable", "Could not verify your project agent limit. Check your connection and retry.");
  }
  if (response.status === 401 || response.status === 403) {
    throw entitlementError("project-agent-sign-in-required", "Your session expired. Sign in again with `agentlas login`.");
  }
  if (!response.ok) {
    throw entitlementError("project-agent-entitlement-unavailable", "Could not verify your project agent limit. Check your connection and retry.");
  }
  let balance;
  try { balance = parseHubJson(response, "billing/credits"); }
  catch {
    throw entitlementError("project-agent-entitlement-unavailable", "The project agent limit response was invalid. Retry when Agentlas Cloud is available.");
  }
  if (!balance || balance.authenticated !== true) {
    throw entitlementError("project-agent-sign-in-required", "Your session is not valid. Sign in again with `agentlas login`.");
  }
  const limit = balance.entitlements?.projectAgents;
  if (balance.error || !Number.isSafeInteger(limit) || limit < 0 || limit > 32) {
    throw entitlementError("project-agent-entitlement-unavailable", "The current plan's project agent limit is unavailable. Retry when Agentlas Cloud is available.");
  }
  return Object.freeze({ limit, checkedAtMs: Date.now() });
}

function assertFreshProjectAgentLimit(grant, count) {
  if (!grant || Date.now() - grant.checkedAtMs > PROJECT_AGENT_GRANT_MAX_AGE_MS) {
    throw entitlementError("project-agent-entitlement-unavailable", "Could not verify a fresh project agent limit. Retry the command.");
  }
  if (count > grant.limit) {
    throw entitlementError("project-agent-limit-reached", `Your plan allows ${grant.limit} agents and teams per project (${count} selected). Remove members or change plans.`);
  }
}

module.exports = { freshProjectAgentLimit, assertFreshProjectAgentLimit };
