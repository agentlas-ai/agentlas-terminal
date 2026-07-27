"use strict";
/*
 * project/state — .agentlas/ 비공개 프로젝트 상태 경계 (v1 monolith 8340–8690 포팅).
 *
 * 비타협 계약 (0.9.10 경계):
 *  1. .agentlas/ 는 개인정보다. 절대 커밋/업로드되지 않는다 — .gitignore의
 *     surgical marker 블록(# >>> agentlas local project state >>>)이 그 제품 장치다.
 *  2. 어떤 일반 실행도 사용자 프로젝트에 .agentlas/ 를 자동 생성하지 않는다.
 *     생성 권한은 `agentlas project init`(initializeTerminalProjectCli) 단 하나.
 *     write/full 권한은 "요청된 작업"에 대한 권한이지 폴더 초기화 동의가 아니다.
 *  3. 부트스트랩은 fail-closed: 심볼릭 링크가 섞인 .agentlas, 심볼릭 링크/1MB 초과
 *     .gitignore 처럼 프라이버시 경계를 보증할 수 없는 상태면 던진다(생성 금지).
 *  4. Core 런타임이 있으면 canonical 시드는 Core(project_bootstrap.py)가 소유하고,
 *     없을 때만 레거시 로컬 시드(seed.cjs)로 폴백한다 — 폴백은 프로세스 한정 캐시.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
const { tableExists } = require("../core/db.cjs");
const {
  CONTEXT_MAP_MIN_CORE_VERSION,
  captureCoreJsonSync,
  resolveCoreRuntimeRoot,
} = require("../agentlas-core-harness.cjs");
const { runCwd } = require("./paths.cjs");
const { ensureProjectMemoryCli } = require("./seed.cjs");

const AGENTLAS_PROJECT_STATE_IGNORE_START = "# >>> agentlas local project state >>>";
const AGENTLAS_PROJECT_STATE_IGNORE_END = "# <<< agentlas local project state <<<";
const AGENTLAS_GITIGNORE_MAX_BYTES = 1024 * 1024;
const projectBootstrapStates = new Map();

function terminalProjectCandidateCli(projectPath) {
  try {
    const root = path.resolve(projectPath || process.cwd());
    const unsafe = new Set([
      path.resolve(os.homedir()),
      path.parse(root).root,
      path.resolve(userDataDir()),
      path.resolve(runCwd()),
    ]);
    if (unsafe.has(root)) return null;
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return null;
    return root;
  } catch {
    return null;
  }
}

function assertNoSymlinkInAgentlasStateCli(stateDir) {
  const pending = [stateDir];
  let visited = 0;
  while (pending.length && visited < 4096) {
    const current = pending.pop();
    visited += 1;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(".agentlas local state must not contain symbolic links");
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    }
  }
  if (pending.length) throw new Error(".agentlas local state exceeds the safe bootstrap inspection limit");
}

function readRegularUtf8FileNoFollowCli(filePath, maxBytes = AGENTLAS_GITIGNORE_MAX_BYTES) {
  let before;
  try { before = fs.lstatSync(filePath); } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, content: "", mode: 0o644, stat: null };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(".gitignore must be a regular non-symbolic-link file");
  if (before.size > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(error && error.code)) throw error;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(".gitignore changed type during bootstrap");
    if (opened.size > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);
    if (
      Number.isFinite(before.dev) && Number.isFinite(before.ino) &&
      (before.dev !== opened.dev || before.ino !== opened.ino)
    ) {
      throw new Error(".gitignore changed during bootstrap");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(".gitignore changed while it was being read");
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); } catch {
      throw new Error(".gitignore must contain valid UTF-8 text");
    }
    return { exists: true, content, mode: before.mode & 0o777, stat: before };
  } finally {
    fs.closeSync(fd);
  }
}

function assertFileSnapshotUnchangedCli(filePath, snapshot) {
  if (!snapshot.exists) {
    try {
      fs.lstatSync(filePath);
      throw new Error(".gitignore appeared during bootstrap");
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
  }
  const current = fs.lstatSync(filePath);
  if (current.isSymbolicLink() || !current.isFile()) throw new Error(".gitignore changed type during bootstrap");
  const original = snapshot.stat;
  if (
    !original || current.dev !== original.dev || current.ino !== original.ino ||
    current.size !== original.size || current.mtimeMs !== original.mtimeMs
  ) {
    throw new Error(".gitignore changed during bootstrap");
  }
}

function replaceRegularFileCli(tempPath, destinationPath, snapshot) {
  try {
    fs.renameSync(tempPath, destinationPath);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !snapshot.exists || !["EEXIST", "EPERM", "EACCES"].includes(error && error.code)) {
      throw error;
    }
  }

  // Windows can reject replacement of an existing file. Keep a same-directory
  // rollback copy so an interrupted replacement never silently loses user rules.
  assertFileSnapshotUnchangedCli(destinationPath, snapshot);
  const backup = `${destinationPath}.agentlas-${process.pid}-${crypto.randomUUID()}.bak`;
  fs.renameSync(destinationPath, backup);
  try {
    fs.renameSync(tempPath, destinationPath);
  } catch (error) {
    try {
      if (!fs.existsSync(destinationPath)) fs.renameSync(backup, destinationPath);
    } catch { /* preserve the original error and leave the backup recoverable */ }
    throw error;
  }
  try { fs.unlinkSync(backup); } catch { /* a harmless rollback copy may remain on locked Windows hosts */ }
}

