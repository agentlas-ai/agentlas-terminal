"use strict";
/*
 * oberon/render — 헤드리스 렌더 스폰 + 진행률 스트리밍.
 * v1 §12360-12471 (oberonRender / oberonRenderLine) 충실 포팅.
 *
 * 렌더 경로가 실제로 필요로 하는 것 (v1 계약):
 *  - <packageRoot>/scripts/render-oberon-live-request.cjs  (헤드리스 렌더 진입 스크립트)
 *  - <packageRoot>/dist/electron/oberon/render.js          (Electron 렌더 빌드 산출물)
 *  둘 다 Desktop 쪽 Electron 빌드 산출물이며 터미널 npm 패키지에는 실려 있지 않다.
 *  v1도 fs.existsSync 검사 후 정직하게 실패했다 — 렌더를 가짜로 성공시키지 않는다.
 *
 * v2 seam: 렌더 진입점 해석과 spawn은 deps 파라미터로 주입 가능하다.
 *   deps.resolveRenderEntry() → { script, builtRender }
 *   deps.spawn / deps.execPath / deps.stdout / deps.stderr
 *  테스트는 가짜 렌더 스크립트를 주입해 프로토콜(POLL/FILE/DELIVERY 라인)을 검증하고,
 *  실제 배포에서는 진입점이 없으면 v1과 동일한 메시지로 정직 정지한다.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { spawn } = require("node:child_process");
const { packageRoot } = require("../core/paths.cjs");
const { fail, parseFlags, oberonBar, oberonBytes, slugifyOberon } = require("./common.cjs");

const MAX_OBERON_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_OBERON_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_OBERON_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_OBERON_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_OBERON_STDERR_BYTES = 4 * 1024 * 1024;
const MAX_OBERON_LINE_BYTES = 256 * 1024;
const MAX_OBERON_FILES = 512;
const MAX_OBERON_FIELD_BYTES = 4 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const BOOTSTRAP_SOURCE = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

function readFdAt(fd, size) {
  const out = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, out, offset, size - offset, offset);
    if (!count) throw new Error("bound Oberon source ended before its verified length");
    offset += count;
  }
  return out.toString("utf8");
}

function createModule(filename) {
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.path = path.dirname(filename);
  mod.paths = Module._nodeModulePaths(mod.path);
  return mod;
}

function cacheModule(filename, mod) {
  Module._cache[filename] = mod;
  try { Module._cache[fs.realpathSync(filename)] = mod; } catch { /* bound source may have no live pathname */ }
}

function compile(filename, source) {
  const mod = createModule(filename);
  cacheModule(filename, mod);
  mod._compile(source, filename);
  mod.loaded = true;
  return mod;
}

