#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  updateTimeoutConfig,
  fetchUpdateMetadata,
  validateDesktopUpdateArtifact,
  downloadUpdateFile,
  verifyMacAppBundle,
  replaceMacAppBundle,
} = require("../engine/agentlas.cjs");

function streamedResponse(parts, delayMs = 0, options = {}) {
  let timer = null;
  let index = 0;
  const body = new ReadableStream({
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
  });
  const headers = new Headers(options.headers || {});
  return {
    ok: options.status == null || (options.status >= 200 && options.status < 300),
    status: options.status || 200,
    headers,
    body,
    arrayBuffer() {
      throw new Error("arrayBuffer must never be used for updater transfers");
    },
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactFor(value, overrides = {}) {
  return {
    url: "https://downloads.example.test/Agentlas.dmg",
    fileName: "Agentlas.dmg",
    sizeBytes: value.length,
    sha256: sha256(value),
    ...overrides,
  };
}

function assertNoPartials(dir) {
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".partial.")), []);
}

async function testMetadataPolicy() {
  assert.deepEqual(
    updateTimeoutConfig({
      AGENTLAS_UPDATE_METADATA_CONNECT_TIMEOUT_MS: "NaN",
      AGENTLAS_UPDATE_METADATA_IDLE_TIMEOUT_MS: "Infinity",
      AGENTLAS_UPDATE_METADATA_TOTAL_TIMEOUT_MS: "bad",
    }, "metadata"),
    { connectMs: 15_000, idleMs: 15_000, totalMs: 30_000 },
  );
  assert.deepEqual(
    updateTimeoutConfig({
      AGENTLAS_UPDATE_DOWNLOAD_CONNECT_TIMEOUT_MS: "-1",
      AGENTLAS_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS: "0",
      AGENTLAS_UPDATE_DOWNLOAD_TOTAL_TIMEOUT_MS: "999999999999",
    }, "download"),
    { connectMs: 1_000, idleMs: 1_000, totalMs: 3_600_000 },
  );

  const metadata = JSON.stringify({ version: "1.2.3-rc.1", artifacts: [] });
  const parsed = await fetchUpdateMetadata("https://agentlas.example.test/latest", {
    fetch: async () => streamedResponse([metadata.slice(0, 8), metadata.slice(8)], 12),
    timeoutConfig: { connectMs: 40, idleMs: 30, totalMs: 150 },
  });
  assert.equal(parsed.version, "1.2.3-rc.1");

  await assert.rejects(
    fetchUpdateMetadata("https://agentlas.example.test/latest", {
      fetch: () => new Promise(() => {}),
      timeoutConfig: { connectMs: 20, idleMs: 40, totalMs: 80 },
    }),
    (error) => error && error.code === "AGENTLAS_UPDATE_CONNECT_TIMEOUT",
  );
  await assert.rejects(
    fetchUpdateMetadata("https://agentlas.example.test/latest", {
      fetch: async () => streamedResponse(["{"], 0, { immediate: true, stall: true }),
      timeoutConfig: { connectMs: 30, idleMs: 20, totalMs: 100 },
    }),
    (error) => error && error.code === "AGENTLAS_UPDATE_IDLE_TIMEOUT",
  );
  await assert.rejects(
    fetchUpdateMetadata("https://agentlas.example.test/latest", {
      fetch: async () => streamedResponse(Array(20).fill(" "), 8, { immediate: true }),
      timeoutConfig: { connectMs: 20, idleMs: 20, totalMs: 35 },
    }),
    (error) => error && error.code === "AGENTLAS_UPDATE_TOTAL_TIMEOUT",
  );
  await assert.rejects(
    fetchUpdateMetadata("https://agentlas.example.test/latest", {
      fetch: async () => streamedResponse(["x".repeat(33)], 0, { immediate: true }),
      maxBytes: 32,
      timeoutConfig: { connectMs: 30, idleMs: 30, totalMs: 100 },
    }),
    (error) => error && error.code === "AGENTLAS_UPDATE_TOO_LARGE",
  );
}

