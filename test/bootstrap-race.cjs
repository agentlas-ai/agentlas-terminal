#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const launcher = path.join(root, "bin", "agentlas.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-bootstrap-race-"));
const probe = `const x=require(${JSON.stringify(launcher)}); process.stdout.write(JSON.stringify(x.bootstrapDbIfMissing()))`;

function runOne() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", probe], {
      cwd: root,
      env: { ...process.env, AGENTLAS_USER_DATA_DIR: temp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`bootstrap child ${code}: ${stderr}`));
      resolve(JSON.parse(stdout));
    });
  });
}

Promise.all(Array.from({ length: 8 }, () => runOne()))
  .then((results) => {
    assert.equal(results.filter((result) => result.created).length, 1, "exactly one process owns first creation");
    const db = path.join(temp, "agentlas.sqlite");
    assert.equal(fs.existsSync(db), true);
    assert.ok(fs.statSync(db).size > 0);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(temp).mode & 0o777, 0o700, "userData must be private");
      assert.equal(fs.statSync(db).mode & 0o777, 0o600, "SQLite must be private");
    }
    assert.deepEqual(fs.readdirSync(temp).filter((name) => name.includes(".bootstrap-")), []);
    console.log(JSON.stringify({ ok: true, workers: results.length, created: 1 }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