const scriptPath = process.env.AGENTLAS_OBERON_SCRIPT_PATH;
const builtPath = process.env.AGENTLAS_OBERON_BUILT_PATH;
const scriptFd = Number(process.env.AGENTLAS_OBERON_SCRIPT_FD);
const builtFd = Number(process.env.AGENTLAS_OBERON_BUILT_FD);
const scriptBytes = Number(process.env.AGENTLAS_OBERON_SCRIPT_BYTES);
const builtBytes = Number(process.env.AGENTLAS_OBERON_BUILT_BYTES);
if (!scriptPath || !builtPath || !Number.isSafeInteger(scriptFd) || !Number.isSafeInteger(builtFd) ||
    !Number.isSafeInteger(scriptBytes) || !Number.isSafeInteger(builtBytes) || scriptBytes < 1 || builtBytes < 1) {
  throw new Error("bound Oberon execution inputs are incomplete");
}
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === scriptPath || request === builtPath) return request;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
const main = createModule(scriptPath);
process.mainModule = main;
require.main = main;
process.argv[1] = scriptPath;
cacheModule(scriptPath, main);
compile(builtPath, readFdAt(builtFd, builtBytes));
main._compile(readFdAt(scriptFd, scriptBytes), scriptPath);
main.loaded = true;
`;

function regularSnapshot(stat) {
  return stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    ? stat
    : null;
}

function sameFileSnapshot(left, right) {
  return Boolean(
    regularSnapshot(left) && regularSnapshot(right) &&
    left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs,
  );
}

function sameFileIdentity(left, right) {
  return Boolean(
    regularSnapshot(left) && regularSnapshot(right) &&
    left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs,
  );
}

function readFdBounded(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (!count) break;
    chunks.push(buffer.subarray(0, count));
    total += count;
  }
  return Buffer.concat(chunks, total);
}

function decodeUtf8(buffer, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { fail(`${label} must contain valid UTF-8`); }
}

function readVerifiedFile(file, label, maxBytes) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === "ENOENT") throw error;
    throw new Error(`${label} could not be inspected: ${error.message}`);
  }
  if (!regularSnapshot(before) || before.size <= 0 || before.size > maxBytes) {
    throw new Error(`${label} must be a non-empty regular non-symbolic-link single-link file no larger than ${maxBytes} bytes`);
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!sameFileSnapshot(opened, before)) throw new Error(`${label} changed while opening`);
    const bytes = readFdBounded(fd, maxBytes);
    const after = fs.fstatSync(fd);
    if (!sameFileSnapshot(after, opened) || bytes.length !== after.size || bytes.length > maxBytes) {
      throw new Error(`${label} changed while reading`);
    }
    return { path: file, fd, bytes, text: decodeUtf8(bytes, label), snapshot: after };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

function readOberonManifest(manifestPath) {
  let source;
  let fd;
  try {
    source = readVerifiedFile(manifestPath, "Manifest", MAX_OBERON_MANIFEST_BYTES);
    fd = source.fd;
    return JSON.parse(source.text);
  } catch (error) {
    if (error && error.code === "ENOENT") fail(`Manifest not found: ${manifestPath}`);
    if (error && error.oberonFail) throw error;
    fail(`Failed to parse manifest JSON: ${error.message}`);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the parse result */ }
    }
  }
}

function positiveIntegerFlag(flags, key, { min = 1, max }) {
  if (flags[key] === undefined) return null;
  const value = Number(flags[key]);
  if (!Number.isInteger(value) || value < min || value > max) fail(`Oberon --${key} must be an integer from ${min} to ${max}`);
  return value;
}

function safeManifestId(value, label) {
  if (
    typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === "." || value === ".." || value.includes("..")
  ) fail(`Manifest ${label} is unsafe`);
  return value;
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!written) throw new Error("Oberon temporary file write made no progress");
    offset += written;
  }
}

function writeOwnedFile(file, bytes, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeAll(fd, bytes);
    fs.fsyncSync(fd);
    const snapshot = fs.fstatSync(fd);
    if (!regularSnapshot(snapshot) || snapshot.size !== bytes.length) {
      throw new Error(`${label} did not remain a regular single-link file`);
    }
    return { path: file, fd, snapshot };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

function reopenOwnedReadable(file, expected, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const current = fs.fstatSync(fd);
    if (!sameFileSnapshot(current, expected)) throw new Error(`${label} changed while reopening`);
    return fd;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

function privateRunDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-oberon-run-"));
}

function cleanupOwnedFile(file, expected, label) {
  let current;
  try { current = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    return new Error(`${label} could not be inspected during cleanup: ${error.message}`);
  }
  if (!sameFileIdentity(current, expected)) {
    return new Error(`${label} changed before cleanup; refusing to unlink an unknown file`);
  }
  // Rename first. If the original pathname is replaced in the final window,
  // only that successor is moved to a recoverable quarantine name; it is never
  // unlinked as if it were our temporary file.
  const quarantine = `${file}.quarantine-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, quarantine);
  } catch (error) {
    return new Error(`${label} could not be quarantined during cleanup: ${error.message}`);
  }
  let moved;
  try { moved = fs.lstatSync(quarantine); }
  catch (error) {
    return new Error(`${label} quarantine could not be verified: ${error.message}`);
  }
  if (!sameFileIdentity(moved, expected)) {
    return new Error(`${label} cleanup found an unknown successor; preserved at ${quarantine}`);
  }
  try {
    fs.unlinkSync(quarantine);
    return null;
  } catch (error) {
    return new Error(`${label} quarantine could not be removed: ${error.message}`);
  }
}