async function testArtifactAndDownloadPolicy() {
  const payload = Buffer.from("streamed-dmg-payload");
  assert.throws(
    () => validateDesktopUpdateArtifact(artifactFor(payload, { sha256: undefined })),
    (error) => error && error.code === "AGENTLAS_UPDATE_MISSING_DIGEST",
  );
  assert.throws(
    () => validateDesktopUpdateArtifact(artifactFor(payload, { sizeBytes: undefined })),
    (error) => error && error.code === "AGENTLAS_UPDATE_MISSING_SIZE",
  );
  assert.throws(
    () => validateDesktopUpdateArtifact(artifactFor(payload, { fileName: "../Agentlas.dmg" })),
    (error) => error && error.code === "AGENTLAS_UPDATE_INVALID_FILENAME",
  );
  assert.throws(
    () => validateDesktopUpdateArtifact(artifactFor(payload, { url: "http://downloads.example.test/Agentlas.dmg" })),
    (error) => error && error.code === "AGENTLAS_UPDATE_INSECURE_URL",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-update-test."));
  try {
    let unsafeFetchCalled = false;
    const unsafeDestination = path.join(root, "missing-integrity.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", unsafeDestination, artifactFor(payload, { sha256: undefined }), {
        fetch: async () => {
          unsafeFetchCalled = true;
          return streamedResponse([payload], 0, { immediate: true });
        },
        maxBytes: 1024,
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_MISSING_DIGEST",
    );
    assert.equal(unsafeFetchCalled, false, "missing integrity metadata must fail before any network request");
    assert.equal(fs.existsSync(unsafeDestination), false);

    const destination = path.join(root, "ok.dmg");
    const result = await downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", destination, artifactFor(payload), {
      fetch: async () => streamedResponse([payload.subarray(0, 5), payload.subarray(5, 11), payload.subarray(11)], 12, {
        headers: { "content-length": String(payload.length) },
      }),
      maxBytes: 1024,
      timeoutConfig: { connectMs: 40, idleMs: 30, totalMs: 200 },
    });
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(fs.readFileSync(destination), payload);
    assertNoPartials(root);

    const connectionDestination = path.join(root, "connect-timeout.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", connectionDestination, artifactFor(payload), {
        fetch: () => new Promise(() => {}),
        maxBytes: 1024,
        timeoutConfig: { connectMs: 20, idleMs: 40, totalMs: 90 },
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_CONNECT_TIMEOUT",
    );
    assert.equal(fs.existsSync(connectionDestination), false);
    assertNoPartials(root);

    const idleDestination = path.join(root, "idle-timeout.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", idleDestination, artifactFor(payload), {
        fetch: async () => streamedResponse([payload.subarray(0, 2)], 0, { immediate: true, stall: true }),
        maxBytes: 1024,
        timeoutConfig: { connectMs: 30, idleMs: 20, totalMs: 100 },
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_IDLE_TIMEOUT",
    );
    assert.equal(fs.existsSync(idleDestination), false);
    assertNoPartials(root);

    const digestDestination = path.join(root, "bad-digest.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", digestDestination, artifactFor(payload, { sha256: "0".repeat(64) }), {
        fetch: async () => streamedResponse([payload], 0, { immediate: true }),
        maxBytes: 1024,
        timeoutConfig: { connectMs: 30, idleMs: 30, totalMs: 100 },
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_DIGEST_MISMATCH",
    );
    assert.equal(fs.existsSync(digestDestination), false);
    assertNoPartials(root);

    const sizeDestination = path.join(root, "bad-size.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", sizeDestination, artifactFor(payload, { sizeBytes: payload.length - 1 }), {
        fetch: async () => streamedResponse([payload], 0, { immediate: true }),
        maxBytes: 1024,
        timeoutConfig: { connectMs: 30, idleMs: 30, totalMs: 100 },
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_SIZE_MISMATCH",
    );
    assert.equal(fs.existsSync(sizeDestination), false);
    assertNoPartials(root);

    const maxDestination = path.join(root, "too-large.dmg");
    await assert.rejects(
      downloadUpdateFile("https://downloads.example.test/Agentlas.dmg", maxDestination, artifactFor(payload), {
        fetch: async () => streamedResponse([payload], 0, { immediate: true }),
        maxBytes: payload.length - 1,
        timeoutConfig: { connectMs: 30, idleMs: 30, totalMs: 100 },
      }),
      (error) => error && error.code === "AGENTLAS_UPDATE_TOO_LARGE",
    );
    assert.equal(fs.existsSync(maxDestination), false);
    assertNoPartials(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeApp(appPath, marker) {
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, "marker.txt"), marker);
}

function readMarker(appPath) {
  return fs.readFileSync(path.join(appPath, "marker.txt"), "utf8");
}

function appFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-app-transaction."));
  const sourceApp = path.join(root, "Source.app");
  const targetApp = path.join(root, "Agentlas.app");
  const backupPath = path.join(root, ".Agentlas.backup.test.app");
  const stagingPath = path.join(root, ".Agentlas.installing.test.app");
  writeApp(sourceApp, "new");
  writeApp(targetApp, "original");
  return { root, sourceApp, targetApp, backupPath, stagingPath };
}

function mockCommands(fixture, options = {}) {
  const commands = { mv: "mock-mv", rm: "mock-rm", ditto: "mock-ditto", codesign: "mock-codesign", spctl: "mock-spctl" };
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args: [...args] });
    const pathArgs = args.filter((value) => !String(value).startsWith("-"));
    if (!pathArgs.every((value) => path.resolve(value).startsWith(fixture.root)) && command !== commands.codesign && command !== commands.spctl) {
      throw new Error(`test command escaped fixture: ${args.join(" ")}`);
    }
    if (command === commands.ditto) {
      if (options.failDitto && args[0] === fixture.sourceApp) throw new Error("mock ditto failure");
      fs.cpSync(args[0], args[1], { recursive: true, errorOnExist: true });
    } else if (command === commands.mv) {
      if (options.failRestore && args[0] === fixture.backupPath && args[1] === fixture.targetApp) throw new Error("mock restore failure");
      fs.renameSync(args[0], args[1]);
    } else if (command === commands.rm) {
      fs.rmSync(args[1], { recursive: true, force: true });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { commands, calls, runCommand };
}

async function runReplacementCase(options = {}) {
  const fixture = appFixture();
  const mock = mockCommands(fixture, options);
  const phases = [];
  const verifyApp = async (appPath, context) => {
    phases.push(context.phase);
    assert.equal(fs.existsSync(path.join(appPath, "marker.txt")), true, `missing app marker during ${context.phase}`);
    if (options.failPhase === context.phase) throw new Error(`mock ${context.phase} verification failure`);
    return { identifier: "com.agentlas.desktop", teamIdentifier: options.teamByPhase?.[context.phase] || "AGENTLAS123" };
  };
  const promise = replaceMacAppBundle({ ...fixture, ...mock, verifyApp });
  return { fixture, mock, phases, promise };
}

async function testReplacementTransaction() {
  {
    const run = await runReplacementCase();
    try {
      const result = await run.promise;
      assert.equal(readMarker(run.fixture.targetApp), "new");
      assert.equal(fs.existsSync(run.fixture.backupPath), false);
      assert.equal(fs.existsSync(run.fixture.stagingPath), false);
      assert.equal(result.backupRetained, false);
      assert.deepEqual(run.phases, ["source", "original", "backup", "staging", "installed"]);
    } finally {
      fs.rmSync(run.fixture.root, { recursive: true, force: true });
    }
  }

  for (const failure of [{ failDitto: true }, { failPhase: "staging" }, { failPhase: "installed" }, { teamByPhase: { staging: "EVIL123" } }]) {
    const run = await runReplacementCase(failure);
    try {
      await assert.rejects(run.promise, (error) => error && error.code === "AGENTLAS_UPDATE_REPLACEMENT_FAILED_ROLLED_BACK");
      assert.equal(readMarker(run.fixture.targetApp), "original", "the exact original app must be restored");
      assert.equal(fs.existsSync(run.fixture.backupPath), false);
      assert.equal(fs.existsSync(run.fixture.stagingPath), false);
      assert.equal(run.phases.at(-1), "restored", "rollback must verify the restored app");
    } finally {
      fs.rmSync(run.fixture.root, { recursive: true, force: true });
    }
  }

  {
    const run = await runReplacementCase({ failDitto: true, failRestore: true });
    try {
      await assert.rejects(run.promise, (error) => {
        assert.equal(error.code, "AGENTLAS_UPDATE_ROLLBACK_FAILED");
        assert.equal(error.backupPath, run.fixture.backupPath);
        return true;
      });
      assert.equal(readMarker(run.fixture.backupPath), "original", "failed rollback must retain the original backup");
    } finally {
      fs.rmSync(run.fixture.root, { recursive: true, force: true });
    }
  }
}

async function testCodeSigningChecks() {
  const calls = [];
  const identity = await verifyMacAppBundle("/tmp/fixture/Agentlas.app", {
    commands: { codesign: "codesign", spctl: "spctl" },
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "codesign" && args[0] === "-d") {
        return { code: 0, stdout: "", stderr: "Identifier=com.agentlas.desktop\nTeamIdentifier=AGENTLAS123\n" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(identity, { identifier: "com.agentlas.desktop", teamIdentifier: "AGENTLAS123" });
  assert.deepEqual(calls, [
    { command: "codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", "/tmp/fixture/Agentlas.app"], options: undefined },
    { command: "codesign", args: ["-d", "--verbose=4", "/tmp/fixture/Agentlas.app"], options: { capture: true } },
    { command: "spctl", args: ["-a", "-t", "exec", "-vv", "/tmp/fixture/Agentlas.app"], options: undefined },
  ]);

  await assert.rejects(
    verifyMacAppBundle("/tmp/fixture/Evil.app", {
      commands: { codesign: "codesign", spctl: "spctl" },
      runCommand: async (command, args) => command === "codesign" && args[0] === "-d"
        ? { code: 0, stdout: "", stderr: "Identifier=com.example.evil\nTeamIdentifier=EVIL123\n" }
        : { code: 0, stdout: "", stderr: "" },
    }),
    (error) => error && error.code === "AGENTLAS_UPDATE_SIGNER_MISMATCH",
  );
}

async function main() {
  await testMetadataPolicy();
  await testArtifactAndDownloadPolicy();
  await testReplacementTransaction();
  await testCodeSigningChecks();
  console.log("update-safety: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
