#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runApi,
  DEFAULT_API_MODEL,
  ANTHROPIC_COMPAT_API,
} = require("../engine/agentlas.cjs");
const { create: createParity } = require("../engine/agentlas-parity.cjs");

function response(status, payload, errorText) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => errorText || "",
  };
}

function openFixtureDb(file) {
  try {
    const Database = require("better-sqlite3");
    return new Database(file);
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(file);
  }
}

function quietUi() {
  const same = (value) => String(value ?? "");
  return {
    lang: "en",
    c: { paw: same, bold: same, text: same, dim: same },
    line() {},
    info() {},
    warn() {},
    error() {},
    tool() {},
    toolResult() {},
    startSpinner() {},
    stopSpinner() {},
    markdown() {},
  };
}

async function testAnthropicCompatibleProviders() {
  for (const backend of ["glm", "kimi", "deepseek"]) {
    const calls = [];
    const text = await runApi(backend, null, "system", "prompt", {
      apiKey: `${backend}-secret`,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response(200, { content: [{ type: "text", text: `${backend}-ok` }] });
      },
    });

    assert.equal(text, `${backend}-ok`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ANTHROPIC_COMPAT_API[backend].baseUrl}/v1/messages`);
    assert.equal(calls[0].init.headers["x-api-key"], `${backend}-secret`);
    assert.equal(calls[0].init.headers.authorization, `Bearer ${backend}-secret`);
    assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(calls[0].init.body).model, DEFAULT_API_MODEL[backend]);
  }
}

async function testCustomBaseUrlComesFromSharedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-run-api-"));
  const previous = process.env.AGENTLAS_USER_DATA_DIR;
  process.env.AGENTLAS_USER_DATA_DIR = dir;
  const db = openFixtureDb(path.join(dir, "agentlas.sqlite"));
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      "custom_base_url",
      "https://gateway.example.test/openai/v1/",
    );

    const calls = [];
    const text = await runApi("custom", "company-model", "system", "prompt", {
      apiKey: "custom-secret",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response(200, { choices: [{ message: { content: "custom-ok" } }] });
      },
    });

    assert.equal(text, "custom-ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gateway.example.test/openai/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer custom-secret");
    assert.equal(JSON.parse(calls[0].init.body).model, "company-model");

    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(
      "http://public.example.test/v1",
      "custom_base_url",
    );
    let unsafeFetchCalled = false;
    await assert.rejects(
      runApi("custom", "company-model", "system", "prompt", {
        apiKey: "custom-secret",
        fetch: async () => {
          unsafeFetchCalled = true;
          return response(200, {});
        },
      }),
      /HTTPS.*localhost\/LAN/,
    );
    assert.equal(unsafeFetchCalled, false, "invalid public HTTP base URL must not receive the API key");
  } finally {
    try { db.close(); } catch { /* ignore */ }
    if (previous === undefined) delete process.env.AGENTLAS_USER_DATA_DIR;
    else process.env.AGENTLAS_USER_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testProviderErrorsNeverExitTheHostProcess() {
  const originalExit = process.exit;
  let exitCalls = 0;
  process.exit = (code) => {
    exitCalls += 1;
    throw new Error(`unexpected process.exit(${code})`);
  };
  try {
    await assert.rejects(
      runApi("openai", "gpt-test", "system", "prompt", {
        apiKey: "openai-secret",
        fetch: async () => response(429, null, "rate limited"),
      }),
      /OpenAI 429: rate limited/,
    );
    await assert.rejects(
      runApi("deepseek", "deepseek-chat", "system", "prompt", {
        apiKey: "",
        fetch: async () => response(200, {}),
      }),
      /deepseek API \ud0a4/,
    );
    await assert.rejects(
      runApi("unknown", null, "system", "prompt", {
        apiKey: "secret",
        fetch: async () => response(200, {}),
      }),
      /\uc9c0\uc6d0\ud558\uc9c0 \uc54a\ub294 backend/,
    );
    assert.equal(exitCalls, 0, "runApi must throw to swarm/automation instead of exiting");
  } finally {
    process.exit = originalExit;
  }
}

async function testSwarmAndAutomationContainProviderFailure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-run-api-host-"));
  const db = openFixtureDb(path.join(dir, "agentlas.sqlite"));
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  let exitCalls = 0;
  process.exit = (code) => {
    exitCalls += 1;
    throw new Error(`unexpected process.exit(${code})`);
  };
  try {
    db.exec(`
      CREATE TABLE installed_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        system_prompt TEXT
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        claimed_at TEXT,
        lease_owner TEXT,
        last_run_at TEXT,
        next_run_at TEXT,
        schedule_json TEXT,
        timezone TEXT,
        trigger_type TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        max_runs INTEGER
      );
      CREATE TABLE run_history (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        scheduled_for TEXT,
        ran_at TEXT,
        status TEXT,
        skipped_count INTEGER,
        error TEXT
      );
      INSERT INTO installed_agents(id, name, system_prompt)
      VALUES ('agent-1', 'Regression Agent', 'System');
      INSERT INTO automations(
        id, name, schedule, target_type, target_id, prompt_template, enabled,
        next_run_at, timezone, trigger_type, run_count
      ) VALUES (
        'automation-1', 'Regression Automation', 'daily-09:00', 'agent', 'agent-1', 'Run', 1,
        '2026-01-01T00:00:00.000Z', 'Asia/Seoul', 'schedule', 0
      );
    `);

    const failingRunApi = (backend, model, system, prompt) => runApi(backend, model, system, prompt, {
      apiKey: "openai-secret",
      fetch: async () => response(429, null, "rate limited"),
    });
    const parity = createParity({
      prefsLang: () => "en",
      resolveRuntime: () => ({ mode: "api", backend: "openai", model: "gpt-test" }),
      buildChildEnvCli: async () => ({}),
      runApi: failingRunApi,
      captureRuntime: async () => "",
      runCwd: () => dir,
      out() {},
      fail(message) { throw new Error(message); },
    });

    const swarm = await parity.swarmRun(db, "provider failure containment", { ui: quietUi(), concurrency: 2 });
    assert.equal(swarm.ok, false, "all-failed swarm should finish normally with ok=false");

    await parity.cmdAutomation(db, ["run", "automation-1"]);
    const automation = db.prepare(
      "SELECT claimed_at, lease_owner, last_run_at, run_count FROM automations WHERE id = ?",
    ).get("automation-1");
    assert.equal(automation.claimed_at, null, "automation lease must be released after provider error");
    assert.equal(automation.lease_owner, null, "automation lease owner must be cleared after provider error");
    assert.ok(automation.last_run_at, "automation failure must still be recorded");
    assert.equal(automation.run_count, 0, "failed automation must not count as success");
    const history = db.prepare(
      "SELECT status, error FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC LIMIT 1",
    ).get("automation-1");
    assert.equal(history.status, "error");
    assert.match(history.error, /OpenAI 429: rate limited/);
    assert.equal(exitCalls, 0, "swarm/automation must contain provider errors without exiting the host");

    const fixedFrom = new Date("2026-07-10T00:30:00.000Z"); // 09:30 Asia/Seoul
    assert.equal(
      parity.nextAutomationRun(
        { schedule: "daily-09:00", schedule_json: null, timezone: "Asia/Seoul" },
        fixedFrom,
      ).toISOString(),
      "2026-07-11T00:00:00.000Z",
      "legacy desktop token must advance in its stored timezone",
    );

    const scheduledFailureRow = db.prepare("SELECT * FROM automations WHERE id = ?").get("automation-1");
    const failedScheduled = await parity.runAutomationOnce(db, scheduledFailureRow, {
      ui: quietUi(),
      advanceSchedule: true,
      scheduledFor: scheduledFailureRow.next_run_at,
    });
    assert.equal(failedScheduled.ok, false);
    const afterScheduledFailure = db.prepare(
      "SELECT next_run_at, run_count, enabled FROM automations WHERE id = ?",
    ).get("automation-1");
    assert.ok(
      Date.parse(afterScheduledFailure.next_run_at) > Date.now(),
      "failed scheduled automation must advance beyond now instead of retrying every poll",
    );
    assert.equal(afterScheduledFailure.run_count, 0, "failed run remains excluded from success count");

    db.prepare(
      `INSERT INTO automations(
        id, name, schedule, target_type, target_id, prompt_template, enabled,
        next_run_at, timezone, trigger_type, run_count
      ) VALUES ('automation-2', 'Success Automation', 'cron:*/5 * * * *', 'agent', 'agent-1', 'Run', 1,
        '2026-01-01T00:00:00.000Z', 'UTC', 'schedule', 0)`,
    ).run();
    const successParity = createParity({
      prefsLang: () => "en",
      resolveRuntime: () => ({ mode: "api", backend: "openai", model: "gpt-test" }),
      buildChildEnvCli: async () => ({}),
      runApi: async () => "ok",
      captureRuntime: async () => "",
      runCwd: () => dir,
      out() {},
      fail(message) { throw new Error(message); },
    });
    const successRow = db.prepare("SELECT * FROM automations WHERE id = ?").get("automation-2");
    const scheduledSuccess = await successParity.runAutomationOnce(db, successRow, {
      ui: quietUi(),
      advanceSchedule: true,
      scheduledFor: successRow.next_run_at,
    });
    assert.equal(scheduledSuccess.ok, true);
    const afterScheduledSuccess = db.prepare(
      "SELECT next_run_at, run_count, enabled FROM automations WHERE id = ?",
    ).get("automation-2");
    assert.ok(Date.parse(afterScheduledSuccess.next_run_at) > Date.now());
    assert.equal(afterScheduledSuccess.run_count, 1);
    assert.equal(afterScheduledSuccess.enabled, 1);
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testAnthropicCompatibleProviders();
  await testCustomBaseUrlComesFromSharedDb();
  await testProviderErrorsNeverExitTheHostProcess();
  await testSwarmAndAutomationContainProviderFailure();
  process.stdout.write("run-api regression: PASS (BYOK parity + swarm/automation failure containment)\n");
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