function cleanupPrivateRun(runDir, ownedFiles) {
  const errors = [];
  for (const item of ownedFiles || []) {
    if (item.fd !== undefined) {
      try { fs.closeSync(item.fd); } catch { /* cleanup below still verifies the path */ }
      item.fd = undefined;
    }
    const error = cleanupOwnedFile(item.path, item.snapshot, item.label);
    if (error) errors.push(error.message);
  }
  if (runDir) {
    try { fs.rmdirSync(runDir); }
    catch (error) { if (!error || error.code !== "ENOENT") errors.push(`private render directory cleanup failed: ${error.message}`); }
  }
  return errors.length ? new Error(errors.join("; ")) : null;
}

function prepareBoundExecution(runDir, scriptSource, builtSource, ownedFiles) {
  const scriptCopy = writeOwnedFile(path.join(runDir, "script.cjs"), scriptSource.bytes, "bound Oberon render script");
  const scriptOwned = { path: scriptCopy.path, snapshot: scriptCopy.snapshot, label: "bound Oberon render script" };
  ownedFiles.push(scriptOwned);
  fs.closeSync(scriptCopy.fd);
  scriptCopy.fd = undefined;
  scriptOwned.fd = reopenOwnedReadable(scriptCopy.path, scriptCopy.snapshot, scriptOwned.label);
  const builtCopy = writeOwnedFile(path.join(runDir, "built-render.js"), builtSource.bytes, "bound Electron render build");
  const builtOwned = { path: builtCopy.path, snapshot: builtCopy.snapshot, label: "bound Electron render build" };
  ownedFiles.push(builtOwned);
  fs.closeSync(builtCopy.fd);
  builtCopy.fd = undefined;
  builtOwned.fd = reopenOwnedReadable(builtCopy.path, builtCopy.snapshot, builtOwned.label);
  const bootstrap = writeOwnedFile(path.join(runDir, "bootstrap.cjs"), Buffer.from(BOOTSTRAP_SOURCE, "utf8"), "bound Oberon bootstrap");
  ownedFiles.push({ path: bootstrap.path, snapshot: bootstrap.snapshot, label: "bound Oberon bootstrap" });
  fs.closeSync(bootstrap.fd);
  return {
    bootstrapPath: bootstrap.path,
    scriptFd: scriptOwned.fd,
    builtFd: builtOwned.fd,
    scriptPath: scriptSource.path,
    builtPath: builtSource.path,
    scriptBytes: scriptSource.bytes.length,
    builtBytes: builtSource.bytes.length,
  };
}

function boundedProtocolNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`Oberon ${label} value is invalid`);
  return parsed;
}

function boundedProtocolField(value, label, maxBytes = MAX_OBERON_FIELD_BYTES) {
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`Oberon ${label} exceeds ${maxBytes} bytes`);
  return value;
}

function timeoutSetting(config, keys, fallback, max = 24 * 60 * 60_000) {
  const source = config || {};
  for (const key of keys) {
    if (source[key] === undefined) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return Math.min(Math.trunc(value), max);
    fail(`Oberon ${key} timeout must be a positive finite number`);
  }
  return fallback;
}

function closeVerifiedSource(source) {
  if (!source || source.fd === undefined) return;
  try { fs.closeSync(source.fd); } catch { /* source cleanup is best effort after validation */ }
  source.fd = undefined;
}

// v1 oberonRepoRoot() = engine/의 부모 = 패키지 루트. v2에서는 core/paths가 정본.
function defaultRenderEntry() {
  const root = packageRoot();
  return {
    script: path.join(root, "scripts", "render-oberon-live-request.cjs"),
    builtRender: path.join(root, "dist", "electron", "oberon", "render.js"),
  };
}

