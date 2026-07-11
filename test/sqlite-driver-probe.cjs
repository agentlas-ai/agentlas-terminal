#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { probeSqliteDriver } = require("../bin/agentlas.cjs");

const driver = probeSqliteDriver();
assert.ok(driver === "better-sqlite3" || driver === "node:sqlite", `unexpected SQLite driver: ${driver}`);

const launcher = path.join(__dirname, "..", "bin", "agentlas.cjs");
const result = spawnSync(process.execPath, [launcher, "--where"], {
  encoding: "utf8",
  env: { ...process.env, NODE_NO_WARNINGS: "" },
});
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.doesNotMatch(result.stderr, /ExperimentalWarning|SQLite is an experimental feature/i);
const where = JSON.parse(result.stdout);
assert.equal(where.sqliteDriver, driver, "--where must report the driver that can actually open a database");

console.log(`sqlite-driver-probe: PASS (${driver})`);
