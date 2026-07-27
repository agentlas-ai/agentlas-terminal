#!/usr/bin/env node
"use strict";
// v1 release gate (legacy-v1-engine-snapshot test/project-bootstrap-contract.cjs)
// restored for v2: requires repointed from the deleted engine/agentlas.cjs monolith
// to engine/project/. Assertions are unchanged except the final source scan, which
// now checks the v2 command modules instead of the monolith's switch cases (same
// invariant: read-only commands must never touch project bootstrap).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const strict = process.argv.includes("--strict") || process.env.AGENTLAS_PROJECT_BOOTSTRAP_STRICT === "1";
const coreRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
const coreModule = coreRoot && path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py");
if (!coreModule || !fs.existsSync(coreModule)) {
  const message = "project-bootstrap-contract: new Agentlas Core runtime was not supplied";
  if (strict) {
    console.error(`${message} (strict release gate)`);
    process.exit(1);
  }
  console.log(`${message}; SKIP`);
  process.exit(0);
}

const terminal = require("../engine/project/index.cjs");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-terminal-project-bootstrap-"));
const project = path.join(workspace, "new-core-project");
const readOnlyIntent = path.join(workspace, "read-intent-project");
const readExistingIgnore = path.join(workspace, "read-existing-ignore-project");
const writeIntent = path.join(workspace, "write-intent-project");
const fallbackProject = path.join(workspace, "old-core-fallback-project");
const symlinkProject = path.join(workspace, "symlink-project");
const oversizeProject = path.join(workspace, "oversize-gitignore-project");
const gitignoreSymlinkProject = path.join(workspace, "gitignore-symlink-project");
const oldCore = path.join(workspace, "old-core");

function statMode(file) {
  return fs.statSync(file).mode & 0o777;
}

function noTablesDb() {
  return {
    prepare() {
      throw new Error("schema intentionally unavailable");
    },
  };
}

