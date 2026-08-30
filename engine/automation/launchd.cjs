"use strict";
/*
 * automation/launchd — 앱/창이 꺼져 있어도 자동화를 돌리는 macOS 영속성 (2026-08-06).
 *
 * 배경(오너: "터미널인데 모든 기능이 다 돼야"): 터미널 automation daemon 은 포그라운드
 * setInterval 이라 셸 창을 닫으면 멈춘다 — "데스크탑 없이 자동화가 발동"이 실제론 안 됐다.
 * 데스크탑 electron/launchd/agent.ts 와 같은 방식으로 ~/Library/LaunchAgents 에 plist 를 써서
 * launchctl 로 로드한다. plist 는 coarse StartInterval(기본 300s)마다 `agentlas automation tick`
 * (1회 due 스윕 후 종료)을 poke 한다. DB 가 스케줄 권위이고 plist 는 poke 만 하므로 자동화별
 * plist 동기화가 필요 없다 — 데스크탑과 정확히 같은 계약.
 *
 * ★Label 은 데스크탑("ai.agentlas.automations")과 다르게 둔다("ai.agentlas.cli.automations").
 *   둘 다 설치돼 있어도 공유 DB 의 lease(claimDue)가 이중 실행을 막으므로 공존은 안전하고,
 *   서로의 plist 를 install/uninstall 로 덮지 않게 하려는 것.
 *
 * macOS 전용(launchd). 다른 OS 는 supported:false 로 정직하게 알린다(자동화는 포그라운드
 * `automation daemon` 으로만 — 조용히 안 되는 척하지 않는다).
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

const LABEL = "ai.agentlas.cli.automations";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_PLIST_BYTES = 64 * 1024;
const LAUNCHCTL_TIMEOUT_MS = 10_000;
const LAUNCHCTL_MAX_BUFFER = 64 * 1024;
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 24 * 60 * 60;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0;

function isSupported() { return process.platform === "darwin"; }
function plistPath() { return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`); }
function domainTarget() { return `gui/${os.userInfo().uid}`; }

/** launchd 가 poke 할 CLI 진입점(절대경로). 전역 설치본이든 체크아웃이든 이 파일 기준으로 해석. */
function cliEntry() { return path.resolve(__dirname, "..", "..", "bin", "agentlas.cjs"); }

