#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { create, _test } = require("../engine/agentlas-parity.cjs");

const parity = create({});

function startAttempt(options = {}) {
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = parity.waitForLoopbackSession({
    baseUrl: "https://agentlas.cloud",
    timeoutMs: options.timeoutMs || 1_000,
    onLoginUrl(url) {
      readyResolve(url);
    },
  });
  void result.catch((error) => readyReject(error));
  return { ready, result };
}

function callbackFromLoginUrl(loginUrl) {
  const login = new URL(loginUrl);
  assert.equal(login.origin, "https://agentlas.cloud");
  assert.equal(login.pathname, "/account");
  assert.equal(login.searchParams.get("desktop"), "1");
  const rawCallback = login.searchParams.get("callback");
  assert.ok(rawCallback, "Hub login URL must carry the loopback callback");
  const callback = new URL(rawCallback);
  assert.equal(callback.hostname, "127.0.0.1");
  assert.equal(callback.pathname, "/callback");
  assert.match(callback.searchParams.get("state") || "", /^[A-Za-z0-9_-]{43}$/);
  return callback;
}

async function readResponse(response) {
  await response.text();
  return response;
}

async function main() {
  const stateA = _test.createLoginState();
  const stateB = _test.createLoginState();
  assert.match(stateA, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stateA, stateB, "each login must use a fresh cryptographic state nonce");

  // Pure transaction guard: exact path only, valid response consumes once, replay is rejected.
  const guard = _test.createLoginCallbackGuard(stateA);
  assert.equal(guard.consume(`/callback-extra?state=${stateA}&session=evil`).statusCode, 404);
  assert.equal(guard.isConsumed(), false, "unrelated paths must not consume the transaction");
  assert.equal(guard.consume(`/callback?state=${stateA}&session=first`).value, "first");
  assert.equal(guard.isConsumed(), true);
  assert.equal(guard.consume(`/callback?state=${stateA}&session=second`).statusCode, 410, "callback replay must fail");

  const mismatchGuard = _test.createLoginCallbackGuard(stateB);
  const mismatch = mismatchGuard.consume(`/callback?state=wrong&session=attacker`);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /state/);
  assert.equal(mismatchGuard.consume(`/callback?state=${stateB}&session=late`).statusCode, 410, "state mismatch must close the transaction");

  const errorGuard = _test.createLoginCallbackGuard(stateB);
  assert.match(errorGuard.consume(`/callback?state=${stateB}&error=access_denied`).message, /access_denied/);
  const missingGuard = _test.createLoginCallbackGuard(stateB);
  assert.match(missingGuard.consume(`/callback?state=${stateB}`).message, /session/);
  const tokenGuard = _test.createLoginCallbackGuard(stateB);
  assert.equal(tokenGuard.consume(`/callback?state=${stateB}&token=legacy-compatible`).value, "legacy-compatible");

  // Real loopback server: unrelated path and non-GET do not consume; correct callback succeeds.
  const success = startAttempt();
  const successCallback = callbackFromLoginUrl(await success.ready);
  const unrelated = new URL("/callback-extra", successCallback.origin);
  unrelated.searchParams.set("state", successCallback.searchParams.get("state"));
  unrelated.searchParams.set("session", "evil");
  assert.equal((await readResponse(await fetch(unrelated))).status, 404);
  assert.equal((await readResponse(await fetch(successCallback, { method: "POST" }))).status, 405);
  successCallback.searchParams.set("session", "valid-hub-session");
  const successResponse = await readResponse(await fetch(successCallback));
  assert.equal(successResponse.status, 200);
  assert.match(successResponse.headers.get("cache-control") || "", /no-store/);
  assert.equal(await success.result, "valid-hub-session");

  // A forged state is never persisted and terminates this login attempt.
  const forged = startAttempt();
  const forgedCallback = callbackFromLoginUrl(await forged.ready);
  forgedCallback.searchParams.set("state", "forged-state");
  forgedCallback.searchParams.set("session", "attacker-session");
  assert.equal((await readResponse(await fetch(forgedCallback))).status, 400);
  await assert.rejects(forged.result, /state/);

  // Hub/OAuth errors with the correct state also fail closed.
  const denied = startAttempt();
  const deniedCallback = callbackFromLoginUrl(await denied.ready);
  deniedCallback.searchParams.set("error", "access_denied");
  deniedCallback.searchParams.set("error_description", "must-not-be-reflected");
  const deniedResponse = await readResponse(await fetch(deniedCallback));
  assert.equal(deniedResponse.status, 400);
  await assert.rejects(denied.result, /access_denied/);

  // Timeout closes the listener and never returns a session.
  const timedOut = startAttempt({ timeoutMs: 25 });
  callbackFromLoginUrl(await timedOut.ready);
  await assert.rejects(timedOut.result, /Login timed out/);

  console.log("login-loopback-security: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