try {
  for (const dir of [project, readOnlyIntent, readExistingIgnore, writeIntent, fallbackProject, symlinkProject, oversizeProject, gitignoreSymlinkProject]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(project, "main.js"), "function terminalFirstContact() { return true; }\n");
  fs.writeFileSync(path.join(project, ".gitignore"), "custom-user-rule\n");

  assert.equal(terminal.ensureCoreProjectCli(project, { coreRoot }), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "project-soul-memory.md")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "code-map", "project-map.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "ontology-runtime.sqlite")), true);
  assert.equal(fs.existsSync(path.join(project, ".agentlas", "career-graph.sqlite")), true);
  const ignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  assert.match(ignore, /^custom-user-rule$/m, "bootstrap must preserve user ignore rules");
  assert.match(ignore, /# >>> agentlas local project state >>>/);
  assert.match(ignore, /^\.agentlas\/$/m, "the whole local Agentlas state namespace must be future-proof private");
  if (process.platform !== "win32") {
    assert.equal(statMode(path.join(project, ".agentlas")), 0o700);
    assert.equal(statMode(path.join(project, ".agentlas", "project-soul-memory.md")), 0o600);
  }

  // A read-permission execution intent is passive: no project files, ignore
  // edits, or visit rows are created merely by looking at a folder.
  assert.equal(
    terminal.ensureTerminalProjectForExecutionCli(noTablesDb(), readOnlyIntent, "read", "terminal-read-contract"),
    null,
  );
  assert.equal(fs.existsSync(path.join(readOnlyIntent, ".agentlas")), false);
  assert.equal(fs.existsSync(path.join(readOnlyIntent, ".gitignore")), false);
  fs.writeFileSync(path.join(readExistingIgnore, ".gitignore"), "keep-read-only\n");
  assert.equal(terminal.ensureTerminalProjectForExecutionCli(noTablesDb(), readExistingIgnore, "read"), null);
  assert.equal(fs.readFileSync(path.join(readExistingIgnore, ".gitignore"), "utf8"), "keep-read-only\n");
  assert.equal(fs.existsSync(path.join(readExistingIgnore, ".agentlas")), false);
  assert.equal(
    terminal.ensureTerminalProjectForExecutionCli(noTablesDb(), writeIntent, "full", "terminal-write-contract"),
    null,
    "ordinary write/full execution must not initialize unrelated project files",
  );
  assert.equal(fs.existsSync(path.join(writeIntent, ".agentlas")), false);
  assert.equal(fs.existsSync(path.join(writeIntent, ".gitignore")), false);
  assert.equal(
    terminal.initializeTerminalProjectCli(noTablesDb(), writeIntent, "terminal-explicit-project-init", { coreRoot }),
    writeIntent,
  );
  assert.equal(fs.existsSync(path.join(writeIntent, ".agentlas", "project-soul-memory.md")), true);
  assert.equal(
    terminal.ensureTerminalProjectForExecutionCli(noTablesDb(), writeIntent, "full", "terminal-write-contract"),
    writeIntent,
    "an explicitly initialized project remains available to later turns",
  );
  const readReply = terminal.curateCliReply(
    noTablesDb(),
    'safe answer\n\n## Memory Events\n```json\n[{"memory_kind":"decision","content":"must not persist","suggested_scope":"project"}]\n```',
    { projectPath: readOnlyIntent, permission: "read", curatedMemories: [] },
  );
  assert.match(readReply, /safe answer/);
  assert.doesNotMatch(readReply, /must not persist/);
  const commentedReadReply = terminal.curateCliReply(
    noTablesDb(),
    'visible answer\n<!--\n## Memory Events\n```json\n[]\n```\n-->',
    { projectPath: readOnlyIntent, permission: "read", curatedMemories: [] },
  );
  assert.equal(commentedReadReply, "visible answer", "hidden memory comments must not leak an opening marker");
  const unfencedReadReply = terminal.curateCliReply(
    noTablesDb(),
    "visible answer\n## Memory Events\nmalformed hidden metadata",
    { projectPath: readOnlyIntent, permission: "read", curatedMemories: [] },
  );
  assert.equal(unfencedReadReply, "visible answer", "malformed hidden metadata must be removed from the user reply");
  assert.equal(terminal.finalizeExperienceExecutionCli(noTablesDb(), { permission: "read", agentId: "agent:test" }), null);
  const readSystem = terminal.augmentSystem(noTablesDb(), "base", { projectPath: readOnlyIntent, permission: "read" }, true, "remember this");
  assert.doesNotMatch(readSystem, /Each item: memory_kind/, "read mode must not solicit durable memory writes");
  assert.equal(fs.existsSync(path.join(readOnlyIntent, ".agentlas")), false);

  // Simulate the prior Core, which has a module entry point but no project
  // command. Terminal may fall back, but that state must still be ignored and
  // owner-only before any private seed is materialized.
  fs.mkdirSync(path.join(oldCore, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(oldCore, "agentlas_cloud", "__init__.py"), "");
  fs.writeFileSync(path.join(oldCore, "agentlas_cloud", "__main__.py"), "raise SystemExit(2)\n");
  assert.equal(terminal.ensureCoreProjectCli(fallbackProject, { coreRoot: oldCore }), false);
  assert.equal(terminal.ensureCoreProjectCli(fallbackProject, { coreRoot: oldCore }), false, "legacy fallback is cached only for this process");
  const fallbackIgnore = fs.readFileSync(path.join(fallbackProject, ".gitignore"), "utf8");
  assert.match(fallbackIgnore, /^\.agentlas\/$/m);
  assert.equal(fallbackIgnore.split("# >>> agentlas local project state >>>").length - 1, 1);
  assert.equal(fs.existsSync(path.join(fallbackProject, ".agentlas", "project-soul-memory.md")), true);
  if (process.platform !== "win32") {
    assert.equal(statMode(path.join(fallbackProject, ".agentlas")), 0o700);
    assert.equal(statMode(path.join(fallbackProject, ".agentlas", "project-soul-memory.md")), 0o600);
  }

  if (process.platform !== "win32") {
    const outside = path.join(workspace, "outside-private-state");
    fs.mkdirSync(path.join(symlinkProject, ".agentlas"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(symlinkProject, ".agentlas", "code-map"), "dir");
    assert.throws(
      () => terminal.ensureCoreProjectCli(symlinkProject, { coreRoot }),
      /must not contain symbolic links/,
      "bootstrap must not follow a hostile local-state symlink",
    );
    assert.deepEqual(fs.readdirSync(outside), []);

    const outsideIgnore = path.join(workspace, "outside.gitignore");
    fs.writeFileSync(outsideIgnore, "outside-must-not-change\n");
    fs.symlinkSync(outsideIgnore, path.join(gitignoreSymlinkProject, ".gitignore"), "file");
    assert.throws(
      () => terminal.ensureCoreProjectCli(gitignoreSymlinkProject, { coreRoot }),
      /regular non-symbolic-link file/,
    );
    assert.equal(fs.readFileSync(outsideIgnore, "utf8"), "outside-must-not-change\n");
    assert.equal(fs.existsSync(path.join(gitignoreSymlinkProject, ".agentlas")), false);
  }

  const oversizeIgnore = path.join(oversizeProject, ".gitignore");
  fs.writeFileSync(oversizeIgnore, Buffer.alloc(1024 * 1024 + 1, 0x61));
  assert.throws(
    () => terminal.ensureCoreProjectCli(oversizeProject, { coreRoot }),
    /exceeds the 1048576-byte safe bootstrap limit/,
  );
  assert.throws(
    () => terminal.initializeTerminalProjectCli(
      noTablesDb(),
      oversizeProject,
      "terminal-write-contract",
      { coreRoot },
    ),
    /exceeds the 1048576-byte safe bootstrap limit/,
    "a real write/full execution must fail closed when its local-state privacy boundary is unsafe",
  );
  assert.equal(fs.statSync(oversizeIgnore).size, 1024 * 1024 + 1);
  assert.equal(fs.existsSync(path.join(oversizeProject, ".agentlas")), false);

  // v2 form of the v1 monolith source scan: read-only commands must never call
  // project bootstrap. A command is either its own module (scanned) or still in
  // the honest-stop NOT_YET_PORTED list (trivially non-mutating).
  const dispatcher = require("../engine/commands/index.cjs");
  for (const command of ["search", "route", "research", "browser", "whoami", "usage", "doctor"]) {
    const moduleFile = path.join(__dirname, "..", "engine", "commands", `${command}.cjs`);
    if (fs.existsSync(moduleFile)) {
      const commandSource = fs.readFileSync(moduleFile, "utf8");
      assert.doesNotMatch(commandSource, /ensureTerminalProjectForExecutionCli|ensureCoreProjectCli/, `${command} must stay non-mutating`);
    } else {
      assert.ok(
        dispatcher.NOT_YET_PORTED.includes(command),
        `command must exist as a module or an honest stop: ${command}`,
      );
    }
  }

  console.log("project-bootstrap-contract: PASS");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