function samePath(left, right) {
  const a = path.normalize(String(left || ""));
  const b = path.normalize(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameDirectoryIdentity(left, right) {
  return !!left && !!right
    && left.isDirectory() && right.isDirectory()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left, right) {
  return !!left && !!right
    && left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino;
}

function realPath(file) {
  // Keep the normal Win32 spelling for plist paths; the non-native resolver is
  // also available on older supported Node versions.
  return fs.realpathSync(path.resolve(file));
}

function inspectDirectory(directory, label = "directory") {
  const requestedPath = path.resolve(String(directory || ""));
  const stat = fs.lstatSync(requestedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing unsafe ${label}`);
  const realpath = realPath(requestedPath);
  const verified = fs.lstatSync(requestedPath);
  if (!sameDirectoryIdentity(stat, verified)) throw new Error(`${label} changed during inspection`);
  return { requestedPath, stat: verified, realpath };
}

function assertDirectory(info, label = "directory") {
  const current = inspectDirectory(info.requestedPath, label);
  if (!sameDirectoryIdentity(info.stat, current.stat) || !samePath(info.realpath, current.realpath)) {
    throw new Error(`${label} changed during operation`);
  }
  return current;
}

function ensureDirectory(directory, { create = false, mode = DIRECTORY_MODE, restrict = false, label = "directory" } = {}) {
  const requestedPath = path.resolve(String(directory || ""));
  const parentPath = path.dirname(requestedPath);
  const parent = samePath(parentPath, requestedPath)
    ? null
    : inspectDirectory(parentPath, `${label} parent`);
  if (create) {
    let exists = true;
    try { fs.lstatSync(requestedPath); }
    catch (error) {
      if (error && error.code === "ENOENT") exists = false;
      else throw error;
    }
    // Callers provide an already-anchored parent, so one-level creation cannot
    // silently follow a newly swapped parent symlink.
    if (parent) assertDirectory(parent, `${label} parent`);
    if (!exists) fs.mkdirSync(requestedPath, { mode });
  }
  if (parent) assertDirectory(parent, `${label} parent`);
  const before = inspectDirectory(requestedPath, label);
  if (restrict) {
    if (process.platform === "win32") {
      try { fs.chmodSync(requestedPath, mode); } catch { /* Windows/best-effort */ }
    } else {
      let fd = null;
      try {
        fd = fs.openSync(requestedPath, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (!sameDirectoryIdentity(before.stat, opened)) throw new Error(`${label} changed before chmod`);
        fs.fchmodSync(fd, mode);
        const changed = fs.fstatSync(fd);
        if (!sameDirectoryIdentity(before.stat, changed)) throw new Error(`${label} changed during chmod`);
      } catch { /* best-effort; the lstat/realpath checks below still gate use */ }
      finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* preserve boundary checks */ } } }
    }
  }
  if (parent) assertDirectory(parent, `${label} parent`);
  const after = inspectDirectory(requestedPath, label);
  if (!sameDirectoryIdentity(before.stat, after.stat) || !samePath(before.realpath, after.realpath)) {
    throw new Error(`${label} changed during setup`);
  }
  return after;
}

function isStrictChild(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function launchAgentsDirectory({ create = false } = {}) {
  const home = inspectDirectory(os.homedir(), "home directory");
  const library = ensureDirectory(path.join(home.realpath, "Library"), {
    create,
    restrict: false,
    label: "Library directory",
  });
  const launchAgents = ensureDirectory(path.join(library.realpath, "LaunchAgents"), {
    create,
    restrict: true,
    label: "LaunchAgents directory",
  });
  if (!isStrictChild(home.realpath, library.realpath) || !isStrictChild(library.realpath, launchAgents.realpath)) {
    throw new Error("LaunchAgents directory escaped the home boundary");
  }
  assertDirectory(home, "home directory");
  assertDirectory(library, "Library directory");
  assertDirectory(launchAgents, "LaunchAgents directory");
  return { home, library, launchAgents };
}

function launchAgentsLocation(options = {}) {
  const directories = launchAgentsDirectory(options);
  const target = path.join(directories.launchAgents.realpath, `${LABEL}.plist`);
  return { ...directories, target };
}

function inspectPlistTarget(target, { allowMissing = false, allowHardLinks = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("refusing symlink LaunchAgent plist");
  if (!stat.isFile()) throw new Error("refusing non-regular LaunchAgent plist");
  if (!allowHardLinks && stat.nlink !== 1) throw new Error("refusing hard-linked LaunchAgent plist");
  return stat;
}

function assertPlistTarget(target, expected) {
  const current = inspectPlistTarget(target);
  if (!sameFileIdentity(expected, current) || current.nlink !== 1) throw new Error("LaunchAgent plist changed during operation");
  return current;
}

function logPath() {
  const dataDir = path.resolve(String(userDataDir() || ""));
  const data = ensureDirectory(dataDir, { create: true, restrict: true, label: "Agentlas data directory" });
  const logs = ensureDirectory(path.join(data.realpath, "logs"), { create: true, restrict: true, label: "Agentlas log directory" });
  assertDirectory(data, "Agentlas data directory");
  assertDirectory(logs, "Agentlas log directory");
  const file = path.join(logs.realpath, "launchd-automations.log");
  inspectPlistTarget(file, { allowMissing: true });
  return file;
}

function normalizeIntervalSec(value, fallback = 300) {
  let number;
  try { number = Number(value); } catch { number = NaN; }
  if (!Number.isFinite(number)) return fallback;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.trunc(number)));
}

function plistXml(intervalSec = 300) {
  const node = process.execPath;
  const entry = cliEntry();
  const log = logPath();
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${esc(node)}</string>`,
    `    <string>${esc(entry)}</string>`,
    "    <string>automation</string>",
    "    <string>tick</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${normalizeIntervalSec(intervalSec)}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LowPriorityIO</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${esc(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${esc(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  if (Buffer.byteLength(xml, "utf8") > MAX_PLIST_BYTES) throw new Error("LaunchAgent plist is too large");
  return xml;
}

/** launchctl 실행 — throw 하지 않고 {code, stderr} 반환(상태 함수가 판정). */
function launchctl(args) {
  try {
    const res = spawnSync("launchctl", args, {
      encoding: "utf8",
      timeout: LAUNCHCTL_TIMEOUT_MS,
      maxBuffer: LAUNCHCTL_MAX_BUFFER,
    });
    const stderr = String(res && (res.stderr || res.error?.message || "") || "").slice(0, LAUNCHCTL_MAX_BUFFER).trim();
    return { code: res && Number.isInteger(res.status) ? res.status : -1, stderr };
  } catch (error) {
    return { code: -1, stderr: String((error && error.message) || error).slice(0, LAUNCHCTL_MAX_BUFFER).trim() };
  }
}

function isLoaded() {
  if (!isSupported()) return false;
  return launchctl(["print", `${domainTarget()}/${LABEL}`]).code === 0;
}

function writeAll(fd, payload) {
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(fd, payload, offset, payload.length - offset);
    if (!written) throw new Error("failed to write LaunchAgent plist");
    offset += written;
  }
}

function tempPath(directory, suffix) {
  return path.join(directory.realpath, `.${LABEL}.${process.pid}.${cryptoRandomId()}.${suffix}`);
}

function cryptoRandomId() {
  // LaunchAgent paths are local-only, but a random name keeps recovery files
  // from colliding with a user's own dotfiles or another CLI process.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function writePlistTemp(directory, xml) {
  const payload = Buffer.from(xml, "utf8");
  if (payload.length > MAX_PLIST_BYTES) throw new Error("LaunchAgent plist is too large");
  const temporary = tempPath(directory, "tmp");
  let fd = null;
  let created = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, FILE_MODE);
    try { fs.fchmodSync(fd, FILE_MODE); } catch { /* Windows/best-effort */ }
    created = fs.fstatSync(fd);
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) throw new Error("unsafe LaunchAgent plist temporary file");
    writeAll(fd, payload);
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (!sameFileIdentity(created, written) || written.nlink !== 1 || written.size !== payload.length) {
      throw new Error("LaunchAgent plist temporary file changed during write");
    }
    fs.closeSync(fd);
    fd = null;
    assertDirectory(directory, "LaunchAgents directory");
    return { path: temporary, stat: written };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* preserve original */ }
    }
    // Never unlink a pathname which may have been replaced after our fd was
    // opened.  An unknown temp successor is a recovery artifact, not ours.
    if (created) {
      try {
        const current = inspectPlistTarget(temporary, { allowMissing: true });
        if (current && sameFileIdentity(created, current) && current.nlink === 1) fs.unlinkSync(temporary);
      } catch { /* best-effort; recovery path remains */ }
    }
    throw error;
  }
}

