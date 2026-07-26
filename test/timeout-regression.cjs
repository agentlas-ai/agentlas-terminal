#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { fetchHubCli, hubTimeoutConfig } = require("../engine/agentlas.cjs");
const {
  activeNativeProcessIds,
  forceStopNativeProcessTree,
  runNativeTurn,
  nativeTimeoutConfig,
} = require("../engine/agentlas-native-host.cjs");

function delayedResponse(parts, delayMs, options = {}) {
  let timer = null;
  let index = 0;
  return new Response(new ReadableStream({
    start(controller) {
      const push = () => {
        if (index >= parts.length) {
          if (!options.stall) controller.close();
          return;
        }
        controller.enqueue(Buffer.from(parts[index++]));
        timer = setTimeout(push, delayMs);
      };
      timer = setTimeout(push, options.immediate ? 0 : delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  }), { status: options.status || 200, headers: { "content-type": "application/json" } });
}

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.ignoreTerm = !!options.ignoreTerm;
    this.closed = false;
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
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

function fakeUi() {
  const errors = [];
  return {
    errors,
    c: { faint: (value) => value, italic: (value) => value },
    status() {},
    error(value) { errors.push(String(value)); },
    warn() {},
    info() {},
    line() {},
    tool() {},
    toolResult() {},
    streamStart() {},
    streamDelta() {},
    streamEnd() {},
    stopSpinner() {},
    cost() {},
  };
}

function nativeRequest(child, timeoutConfig, ui = fakeUi()) {
  return {
    kind: "gemini",
    bin: "fake-gemini",
    prompt: "test",
    systemPrompt: "system",
    cwd: process.cwd(),
    permission: "read",
    session: {},
    env: {},
    ui,
    timeoutConfig,
    spawn: () => child,
  };
}

async function testHubTimeouts() {
  assert.deepEqual(
    hubTimeoutConfig({
      AGENTLAS_HUB_CONNECT_TIMEOUT_MS: "NaN",
      AGENTLAS_HUB_IDLE_TIMEOUT_MS: "Infinity",
      AGENTLAS_HUB_TOTAL_TIMEOUT_MS: "not-a-number",
    }),
    { connectMs: 15_000, idleMs: 30_000, totalMs: 180_000 },
  );
  assert.deepEqual(
    hubTimeoutConfig({
      AGENTLAS_HUB_CONNECT_TIMEOUT_MS: "-1",
      AGENTLAS_HUB_IDLE_TIMEOUT_MS: "0",
      AGENTLAS_HUB_TOTAL_TIMEOUT_MS: "999999999999",
    }),
    { connectMs: 1_000, idleMs: 1_000, totalMs: 900_000 },
  );

  await assert.rejects(
    fetchHubCli("https://blackhole.invalid", {}, {
      fetch: () => new Promise(() => {}),
      timeoutConfig: { connectMs: 25, idleMs: 100, totalMs: 200 },
    }),
    (error) => error && error.code === "AGENTLAS_HUB_CONNECT_TIMEOUT",
  );

  await assert.rejects(
    fetchHubCli("https://idle.invalid", {}, {
      fetch: async () => delayedResponse(["{"], 1, { immediate: true, stall: true }),
      timeoutConfig: { connectMs: 50, idleMs: 30, totalMs: 200 },
    }),
    (error) => error && error.code === "AGENTLAS_HUB_IDLE_TIMEOUT",
  );

  await assert.rejects(
    fetchHubCli("https://total.invalid", {}, {
      fetch: async () => delayedResponse(Array(30).fill(" "), 10, { immediate: true }),
      timeoutConfig: { connectMs: 50, idleMs: 30, totalMs: 75 },
    }),
    (error) => error && error.code === "AGENTLAS_HUB_TOTAL_TIMEOUT",
  );

  const streamed = await fetchHubCli("https://stream.invalid", {}, {
    fetch: async () => delayedResponse(["{\"", "ok", "\":", "true", "}"], 15),
    timeoutConfig: { connectMs: 50, idleMs: 35, totalMs: 250 },
  });
  assert.equal(streamed.ok, true);
  assert.deepEqual(JSON.parse(streamed.text), { ok: true }, "regular chunks must keep the idle watchdog alive");

  const abort = new AbortController();
  const aborted = fetchHubCli("https://abort.invalid", { signal: abort.signal }, {
    fetch: () => new Promise(() => {}),
    timeoutConfig: { connectMs: 200, idleMs: 200, totalMs: 300 },
  });
  setTimeout(() => abort.abort(new Error("caller stop")), 15);
  await assert.rejects(aborted, /caller stop/);
}

async function testNativeTimeouts() {
  assert.deepEqual(
    nativeTimeoutConfig({
      AGENTLAS_NATIVE_IDLE_TIMEOUT_MS: "NaN",
      AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS: "Infinity",
      AGENTLAS_NATIVE_KILL_GRACE_MS: "bad",
    }),
    { idleMs: 600_000, totalMs: 14_400_000, killGraceMs: 3_000 },
  );
  assert.deepEqual(
    nativeTimeoutConfig({
      AGENTLAS_NATIVE_IDLE_TIMEOUT_MS: "-1",
      AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS: "999999999999",
      AGENTLAS_NATIVE_KILL_GRACE_MS: "999999999999",
    }),
    { idleMs: 5_000, totalMs: 43_200_000, killGraceMs: 15_000 },
  );

  const silent = new FakeChild({ ignoreTerm: true });
  const silentResult = await runNativeTurn(nativeRequest(silent, { idleMs: 30, totalMs: 250, killGraceMs: 15 }));
  assert.match(silentResult.error || "", /idle timeout/);
  assert.deepEqual(silent.signals, ["SIGTERM", "SIGKILL"], "silent child must escalate when SIGTERM is ignored");

  const streaming = new FakeChild();
  const streamingRun = runNativeTurn(nativeRequest(streaming, { idleMs: 35, totalMs: 250, killGraceMs: 15 }));
  const chunks = ["one", "two", "three", "four"];
  chunks.forEach((content, index) => {
    setTimeout(() => streaming.stdout.write(`${JSON.stringify({ type: "message", role: "assistant", content })}\n`), 15 + index * 20);
  });
  setTimeout(() => {
    streaming.stdout.write(`${JSON.stringify({ type: "result", status: "success", stats: {} })}\n`);
    streaming.finish(0);
  }, 105);
  const streamingResult = await streamingRun;
  assert.equal(streamingResult.error, null);
  assert.equal(streamingResult.text, "onetwothreefour");
  assert.deepEqual(streaming.signals, [], "active streaming must not be killed by the idle watchdog");

  const endless = new FakeChild({ ignoreTerm: true });
  const endlessRun = runNativeTurn(nativeRequest(endless, { idleMs: 35, totalMs: 85, killGraceMs: 15 }));
  const activity = setInterval(() => endless.stderr.write("progress\n"), 12);
  const endlessResult = await endlessRun;
  clearInterval(activity);
  assert.match(endlessResult.error || "", /total timeout/);
  assert.deepEqual(endless.signals, ["SIGTERM", "SIGKILL"], "total timeout must cap even an active stream");

  const cancellable = new FakeChild();
  const controller = new AbortController();
  const cancelRun = runNativeTurn({
    ...nativeRequest(cancellable, { idleMs: 200, totalMs: 300, killGraceMs: 15 }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 15);
  const cancelResult = await cancelRun;
  assert.equal(cancelResult.error, "aborted");
  assert.deepEqual(cancellable.signals, ["SIGTERM"]);
}

async function testDetachedDescendantCancellation() {
  if (process.platform === "win32") return;
  assert.equal(activeNativeProcessIds([12345], null), null, "process verification must fail closed when ps is unavailable");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-native-tree-"));
  const sentinel = path.join(tempDir, "must-not-exist.txt");
  const descendantCode = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'BAD\\n'), 700);`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const rootCode = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'ignore' }).unref();`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const root = spawn(process.execPath, ["-e", rootCode], {
    detached: true,
    stdio: "ignore",
  });
  root.__agentlasGroupedChild = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const targets = forceStopNativeProcessTree(root);
    assert.ok(targets.includes(root.pid), "forced tree must include the native runtime root");
    assert.ok(targets.length >= 2, "forced tree must include a detached tool descendant");
    const deadline = Date.now() + 2_000;
    while (activeNativeProcessIds(targets).length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(activeNativeProcessIds(targets), [], "cancelled native tree must be fully stopped");
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(fs.existsSync(sentinel), false, "detached tool descendant must not finish a forbidden write");
  } finally {
    try { process.kill(-root.pid, "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testHubTimeouts();
  await testNativeTimeouts();
  await testDetachedDescendantCancellation();
  console.log("timeout-regression: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
