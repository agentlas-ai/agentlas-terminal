#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const terminal = require("../engine/mcp/index.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-probe-pool-"));

function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `server-${index}`,
    catalog_id: `catalog-${index}`,
    name: `Catalog ${index}`,
    name_en: `Catalog ${index}`,
    transport: "stdio",
    command: `fixture-mcp-${index}`,
    args_json: "[]",
    env_keys_json: "[]",
    enabled: 1,
  }));
}

function dbFor(rows) {
  return {
    prepare(sql) {
      if (/WHERE id=\? LIMIT 1/.test(sql)) return { get: (id) => rows.find((row) => row.id === id) || null };
      return { all: () => rows };
    },
  };
}

(async () => {
  try {
    const rows = makeRows(8);
    const db = dbFor(rows);
    const inventory = terminal.collectSystemMcpInventory(db, { userDataDir: temp, env: {} });
    const ids = rows.map((row) => row.catalog_id);
    const plan = terminal.buildMcpPlan({ inventory, request: "", policy: null, requiredIds: [], recommendedIds: ids });
    let active = 0;
    let maxActive = 0;
    const started = [];
    const start = Date.now();
    const result = await terminal.resolveApprovedMcpRuntimeAllowlist({
      db,
      plan,
      approvedIds: ids,
      userDataDir: temp,
      probeConcurrency: 3,
      probeTimeoutMs: 500,
      totalProbeTimeoutMs: 1_000,
      probeServer: async (server) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(server.catalog_id);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { connected: true, reason: "connected" };
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(maxActive, 3, "probe worker pool must use its bounded concurrency");
    assert.ok(elapsed < 500, `bounded concurrency unexpectedly behaved serially (${elapsed}ms)`);
    assert.deepEqual(started.slice(0, 3), ids.slice(0, 3));
    assert.deepEqual(result.attached.map((item) => item.catalogId), ids, "receipt order must remain deterministic");
    assert.deepEqual(result.failed, []);

    const deadlineStart = Date.now();
    const deadlineResult = await terminal.resolveApprovedMcpRuntimeAllowlist({
      db,
      plan,
      approvedIds: ids,
      userDataDir: temp,
      probeConcurrency: 2,
      probeTimeoutMs: 500,
      totalProbeTimeoutMs: 80,
      probeServer: () => new Promise(() => {}),
    });
    const deadlineElapsed = Date.now() - deadlineStart;
    assert.ok(deadlineElapsed < 400, `shared probe deadline was not enforced (${deadlineElapsed}ms)`);
    assert.equal(deadlineResult.attached.length, 0);
    assert.equal(deadlineResult.failed.length, 8);
    assert.ok(deadlineResult.failed.every((item) => ["connection_timeout", "probe_total_deadline"].includes(item.reason)));
    assert.equal(deadlineResult.emptyMode, true);

    const fallbackRows = [
      { id: "server-primary", catalog_id: "primary", name: "Primary", name_en: "Primary", transport: "stdio", command: "primary-mcp", args_json: "[]", env_keys_json: "[]", enabled: 1 },
      { id: "server-fallback", catalog_id: "fallback", name: "Fallback", name_en: "Fallback", transport: "stdio", command: "fallback-mcp", args_json: "[]", env_keys_json: "[]", enabled: 1 },
      { id: "server-independent", catalog_id: "independent", name: "Independent", name_en: "Independent", transport: "stdio", command: "independent-mcp", args_json: "[]", env_keys_json: "[]", enabled: 1 },
    ];
    const fallbackDb = dbFor(fallbackRows);
    const fallbackInventory = terminal.collectSystemMcpInventory(fallbackDb, { userDataDir: temp, env: {} });
    const requirement = (catalogId, alternatives = []) => ({
      schemaVersion: "agentlas.mcp-requirement.v1",
      kind: "agentlas-mcp-requirement",
      requirementId: `requirement:${catalogId}`,
      catalogId,
      reason: `Runtime group for ${catalogId}`,
      capabilities: [`capability:${catalogId}`],
      required: false,
      requiresKey: false,
      priority: catalogId === "primary" ? 1 : 20,
      permissions: [],
      alternatives,
      unavailablePolicy: { build: "degrade", rental: "continue-degraded", execution: "use-alternative" },
    });
    const fallbackPlan = terminal.buildMcpPlan({
      inventory: fallbackInventory,
      request: "",
      policy: { registryResolutionOrder: ["system-global"], requirements: [
        requirement("primary", ["fallback"]),
        requirement("independent"),
      ] },
      requiredIds: [],
      recommendedIds: [],
    });
    assert.deepEqual(fallbackPlan.availableCatalogIds, ["primary", "fallback", "independent"]);
    assert.deepEqual(fallbackPlan.entries[0].fallbackCatalogIds, ["fallback"]);
    const fallbackStarted = [];
    const fallbackResult = await terminal.resolveApprovedMcpRuntimeAllowlist({
      db: fallbackDb,
      plan: fallbackPlan,
      approvedIds: ["primary", "fallback", "independent"],
      userDataDir: temp,
      probeConcurrency: 2,
      probeServer: async (server) => {
        fallbackStarted.push(server.catalog_id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return server.catalog_id === "primary"
          ? { connected: false, reason: "connection_failed" }
          : { connected: true, reason: "connected" };
      },
    });
    assert.ok(fallbackStarted.indexOf("fallback") > fallbackStarted.indexOf("primary"), "fallback must be sequential after its failed primary");
    assert.deepEqual(fallbackResult.attached.map((item) => item.catalogId), ["fallback", "independent"]);
    assert.deepEqual(fallbackResult.failed, [{ catalogId: "primary", reason: "connection_failed" }]);

    const keyRows = [{
      id: "key-server",
      catalog_id: "key-server",
      name: "Key server",
      name_en: "Key server",
      transport: "stdio",
      command: "key-mcp",
      args_json: "[]",
      env_keys_json: '["ORIGINAL_TOKEN"]',
      enabled: 1,
    }];
    const keyDb = dbFor(keyRows);
    const keyInventory = terminal.collectSystemMcpInventory(keyDb, { userDataDir: temp, env: { ORIGINAL_TOKEN: "present", WIDENED_TOKEN: "present" } });
    const keyPlan = terminal.buildMcpPlan({ inventory: keyInventory, request: "", policy: null, requiredIds: [], recommendedIds: ["key-server"] });
    keyRows[0].env_keys_json = '["WIDENED_TOKEN"]';
    let widenedProbeCalled = false;
    const widened = await terminal.resolveApprovedMcpRuntimeAllowlist({
      db: keyDb,
      plan: keyPlan,
      approvedIds: ["key-server"],
      userDataDir: temp,
      probeServer: async () => { widenedProbeCalled = true; return { connected: true, reason: "connected" }; },
    });
    assert.equal(widenedProbeCalled, false, "post-consent credential metadata widening must fail before execution");
    assert.deepEqual(widened.failed, [{ catalogId: "key-server", reason: "registry_row_unavailable" }]);

    const unwritableBoundary = path.join(temp, "not-a-directory");
    fs.writeFileSync(unwritableBoundary, "fixture", "utf8");
    const boundaryResult = await terminal.resolveApprovedMcpRuntimeAllowlist({
      db,
      plan,
      approvedIds: [ids[0]],
      userDataDir: unwritableBoundary,
      probeServer: async () => ({ connected: true, reason: "connected" }),
    });
    assert.deepEqual(boundaryResult.failed, [{ catalogId: ids[0], reason: "registry_row_unavailable" }], "runtime-home failure must stay server-local");
    assert.equal(boundaryResult.emptyMode, true);

    console.log(JSON.stringify({ ok: true, checks: 24, maxActive, elapsed, deadlineElapsed }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