function removeKnownFile(file, expected, directory) {
  assertDirectory(directory, "LaunchAgents directory");
  const current = assertPlistTarget(file, expected);
  if (current.nlink !== 1) throw new Error("LaunchAgent plist became hard-linked");
  fs.unlinkSync(file);
  assertDirectory(directory, "LaunchAgents directory");
}

function restoreQuarantinedFile(location, quarantine) {
  let quarantined;
  try { quarantined = inspectPlistTarget(quarantine); } catch { return false; }
  try {
    // A directory swap can make the original boundary unverifiable, but the
    // recovery path is still safe to use if the destination is absent: link(2)
    // is no-replace, and the inode check below prevents restoring an unknown
    // successor.  Do not require the unsafe directory assertion here or a
    // victim moved by a race would be stranded under the quarantine name.
    try { assertDirectory(location.launchAgents, "LaunchAgents directory"); } catch { /* recovery may cross a detected swap */ }
    const target = inspectPlistTarget(location.target, { allowMissing: true });
    if (target) return false;
    fs.linkSync(quarantine, location.target);
    const restored = fs.lstatSync(location.target);
    if (!sameFileIdentity(quarantined, restored) || restored.nlink < 2) return false;
    fs.unlinkSync(quarantine);
    const final = inspectPlistTarget(location.target);
    return sameFileIdentity(quarantined, final) && final.nlink === 1;
  } catch {
    return false;
  }
}

