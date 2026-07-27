#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  captureRuntime,
  capturedRuntimeUsage,
  captureOutputLimit,
  isProtectedChildEnvKeyCli,
  runApi,
} = require("../engine/workforce/capture.cjs");

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.ignoreTerm = !!options.ignoreTerm;
    this.ignoreKill = !!options.ignoreKill;
    this.closed = false;
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    if (signal === "SIGKILL" && this.ignoreKill) return true;
    this.finish(null, signal);
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

function capture(child, options = {}) {
  return captureRuntime("gemini", "system", "prompt", {
    cwd: process.cwd(),
    permission: "read",
    env: {},
    timeoutConfig: options.timeoutConfig || { idleMs: 40, totalMs: 300, killGraceMs: 15 },
    outputLimitBytes: options.outputLimitBytes || 1_024,
    signal: options.signal,
    envelope: options.envelope,
    spawn: () => child,
  });
}

async function main() {
  assert.equal(captureOutputLimit({ AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES: "NaN" }), 4 * 1024 * 1024);
  assert.equal(captureOutputLimit({ AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES: "-1" }), 64 * 1024);
  assert.equal(captureOutputLimit({ AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES: "999999999999" }), 32 * 1024 * 1024);
  for (const key of [
    "AGENTLAS_NATIVE_IDLE_TIMEOUT_MS",
    "AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS",
    "AGENTLAS_NATIVE_KILL_GRACE_MS",
    "AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES",
  ]) {
    assert.equal(isProtectedChildEnvKeyCli(key), true, `${key} must not be overridden by a project .env`);
  }

  const streaming = new FakeChild();
  const streamingRun = capture(streaming, { timeoutConfig: { idleMs: 35, totalMs: 250, killGraceMs: 15 } });
  ["one", "two", "three", "four"].forEach((value, index) => {
    setTimeout(() => streaming.stdout.write(value), 15 + index * 20);
  });
  setTimeout(() => streaming.finish(0), 110);
  assert.equal(await streamingRun, "onetwothreefour", "regular output must keep the capture idle timer alive");
  assert.deepEqual(streaming.signals, []);

  assert.deepEqual(capturedRuntimeUsage("claude-code", JSON.stringify({
    type: "result",
    result: "ok",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      output_tokens: 5,
    },
  })), { inputTokens: 17, outputTokens: 5 });
  assert.deepEqual(capturedRuntimeUsage("codex", JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 7 },
  })), { inputTokens: 20, outputTokens: 7 });
  assert.deepEqual(capturedRuntimeUsage("gemini", JSON.stringify({
    type: "result",
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
  })), { inputTokens: 12, outputTokens: 6 });
  assert.equal(capturedRuntimeUsage("codex", JSON.stringify({
    type: "turn.completed",
    usage: { output_tokens: 7 },
  })), null, "one-sided provider usage must remain unobserved");

  const metered = new FakeChild();
  const meteredRun = capture(metered, { envelope: true });
  metered.stdout.write(JSON.stringify({
    type: "result",
    response: "metered",
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
  }));
  metered.finish(0);
  assert.deepEqual(await meteredRun, {
    text: "metered",
    usage: { inputTokens: 9, outputTokens: 4 },
  });

  const ollama = await runApi("ollama", "qwen", "system", "prompt", {
    envelope: true,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        message: { content: "local" },
        prompt_eval_count: 11,
        eval_count: 3,
      }),
    }),
  });
  assert.deepEqual(ollama, {
    text: "local",
    usage: { inputTokens: 11, outputTokens: 3 },
  });

  // BYOK 프롬프트 캐시 계약: 진짜 Anthropic만 system을 cache_control 블록 배열로
  // 보낸다. 호환 엔드포인트(GLM 등)는 문자열 유지 — 추가 필드를 거부할 수 있다.
  const anthropicBodies = [];
  await runApi("anthropic", "claude-haiku-4-5", "stable system prefix", "prompt", {
    apiKey: "key-test",
    fetch: async (_url, init) => {
      anthropicBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ content: [{ text: "cached" }], usage: { input_tokens: 5, output_tokens: 2 } }) };
    },
  });
  assert.deepEqual(anthropicBodies[0].system, [
    { type: "text", text: "stable system prefix", cache_control: { type: "ephemeral" } },
  ], "real Anthropic must receive the system prefix as one ephemeral cache breakpoint");

  const compatBodies = [];
  await runApi("glm", "glm-4.6", "stable system prefix", "prompt", {
    apiKey: "key-test",
    fetch: async (_url, init) => {
      compatBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ content: [{ text: "compat" }], usage: { input_tokens: 5, output_tokens: 2 } }) };
    },
  });
  assert.strictEqual(compatBodies[0].system, "stable system prefix",
    "Anthropic-compatible endpoints must keep the plain string system field");

  const silent = new FakeChild({ ignoreTerm: true });
  await assert.rejects(
    capture(silent, { timeoutConfig: { idleMs: 30, totalMs: 250, killGraceMs: 15 } }),
    (error) => error && error.code === "AGENTLAS_CAPTURE_IDLE_TIMEOUT",
  );
  assert.deepEqual(silent.signals, ["SIGTERM", "SIGKILL"]);

  const active = new FakeChild({ ignoreTerm: true });
  const activeRun = capture(active, { timeoutConfig: { idleMs: 35, totalMs: 85, killGraceMs: 15 } });
  const activity = setInterval(() => active.stderr.write("progress\n"), 12);
  await assert.rejects(activeRun, (error) => error && error.code === "AGENTLAS_CAPTURE_TOTAL_TIMEOUT");
  clearInterval(activity);
  assert.deepEqual(active.signals, ["SIGTERM", "SIGKILL"], "total timeout caps an otherwise active capture");

  const noisy = new FakeChild();
  const noisyRun = capture(noisy, {
    outputLimitBytes: 128,
    timeoutConfig: { idleMs: 200, totalMs: 300, killGraceMs: 15 },
  });
  noisy.stdout.write(Buffer.alloc(512, 0x61));
  await assert.rejects(noisyRun, (error) => error && error.code === "AGENTLAS_CAPTURE_OUTPUT_LIMIT");
  assert.deepEqual(noisy.signals, ["SIGTERM"], "output overflow should stop immediately without retaining unbounded data");

  const cancellable = new FakeChild();
  const controller = new AbortController();
  const cancelRun = capture(cancellable, {
    signal: controller.signal,
    timeoutConfig: { idleMs: 200, totalMs: 300, killGraceMs: 15 },
  });
  setTimeout(() => controller.abort(new Error("operator cancelled")), 15);
  await assert.rejects(cancelRun, /operator cancelled/);
  assert.deepEqual(cancellable.signals, ["SIGTERM"]);

  const stubborn = new FakeChild({ ignoreTerm: true, ignoreKill: true });
  const startedAt = Date.now();
  await assert.rejects(
    capture(stubborn, { timeoutConfig: { idleMs: 20, totalMs: 300, killGraceMs: 10 } }),
    (error) => error && error.code === "AGENTLAS_CAPTURE_IDLE_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 1_000, "capture slot must be released even if the child never emits close");
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stubborn.stdout.listenerCount("data"), 0, "force resolution must detach stdout capture");
  assert.equal(stubborn.stderr.listenerCount("data"), 0, "force resolution must detach stderr capture");
  assert.equal(stubborn.listenerCount("close"), 0, "force resolution must detach process listeners");

  console.log("capture-runtime-guard: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
