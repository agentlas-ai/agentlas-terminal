"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTool } = require("../engine/agentlas-tools.cjs");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-tool-boundary-"));
const workspace = path.join(fixture, "workspace");
const outside = path.join(fixture, "outside");
fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(workspace, "docs", "guide.md"), "alpha\n", "utf8");
fs.writeFileSync(path.join(workspace, "docs", "file..md"), "valid dots\n", "utf8");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret\n", "utf8");

const readCtx = { cwd: workspace, permission: "read" };
const writeCtx = { cwd: workspace, permission: "write" };

function expectAllowed(name, args, ctx = readCtx) {
  const result = runTool(name, args, ctx);
  assert.equal(result.ok, true, `${name} unexpectedly failed: ${result.content}`);
  return result.content;
}

function expectDenied(name, args, ctx = readCtx) {
  const result = runTool(name, args, ctx);
  assert.equal(result.ok, false, `${name} unexpectedly escaped the workspace`);
  assert.match(result.content, /workspace path denied:/, `${name} did not use the workspace boundary`);
  return result.content;
}

try {
  // Normal workspace-relative reads, creates, and edits must keep working.
  assert.equal(expectAllowed("read_file", { path: "docs/guide.md" }), "alpha\n");
  assert.equal(expectAllowed("read_file", { path: "docs/file..md" }), "valid dots\n");
  assert.match(expectAllowed("list_dir", { path: "docs" }), /guide\.md/);
  expectAllowed("write_file", { path: "notes/new.md", content: "draft\n" }, writeCtx);
  expectAllowed(
    "edit_file",
    { path: "notes/new.md", old_string: "draft", new_string: "ready" },
    writeCtx,
  );
  assert.equal(fs.readFileSync(path.join(workspace, "notes", "new.md"), "utf8"), "ready\n");

  const outsideSecret = path.join(outside, "secret.txt");
  const originalSecret = fs.readFileSync(outsideSecret, "utf8");

  // All absolute path dialects are denied, including an absolute path that
  // happens to point back into the workspace.
  for (const [name, args, ctx] of [
    ["list_dir", { path: outside }, readCtx],
    ["read_file", { path: outsideSecret }, readCtx],
    ["read_file", { path: path.join(workspace, "docs", "guide.md") }, readCtx],
    ["write_file", { path: outsideSecret, content: "changed\n" }, writeCtx],
    ["edit_file", { path: outsideSecret, old_string: "outside", new_string: "changed" }, writeCtx],
    ["read_file", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" }, readCtx],
    ["read_file", { path: "C:relative-drive-path.txt" }, readCtx],
    ["read_file", { path: "\\\\server\\share\\secret.txt" }, readCtx],
  ]) {
    expectDenied(name, args, ctx);
  }
  assert.equal(fs.readFileSync(outsideSecret, "utf8"), originalSecret, "absolute path changed outside data");

  // A parent segment is denied before normalization, even if it would land
  // back inside the workspace or uses the other platform's separator.
  for (const [name, args, ctx] of [
    ["list_dir", { path: "../outside" }, readCtx],
    ["read_file", { path: "../outside/secret.txt" }, readCtx],
    ["read_file", { path: "docs/../docs/guide.md" }, readCtx],
    ["read_file", { path: "..\\outside\\secret.txt" }, readCtx],
    ["write_file", { path: "../outside/created.txt", content: "escape\n" }, writeCtx],
    ["edit_file", { path: "../outside/secret.txt", old_string: "outside", new_string: "changed" }, writeCtx],
  ]) {
    expectDenied(name, args, ctx);
  }
  assert.equal(fs.existsSync(path.join(outside, "created.txt")), false, "traversal created an outside file");
  assert.equal(fs.readFileSync(outsideSecret, "utf8"), originalSecret, "traversal changed outside data");

  const outsideLink = path.join(workspace, "outside-link");
  const insideLink = path.join(workspace, "inside-link");
  fs.symlinkSync(outside, outsideLink, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(path.join(workspace, "docs"), insideLink, process.platform === "win32" ? "junction" : "dir");

  // Existing targets and not-yet-created descendants cannot escape through a
  // directory symlink. The denied create must have no mkdir side effect.
  expectDenied("list_dir", { path: "outside-link" });
  expectDenied("read_file", { path: "outside-link/secret.txt" });
  expectDenied("write_file", { path: "outside-link/new/deep.txt", content: "escape\n" }, writeCtx);
  expectDenied(
    "edit_file",
    { path: "outside-link/secret.txt", old_string: "outside", new_string: "changed" },
    writeCtx,
  );
  assert.equal(fs.existsSync(path.join(outside, "new")), false, "symlink escape created outside directories");
  assert.equal(fs.readFileSync(outsideSecret, "utf8"), originalSecret, "symlink escape changed outside data");

  // In-workspace symlinks remain valid and resolve to their canonical target.
  assert.equal(expectAllowed("read_file", { path: "inside-link/guide.md" }), "alpha\n");
  expectAllowed("write_file", { path: "inside-link/linked-write.md", content: "inside\n" }, writeCtx);
  expectAllowed(
    "edit_file",
    { path: "inside-link/linked-write.md", old_string: "inside", new_string: "safe" },
    writeCtx,
  );
  assert.equal(fs.readFileSync(path.join(workspace, "docs", "linked-write.md"), "utf8"), "safe\n");

  // A hard link shares an inode even though both paths are lexically valid.
  // Writes and edits must replace the workspace entry, not mutate the outside inode.
  if (process.platform !== "win32") {
    const hardWrite = path.join(workspace, "hard-write.txt");
    fs.linkSync(outsideSecret, hardWrite);
    expectAllowed("write_file", { path: "hard-write.txt", content: "workspace-only\n" }, writeCtx);
    assert.equal(fs.readFileSync(hardWrite, "utf8"), "workspace-only\n");
    assert.equal(fs.readFileSync(outsideSecret, "utf8"), originalSecret, "hard-link write changed outside data");

    const hardEdit = path.join(workspace, "hard-edit.txt");
    fs.linkSync(outsideSecret, hardEdit);
    expectAllowed(
      "edit_file",
      { path: "hard-edit.txt", old_string: "outside", new_string: "workspace" },
      writeCtx,
    );
    assert.match(fs.readFileSync(hardEdit, "utf8"), /workspace-secret/);
    assert.equal(fs.readFileSync(outsideSecret, "utf8"), originalSecret, "hard-link edit changed outside data");
  }

  const executable = path.join(workspace, "script.sh");
  fs.writeFileSync(executable, "#!/bin/sh\necho old\n", { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  expectAllowed(
    "edit_file",
    { path: "script.sh", old_string: "old", new_string: "new" },
    writeCtx,
  );
  assert.equal(fs.statSync(executable).mode & 0o777, 0o755, "atomic edit stripped executable mode bits");
  expectAllowed("write_file", { path: "script.sh", content: "#!/bin/sh\necho overwritten\n" }, writeCtx);
  assert.equal(fs.statSync(executable).mode & 0o777, 0o755, "atomic overwrite stripped executable mode bits");

  if (process.platform !== "win32") {
    const outsideFileLink = path.join(workspace, "outside-file-link");
    fs.symlinkSync(outsideSecret, outsideFileLink, "file");
    expectDenied("read_file", { path: "outside-file-link" });
    expectDenied("write_file", { path: "outside-file-link", content: "changed\n" }, writeCtx);
    expectDenied(
      "edit_file",
      { path: "outside-file-link", old_string: "outside", new_string: "changed" },
      writeCtx,
    );

    const brokenLink = path.join(workspace, "broken-link");
    fs.symlinkSync(path.join(outside, "missing-target"), brokenLink, "dir");
    expectDenied("write_file", { path: "broken-link/file.txt", content: "no\n" }, writeCtx);
    assert.equal(fs.existsSync(path.join(outside, "missing-target")), false, "broken symlink created an outside target");
  }

  for (const invalidPath of ["", 42, "bad\0path"]) {
    expectDenied("read_file", { path: invalidPath });
  }

  console.log("tool workspace boundary: PASS");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