function writePlistAtomic(location, xml) {
  if (Buffer.byteLength(xml, "utf8") > MAX_PLIST_BYTES) throw new Error("LaunchAgent plist is too large");
  assertDirectory(location.launchAgents, "LaunchAgents directory");
  const expected = inspectPlistTarget(location.target, { allowMissing: true });
  assertDirectory(location.launchAgents, "LaunchAgents directory");
  const temporary = writePlistTemp(location.launchAgents, xml);
  let published = false;
  let quarantine = null;
  try {
    assertDirectory(location.launchAgents, "LaunchAgents directory");
    const current = inspectPlistTarget(location.target, { allowMissing: true });
    if (expected && (!current || !sameFileIdentity(expected, current) || current.nlink !== 1)) {
      throw new Error("LaunchAgent plist changed before update");
    }
    if (!expected && current) throw new Error("LaunchAgent plist successor appeared during install");

    if (expected) {
      quarantine = tempPath(location.launchAgents, "previous");
      // Move the known inode to a private recovery path. If a successor won
      // the pathname race, the post-rename identity check restores it without
      // overwriting the successor or losing the previous plist.
      fs.renameSync(location.target, quarantine);
      const moved = inspectPlistTarget(quarantine);
      if (!sameFileIdentity(expected, moved) || moved.nlink !== 1) {
        restoreQuarantinedFile(location, quarantine);
        throw new Error("LaunchAgent plist successor replaced the expected file");
      }
      assertDirectory(location.launchAgents, "LaunchAgents directory");
      if (inspectPlistTarget(location.target, { allowMissing: true })) {
        throw new Error("LaunchAgent plist successor appeared during update");
      }
    }

    // link(2) is atomic and no-replace. A successor that appears after the
    // preflight therefore causes EEXIST instead of being silently clobbered.
    fs.linkSync(temporary.path, location.target);
    published = true;
    assertDirectory(location.launchAgents, "LaunchAgents directory");
    const linked = fs.lstatSync(location.target);
    if (!sameFileIdentity(temporary.stat, linked) || linked.nlink < 2) throw new Error("LaunchAgent plist identity changed after publish");
    const linkedTemporary = inspectPlistTarget(temporary.path, { allowHardLinks: true });
    if (!sameFileIdentity(temporary.stat, linkedTemporary) || linkedTemporary.nlink < 2) {
      throw new Error("LaunchAgent plist temporary file changed after publish");
    }
    assertDirectory(location.launchAgents, "LaunchAgents directory");
    fs.unlinkSync(temporary.path);
    published = false;
    const installed = inspectPlistTarget(location.target);
    if (!sameFileIdentity(temporary.stat, installed) || installed.nlink !== 1) throw new Error("LaunchAgent plist identity changed after publish");
    if (quarantine) {
      const previous = inspectPlistTarget(quarantine);
      removeKnownFile(quarantine, previous, location.launchAgents);
      quarantine = null;
    }
    assertDirectory(location.launchAgents, "LaunchAgents directory");
  } catch (error) {
    if (published) {
      // If the directory was swapped after the no-replace link, the target
      // pathname may now resolve through an unsafe successor directory.  Only
      // unlink it when the inode is still exactly our temporary file; never
      // remove a replacement merely because it occupies the same pathname.
      try {
        const current = inspectPlistTarget(location.target, { allowMissing: true });
        if (current && sameFileIdentity(temporary.stat, current) && current.nlink >= 2) {
          fs.unlinkSync(location.target);
          published = false;
        }
      } catch { /* leave an unknown successor and recovery artifact intact */ }
    }
    if (!published) {
      try {
        const current = inspectPlistTarget(temporary.path, { allowMissing: true });
        if (current && sameFileIdentity(temporary.stat, current) && current.nlink === 1) {
          fs.unlinkSync(temporary.path);
        }
      } catch { /* leave the temp as a recovery artifact if the boundary moved */ }
    }
    // A quarantine is deliberately retained when publication/update fails so
    // an operator can restore the previous plist without guessing its bytes.
    throw error;
  }
}