function ensureAgentlasProjectStateIgnoreCli(projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) throw new Error("refusing to initialize an unsafe Agentlas project root");
  const stateDir = path.join(root, ".agentlas");
  let stateExists = false;
  try {
    const state = fs.lstatSync(stateDir);
    stateExists = true;
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(".agentlas must be a real directory");
    assertNoSymlinkInAgentlasStateCli(stateDir);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  const gitignorePath = path.join(root, ".gitignore");
  const snapshot = readRegularUtf8FileNoFollowCli(gitignorePath);
  const existing = snapshot.content;
  const mode = snapshot.mode || 0o644;

  let next = existing;
  const start = existing.indexOf(AGENTLAS_PROJECT_STATE_IGNORE_START);
  const end = start >= 0 ? existing.indexOf(AGENTLAS_PROJECT_STATE_IGNORE_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const blockEnd = end + AGENTLAS_PROJECT_STATE_IGNORE_END.length;
    const block = existing.slice(start, blockEnd);
    if (!/^\.agentlas\/$/m.test(block)) {
      next = `${existing.slice(0, start)}${block.replace(AGENTLAS_PROJECT_STATE_IGNORE_START, `${AGENTLAS_PROJECT_STATE_IGNORE_START}\n.agentlas/`)}${existing.slice(blockEnd)}`;
    }
  } else {
    const block = `${AGENTLAS_PROJECT_STATE_IGNORE_START}\n.agentlas/\n${AGENTLAS_PROJECT_STATE_IGNORE_END}\n`;
    next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  }
  if (next !== existing) {
    const temp = path.join(root, `.gitignore.agentlas-${process.pid}-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, next.endsWith("\n") ? next : `${next}\n`, { encoding: "utf8", mode, flag: "wx" });
    try {
      assertFileSnapshotUnchangedCli(gitignorePath, snapshot);
      replaceRegularFileCli(temp, gitignorePath, snapshot);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      throw error;
    }
  }
  if (!stateExists) fs.mkdirSync(stateDir, { recursive: false, mode: 0o700 });
  assertNoSymlinkInAgentlasStateCli(stateDir);
  try { fs.chmodSync(stateDir, 0o700); } catch { /* Windows/best effort */ }
}

function hardenAgentlasProjectStateCli(projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return;
  const stateDir = path.join(root, ".agentlas");
  const pending = [stateDir];
  let visited = 0;
  while (pending.length && visited < 4096) {
    const current = pending.pop();
    visited += 1;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        try { fs.chmodSync(current, 0o700); } catch { /* Windows/best effort */ }
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile()) {
        try { fs.chmodSync(current, 0o600); } catch { /* Windows/best effort */ }
      }
    } catch { /* disappearing files and ACL-only hosts are best effort */ }
  }
}

function ensureCoreProjectCli(projectPath, options = {}) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) throw new Error("Agentlas project bootstrap requires a real project directory");
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  ensureAgentlasProjectStateIgnoreCli(root);
  const cached = projectBootstrapStates.get(root);
  if (cached && fs.existsSync(path.join(root, ".agentlas", "project-soul-memory.md"))) {
    return cached === "core";
  }
  projectBootstrapStates.delete(root);
  /*
   * 프로젝트 부트스트랩의 능력 판정은 minVersion이 아니라 실제 모듈 존재
   * (agentlas_cloud/project_bootstrap.py)다. 버전 메타데이터가 없는 소스
   * 체크아웃(CI가 Agentlas-OS를 특정 커밋으로 받는 경우)에서 minVersion 게이트가
   * 정상 Core를 걸러 부트스트랩이 통째로 스킵됐다(v1.0.0 태그 CI 실패의 진범).
   * minVersion은 context-map 능력 경로에만 적용한다.
   */
  const coreRoot = resolveCoreRuntimeRoot(options.coreRoot);
  const hasCanonicalBootstrap = Boolean(
    coreRoot && fs.existsSync(path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py")),
  );
  if (hasCanonicalBootstrap) {
    const result = captureCoreJsonSync(
      "agentlas_cloud",
      ["project", "ensure", "--project", root, "--reason", options.reason || "terminal-first-contact"],
      { cwd: root },
      coreRoot,
    );
    const canonical = Boolean(
      result
      && result.schemaVersion === "agentlas.project-bootstrap.v1"
      && ["active", "privacy_warning"].includes(result.status)
      && result.mergeOnly === true
      && result.privacyBlockInstalled === true
      && result.privateModeCompliant === true
      && Array.isArray(result.missing)
      && result.missing.length === 0
      && Array.isArray(result.overwritten)
      && result.overwritten.length === 0
      && Array.isArray(result.permissionIssues)
      && result.permissionIssues.length === 0
    );
    if (canonical) {
      // Core owns the canonical seed. Terminal adds one intentionally broader
      // guard so future local memory files are private without a release update.
      ensureAgentlasProjectStateIgnoreCli(root);
      hardenAgentlasProjectStateCli(root);
      projectBootstrapStates.set(root, "core");
      return true;
    }
    throw new Error("Agentlas Core returned an incomplete project bootstrap contract");
  }
  // A just-updated Terminal can briefly see the previous Core. The legacy
  // merge-only seed remains local-only and Core is retried next process.
  ensureProjectMemoryCli(root);
  if (!fs.existsSync(path.join(root, ".agentlas"))) {
    throw new Error("Agentlas project bootstrap could not create private local state");
  }
  ensureAgentlasProjectStateIgnoreCli(root);
  hardenAgentlasProjectStateCli(root);
  projectBootstrapStates.set(root, "fallback");
  return false;
}

// Passive checks never increment visits or touch the project. Activation is
// reserved for the explicit project-initialization boundary.
function recordCliFolderVisit(db, projectPath, options = {}) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return { activated: false };
  const activate = options.activate === true;
  try {
    if (!activate) {
      const row = tableExists(db, "folder_activity")
        ? db.prepare("SELECT activated_at FROM folder_activity WHERE path=?").get(root)
        : null;
      return { activated: Boolean(row && row.activated_at) || fs.existsSync(path.join(root, ".agentlas")) };
    }

    ensureCoreProjectCli(root, { reason: options.reason || "terminal-first-contact", coreRoot: options.coreRoot });
    if (!tableExists(db, "folder_activity")) return { activated: true };
    const now = new Date().toISOString();
    const row = db.prepare("SELECT visits FROM folder_activity WHERE path=?").get(root);
    if (row) {
      db.prepare("UPDATE folder_activity SET visits=?, activated_at=COALESCE(activated_at,?), last_seen=? WHERE path=?")
        .run(Number(row.visits || 0) + 1, now, now, root);
    } else {
      db.prepare("INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?,?,?,?,?)")
        .run(root, 1, now, now, now);
    }
    return { activated: true };
  } catch (error) {
    // An activation failure can mean that the project-local privacy boundary
    // could not be established (for example, a symlinked or oversized
    // .gitignore). Explicit initialization must fail closed in that state.
    if (activate) throw error;
    return { activated: false };
  }
}

function activeProjectPath(db, options = {}) {
  const root = terminalProjectCandidateCli(options.projectPath || process.cwd());
  if (!root) return null;
  const result = recordCliFolderVisit(db, root, options);
  return result.activated ? root : null;
}

// v1 시그니처 보존: permission/reason은 받되 절대 초기화 권한으로 쓰지 않는다.
function ensureTerminalProjectForExecutionCli(db, projectPath, permission = "write", reason = "terminal-first-contact") {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return null;
  // Every ordinary execution mode is passive. Only `agentlas project init`
  // may create .agentlas state or edit .gitignore; write/full permission is
  // authority for the requested task, not consent to initialize the folder.
  void permission;
  void reason;
  const active = activeProjectPath(db, { projectPath: root });
  if (!active) return null;
  return initializedAgentlasProjectPathCli(root);
}

function initializedAgentlasProjectPathCli(projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return null;
  try {
    const stateDir = path.join(root, ".agentlas");
    const soul = path.join(stateDir, "project-soul-memory.md");
    const ignore = readRegularUtf8FileNoFollowCli(path.join(root, ".gitignore")).content;
    if (!fs.existsSync(soul) || !ignore.includes(AGENTLAS_PROJECT_STATE_IGNORE_START) || !/^\.agentlas\/$/m.test(ignore)) {
      return null;
    }
    assertNoSymlinkInAgentlasStateCli(stateDir);
    return root;
  } catch {
    return null;
  }
}

function initializeTerminalProjectCli(db, projectPath, reason = "terminal-explicit-project-init", options = {}) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) throw new Error("Agentlas project initialization requires a safe project directory");
  return activeProjectPath(db, {
    projectPath: root,
    activate: true,
    reason,
    coreRoot: options.coreRoot,
  });
}

module.exports = {
  AGENTLAS_PROJECT_STATE_IGNORE_START,
  AGENTLAS_PROJECT_STATE_IGNORE_END,
  AGENTLAS_GITIGNORE_MAX_BYTES,
  terminalProjectCandidateCli,
  assertNoSymlinkInAgentlasStateCli,
  readRegularUtf8FileNoFollowCli,
  assertFileSnapshotUnchangedCli,
  replaceRegularFileCli,
  ensureAgentlasProjectStateIgnoreCli,
  hardenAgentlasProjectStateCli,
  ensureCoreProjectCli,
  recordCliFolderVisit,
  activeProjectPath,
  ensureTerminalProjectForExecutionCli,
  initializedAgentlasProjectPathCli,
  initializeTerminalProjectCli,
};