function readRenderEntry(file, label, missingMessage) {
  let target;
  try { target = path.resolve(String(file)); }
  catch (error) { fail(`${label} path is invalid: ${error.message}`); }
  try {
    return readVerifiedFile(target, label, MAX_OBERON_SOURCE_BYTES);
  } catch (error) {
    if (error && error.code === "ENOENT") fail(missingMessage(target));
    if (error && error.oberonFail) throw error;
    fail(`${label} is unsafe or changed: ${error.message}`);
  }
}

/*
 * 렌더 자식의 stdout 프로토콜 한 줄 처리 (v1 oberonRenderLine).
 *   POLL status= phase= clips= percent=   → \r 진행률 바 갱신
 *   FILE kind= name= bytes=               → 산출물 수집 (titled 요약용)
 *   DELIVERY kind= name= path= bytes=     → 딜리버리 복사 알림
 *   WARNINGS=                             → 경고 표시
 *   JOB= / OUT_DIR= / *=present|missing   → 내부 추적/키 존재 점검 라인 — 숨김
 */
function oberonRenderLine(line, files, io, evidence = null) {
  let m;
  if ((m = line.match(/^POLL status=(\S+) phase=(\S+) clips=(\S+) percent=(\d+)/))) {
    const [, status, phase, clips, pct] = m;
    boundedProtocolField(status, "POLL status");
    boundedProtocolField(phase, "POLL phase");
    boundedProtocolField(clips, "POLL clips");
    boundedProtocolNumber(pct, "POLL percent");
    const bar = oberonBar(Number(pct));
    io.write(`\r⏳ ${bar} ${String(pct).padStart(3)}%  ${phase}  clips ${clips}   `);
    if (status === "succeeded") io.write("\n");
    return;
  }
  if ((m = line.match(/^FILE kind=(\S+) name=(\S+) bytes=(\d+)/))) {
    if (files.length >= MAX_OBERON_FILES) fail(`Oberon render emitted more than ${MAX_OBERON_FILES} FILE records`);
    boundedProtocolField(m[1], "FILE kind");
    boundedProtocolField(m[2], "FILE name");
    const bytes = boundedProtocolNumber(m[3], "FILE bytes");
    files.push({ kind: m[1], name: m[2], bytes });
    if (evidence) evidence.files += 1;
    return;
  }
  if ((m = line.match(/^DELIVERY kind=(\S+) name=(\S+) path=(\S+) bytes=(\d+)/))) {
    boundedProtocolField(m[1], "DELIVERY kind");
    boundedProtocolField(m[2], "DELIVERY name");
    boundedProtocolField(m[3], "DELIVERY path");
    const bytes = boundedProtocolNumber(m[4], "DELIVERY bytes");
    if (evidence) evidence.deliveries += 1;
    io.out(`  📦 ${m[1].padEnd(11)} ${m[2]}  (${oberonBytes(bytes)})`);
    return;
  }
  if (line.startsWith("WARNINGS=")) {
    boundedProtocolField(line.slice("WARNINGS=".length), "WARNINGS");
    io.out(`  ⚠ ${line.slice("WARNINGS=".length)}`);
    return;
  }
  if (line.startsWith("JOB=") || line.startsWith("OUT_DIR=")) return; // 내부 추적
  if (/=(present|missing)$/.test(line)) return; // 키 존재 점검 라인
  if (line.trim()) io.out(`  ${line}`);
}