function removePlistSafely(location) {
  assertDirectory(location.launchAgents, "LaunchAgents directory");
  const expected = inspectPlistTarget(location.target, { allowMissing: true });
  if (!expected) return;
  const quarantine = tempPath(location.launchAgents, "disabled");
  assertDirectory(location.launchAgents, "LaunchAgents directory");
  fs.renameSync(location.target, quarantine);
  const moved = inspectPlistTarget(quarantine);
  if (!sameFileIdentity(expected, moved) || moved.nlink !== 1) {
    restoreQuarantinedFile(location, quarantine);
    throw new Error("LaunchAgent plist successor replaced the expected file");
  }
  assertDirectory(location.launchAgents, "LaunchAgents directory");
  if (inspectPlistTarget(location.target, { allowMissing: true })) {
    throw new Error("LaunchAgent plist successor appeared during removal");
  }
  removeKnownFile(quarantine, moved, location.launchAgents);
}

function launchdStatus() {
  const supported = isSupported();
  let installed = false;
  if (supported) {
    try {
      const location = launchAgentsLocation({ create: false });
      const target = inspectPlistTarget(location.target, { allowMissing: true });
      assertDirectory(location.launchAgents, "LaunchAgents directory");
      installed = !!target;
    } catch { /* unsafe/missing path is not an installed LaunchAgent */ }
  }
  return {
    supported,
    installed: supported && installed,
    loaded: supported && isLoaded(),
    plistPath: plistPath(),
    label: LABEL,
    entry: cliEntry(),
  };
}

/** plist 작성 + launchctl bootstrap 로드(멱등 — 이미 로드면 bootout 후 재로드). */
function enableLaunchd({ intervalSec = 300 } = {}) {
  if (!isSupported()) return { ...launchdStatus(), error: "launchd persistence is macOS-only." };
  let location;
  try {
    location = launchAgentsLocation({ create: true });
    writePlistAtomic(location, plistXml(intervalSec));
  } catch (err) {
    return { ...launchdStatus(), error: `failed to write plist: ${String(err)}` };
  }
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  const res = launchctl(["bootstrap", domainTarget(), location.target]);
  if (res.code !== 0 && !isLoaded()) {
    return { ...launchdStatus(), error: res.stderr || "launchctl bootstrap failed." };
  }
  return launchdStatus();
}

/** launchctl bootout + plist 삭제. */
function disableLaunchd() {
  if (!isSupported()) return launchdStatus();
  let location;
  try {
    location = launchAgentsLocation({ create: false });
    removePlistSafely(location);
  } catch (err) {
    if (err && err.code === "ENOENT") return launchdStatus();
    return { ...launchdStatus(), error: `failed to remove plist: ${String(err)}` };
  }
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  return launchdStatus();
}

module.exports = {
  LABEL, plistPath, plistXml, cliEntry, isSupported,
  launchdStatus, enableLaunchd, disableLaunchd,
};