// `oberon render <manifest.json> [--delivery DIR] [--max-shots N] [--takes N]
//                [--resolution R] [--max-polls N] [--poll-ms N] [--open] [--dry-run]`
async function render(io, args, deps = {}) {
  const { flags, rest } = parseFlags(args, {
    delivery: "value",
    "max-shots": "value",
    takes: "value",
    resolution: "value",
    "max-polls": "value",
    "poll-ms": "value",
    open: "boolean",
    "dry-run": "boolean",
  });
  if (rest.length !== 1) fail("A single manifest path is required: agentlas oberon render <manifest.json>");
  const manifestPath = path.resolve(rest[0]);
  const manifest = readOberonManifest(manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("The manifest must be a JSON object.");
  if (typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 300 || /[\u0000\r\n]/.test(manifest.title)) {
    fail("The manifest title is invalid.");
  }
  if (!Array.isArray(manifest.shots) || !manifest.shots.length) fail("The manifest has no shots[].");
  safeManifestId(manifest.productionId, "productionId");
  if (manifest.shots.length > 12) fail("The manifest exceeds the 12-shot safety limit.");
  const shotIds = new Set();
  for (const [index, shot] of manifest.shots.entries()) {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) fail(`Manifest shots[${index}] is invalid`);
    const shotId = safeManifestId(shot.shotId, `shots[${index}].shotId`);
    if (shotIds.has(shotId)) fail(`Manifest shotId is duplicated: ${shotId}`);
    shotIds.add(shotId);
  }
  if (manifest.maxShots != null && (!Number.isInteger(manifest.maxShots) || manifest.maxShots < 1 || manifest.maxShots > 12)) {
    fail("Manifest maxShots must be an integer from 1 to 12");
  }
  if (manifest.takesPerShot != null && (!Number.isInteger(manifest.takesPerShot) || manifest.takesPerShot < 1 || manifest.takesPerShot > 8)) {
    fail("Manifest takesPerShot must be an integer from 1 to 8");
  }

  const overrides = {};
  const maxShots = positiveIntegerFlag(flags, "max-shots", { max: 12 });
  const takes = positiveIntegerFlag(flags, "takes", { max: 8 });
  positiveIntegerFlag(flags, "max-polls", { max: 10_000 });
  positiveIntegerFlag(flags, "poll-ms", { min: 100, max: 600_000 });
  if (maxShots != null) overrides.maxShots = maxShots;
  if (takes != null) overrides.takesPerShot = takes;
  if (flags.resolution) {
    if (flags.resolution.length > 32 || /[\u0000\r\n]/.test(flags.resolution)) fail("Oberon --resolution is invalid");
    overrides.resolution = flags.resolution;
  }
  const patchedManifest = Object.keys(overrides).length ? { ...manifest, ...overrides } : null;
  if (flags.delivery && (flags.delivery.length > 4096 || /[\u0000\r\n]/.test(flags.delivery))) fail("Oberon --delivery path is invalid");
  const deliveryDir = path.resolve(flags.delivery || path.join(path.dirname(manifestPath), `${slugifyOberon(manifest.title)}-delivery`));
  const timeoutConfig = deps.timeoutConfig || deps.timeouts || deps.timeout || {};
  const idleTimeoutMs = timeoutSetting(
    { ...timeoutConfig, idleMs: deps.idleTimeoutMs ?? timeoutConfig.idleMs },
    ["idleMs", "idleTimeoutMs", "idle"],
    DEFAULT_IDLE_TIMEOUT_MS,
  );
  const totalTimeoutMs = timeoutSetting(
    { ...timeoutConfig, totalMs: deps.totalTimeoutMs ?? timeoutConfig.totalMs },
    ["totalMs", "totalTimeoutMs", "total"],
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const killGraceMs = timeoutSetting(
    { ...timeoutConfig, killGraceMs: deps.killGraceMs ?? timeoutConfig.killGraceMs },
    ["killGraceMs", "killGraceTimeoutMs", "killGrace"],
    DEFAULT_KILL_GRACE_MS,
  );

  // seam: 다른 산출물 배치(예: Desktop 동봉 빌드)가 생기면 여기만 주입 교체.
  const { script, builtRender } = (deps.resolveRenderEntry || defaultRenderEntry)();
  // 정직 정지 — v1과 동일한 문구. 렌더 진입점이 없으면 절대 가짜 렌더를 하지 않는다.
  let scriptSource;
  let builtSource;
  try {
    scriptSource = readRenderEntry(
      script,
      "Headless render script",
      (target) => `Headless render script not found (not included in the packaged app): ${target}`,
    );
    builtSource = readRenderEntry(
      builtRender,
      "Electron render build",
      (target) => `An Electron build is required. Run npm run build:electron first (missing: ${target})`,
    );
  } catch (error) {
    closeVerifiedSource(scriptSource);
    closeVerifiedSource(builtSource);
    throw error;
  }

  // The child must not reopen the user path after validation: always hand it a
  // private immutable request snapshot, with overrides applied only to that copy.
  let reqPath;
  let temporaryRequestPath = null;
  let temporaryRequestSnapshot = null;
  let renderTempDir = null;
  const ownedTempFiles = [];
  try {
    renderTempDir = privateRunDirectory();
    const requestBytes = Buffer.from(`${JSON.stringify(patchedManifest || manifest, null, 2)}\n`, "utf8");
    if (requestBytes.length <= 0 || requestBytes.length > MAX_OBERON_REQUEST_BYTES) {
      fail(`Oberon render request exceeds ${MAX_OBERON_REQUEST_BYTES} bytes`);
    }
    temporaryRequestPath = path.join(renderTempDir, "request.json");
    const requestFile = writeOwnedFile(temporaryRequestPath, requestBytes, "temporary Oberon request");
    temporaryRequestSnapshot = requestFile.snapshot;
    ownedTempFiles.push({ path: requestFile.path, snapshot: requestFile.snapshot, label: "temporary Oberon request" });
    fs.closeSync(requestFile.fd);
    requestFile.fd = undefined;
    reqPath = temporaryRequestPath;
  } catch (error) {
    closeVerifiedSource(scriptSource);
    closeVerifiedSource(builtSource);
    const cleanupError = cleanupPrivateRun(renderTempDir, ownedTempFiles);
    if (cleanupError) fail(`${error.message}; ${cleanupError.message}`);
    if (error && error.oberonFail) throw error;
    fail(`Failed to prepare temporary Oberon request: ${error.message}`);
  }

  const cleanupTemporaryRequest = () => {
    if (!temporaryRequestPath) return null;
    const error = cleanupOwnedFile(temporaryRequestPath, temporaryRequestSnapshot, "temporary Oberon request");
    if (!error) temporaryRequestPath = null;
    return error;
  };

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // full Electron으로 부팅 (Desktop execPath일 때)
  childEnv.OBERON_LIVE_VEO = "1";
  childEnv.OBERON_LIVE_REQUEST_FILE = reqPath;
  childEnv.OBERON_LIVE_DELIVERY_DIR = deliveryDir;
  if (flags["max-polls"]) childEnv.OBERON_LIVE_MAX_POLLS = String(flags["max-polls"]);
  if (flags["poll-ms"]) childEnv.OBERON_LIVE_POLL_MS = String(flags["poll-ms"]);
  if (flags.open) childEnv.OBERON_LIVE_OPEN_DELIVERY = "1";

  io.out(`▶ Oberon render: "${manifest.title}"  (${manifest.shots.length} shots, max ${overrides.maxShots ?? manifest.maxShots ?? 3})`);
  io.out(`  Manifest: ${manifestPath}`);
  io.out(`  Delivery folder: ${deliveryDir}`);
  if (manifest.titles) io.out(`  title/subtitle burn-in: enabled → generating additional *_titled.mp4`);

  if (flags["dry-run"]) {
    const execPath = deps.execPath || process.execPath;
    io.out("\n[dry-run] Command to run:");
    io.out(`  ${execPath} ${scriptSource.path}`);
    io.out("  env: OBERON_LIVE_VEO=1");
    io.out(`       OBERON_LIVE_REQUEST_FILE=${reqPath}`);
    io.out(`       OBERON_LIVE_DELIVERY_DIR=${deliveryDir}`);
    io.out("  (full Electron · GEMINI_API_KEY/GOOGLE_CLOUD_PROJECT vault required)");
    closeVerifiedSource(scriptSource);
    closeVerifiedSource(builtSource);
    const cleanupError = cleanupTemporaryRequest();
    const privateCleanupError = cleanupPrivateRun(renderTempDir, ownedTempFiles);
    if (cleanupError || privateCleanupError) {
      fail(`Failed to clean up temporary Oberon files: ${(cleanupError || privateCleanupError).message}`);
    }
    return 0;
  }

  let boundExecution;
  try {
    boundExecution = prepareBoundExecution(renderTempDir, scriptSource, builtSource, ownedTempFiles);
  } catch (error) {
    closeVerifiedSource(scriptSource);
    closeVerifiedSource(builtSource);
    const cleanupError = cleanupPrivateRun(renderTempDir, ownedTempFiles);
    if (cleanupError) fail(`${error.message}; ${cleanupError.message}`);
    if (error && error.oberonFail) throw error;
    fail(`Failed to prepare bound Oberon render: ${error.message}`);
  }
  closeVerifiedSource(scriptSource);
  closeVerifiedSource(builtSource);
  childEnv.AGENTLAS_OBERON_SCRIPT_PATH = scriptSource.path;
  childEnv.AGENTLAS_OBERON_BUILT_PATH = builtSource.path;
  childEnv.AGENTLAS_OBERON_SCRIPT_FD = "3";
  childEnv.AGENTLAS_OBERON_BUILT_FD = "4";
  childEnv.AGENTLAS_OBERON_SCRIPT_BYTES = String(boundExecution.scriptBytes);
  childEnv.AGENTLAS_OBERON_BUILT_BYTES = String(boundExecution.builtBytes);

  const doSpawn = deps.spawn || spawn;
  const execPath = deps.execPath || process.execPath;
  const stdoutStream = deps.stdout || process.stdout;
  const stderrStream = deps.stderr || process.stderr;
  const lineIo = { out: io.out, write: (s) => stdoutStream.write(s) };

  return new Promise((resolve) => {
    const files = [];
    const evidence = { files: 0, deliveries: 0 };
    let buf = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopRequested = false;
    let stopReason = null;
    let child = null;
    let idleTimer = null;
    let totalTimer = null;
    let killTimer = null;
    let forceTimer = null;

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      idleTimer = null;
      totalTimer = null;
      killTimer = null;
      forceTimer = null;
    };

    const cleanup = () => {
      const requestError = cleanupTemporaryRequest();
      const privateError = cleanupPrivateRun(renderTempDir, ownedTempFiles);
      if (requestError && privateError) return new Error(`${requestError.message}; ${privateError.message}`);
      return requestError || privateError;
    };

    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      let finalError = error || stopReason;
      if (!finalError && buf) {
        try { oberonRenderLine(buf.replace(/\r$/, ""), files, lineIo, evidence); }
        catch (parseError) { finalError = parseError; }
      }
      buf = "";
      const cleanupError = cleanup();
      if (!finalError && cleanupError) finalError = cleanupError;
      if (!finalError && code === 0 && evidence.files === 0 && evidence.deliveries === 0) {
        finalError = new Error("Render exited successfully without FILE or DELIVERY evidence");
      }
      if (finalError) {
        stderrStream.write(`\n✖ Render process failed: ${finalError.message || finalError}\n`);
        resolve(1);
        return;
      }
      if (code === 0) {
        io.out(`\n✓ Render complete — delivery folder: ${deliveryDir}`);
        const titled = files.filter((f) => f.kind && f.kind.startsWith("titled"));
        if (titled.length) io.out(`  title/subtitle burn-in files: ${titled.map((f) => f.name).join(", ")}`);
        resolve(0);
      } else {
        stderrStream.write(`\n✖ Render failed (exit ${code})\n`);
        resolve(code || 1); // v1은 process.exitCode 설정 — v2는 코드 반환
      }
    };

    const stop = (reason) => {
      if (settled || stopRequested) return;
      stopRequested = true;
      stopReason = reason instanceof Error ? reason : new Error(String(reason));
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = null;
      totalTimer = null;
      if (!child || typeof child.kill !== "function") {
        finish(1, stopReason);
        return;
      }
      try { child.kill("SIGTERM"); }
      catch (error) { stopReason = new Error(`${stopReason.message}; failed to stop render process: ${error.message}`); }
      killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); }
        catch (error) { stopReason = new Error(`${stopReason.message}; failed to force-stop render process: ${error.message}`); }
        forceTimer = setTimeout(() => finish(1, stopReason), killGraceMs);
      }, killGraceMs);
    };

    const markActivity = () => {
      if (settled || stopRequested) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(new Error(`Render process produced no output for ${idleTimeoutMs} ms`)), idleTimeoutMs);
    };

    const handle = (chunk) => {
      try {
        markActivity();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        if (stdoutBytes + bytes.length > MAX_OBERON_STDOUT_BYTES) {
          stop(new Error(`Render stdout exceeded ${MAX_OBERON_STDOUT_BYTES} bytes`));
          return;
        }
        stdoutBytes += bytes.length;
        buf += bytes.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_OBERON_LINE_BYTES) {
            stop(new Error(`Render stdout line exceeded ${MAX_OBERON_LINE_BYTES} bytes`));
            return;
          }
          oberonRenderLine(line, files, lineIo, evidence);
          if (stopRequested) return;
        }
        if (Buffer.byteLength(buf, "utf8") > MAX_OBERON_LINE_BYTES) {
          stop(new Error(`Render stdout line exceeded ${MAX_OBERON_LINE_BYTES} bytes`));
        }
      } catch (error) {
        stop(error);
      }
    };

    const handleStderr = (chunk) => {
      try {
        markActivity();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        const remaining = Math.max(0, MAX_OBERON_STDERR_BYTES - stderrBytes);
        if (remaining > 0) stderrStream.write(bytes.subarray(0, remaining).toString("utf8"));
        stderrBytes += bytes.length;
        if (stderrBytes > MAX_OBERON_STDERR_BYTES) stop(new Error(`Render stderr exceeded ${MAX_OBERON_STDERR_BYTES} bytes`));
      } catch (error) {
        stop(error);
      }
    };

    try {
      child = doSpawn(execPath, [boundExecution.bootstrapPath], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe", boundExecution.scriptFd, boundExecution.builtFd],
      });
      if (!child || !child.stdout || !child.stderr || typeof child.on !== "function") {
        throw new Error("Render process did not provide stdout/stderr streams");
      }
      child.stdout.on("data", handle);
      child.stdout.on("error", (error) => stop(error));
      child.stderr.on("data", handleStderr);
      child.stderr.on("error", (error) => stop(error));
      child.on("error", (error) => stop(error));
      child.on("close", (code) => finish(code));
      markActivity();
      totalTimer = setTimeout(() => stop(new Error(`Render process exceeded total timeout of ${totalTimeoutMs} ms`)), totalTimeoutMs);
    } catch (error) {
      if (boundExecution.scriptFd !== undefined) {
        try { fs.closeSync(boundExecution.scriptFd); } catch { /* cleanup below */ }
        boundExecution.scriptFd = undefined;
      }
      if (boundExecution.builtFd !== undefined) {
        try { fs.closeSync(boundExecution.builtFd); } catch { /* cleanup below */ }
        boundExecution.builtFd = undefined;
      }
      finish(1, error);
    }
  });
}

module.exports = {
  render,
  oberonRenderLine,
  defaultRenderEntry,
  MAX_OBERON_MANIFEST_BYTES,
  MAX_OBERON_SOURCE_BYTES,
  MAX_OBERON_STDOUT_BYTES,
  MAX_OBERON_LINE_BYTES,
  MAX_OBERON_FILES,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
};
