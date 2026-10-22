"use strict";
/*
 * native-host: claude / codex / gemini 를 headless 스트리밍으로 구동하고
 * 그 이벤트를 agentlas TUI 안에서 렌더한다. (사용자 결정: "agentlas 터미널이 항상 호스트")
 *
 * 핵심: 사용자의 기존 claude/codex 구독 인증을 그대로 사용한다 (API 키 불필요).
 *  - claude:  claude -p <prompt> --output-format stream-json --include-partial-messages --verbose
 *             (멀티턴은 --resume <session_id>)
 *  - codex:   codex exec --json --skip-git-repo-check -C <cwd> [sandbox] <prompt>
 *             (멀티턴은 codex exec resume <thread_id> ...)
 *  - gemini:  gemini -p <system+prompt> --approval-mode <mode>
 *
 * 스키마는 실측으로 확인됨 (cli/agentlas.cjs 상단 주석 참고).
 */
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { detectRuntimeRefusal } = require("./runtime-refusal.cjs");
const { normalizeCliUsage } = require("./usage-normalizer.cjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const permissions = require("./agentlas-permissions.cjs");
const acpDriver = require("./runtimes/acp-driver.cjs");
const i18n = require("./agentlas-i18n.cjs");
const { wrapStdioServer } = require("./agentlas-mcp-env.cjs");
const { withClaudeProductHome, withClaudeNativeCompaction } = require("./claude-product-home.cjs");
const generation = require("./sessions/generation.cjs");

function uiText(ui, key, ...args) {
  return ui && typeof ui.t === "function" ? ui.t(key, ...args) : i18n.t("en", key, ...args);
}

const NATIVE_TIMEOUT_DEFAULTS = Object.freeze({
  idleMs: 10 * 60_000,
  totalMs: 4 * 60 * 60_000,
  killGraceMs: 3_000,
});
const NATIVE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const MANAGED_MCP_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

function finiteTimeoutMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function nativeTimeoutConfig(env = process.env) {
  const totalMs = finiteTimeoutMs(env.AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS, NATIVE_TIMEOUT_DEFAULTS.totalMs, 30_000, 12 * 60 * 60_000);
  return {
    idleMs: Math.min(totalMs, finiteTimeoutMs(env.AGENTLAS_NATIVE_IDLE_TIMEOUT_MS, NATIVE_TIMEOUT_DEFAULTS.idleMs, 5_000, 60 * 60_000)),
    totalMs,
    killGraceMs: finiteTimeoutMs(env.AGENTLAS_NATIVE_KILL_GRACE_MS, NATIVE_TIMEOUT_DEFAULTS.killGraceMs, 100, 15_000),
  };
}

// Programmatic override is used by the deterministic regression harness; user env always uses the safer bounds above.
function directNativeTimeoutConfig(value = {}) {
  const totalMs = finiteTimeoutMs(value.totalMs, NATIVE_TIMEOUT_DEFAULTS.totalMs, 10, 12 * 60 * 60_000);
  return {
    idleMs: Math.min(totalMs, finiteTimeoutMs(value.idleMs, NATIVE_TIMEOUT_DEFAULTS.idleMs, 10, 60 * 60_000)),
    totalMs,
    killGraceMs: finiteTimeoutMs(value.killGraceMs, NATIVE_TIMEOUT_DEFAULTS.killGraceMs, 10, 15_000),
  };
}

function nativeTimeoutMessage(kind, ms) {
  return kind === "idle"
    ? `native runtime idle timeout: ${ms}ms 동안 출력이 없습니다.`
    : `native runtime total timeout: 전체 실행 시간이 ${ms}ms를 초과했습니다.`;
}

function userDataDir(env = process.env) {
  const override = env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

const EMPTY_CLAUDE_MCP_CONFIG = '{"mcpServers":{}}';

function claudeMcpIsolationArgs() {
  return ["--strict-mcp-config", "--mcp-config", EMPTY_CLAUDE_MCP_CONFIG];
}

function geminiMcpIsolationArgs() {
  // Gemini treats a non-empty allow-list as exclusive. A per-turn random name
  // cannot match a configured or extension-provided server, so read/write gets none.
  return ["--allowed-mcp-server-names", `__agentlas_no_mcp_${crypto.randomUUID()}__`];
}

function sameManagedDirectoryIdentity(left, right) {
  return Boolean(left && right) &&
    left.isDirectory() && right.isDirectory() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino;
}

function assertManagedDirectory(dir, parent = null) {
  const requestedPath = path.resolve(dir);
  if (parent) recheckManagedDirectory(parent);
  fs.mkdirSync(requestedPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(requestedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`managed runtime directory must be a real directory: ${requestedPath}`);
  }
  const realPath = fs.realpathSync.native(requestedPath);
  let canonical;
  try { canonical = fs.lstatSync(realPath); } catch { canonical = null; }
  if (!sameManagedDirectoryIdentity(stat, canonical)) {
    throw new Error(`managed runtime directory identity changed while resolving: ${requestedPath}`);
  }
  if (parent) {
    recheckManagedDirectory(parent);
    const relative = path.relative(parent.realPath, realPath);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`managed runtime directory escaped its parent: ${requestedPath}`);
    }
  }
  try { fs.chmodSync(requestedPath, 0o700); } catch { /* Windows/best-effort */ }
  const identity = { requestedPath, realPath, dev: stat.dev, ino: stat.ino };
  // The chmod above is a pathname operation. Bind the returned anchor to the
  // same inode after it, so a successor cannot become the directory identity.
  recheckManagedDirectory(identity);
  if (parent) recheckManagedDirectory(parent);
  return identity;
}

function recheckManagedDirectory(identity) {
  let stat;
  try {
    stat = fs.lstatSync(identity.requestedPath);
  } catch {
    throw new Error(`managed runtime directory changed while publishing: ${identity.requestedPath}`);
  }
  let realPath;
  try {
    realPath = fs.realpathSync.native(identity.requestedPath);
  } catch {
    throw new Error(`managed runtime directory changed while publishing: ${identity.requestedPath}`);
  }
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    stat.dev !== identity.dev || stat.ino !== identity.ino || realPath !== identity.realPath
  ) {
    throw new Error(`managed runtime directory changed while publishing: ${identity.requestedPath}`);
  }
  return stat;
}

function managedUserDataDirectory(env = process.env) {
  const identity = assertManagedDirectory(userDataDir(env));
  // Every user-data-derived path below is built from this canonical anchor.
  // Rechecking immediately after the initial mkdir/lstat closes the final-path
  // symlink and deterministic root-successor cases before any child exists.
  recheckManagedDirectory(identity);
  return identity;
}

function managedFileLocation(file, directory = null) {
  const requestedFile = path.resolve(file);
  const requestedDirectory = path.dirname(requestedFile);
  const identity = directory || assertManagedDirectory(requestedDirectory);
  if (identity.requestedPath !== requestedDirectory) {
    throw new Error(`managed runtime file directory mismatch: ${requestedFile}`);
  }
  recheckManagedDirectory(identity);
  return {
    requestedFile,
    file: path.join(identity.realPath, path.basename(requestedFile)),
    directory: identity,
  };
}

function existingManagedFileStat(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`managed runtime file must be a single-link regular file: ${file}`);
    }
    return stat;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function readManagedFileDetails(file, maxBytes = MANAGED_MCP_CONFIG_MAX_BYTES) {
  const listed = existingManagedFileStat(file);
  if (!listed) return null;
  if (listed.size > maxBytes) throw new Error(`managed runtime file exceeds ${maxBytes} bytes: ${file}`);
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink !== 1 ||
      opened.dev !== listed.dev || opened.ino !== listed.ino || opened.size !== listed.size
    ) throw new Error(`managed runtime file changed while opening: ${file}`);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    const after = fs.fstatSync(fd);
    if (
      total > maxBytes || !after.isFile() || after.nlink !== 1 ||
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || total !== after.size
    ) throw new Error(`managed runtime file changed while reading: ${file}`);
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { throw new Error(`managed runtime file must contain valid UTF-8: ${file}`); }
    return {
      content,
      stat: after,
    };
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function readManagedFile(file, maxBytes = MANAGED_MCP_CONFIG_MAX_BYTES) {
  const result = readManagedFileDetails(file, maxBytes);
  return result && result.content;
}

function sameManagedFileIdentity(stat, expected) {
  return stat && stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function sameManagedFileSnapshot(stat, expected) {
  return sameManagedFileIdentity(stat, expected) && stat.nlink === expected.nlink &&
    stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
}

function assertManagedFileStable(file, expected, expectedContent, directory) {
  recheckManagedDirectory(directory);
  const listed = existingManagedFileStat(file);
  if (!sameManagedFileSnapshot(listed, expected)) {
    throw new Error(`managed runtime file changed after reading: ${file}`);
  }
  const reread = readManagedFileDetails(file);
  if (!reread || reread.content !== expectedContent || !sameManagedFileSnapshot(reread.stat, expected)) {
    throw new Error(`managed runtime file content changed after reading: ${file}`);
  }
  recheckManagedDirectory(directory);
  const final = existingManagedFileStat(file);
  if (!sameManagedFileSnapshot(final, expected)) {
    throw new Error(`managed runtime file changed before returning: ${file}`);
  }
}

function removeOwnedManagedTemp(temp, expected, directory = null) {
  const candidates = [temp];
  if (directory) {
    try {
      const parent = path.dirname(directory.requestedPath);
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidateDirectory = path.join(parent, entry.name);
        const candidateStat = fs.lstatSync(candidateDirectory);
        if (candidateStat.dev === directory.dev && candidateStat.ino === directory.ino) {
          candidates.push(path.join(candidateDirectory, path.basename(temp)));
        }
      }
    } catch { /* leave an unknown successor untouched */ }
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (sameManagedFileIdentity(stat, expected)) fs.unlinkSync(candidate);
    } catch { /* leave an unknown successor untouched */ }
  }
}

function writeManagedFile(file, content, location = null) {
  const managed = location || managedFileLocation(file);
  const value = String(content);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MANAGED_MCP_CONFIG_MAX_BYTES) {
    throw new Error(`managed runtime file exceeds ${MANAGED_MCP_CONFIG_MAX_BYTES} bytes: ${managed.file}`);
  }
  recheckManagedDirectory(managed.directory);
  const currentRead = readManagedFileDetails(managed.file);
  const current = currentRead && currentRead.content;
  if (current !== null) {
    if (current !== value) {
      assertManagedFileStable(managed.file, currentRead.stat, current, managed.directory);
      throw new Error(`managed runtime file already exists with different content: ${managed.file}`);
    }
    // The first check binds the pathname to the inode that was read. Repeat
    // it immediately before returning so an intervening successor cannot be
    // mistaken for the idempotent managed file.
    assertManagedFileStable(managed.file, currentRead.stat, current, managed.directory);
    assertManagedFileStable(managed.file, currentRead.stat, current, managed.directory);
    return managed.file;
  }
  recheckManagedDirectory(managed.directory);

  const temp = `${managed.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let tempIdentity = null;
  let fd = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`managed runtime temp file is unsafe: ${managed.file}`);
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) throw new Error(`managed runtime file write stalled: ${managed.file}`);
      offset += written;
    }
    try { fs.fchmodSync(fd, 0o600); } catch { /* Windows/ACL-only host */ }
    fs.fsyncSync(fd);
    const finished = fs.fstatSync(fd);
    if (
      !sameManagedFileIdentity(finished, tempIdentity) || finished.nlink !== 1 ||
      finished.size !== bytes.length
    ) throw new Error(`managed runtime temp file changed while writing: ${managed.file}`);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  try {
    const listedTemp = fs.lstatSync(temp);
    if (!sameManagedFileIdentity(listedTemp, tempIdentity) || listedTemp.nlink !== 1 || listedTemp.size !== bytes.length) {
      throw new Error(`managed runtime temp file changed before publication: ${managed.file}`);
    }
    recheckManagedDirectory(managed.directory);
    // link(2) is an atomic create-if-absent publication on POSIX and never
    // replaces a destination. Windows has no safe overwrite fallback here:
    // linkSync failure is deliberately surfaced and the successor is kept.
    fs.linkSync(temp, managed.file);
    const linked = fs.lstatSync(managed.file);
    if (!sameManagedFileIdentity(linked, tempIdentity) || linked.nlink < 2 || linked.size !== bytes.length) {
      throw new Error(`managed runtime file publication produced an unsafe target: ${managed.file}`);
    }
    removeOwnedManagedTemp(temp, tempIdentity, managed.directory);
    const published = existingManagedFileStat(managed.file);
    if (!published || !sameManagedFileIdentity(published, tempIdentity) || published.size !== bytes.length) {
      throw new Error(`managed runtime file publication changed while finishing: ${managed.file}`);
    }
    recheckManagedDirectory(managed.directory);
    return managed.file;
  } catch (error) {
    // If the directory moved to a symlink during publication, the canonical
    // path can temporarily resolve outside the managed tree. Remove only our
    // inode; a successor at the same path remains untouched.
    removeOwnedManagedTemp(managed.file, tempIdentity, managed.directory);
    throw error;
  } finally {
    removeOwnedManagedTemp(temp, tempIdentity, managed.directory);
  }
}

/*
 * The person's Codex telemetry OPT-OUTS a Terminal Codex home keeps (owner decision 2026-10-17, every product home: a
 * person who turned vendor telemetry off keeps it off in product runs; never an opt-in, never an [otel] exporter;
 * otherwise the vendor default). Same rule as Desktop electron/runtime/codex-product-home.ts PRODUCT_CODEX_OPT_OUTS:
 * `analytics.enabled = false` and `feedback.enabled = false`, as a `[table]` key, a dotted root key or an inline table.
 * A line scan, not a TOML parser: a misread can only turn telemetry off, never on. They ride as `-c` overrides
 * (codexArgs): the managed config.toml is write-once (writeManagedFile refuses different content), so its text stays.
 */
function codexTelemetryOptOuts(configText) {
  const out = new Set();
  let table = "";
  for (const raw of String(configText || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (header) { table = header[1]; continue; }
    if (/^\[\[/.test(line)) { table = "[[array]]"; continue; }
    for (const name of ["analytics", "feedback"]) {
      if ((table === name && /^enabled\s*=\s*false$/.test(line))
        || (table === "" && new RegExp(`^${name}\\.enabled\\s*=\\s*false$`).test(line))
        || (table === "" && new RegExp(`^${name}\\s*=\\s*\\{\\s*enabled\\s*=\\s*false\\s*\\}$`).test(line))) out.add(`${name}.enabled = false`);
    }
  }
  return [...out];
}

function prepareCodexRuntimeEnv(env = process.env) {
  const base = { ...env };
  const sourceHome = path.resolve(base.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const dataDirectory = managedUserDataDirectory(base);
  const realDataHome = dataDirectory.realPath;
  const explicitTarget = Boolean(base.AGENTLAS_CODEX_HOME);
  const targetHome = path.resolve(base.AGENTLAS_CODEX_HOME || path.join(realDataHome, "runtime-homes", "codex"));
  const targetParent = explicitTarget ? null : dataDirectory;
  const targetDirectory = assertManagedDirectory(targetHome, targetParent);
  recheckManagedDirectory(dataDirectory);
  const realTargetHome = targetDirectory.realPath;
  let realSourceHome = sourceHome;
  try { realSourceHome = fs.realpathSync(sourceHome); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  const targetRelative = path.relative(realDataHome, realTargetHome);
  if (!explicitTarget && (path.isAbsolute(targetRelative) || targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`))) {
    throw new Error("Agentlas Codex runtime home escapes the Agentlas data directory");
  }
  if (realTargetHome === realSourceHome) {
    throw new Error("Agentlas Codex runtime home must be isolated from the user's Codex home");
  }

  // CODEX_HOME has no replace-config CLI flag: profiles and `mcp_servers={}`
  // merge with the user's global config. A dedicated home is the only reliable
  // way to exclude global/project/plugin MCP while keeping Agentlas sessions.
  const configLocation = managedFileLocation(path.join(realTargetHome, "config.toml"), targetDirectory);
  writeManagedFile(
    configLocation.file,
    "# Managed by Agentlas Terminal. MCP is supplied only for explicit full-access turns.\n",
    configLocation,
  );
  recheckManagedDirectory(dataDirectory);
  recheckManagedDirectory(targetDirectory);

  if (sourceHome !== targetHome) {
    const sourceAuth = path.join(sourceHome, "auth.json");
    const targetAuth = path.join(realTargetHome, "auth.json");
    let targetExists = false;
    try { fs.lstatSync(targetAuth); targetExists = true; } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    if (!targetExists && fs.existsSync(sourceAuth)) {
      try {
        fs.symlinkSync(sourceAuth, targetAuth, "file");
      } catch {
        try {
          fs.linkSync(sourceAuth, targetAuth);
        } catch {
          fs.copyFileSync(sourceAuth, targetAuth, fs.constants.COPYFILE_EXCL);
          try { fs.chmodSync(targetAuth, 0o600); } catch { /* Windows/best-effort */ }
        }
      }
    }
  }

  recheckManagedDirectory(dataDirectory);
  recheckManagedDirectory(targetDirectory);

  base.CODEX_HOME = realTargetHome;
  return base;
}

function runtimeEnvForKind(kind, env = process.env, options = {}) {
  if (kind === "codex") return prepareCodexRuntimeEnv(env);
  if (kind === "gemini") return prepareGeminiRuntimeEnv(env, options);
  if (kind === "claude-code" || kind === "claude") return prepareClaudeRuntimeEnv(env, options);
  return env;
}

// Product turns keep their Claude sessions in Agentlas's own config dir, never in the person's ~/.claude (owner
// 2026-10-13: a Motiondirector run through this host wrote its session into ~/.claude/projects). Same rule as the desktop.
function prepareClaudeRuntimeEnv(env = process.env, options = {}) {
  let runEnv = env;
  if (env.AGENTLAS_CLAUDE_KEEP_HOME !== "1") {
    try {
      runEnv = withClaudeProductHome({ ...env }, path.join(managedUserDataDirectory(env).realPath, "claude-product-home"));
    } catch { /* keep the existing home when the mirror is unavailable */ }
  }
  const windowTokens = generation.contextWindowTokens("claude-code", options.model);
  return withClaudeNativeCompaction(runEnv, { windowTokens, limitTokens: generation.nativeCompactionLimit(windowTokens) });
}

// MCP 서버 이름 → TOML/JSON 안전 키 (하이픈/공백 → _).
function mcpKey(s) {
  return String((s && (s.catalog_id || s.id || s.name)) || "mcp").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}
function selectedMcpServers(servers, options = {}) {
  const selected = [];
  for (const server of servers || []) {
    if (!server || server.enabled === 0 || server.transport !== "stdio" || !server.command) continue;
    selected.push(server);
  }
  return selected;
}
function wrappedMcpServerMap(servers, options = {}) {
  const result = {};
  const selected = selectedMcpServers(servers, options);
  if (!selected.length) return result;
  const dataDir = options.dataDir || managedUserDataDirectory(options.env || process.env).realPath;
  for (const server of selected) {
    const wrapped = wrapStdioServer(server, { dataDir });
    const baseKey = mcpKey(server);
    let key = baseKey;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const identity = String(server.catalog_id || server.id || server.name || server.command);
      key = `${baseKey}_${crypto.createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 8)}`;
    }
    result[key] = { command: wrapped.command, args: wrapped.args };
  }
  return result;
}
// Full-access turns only: claude --mcp-config with the exact host-authorized
// stdio servers. Empty means empty; there is no legacy or provider seed.
function cliMcpConfigPath(servers, options = {}) {
  const dataDirectory = managedUserDataDirectory(options.env || process.env);
  const dir = path.join(dataDirectory.realPath, "mcp");
  const directory = assertManagedDirectory(dir, dataDirectory);
  const mcpServers = wrappedMcpServerMap(servers, { ...options, dataDir: dataDirectory.realPath });
  const body = JSON.stringify({ mcpServers }, null, 2);
  // 서로 다른 동시 실행이 하나의 agentlas-cli-mcp.json을 덮어쓰지 않도록 내용 주소 파일을 쓴다.
  const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 20);
  const location = managedFileLocation(path.join(dir, `agentlas-cli-mcp-${digest}.json`), directory);
  // Always delegate the idempotent case to the identity-checked writer; a
  // caller-side read followed by an early return would reopen a TOCTOU gap.
  writeManagedFile(location.file, body, location);
  recheckManagedDirectory(dataDirectory);
  recheckManagedDirectory(directory);
  return { file: location.file, names: Object.keys(mcpServers) };
}
// Full-access turns only: codex -c mcp_servers.* with the same exact Build
// allowlist semantics as Claude.
function codexMcpArgs(servers, options = {}) {
  const out = [];
  for (const [key, server] of Object.entries(wrappedMcpServerMap(servers, options))) {
    out.push("-c", `mcp_servers.${key}.command=${JSON.stringify(server.command)}`);
    out.push("-c", `mcp_servers.${key}.args=${JSON.stringify(server.args)}`);
  }
  return out;
}

// 툴 input(JSON)에서 사람이 읽을 대표 인자 한 줄 추출.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  // TodoWrite/플랜류 — todos 배열이면 진행 중 항목 또는 개수로 요약.
  if (Array.isArray(input.todos)) {
    const ip = input.todos.find((t) => t && t.status === "in_progress");
    return ip ? String(ip.content || ip.activeForm || "").slice(0, 80) : `${input.todos.length} todos`;
  }
  const pick = (k) => (typeof input[k] === "string" ? input[k] : undefined);
  return (
    pick("file_path") ||
    pick("path") ||
    pick("command") ||
    pick("pattern") ||
    pick("query") ||
    pick("url") ||
    pick("notebook_path") ||
    (pick("prompt") ? pick("prompt").slice(0, 80) : "") ||
    ""
  );
}

// child.stdout → 줄 단위 콜백. 종료 시 잔여 버퍼 flush. cleanup 반환.
// The bound is one line, not the run: a long run whose tool results carry images can pass any total (owner
// 2026-10-13 — a Motiondirector film was killed at 16 MiB of cumulative stdout mid-render). Memory stays bounded by
// dropping a single line that grows past maxBytes before its newline; the run itself is never stopped for volume.
function lineReader(stream, onLine, onActivity, options = {}) {
  let buf = "";
  let dropping = false;
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Math.max(1, Math.trunc(Number(options.maxBytes)))
    : NATIVE_STDOUT_MAX_BYTES;
  stream.setEncoding("utf8");
  const onData = (chunk) => {
    if (onActivity) onActivity();
    let rest = chunk;
    while (rest.length) {
      const nl = rest.indexOf("\n");
      const piece = nl >= 0 ? rest.slice(0, nl) : rest;
      rest = nl >= 0 ? rest.slice(nl + 1) : "";
      if (!dropping) {
        buf += piece;
        if (Buffer.byteLength(buf, "utf8") > maxBytes) {
          buf = "";
          dropping = true;
          if (typeof options.onLineDropped === "function") options.onLineDropped(maxBytes);
        }
      }
      if (nl < 0) break;
      const line = buf;
      buf = "";
      if (dropping) { dropping = false; continue; }
      if (line.trim()) onLine(line);
    }
  };
  const onEnd = () => {
    if (!dropping && buf.trim()) onLine(buf);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
  };
}

function structuredToolResult(content, fallbackText) {
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.json && typeof block.json === "object") return block.json;
      if (block.content && typeof block.content === "object" && !Array.isArray(block.content)) return block.content;
    }
  }
  const text = String(fallbackText || "").trim();
  if (!text || text.length > 256 * 1024) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  try { return JSON.parse(fenced ? fenced[1] : text); } catch { return null; }
}

// ── effort ───────────────────────────────────────────────
// Effort is a CLI flag wherever the runtime has one and never prompt words (native-harness audit 31, A2 C6.2): Desktop
// passes claude `--effort`, codex `model_reasoning_effort` and agy `--effort` (agy 1.4.0). The installed CLI's own
// `--help` list decides the levels (the same parse as Desktop claude-code.ts parseEffortChoices): a CLI without
// `--effort` gets no flag instead of an unknown option, and an unlisted level clamps down, never up.
const EFFORT_RANK = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_FLAG_KINDS = new Set(["claude-code", "agy"]);
const effortChoiceCache = new Map();

/** Levels listed after `--effort` in a CLI's help: "(low, medium, high, xhigh, max)" or "(low|medium|high)". */
function parseEffortChoices(help) {
  const match = /--effort[\s\S]{0,240}?\(([a-z0-9, |]+)\)/i.exec(String(help || ""));
  if (!match) return [];
  return [...new Set(match[1].split(/[,|]/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The effort levels this executable accepts, read once per executable generation (path, size, mtime).
 * null = the help could not be read (the explicit pin is passed through and the CLI judges it);
 * [] = the CLI has no `--effort` (no flag is sent).
 */
function cliEffortChoices(bin, env = process.env) {
  if (!bin) return null;
  let key;
  try {
    const stat = fs.statSync(bin);
    key = `${fs.realpathSync(bin)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  if (effortChoiceCache.has(key)) return effortChoiceCache.get(key);
  let choices = null;
  try {
    // agy (Go flag) prints its usage on stderr with exit 0; claude prints on stdout. Read both.
    const probe = spawnSync(bin, ["--help"], {
      encoding: "utf8", env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const help = `${probe.stdout || ""}\n${probe.stderr || ""}`;
    choices = probe.error || probe.status !== 0 ? null : parseEffortChoices(help);
  } catch {
    choices = null;
  }
  effortChoiceCache.set(key, choices);
  return choices;
}

/** The exact level to send as `--effort` for claude-code/agy, or null when no flag is sent. */
function nativeEffortLevel(kind, effort, choices) {
  if (!EFFORT_FLAG_KINDS.has(kind)) return null;
  const requested = String(effort || "").trim().toLowerCase();
  if (!requested || ["none", "off", "auto", "default"].includes(requested)) return null;
  const wanted = requested === "minimal" ? "low" : requested;
  if (!Array.isArray(choices)) return /^[a-z][a-z0-9-]{0,23}$/.test(wanted) ? wanted : null;
  if (choices.includes(wanted)) return wanted;
  const rank = EFFORT_RANK.indexOf(wanted);
  if (rank < 0) return null;
  return choices
    .filter((choice) => EFFORT_RANK.indexOf(choice) >= 0 && EFFORT_RANK.indexOf(choice) <= rank)
    .sort((left, right) => EFFORT_RANK.indexOf(right) - EFFORT_RANK.indexOf(left))[0] || null;
}

function effortArgs(kind, effort, choices) {
  const level = nativeEffortLevel(kind, effort, choices);
  return level ? ["--effort", level] : [];
}

// ── claude-code ──────────────────────────────────────────
function claudePermissionArgs(permission) {
  const level = permissions.normalize(permission);
  if (level === "full") return ["--dangerously-skip-permissions"];
  if (level === "write") return ["--permission-mode", "acceptEdits"];
  return ["--permission-mode", "plan"];
}

// Turn context in front of the user message (same frame as Desktop runtime/continuity.ts composeResumeTurnPrompt).
function withTurnContext(prompt, turnContext, locale) {
  const ctx = String(turnContext || "").trim();
  if (!ctx) return prompt;
  return ["── Turn context (host background; not the user's message; never quote) ──", ctx, "",
    locale === "ko" ? "── 이번 요청 ──" : "── Current request ──", prompt].join("\n");
}

function claudeArgs({ prompt, systemPrompt, systemPromptStable, turnContext, locale, permission, session, model, effort, effortChoices, mcpServers, mcpAllowlistMode, env }) {
  // A session-split prompt (sessions/prompt.cjs augmentSystemParts): the same stable bytes on every spawn — Claude's
  // transcript keeps no system prompt, so a resume without it ran with no Agentlas instructions — and this turn's part
  // (turn_id, recall) as turn context. Measured 2026-10-14: 3/3 resumed turns kept the right turn_id this way.
  if (systemPromptStable) prompt = withTurnContext(prompt, turnContext, locale);
  const level = permissions.normalize(permission);
  const perm = claudePermissionArgs(level);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...perm,
    ...effortArgs("claude-code", effort, effortChoices),
  ];
  // MCP tools can mutate state outside the workspace sandbox. Until the desktop schema
  // carries a trustworthy readOnlyHint per tool, only explicit full access may inject them.
  if (level === "full") {
    const mcpCfg = cliMcpConfigPath(mcpServers, { exactAllowlist: mcpAllowlistMode === "exact", env });
    args.push("--strict-mcp-config", "--mcp-config", mcpCfg.file);
    if (mcpCfg.names.length) args.push("--allowedTools", mcpCfg.names.map((n) => "mcp__" + n).join(","));
  } else {
    args.push(...claudeMcpIsolationArgs());
  }
  if (model) args.push("--model", model); // alias (sonnet/opus) or full id — /model parity
  if (session && session.id) {
    args.push("--resume", session.id);
    if (systemPromptStable) args.push("--append-system-prompt", systemPromptStable);
  } else if (systemPromptStable || systemPrompt) {
    args.push("--append-system-prompt", systemPromptStable || systemPrompt);
  }
  return args;
}

// ── typed failures ───────────────────────────────────────
// The kinds are Desktop runner.ts RunnerFailureKind (quota | auth | refused | empty | exit | timeout | unavailable |
// unsupported). errorCode is the provider's own bounded machine code (Desktop RunnerFailure.providerCode), never prose.
// Before this, `terminal_reason: "api_error"` alone meant quota, so the measured "Not logged in" shape (claude 2.1.301:
// assistant.error "authentication_failed", api_error_status null) was reported as a usage limit (audit 31, A2 C8.3).
const CLAUDE_ASSISTANT_ERROR_KIND = Object.freeze({
  authentication_failed: "auth", oauth_org_not_allowed: "auth", account_on_hold: "auth", cloud_credential_error: "auth",
  rate_limit: "quota", billing_error: "quota",
  overloaded: "unavailable", server_error: "unavailable",
  model_not_found: "unsupported",
  invalid_request: "exit", max_output_tokens: "exit", unknown: "exit",
});
const PROVIDER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function boundedProviderCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value).trim();
  return PROVIDER_CODE_RE.test(code) ? code : undefined;
}

/** HTTP status from a provider field → kind (Desktop runtimeHttpFailure: 401 auth, 403 refused, 429 quota). */
function httpStatusFailureKind(status) {
  if (!Number.isSafeInteger(status)) return null;
  if (status === 401) return "auth";
  if (status === 403) return "refused";
  if (status === 429) return "quota";
  if (status === 529 || (status >= 500 && status <= 599)) return "unavailable";
  return null;
}

/** Record one typed failure on the stream state (the last writer wins; callers decide precedence). */
function markFailure(st, failure) {
  st.typedFailure = failure;
  st.error = failure.message;
  st.errorKind = failure.kind;
  st.errorSource = failure.source || "marker";
  st.errorCode = failure.code;
  st.retryAfterHint = failure.retryAfterHint;
}

function claudeAssistantText(obj) {
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : "")).join("").trim();
}

/** A claude error result's own words: `result`, else `errors[]` (error results carry no `result`; A2 C8.8). */
function claudeResultMessage(obj) {
  if (typeof obj.result === "string" && obj.result.trim()) return obj.result.trim().slice(0, 2000);
  if (Array.isArray(obj.errors)) {
    const joined = obj.errors.map((item) => (typeof item === "string" ? item : item && typeof item.message === "string" ? item.message : ""))
      .filter(Boolean).join("; ").trim();
    if (joined) return joined.slice(0, 2000);
  }
  return "";
}

function claudeResultFailure(obj, st) {
  const message = claudeResultMessage(obj);
  const prior = st.typedFailure;
  // A resumed session that no longer exists: error_during_execution with no model turn (Desktop claude-code.ts
  // resumedConversationMissing). No model work happened, so the session layer may start a fresh generation.
  if (st.claudeResumeId && obj.subtype === "error_during_execution" && obj.num_turns === 0) {
    st.sessionGoneBeforeEffects = true;
    return { kind: "exit", code: "session_not_found", message: message || "claude could not resume the saved conversation", source: "marker" };
  }
  // An observed provider cause (assistant.error, a rejected usage window) is more specific than the result envelope.
  if (prior && prior.source === "marker" && prior.kind !== "exit") {
    return { ...prior, message: message || prior.message };
  }
  const httpKind = httpStatusFailureKind(obj.api_error_status);
  if (httpKind) return { kind: httpKind, code: `http_${obj.api_error_status}`, message: message || `HTTP ${obj.api_error_status}`, source: "marker" };
  if (prior) return { ...prior, message: message || prior.message };
  if (/not logged in|please run \/login/i.test(message)) return { kind: "auth", message, source: "heuristic" };
  const reason = obj.terminal_reason && obj.terminal_reason !== "completed" ? boundedProviderCode(obj.terminal_reason) : undefined;
  return { kind: "exit", ...(reason ? { code: reason } : {}), message: message || "claude error", source: "marker" };
}

// ANSI 제거 (에러 stderr 정리용) — 외부 의존성 없이.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * A tool-ish event of a kind this driver draws no row for: the turn did use a tool, so a blank reply behind it is not the model
 * producing nothing at all (sessions/turn-outcome.cjs blankReplyKind). "No tool seen" is not "no tool ran". The hook is optional:
 * a plain UI object (a graph model call) has no tally and needs none.
 */
function noteToolActivity(ui) {
  if (ui && typeof ui.noteToolActivity === "function") ui.noteToolActivity();
}

// Claude content-block types that are reply text or the model's thinking; every other type is tool use (tool_use, server_tool_use,
// mcp_tool_use and their *_tool_result blocks) or one this host does not know - which counts as activity too, never as nothing.
const CLAUDE_NON_TOOL_BLOCKS = new Set(["text", "thinking", "redacted_thinking"]);

/** The blocks of a finished assistant message: a tool call the stream path did not draw (same id) is unclassified tool use. */
function noteClaudeToolBlocks(content, st, ui) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const type = block && typeof block.type === "string" ? block.type : "";
    if (!type || CLAUDE_NON_TOOL_BLOCKS.has(type)) continue;
    if (type === "tool_use" && st.toolUseSeen && st.toolUseSeen.has(block.id)) continue;
    noteToolActivity(ui);
  }
}

function handleClaudeLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  // An event type of the CLI's own that is about a tool (tool_progress, tool_use_summary) and has no handler below.
  if (typeof obj.type === "string" && obj.type !== "stream_event" && /tool/i.test(obj.type)) noteToolActivity(ui);
  switch (obj.type) {
    case "system":
      if (obj.subtype === "init" && obj.session_id) st.session.id = obj.session_id;
      // hook_started / hook_response / status → 노이즈, 무시
      return;
    case "stream_event": {
      const ev = obj.event || {};
      if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "tool_use") {
          const tool = { id: cb.id || String(ev.index), name: cb.name || "tool", input: "" };
          st.tools[ev.index] = tool;
          st.toolById[tool.id] = tool;
          (st.toolUseSeen || (st.toolUseSeen = new Set())).add(tool.id);
          // 인자가 다 모이는 content_block_stop에서 한 줄로(⏺ Name(arg)) 출력 — Claude Code 스타일
        } else if (cb.type === "thinking") {
          st.think[ev.index] = "";
          ui.status(uiText(ui, "runtime.thinking"));
        } else if (cb.type === "text") {
          ui.streamStart();
        } else if (typeof cb.type === "string" && cb.type && !CLAUDE_NON_TOOL_BLOCKS.has(cb.type)) {
          // server_tool_use / mcp_tool_use / a server tool's result block: no row is drawn for it, but a tool ran.
          noteToolActivity(ui);
        }
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta || {};
        if (d.type === "text_delta" && d.text) {
          ui.streamDelta(d.text);
          st.text += d.text;
        } else if (d.type === "input_json_delta" && st.tools[ev.index]) {
          st.tools[ev.index].input += d.partial_json || "";
        } else if (d.type === "thinking_delta" && st.think[ev.index] != null) {
          st.think[ev.index] += d.thinking || "";
        }
      } else if (ev.type === "content_block_stop") {
        const t = st.tools[ev.index];
        if (t) {
          let parsed;
          try {
            parsed = JSON.parse(t.input || "{}");
          } catch {
            parsed = null;
          }
          ui.applyTaskTool?.(t.name, parsed, t.id);
          ui.tool(prettyToolName(t.name), summarizeToolInput(t.name, parsed));
          delete st.tools[ev.index];
        } else if (st.think[ev.index] != null) {
          const th = String(st.think[ev.index] || "").trim();
          if (th) ui.line(ui.c.faint("  " + ui.c.italic(truncateLines(th, 3))));
          st.think[ev.index] = null;
        } else {
          ui.streamEnd();
        }
      }
      return;
    }
    case "assistant": {
      // Tool use in the finished message that the stream path drew no row for (server_tool_use, mcp_tool_use, a sub-agent's own calls).
      noteClaudeToolBlocks(obj.message && obj.message.content, st, ui);
      // The context the next request starts from = the turn's LAST top-level model request (input + cache read +
      // cache creation); a subagent's request is not this conversation (Desktop claude-code.ts contextInputTokens).
      if (obj.parent_tool_use_id == null && obj.isSidechain !== true) {
        const u = obj.message && obj.message.usage;
        const part = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
        const total = u ? part(u.input_tokens) + part(u.cache_read_input_tokens) + part(u.cache_creation_input_tokens) : 0;
        if (total > 0) st.contextInputTokens = total;
      }
      // SDKAssistantMessage.error is the CLI's typed cause (authentication_failed, rate_limit, model_not_found, ...).
      // A cause already observed with a specific kind (a rejected usage window) is not replaced by a later echo.
      if (typeof obj.error === "string" && obj.error) {
        const code = boundedProviderCode(obj.error);
        const prior = st.typedFailure;
        if (code && !(prior && prior.source === "marker" && prior.kind !== "exit")) {
          markFailure(st, { kind: CLAUDE_ASSISTANT_ERROR_KIND[code] || "exit", code,
            message: claudeAssistantText(obj) || code, source: "marker" });
        }
      }
      return;
    }
    case "user": {
      // tool_result 들
      const content = obj.message && obj.message.content;
      const outerToolResult = obj.toolUseResult ?? obj.tool_use_result ?? obj.message?.toolUseResult ?? obj.message?.tool_use_result;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const txt = Array.isArray(block.content)
              ? block.content.map((b) => (b.type === "text" ? b.text : "")).join("")
              : typeof block.content === "string"
                ? block.content
                : "";
            const taskTool = st.toolById[block.tool_use_id];
            if (taskTool) {
              const structured = structuredToolResult(block.content, txt) || structuredToolResult(outerToolResult, "");
              ui.applyTaskResult?.(taskTool.name, structured, taskTool.id);
              delete st.toolById[block.tool_use_id];
            }
            ui.toolResult(txt, !block.is_error);
          }
        }
      }
      return;
    }
    case "result": {
      // One plain -p invocation owns one root CLI turn; sidechain and background results are separate work.
      const origin = obj.origin && typeof obj.origin === "object" ? obj.origin.kind : undefined;
      if (obj.parent_tool_use_id != null || obj.isSidechain === true
        || ["task-notification", "observer", "observer-activity", "coordinator"].includes(origin)) return;
      // The result event is this turn's receipt (Desktop RuntimeTurnDelivery "accepted").
      st.turnAccepted = true;
      st.ownerControlTerminal = obj.is_error ? "uncertain" : "completed";
      st.finalText = typeof obj.result === "string" ? obj.result : st.text;
      // Unreported side stays unknown (input_unknown/output_unknown), never 0. Anthropic: input excludes cache.
      st.usage = normalizeCliUsage("anthropic", obj.usage, { cost_usd: obj.total_cost_usd, duration_ms: obj.duration_ms });
      if (obj.is_error) markFailure(st, claudeResultFailure(obj, st));
      return;
    }
    case "rate_limit_event":
      /*
       * ★한도 거절은 **표식이다** — 경고만 찍고 버리면 안 된다.
       * 실측(2026-08-06): 이 이벤트가 왔는데도 error가 비어 있어, 뒤따르는 거절문
       * ("You've hit your weekly limit")이 정상 답으로 세어졌다. 살아 있는 다른
       * 런타임으로 폴백이 안 걸린 진범. status:rejected면 그 자체로 실패다.
       * A rejected usage window (seven_day, five_hour ...) is the subscription limit: quota/usage_limit, with the
       * reset time only from its machine field (Desktop claudeFailureFromEvent retryAfterHint).
       */
      if (obj.rate_limit_info && obj.rate_limit_info.status === "rejected") {
        ui.warn(uiText(ui, "runtime.rateLimit", "Claude"));
        const resetsAt = obj.rate_limit_info.resetsAt;
        markFailure(st, { kind: "quota", code: "usage_limit", message: st.error || "claude rate limit rejected", source: "marker",
          ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { retryAfterHint: new Date(resetsAt * 1000).toISOString() } : {}) });
      }
      return;
    default:
      return;
  }
}

function prettyToolName(name) {
  if (!name) return "tool";
  // mcp__server__tool → server·tool (Claude Code 처럼 깔끔하게)
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[1]}·${m[2]}`;
  return name;
}

// ── codex ────────────────────────────────────────────────
function codexPermissionArgs(permission) {
  const level = permissions.normalize(permission);
  if (level === "full") return ["--dangerously-bypass-approvals-and-sandbox"];
  // `codex exec` has no -a flag. The installed CLI accepts approval_policy via -c.
  return ["--sandbox", level === "write" ? "workspace-write" : "read-only", "-c", 'approval_policy="never"'];
}

function codexArgs({ prompt, systemPrompt, systemPromptStable, turnContext, locale, permission, session, cwd, model, effort, mcpServers, mcpAllowlistMode, env, compactTokenLimit }) {
  const level = permissions.normalize(permission);
  const sandbox = codexPermissionArgs(level);
  const mcp = level === "full" ? codexMcpArgs(mcpServers, { exactAllowlist: mcpAllowlistMode === "exact", env }) : [];
  const mdl = model ? ["-m", model] : []; // /model parity
  // Current Codex model inventory advertises max directly; preserve the user's
  // explicit pin instead of silently weakening it to high.
  const eff = effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
  // `codex exec` reports thread-cumulative usage, not the last request, so the 80%-of-W generation rule runs as the
  // CLI's own compaction at that point (sessions/generation.cjs; Desktop codex exec passes the same key).
  const compact = Number.isSafeInteger(compactTokenLimit) && compactTokenLimit > 0
    ? ["-c", `model_auto_compact_token_limit=${compactTokenLimit}`] : [];
  // A session-split prompt goes in as developer instructions when the thread starts (in the user message Codex ignored
  // the memory output contract, 0/3) and the thread keeps them; each turn — fresh or resumed — carries this turn's part as
  // turn context (an id inside developer instructions sticks to the first turn). Measured 2026-10-14: 3/3 resumed turns.
  const split = Boolean(systemPromptStable);
  const devInstructions = split && !(session && session.id) ? ["-c", `developer_instructions=${JSON.stringify(systemPromptStable)}`] : [];
  const full = split ? withTurnContext(prompt, turnContext, locale)
    : systemPrompt && !(session && session.id) ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt;
  // -C/--sandbox/--skip-git-repo-check 는 `codex exec` 옵션이라 `resume <id>` 토큰 *앞에* 와야 한다.
  // (codex-cli 0.133: resume 뒤에 두면 `unexpected argument` 로 거부 → 멀티턴 전부 실패. 실측 검증됨.)
  let personalConfig = "";
  try { personalConfig = fs.readFileSync(path.join(path.resolve((env || process.env).CODEX_HOME || path.join(os.homedir(), ".codex")), "config.toml"), "utf8"); }
  catch { /* none */ }
  const optOuts = codexTelemetryOptOuts(personalConfig).flatMap((line) => ["-c", line.replace(/\s+/g, "")]);
  const base = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...mdl, ...eff, ...compact, ...devInstructions, ...optOuts, ...sandbox, ...mcp];
  if (session && session.id) {
    return [...base, "resume", session.id, full];
  }
  return [...base, full];
}

function handleCodexLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  // Any exec event (thread.started included) means the resume got past its refusal point (codexResumeGone).
  if (obj && typeof obj.type === "string") st.codexEventSeen = true;
  switch (obj.type) {
    case "thread.started":
      if (obj.thread_id) st.session.id = obj.thread_id;
      return;
    case "turn.started":
      // codex exec's own turn-started event acknowledges this turn (Desktop RuntimeTurnDelivery "accepted").
      st.turnAccepted = true;
      ui.status(uiText(ui, "runtime.thinking"));
      return;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = obj.item || {};
      const done = obj.type === "item.completed";
      renderCodexItem(item, done, st, ui);
      return;
    }
    case "turn.completed":
      st.ownerControlTerminal = "completed";
      if (obj.usage) {
        st.usage = normalizeCliUsage("unknown", obj.usage);
      }
      st.finalText = st.text;
      return;
    case "turn.failed":
    case "error":
      // turn.failed carries {error:{message}}; the stream-level error event carries {message} (codex exec JSONL).
      // exec has no typed cause, so the kind stays exit (Desktop codexFailureFromEvent); the words are kept.
      st.error = (typeof obj.message === "string" && obj.message.trim())
        || (obj.error && (obj.error.message || (typeof obj.error === "string" ? obj.error : ""))) || "codex error";
      st.errorKind = "exit";
      st.errorSource = "marker";
      ui.error(String(st.error));
      st.errorShown = true;
      return;
    default:
      // An event of the CLI's own about a tool, command, patch, MCP server or search that has no handler above: tool use.
      if (typeof obj.type === "string" && CODEX_TOOLISH_EVENT.test(obj.type)) noteToolActivity(ui);
      return;
  }
}

// Codex events that are about tool use but not a rendered item (older exec protocol: exec_command_begin, patch_apply_end, ...).
const CODEX_TOOLISH_EVENT = /tool|exec|command|patch|mcp|search/i;
// Codex item types that are reply text, the model's reasoning or a non-fatal error notice; every other item type is a tool-ish
// item (a web_search, a collab tool call, the plan update) or one this host does not know - which counts as activity, never as nothing.
const CODEX_NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "error"]);

/**
 * `codex exec resume <id>` of a thread whose rollout is gone exits 1 before any event with Codex's own thread/resume
 * protocol phrase on stderr (codex-cli 0.163.0, measured by Desktop 2026-10-16; Desktop classifyCodexResumeFailure).
 * Only that phrase proves the session gone. "already has an active writer" is transient (Desktop writer_busy) and an
 * exec that emitted any event, text or a turn may already have acted, so neither qualifies.
 */
function codexResumeGone(st, code, text, stderr) {
  return Boolean(st.codexResumeId) && code !== 0 && !st.codexEventSeen && !st.turnAccepted && !text
    && /no rollout found for thread id/.test(stderr);
}

/** codex exec reports a tool item that did not work as `status` failed / declined or an `error` (Desktop codex.ts isError). */
function codexItemFailed(item) {
  return Boolean(item) && (item.error != null || item.status === "failed" || item.status === "declined");
}

function codexItemFailureText(item) {
  const error = item.error;
  const message = error && typeof error === "object" ? error.message : error;
  return typeof message === "string" && message ? message : String(item.status || "failed");
}

function renderCodexItem(item, done, st, ui) {
  const type = item.type || "";
  switch (type) {
    case "agent_message": {
      const text = item.text || "";
      // 증분 스트리밍 (item.updated 가 누적 text를 줄 때)
      const prev = st.itemText[item.id] || "";
      if (text.length > prev.length) {
        if (!prev) ui.streamStart();
        const slice = text.slice(prev.length);
        ui.streamDelta(slice);
        st.itemText[item.id] = text;
        st.text += slice; // 누적 — 한 턴에 agent_message item이 여러 개여도 합쳐서 보존
      }
      if (done) ui.streamEnd();
      return;
    }
    case "reasoning": {
      if (done && item.text) {
        ui.line(ui.c.faint("  " + ui.c.italic(truncateLines(item.text, 3))));
      } else {
        ui.status(uiText(ui, "runtime.reasoning"));
      }
      return;
    }
    case "command_execution":
    case "command": {
      if (!st.itemSeen[item.id]) {
        ui.tool("Bash", item.command || item.cmd || "");
        st.itemSeen[item.id] = true;
      }
      if (done) {
        const out = item.aggregated_output || item.stdout || item.output || "";
        // The exit code is not the only failure fact: a declined or failed command carries a status (and none an exit code).
        const ok = !codexItemFailed(item) && (item.exit_code == null || item.exit_code === 0);
        if (out) ui.toolResult(out, ok);
        else ui.toolResult(ok ? "done" : item.exit_code != null ? `exit ${item.exit_code}` : String(item.status || "failed"), ok);
      }
      return;
    }
    case "file_change":
    case "patch": {
      if (!st.itemSeen[item.id]) {
        const files = item.changes
          ? item.changes.map((c) => c.path).join(", ")
          : item.path || "";
        ui.tool("Edit", files);
        st.itemSeen[item.id] = true;
      }
      if (done) {
        if (codexItemFailed(item)) ui.toolResult(codexItemFailureText(item), false);
        else if (item.diff) ui.toolResult(item.diff, true);
      }
      return;
    }
    case "mcp_tool_call":
    case "tool_call": {
      if (!st.itemSeen[item.id]) {
        ui.tool(item.name || item.tool || "tool", argSummary(item));
        st.itemSeen[item.id] = true;
      }
      if (done) {
        if (codexItemFailed(item)) ui.toolResult(codexItemFailureText(item), false);
        else if (item.result || item.output) ui.toolResult(item.result || item.output, true);
      }
      return;
    }
    case "todo_list": {
      // Codex 0.144 JSONL exposes actual plan state as a todo_list item. Keep this
      // separate from ordinary Bash/Edit activity so Ctrl-T never invents tasks.
      ui.replaceTasks?.(item, "codex");
      // The plan update is the model's update_plan tool call, drawn as a task list rather than a tool row.
      noteToolActivity(ui);
      return;
    }
    default:
      // A tool-ish item this host draws no row for (web_search, a collab tool call, a kind not known yet): a tool ran.
      if (type && !CODEX_NON_TOOL_ITEMS.has(type)) noteToolActivity(ui);
      // 알 수 없는 item — 우아하게 한 줄.
      if (done && (item.text || item.summary)) {
        ui.info((type || "item") + ": " + truncateLines(item.text || item.summary, 1));
      }
      return;
  }
}

function argSummary(item) {
  try {
    const a = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
    return summarizeToolInput(item.name, a);
  } catch {
    return "";
  }
}
function truncateLines(s, n) {
  const lines = String(s).trim().split("\n").slice(0, n);
  return lines.join(" ").slice(0, 200);
}

// ── gemini (stream-json 구조화 렌더 — claude/codex와 동일 파리티) ──
// gemini-cli는 -o stream-json 으로 init/message(delta)/tool_use/tool_result/result 이벤트를 낸다(실측).
function geminiSystemSettingsSourcePath(env = process.env) {
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return path.resolve(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
  if (process.platform === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  if (process.platform === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  return "/etc/gemini-cli/settings.json";
}

function geminiSystemDefaultsSourcePath(env = process.env) {
  if (env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) return path.resolve(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH);
  return path.join(path.dirname(geminiSystemSettingsSourcePath(env)), "system-defaults.json");
}

function geminiMcpIsolationReadiness(env = process.env) {
  let dataDirectory;
  try { dataDirectory = managedUserDataDirectory(env); }
  catch { return { ready: false, reason: "managed-user-data-unavailable" }; }
  const managed = path.join(dataDirectory.realPath, "mcp");
  for (const source of [geminiSystemSettingsSourcePath(env), geminiSystemDefaultsSourcePath(env)]) {
    let stat;
    try { stat = fs.lstatSync(source); }
    catch (error) {
      if (error && error.code === "ENOENT") continue;
      return { ready: false, reason: "system-settings-unreadable" };
    }
    const relative = path.relative(managed, path.resolve(source));
    const insideManaged = relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    if (insideManaged && stat.isFile() && !stat.isSymbolicLink()) continue;
    // Replacing a real organization system policy/defaults file would weaken
    // policy. A Gemini Build therefore degrades to empty-MCP on this host.
    return { ready: false, reason: "system-settings-conflict" };
  }
  return { ready: true, reason: "no-system-settings-conflict" };
}

function prepareGeminiRuntimeEnv(env = process.env, options = {}) {
  const base = { ...env };
  const exactAllowlist = options.mcpAllowlistMode === "exact";
  const selected = selectedMcpServers(options.mcpServers);
  if (!selected.length) return base;
  const dataDirectory = managedUserDataDirectory(base);
  const mcpServers = wrappedMcpServerMap(selected, { exactAllowlist, env: base, dataDir: dataDirectory.realPath });
  if (!Object.keys(mcpServers).length) return base;
  const readiness = geminiMcpIsolationReadiness(base);
  if (!readiness.ready) {
    const error = new Error("Gemini MCP isolation is unavailable because host system settings must be preserved");
    error.code = "AGENTLAS_GEMINI_MCP_ISOLATION_UNAVAILABLE";
    throw error;
  }
  const dir = path.join(dataDirectory.realPath, "mcp");
  const directory = assertManagedDirectory(dir, dataDirectory);
  const names = Object.keys(mcpServers);
  const body = JSON.stringify({ mcpServers, mcp: { allowed: names } }, null, 2);
  const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 20);
  const location = managedFileLocation(path.join(dir, `agentlas-gemini-mcp-${digest}.json`), directory);
  // Keep the idempotent read and return inside writeManagedFile's identity
  // checks; do not leave a caller-side read/early-return race here.
  writeManagedFile(location.file, body, location);
  recheckManagedDirectory(dataDirectory);
  recheckManagedDirectory(directory);
  base.GEMINI_CLI_SYSTEM_SETTINGS_PATH = location.file;
  return base;
}

function geminiPermissionArgs(permission) {
  const level = permissions.normalize(permission);
  const approvalMode = level === "full" ? "yolo" : level === "write" ? "auto_edit" : "plan";
  return ["--approval-mode", approvalMode];
}

// gemini cannot resume: the session replays the journal into every turn (sessions/generation.cjs HOST_REPLAY_KINDS); it
// rides the same turn-context frame in front of the request.
function geminiArgs({ prompt: request, systemPrompt, permission, model, mcpServers, mcpAllowlistMode, env, historySeed, locale }) {
  const prompt = withTurnContext(request, historySeed, locale);
  const level = permissions.normalize(permission);
  // Gemini CLI 0.50 exposes three matching modes: plan, auto_edit, and yolo.
  const approval = geminiPermissionArgs(level);
  const mdl = model ? ["-m", model] : []; // /model parity
  const allowedMcpNames = level === "full"
    ? Object.keys(wrappedMcpServerMap(mcpServers, { exactAllowlist: mcpAllowlistMode === "exact", env }))
    : [];
  const exactMcp = level === "full"
    ? ["--allowed-mcp-server-names", allowedMcpNames.join(",") || `__agentlas_no_mcp_${crypto.randomUUID()}__`]
    : [];
  return [
    "--output-format", "stream-json",
    "--skip-trust", // 헤드리스: 이 세션 동안 워크스페이스 신뢰 (untrusted dir exit 55 방지)
    ...approval,
    ...(level === "full" ? exactMcp : geminiMcpIsolationArgs()),
    ...mdl,
    "--prompt", systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt,
  ];
}

function agyPermissionArgs(permission) {
  const level = permissions.normalize(permission);
  if (level === "full") return ["--dangerously-skip-permissions"];
  return [
    "--mode", level === "write" ? "accept-edits" : "plan",
    "--sandbox",
  ];
}

/**
 * The agy request body. A session-split prompt (sessions/prompt.cjs) starts a conversation with the stable system text,
 * which the conversation keeps; every turn, fresh or resumed (`--conversation`), carries this turn's part (and on a
 * fresh generation the journal seed) as turn context — the same split as codex. Unsplit callers (workforce capture,
 * graph builder) send one self-contained request.
 */
function agyRequestBody(request) {
  const resumed = Boolean(request.session && request.session.id);
  if (request.systemPromptStable) {
    const turn = withTurnContext(request.prompt, request.turnContext, request.locale);
    return resumed ? turn : `${request.systemPromptStable}\n\n---\n\n${turn}`;
  }
  const prompt = withTurnContext(request.prompt, request.historySeed, request.locale);
  return request.systemPrompt && !resumed ? `${request.systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

function agyArgs(request) {
  const { permission, model, addDirectories = [], session, effort, effortChoices } = request;
  const body = typeof request._body === "string" ? request._body : agyRequestBody(request);
  return [
    ...(model ? ["--model", model] : []),
    ...[...new Set(addDirectories.filter(Boolean))].flatMap((dir) => ["--add-dir", dir]),
    ...agyPermissionArgs(permission),
    ...effortArgs("agy", effort, effortChoices),
    "--output-format", "stream-json",
    "--print-timeout", "30m",
    // agy keeps the conversation (measured on Desktop, agy 1.1.14: a `--conversation` turn remembered the codeword).
    ...(session && session.id ? ["--conversation", String(session.id)] : []),
    "--prompt", body,
  ];
}

const AGY_WINDOWS_ARGV_PROMPT_LIMIT = 6_000;

function agyPromptBootstrap(promptFile) {
  return `Read the complete Agentlas request from ${JSON.stringify(promptFile)}, follow it exactly, and do not reveal the file path.`;
}

/**
 * Windows npm CLI shims pass through cmd.exe's much smaller command-line
 * ceiling. Move only oversized agy prompts into a private one-shot file and
 * keep argv limited to a short bootstrap. The caller owns cleanup and must run
 * it on every process terminal path (close, spawn error, timeout, and abort).
 */
function prepareAgyLaunch(launchRequest, options = {}) {
  // The journal seed / turn context is part of the request body (a Windows request file must carry it, never argv).
  const body = agyRequestBody(launchRequest);
  const platform = options.platform || process.platform;
  const promptLimit = Number.isFinite(options.promptLimit)
    ? Math.max(1, Math.trunc(options.promptLimit))
    : AGY_WINDOWS_ARGV_PROMPT_LIMIT;
  if (platform !== "win32" || body.length <= promptLimit) {
    return { args: agyArgs({ ...launchRequest, _body: body }), promptFile: null, cleanup: () => {} };
  }

  let directory = null;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-agy-prompt-"));
    try { fs.chmodSync(directory, 0o700); } catch { /* Windows/best-effort */ }
    const promptFile = path.join(directory, "request.txt");
    fs.writeFileSync(promptFile, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.chmodSync(promptFile, 0o600); } catch { /* Windows/best-effort */ }
    let cleaned = false;
    return {
      args: agyArgs({
        ...launchRequest,
        _body: agyPromptBootstrap(promptFile),
        addDirectories: [directory, ...(launchRequest.addDirectories || [])],
      }),
      promptFile,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* OS temp cleanup fallback */ }
      },
    };
  } catch (error) {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    throw error;
  }
}

// ── agy typed failures ──────────────────────────────────
// Kind only from a provider machine code (the Desktop antigravity contract): result.error is the owner-readable reason
// and is never parsed for a kind; an error with no code is `refused`, an ERROR status with no reason is `exit`.
const AGY_MACHINE_CODE_RE = /^(?:[A-Z][A-Z0-9_.:-]{0,63}|[1-9][0-9]{2})$/;
const AGY_CODE_KIND = Object.freeze({
  500: "unavailable", 502: "unavailable", 503: "unavailable", 504: "unavailable", UNAVAILABLE: "unavailable", INTERNAL: "unavailable",
  429: "quota", RESOURCE_EXHAUSTED: "quota", QUOTA_EXCEEDED: "quota", RATE_LIMITED: "quota", RATE_LIMIT_EXCEEDED: "quota",
  401: "auth", UNAUTHENTICATED: "auth", AUTHENTICATION_REQUIRED: "auth", INVALID_CREDENTIALS: "auth",
  408: "timeout", DEADLINE_EXCEEDED: "timeout", TIMEOUT: "timeout", TIMED_OUT: "timeout",
  UNIMPLEMENTED: "unsupported", UNSUPPORTED_CLIENT: "unsupported",
});

function normalizeAgyCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value).trim().toUpperCase();
  return AGY_MACHINE_CODE_RE.test(code) ? code : undefined;
}

/** A retry hint only from its own provider field: seconds, a compact "25m37s", or an ISO time. */
function normalizeAgyRetryAfter(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 86_400) return `in ${value}s`;
  if (typeof value !== "string") return undefined;
  const hint = value.trim();
  if (!hint || hint.length > 80 || /[\r\n\u0000]/.test(hint)) return undefined;
  if (/^(?:in\s+)?(?:\d{1,2}h)?(?:\d{1,3}m)?(?:\d{1,5}s)?$/i.test(hint) && /\d/.test(hint)) return hint.startsWith("in ") ? hint : `in ${hint}`;
  const parsed = Date.parse(hint);
  return Number.isFinite(parsed) && /T/.test(hint) ? new Date(parsed).toISOString() : undefined;
}

function agyFailureKind(code) {
  return (code && AGY_CODE_KIND[code]) || "refused";
}

function agyConversationId(obj) {
  const value = obj.conversation_id ?? (obj.result && obj.result.conversation_id) ?? (obj.step_update && obj.step_update.conversation_id);
  return typeof value === "string" && value.trim() && value.length <= 256 ? value.trim() : null;
}

function noteAgyDenial(st, ui, tool, detail) {
  const name = String(tool || "").trim();
  if (!name) return;
  const denied = st.agyDenied || (st.agyDenied = new Map());
  if (denied.has(name)) return;
  denied.set(name, String(detail || ""));
  ui.warn(`Antigravity auto-denied ${name}: headless mode has nobody to approve it.`);
}

/** One tool row per agy tool step (ACTIVE → DONE/ERROR share step_index); the result is shown on DONE/ERROR. */
function handleAgyToolStep(step, st, ui) {
  let name = step.tool_name || (step.tool_info && step.tool_info.name) || "";
  if (!name) return false;
  st.agyToolSeen = true;
  if (st.geminiStreaming) { ui.streamEnd(); st.geminiStreaming = false; }
  let params = step.tool_info && step.tool_info.parameters;
  if (name === "call_mcp_tool") {
    let envelope = params;
    if (typeof envelope === "string") { try { envelope = JSON.parse(envelope); } catch { /* keep provider data */ } }
    if (envelope && typeof envelope === "object" && /^[A-Za-z0-9_-]+$/.test(String(envelope.ServerName || ""))
      && /^[A-Za-z0-9_-]+$/.test(String(envelope.ToolName || ""))) {
      name = `mcp__${envelope.ServerName}__${envelope.ToolName}`;
      params = envelope.Arguments;
    }
  }
  const tools = st.agyTools || (st.agyTools = new Map());
  const id = `${name}:${Number.isSafeInteger(step.step_index) ? step.step_index : tools.size}`;
  let entry = tools.get(id);
  if (!entry) { entry = { done: false }; tools.set(id, entry); ui.tool(prettyToolName(name), summarizeToolInput(name, params)); }
  const state = String(step.state || "").toUpperCase();
  if ((state === "DONE" || state === "ERROR") && !entry.done) {
    entry.done = true;
    const errorMessage = step.tool_info && step.tool_info.error && typeof step.tool_info.error.message === "string"
      ? step.tool_info.error.message : "";
    if (state === "ERROR" && /\bdenied permission\b|\bpermission denied\b|\brequires? approval\b/i.test(errorMessage)) {
      noteAgyDenial(st, ui, name, errorMessage);
    }
    const output = step.tool_info && step.tool_info.output;
    const text = typeof output === "string" ? output : output != null ? JSON.stringify(output) : state === "ERROR" ? (errorMessage || "error") : "";
    ui.toolResult(text, state !== "ERROR" && !(step.tool_info && step.tool_info.error));
  }
  return true;
}

function handleAgyLine(line, st, ui) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const conversationId = agyConversationId(obj);
  if (conversationId && !st.agyConversationId) {
    st.agyConversationId = conversationId;
    if (st.agyResumeId && conversationId !== st.agyResumeId) {
      // agy could not find the conversation and silently started a new one without the earlier context (audit 31, A3).
      // Before any tool frame nothing happened, so the session layer may run the turn fresh from the journal.
      st.agySessionGone = true;
      st.sessionGoneBeforeEffects = !st.agyToolSeen;
      markFailure(st, { kind: "exit", code: "session_not_found", source: "marker",
        message: `Antigravity could not resume conversation ${st.agyResumeId}; it started a new conversation without the earlier context.` });
      if (typeof st.onSessionGone === "function") st.onSessionGone();
      return;
    }
    // The id becomes this chat's binding only when the turn completes (sessions/session.cjs ACK).
    if (st.session) st.session.id = conversationId;
  }
  // Nothing from a context-free replacement conversation is shown or kept.
  if (st.agySessionGone) return;
  if (obj.event === "result") {
    st.turnAccepted = true;
    const result = obj.result && typeof obj.result === "object" && !Array.isArray(obj.result) ? obj.result : {};
    const status = String(result.status || "").toLowerCase();
    const ok = ["success", "completed", "done"].includes(status);
    if (st.geminiStreaming) { ui.streamEnd(); st.geminiStreaming = false; }
    // The full answer arrives in result.response; deltas can split a UTF-8 character (measured on Desktop).
    if (typeof result.response === "string") st.finalText = result.response;
    for (const denied of Array.isArray(result.denied_actions) ? result.denied_actions : []) {
      noteAgyDenial(st, ui, denied && (denied.display_name || denied.action), "result.denied_actions");
    }
    const structured = result.error && typeof result.error === "object" && !Array.isArray(result.error) ? result.error : null;
    const message = typeof result.error === "string" ? result.error.trim()
      : structured && typeof structured.message === "string" ? structured.message.trim() : "";
    const code = normalizeAgyCode(result.error_code ?? result.errorCode
      ?? (structured && (structured.code ?? structured.error_code ?? structured.errorCode)));
    const retryAfterHint = normalizeAgyRetryAfter(result.retry_after ?? result.retryAfter
      ?? (structured && (structured.retry_after ?? structured.retryAfter)));
    if (message || code || (status && !ok)) {
      markFailure(st, { kind: message || code ? agyFailureKind(code) : "exit", code, retryAfterHint, source: "marker",
        message: (message || `Antigravity reported status ${result.status || "unknown"} without a reason.`).slice(0, 2000) });
    }
    st.ownerControlTerminal = ok && !st.error && (!st.agyResumeId || st.agyConversationId === st.agyResumeId) ? "completed" : "uncertain";
    return;
  }
  if (obj.event !== "step_update" || !obj.step_update) {
    if (obj.event) ui.status(`agy: ${obj.event}`);
    return;
  }
  st.turnAccepted = true;
  const step = obj.step_update;
  if (step.usage) {
    st.usage = normalizeCliUsage("unknown", step.usage, { duration_ms: step.usage.duration_ms });
    // The last agent_response step's input = the context the next request starts from (the common 80% rule).
    if (step.step_type === "agent_response" && Number.isSafeInteger(step.usage.input_tokens) && step.usage.input_tokens > 0) {
      st.contextInputTokens = step.usage.input_tokens;
    }
  }
  if (step.step_type === "tool" && handleAgyToolStep(step, st, ui)) return;
  if (step.step_type === "agent_response") {
    const delta = typeof step.text_delta === "string" ? step.text_delta : "";
    if (!delta) return;
    if (!st.geminiStreaming) { ui.streamStart(); st.geminiStreaming = true; }
    ui.streamDelta(delta);
    st.text += delta;
    return;
  }
  if (st.geminiStreaming) { ui.streamEnd(); st.geminiStreaming = false; }
  ui.status(`agy: ${step.step_type || "step"}${step.state ? ` (${step.state})` : ""}`);
}

/** agy exit-0 with no answer: a denial is `refused`, nothing at all is `empty` (an empty SUCCESS is not a result). */
function agyEmptyRunFailure(st) {
  if (st.agyDenied && st.agyDenied.size) {
    return { kind: "refused", code: "agy_tool_denied", source: "marker",
      message: `Antigravity auto-denied ${[...st.agyDenied.keys()].join(", ")} and gave no answer: headless mode has nobody to approve it. Raise /permission or rerun with the needed access.` };
  }
  if (!st.agyToolSeen) return { kind: "empty", source: "exit", message: "Antigravity ended the run without producing any answer." };
  return null;
}

// gemini 툴명 → 친숙한 표시명 (claude/codex 표기와 통일)
const GEMINI_TOOL_NAMES = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  list_directory: "List",
  glob: "Glob",
  search_file_content: "Grep",
  web_fetch: "Fetch",
  google_web_search: "Search",
  save_memory: "Memory",
};
function prettyGeminiTool(name) {
  return GEMINI_TOOL_NAMES[name] || name || "tool";
}
function handleGeminiLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // 비-JSON 잡음(경고 등) 무시
  }
  switch (obj.type) {
    case "init":
      if (obj.session_id) st.session.id = obj.session_id;
      return;
    case "tool_use": {
      const p = obj.parameters || {};
      const arg = p.command || summarizeToolInput(obj.tool_name, p) || p.description || "";
      if (st.geminiStreaming) {
        ui.streamEnd();
        st.geminiStreaming = false;
      }
      ui.applyTaskTool?.(obj.tool_name, p, obj.tool_id || obj.id);
      ui.tool(prettyGeminiTool(obj.tool_name), arg);
      return;
    }
    case "tool_result": {
      const out =
        typeof obj.output === "string"
          ? obj.output
          : obj.output != null
            ? JSON.stringify(obj.output)
            : "";
      ui.toolResult(out, obj.status == null || obj.status === "success");
      return;
    }
    case "message": {
      if (obj.role !== "assistant") return; // user echo 스킵
      const txt = typeof obj.content === "string" ? obj.content : "";
      if (!txt) return;
      if (!st.geminiStreaming) {
        ui.streamStart();
        st.geminiStreaming = true;
      }
      ui.streamDelta(txt);
      st.text += txt;
      return;
    }
    case "result": {
      st.turnAccepted = true;
      st.ownerControlTerminal = obj.status === "success" ? "completed" : "uncertain";
      if (st.geminiStreaming) {
        ui.streamEnd();
        st.geminiStreaming = false;
      }
      const s = obj.stats || {};
      st.usage = normalizeCliUsage("unknown", s, { duration_ms: s.duration_ms });
      st.finalText = st.text;
      // error 이벤트가 이미 구체 사유를 남겼으면 뭉뚱그린 상태 문자열로 덮지 않는다.
      if (obj.status && obj.status !== "success" && !st.error) {
        st.error = `gemini ${obj.status}`;
        st.errorKind = "exit";
        st.errorSource = "marker";
      }
      return;
    }
    case "error":
      /*
       * ★프로토콜이 선언하는 이벤트인데 핸들러가 없어 조용히 버려졌다
       * (capture.cjs는 목록에 적어 두고도 안 읽었다). 인증 실패("IneligibleTierError")
       * 같은 것이 여기로 온다 — 버리면 빈 성공이 된다.
       */
      st.error = (obj.error && (obj.error.message || obj.error)) || "gemini error";
      st.errorKind = /auth|login|credential|tier|eligib/i.test(String(st.error)) ? "auth" : "exit";
      st.errorSource = "marker";
      return;
    default:
      // An event of the CLI's own about a tool that has no handler above (tool_use / tool_result are drawn): tool use.
      if (typeof obj.type === "string" && /tool/i.test(obj.type)) noteToolActivity(ui);
      return;
  }
}

/**
 * A process that never started is RuntimeTurnDelivery "not-dispatched"; a missing executable is `unsupported`
 * (Desktop: a CLI that is not installed is refused before dispatch as unsupported).
 */
function spawnFailure(error, child) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const neverStarted = !child || !child.pid || ["ENOENT", "EACCES", "ENOTDIR", "EPERM"].includes(code);
  if (code === "ENOENT") {
    return { errorKind: "unsupported", errorSource: "marker", errorCode: "runtime_executable_missing", turnDelivery: "not-dispatched" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { errorKind: "unsupported", errorSource: "marker", errorCode: "runtime_executable_not_runnable", turnDelivery: "not-dispatched" };
  }
  return { errorKind: "exit", errorSource: "exit", turnDelivery: neverStarted ? "not-dispatched" : "not-accepted" };
}

// ── 공통 실행기 ───────────────────────────────────────────
// req = { kind, bin, prompt, systemPrompt, cwd, permission, session, ui, env, signal }
// 반환: Promise<{ text, session, usage, error }>
function runNativeTurn(req) {
  const { kind, bin, ui } = req;
  const cwd = req.cwd;
  // kimi/grok/cursor: 손코딩 3번째 대신 벤더 코어의 공용 ACP 러너로 (PRD 2026-08-15 T-2).
  // 같은 결과 계약({text, session, usage, error, errorKind, errorSource})으로 돌아온다.
  if (acpDriver.ACP_KINDS.has(kind)) {
    return acpDriver.runAcpTurn(req);
  }
  let launchReq = req;
  if (
    kind === "gemini" && permissions.normalize(req.permission) === "full" &&
    selectedMcpServers(req.mcpServers, { exactAllowlist: req.mcpAllowlistMode === "exact" }).length &&
    !geminiMcpIsolationReadiness(req.env || process.env).ready
  ) {
    ui.warn("Gemini system policy settings are present; MCP attachment was isolated to empty mode for this turn.");
    launchReq = { ...req, mcpServers: [], mcpAllowlistMode: "exact" };
  }
  const st = {
    text: "",
    finalText: "",
    usage: null,
    error: null,
    session: req.session || {},
    tools: {},
    toolById: {},
    think: {},
    geminiStreaming: false,
    itemText: {},
    itemSeen: {},
  };
  const resumeId = req.session && req.session.id ? String(req.session.id) : "";
  if (kind === "claude-code" && resumeId) st.claudeResumeId = resumeId;
  if (kind === "codex" && resumeId) st.codexResumeId = resumeId;
  if (kind === "agy" && resumeId) st.agyResumeId = resumeId;
  // The installed CLI's own level list (read once per executable generation) decides the effort flag.
  const effortChoices = EFFORT_FLAG_KINDS.has(kind) && launchReq.effort && launchReq.effortChoices === undefined
    ? cliEffortChoices(bin, launchReq.env || process.env) : launchReq.effortChoices;
  const appliedEffort = kind === "codex"
    ? (launchReq.effort ? String(launchReq.effort) : null)
    : nativeEffortLevel(kind, launchReq.effort, effortChoices);
  if (EFFORT_FLAG_KINDS.has(kind)) launchReq = { ...launchReq, effortChoices };

  let args;
  let lineHandler;
  let plainStream = false;
  let launchCleanup = () => {};
  try {
    if (kind === "claude-code") {
      args = claudeArgs(launchReq);
      lineHandler = (l) => handleClaudeLine(l, st, ui);
    } else if (kind === "codex") {
      args = codexArgs({ ...launchReq, cwd });
      lineHandler = (l) => handleCodexLine(l, st, ui);
    } else if (kind === "gemini") {
      args = geminiArgs(launchReq);
      lineHandler = (l) => handleGeminiLine(l, st, ui);
    } else if (kind === "agy") {
      const prepared = prepareAgyLaunch(launchReq);
      args = prepared.args;
      launchCleanup = prepared.cleanup;
      lineHandler = (l) => handleAgyLine(l, st, ui);
    } else {
      return Promise.resolve({ text: "", session: st.session, error: `unknown runtime: ${kind}`, errorKind: "unsupported",
        errorSource: "marker", turnDelivery: "not-dispatched", appliedEffort: null });
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    ui.error(uiText(ui, "runtime.failed", kind, message));
    return Promise.resolve({ text: "", session: st.session, error: message, errorKind: "exit", errorSource: "marker",
      turnDelivery: "not-dispatched", appliedEffort: null });
  }

  const timeout = req.timeoutConfig ? directNativeTimeoutConfig(req.timeoutConfig) : nativeTimeoutConfig(req.env || process.env);
  return new Promise((resolve) => {
    ui.status(uiText(ui, "runtime.starting", kind === "claude-code" ? "Claude" : kind));
    let child;
    try {
      const spawnImpl = req.spawn || spawn;
      const groupedChild = process.platform !== "win32" && spawnImpl === spawn;
      const childEnv = launchReq.prepareRuntimeEnv === false
        ? (launchReq.env || process.env)
        : runtimeEnvForKind(kind, launchReq.env || process.env, launchReq);
      child = spawnImpl(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        detached: groupedChild,
        windowsHide: true,
      });
      child.__agentlasNativeChild = spawnImpl === spawn;
      child.__agentlasGroupedChild = groupedChild;
      // 세션 계층(오르카)이 실행 중 중단(kill)을 하려면 child 핸들이 필요하다.
      // 커스텀 spawn 주입 방식은 위 트리킬 플래그를 깨므로 훅으로 노출한다.
      if (typeof req.onSpawn === "function") {
        try { req.onSpawn(child); } catch { /* observer 실패가 턴을 죽이면 안 됨 */ }
      }
    } catch (e) {
      launchCleanup();
      ui.error(uiText(ui, "runtime.failed", kind, e.message));
      return resolve({ text: "", session: st.session, error: e.message, ...spawnFailure(e), appliedEffort: null });
    }

    let settled = false;
    let termination = null;
    let idleTimer = null;
    let totalTimer = null;
    let killTimer = null;
    let forceTimer = null;
    let verifyTimer = null;
    let removeLineReader = () => {};
    let stderrBuf = "";
    const clearWatchdogs = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (verifyTimer) clearTimeout(verifyTimer);
      idleTimer = totalTimer = killTimer = forceTimer = verifyTimer = null;
    };
    const cleanup = () => {
      clearWatchdogs();
      removeLineReader();
      child.stderr?.removeListener("data", onStderr);
      if (req.signal) req.signal.removeEventListener?.("abort", onAbort);
      launchCleanup();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const delivery = () => (st.turnAccepted && !st.agySessionGone ? "accepted" : "not-accepted");
    const terminationResult = () => {
      ui.streamEnd();
      ui.stopSpinner();
      const text = st.agySessionGone ? "" : (st.finalText || st.text || "").trim();
      if (st.usage) ui.cost(st.usage);
      const sessionGone = termination?.reason === "session_gone";
      finish({
        text,
        session: st.session,
        usage: st.usage,
        error: termination ? termination.message : "native runtime stopped",
        errorKind: sessionGone ? st.errorKind : termination?.reason === "output" ? "output_limit" : "timeout",
        errorSource: "marker",
        ...(sessionGone ? { errorCode: st.errorCode, sessionGoneBeforeEffects: st.sessionGoneBeforeEffects === true } : {}),
        terminationVerified: Boolean(termination?.verified),
        turnDelivery: delivery(),
        appliedEffort,
      });
    };
    const verifyTermination = () => {
      if (settled || !termination) return;
      if (verifyTimer) return;
      if (child.__agentlasNativeChild === true && !(termination.pids || []).length) return;
      const alive = activeNativeProcessIds(termination.pids || []);
      if (Array.isArray(alive) && !alive.length) {
        termination.verified = true;
        terminationResult();
        return;
      }
      for (const pid of alive || termination.pids || []) signalNativePid(pid, "SIGKILL");
      verifyTimer = setTimeout(() => {
        verifyTimer = null;
        verifyTermination();
      }, 25);
    };
    const requestStop = (reason) => {
      if (termination || settled) return;
      const message = reason === "abort"
        ? "aborted"
        : reason === "session_gone"
          ? st.error
          : reason === "output"
            ? `native runtime stdout exceeded ${NATIVE_STDOUT_MAX_BYTES} bytes`
            : nativeTimeoutMessage(reason, reason === "idle" ? timeout.idleMs : timeout.totalMs);
      termination = { reason, message };
      st.error = message;
      st.errorShown = true;
      if (reason === "session_gone") ui.status(message);
      else if (reason !== "abort") ui.error(message);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = totalTimer = null;
      const forcedTree = forceStopNativeProcessTree(child);
      if (forcedTree.length) {
        termination.pids = forcedTree;
        verifyTermination();
        return;
      }
      terminateNativeChild(child, "SIGTERM");
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        terminateNativeChild(child, "SIGKILL");
        if (settled) return;
        forceTimer = setTimeout(terminationResult, Math.max(250, Math.min(1_000, timeout.killGraceMs)));
      }, timeout.killGraceMs);
    };
    const onAbort = () => requestStop("abort");
    // A lost agy conversation seen before any tool frame stops the context-free run at once (handleAgyLine).
    st.onSessionGone = () => { if (st.sessionGoneBeforeEffects) requestStop("session_gone"); };
    const armIdle = () => {
      if (settled || termination) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => requestStop("idle"), timeout.idleMs);
    };
    const markActivity = () => armIdle();

    if (plainStream) {
      let plainStarted = false;
      removeLineReader = lineReader(child.stdout, (l) => {
        if (!plainStarted) {
          ui.streamStart();
          plainStarted = true;
        }
        ui.streamDelta(l + "\n");
        st.text += l + "\n";
      }, markActivity, { maxBytes: NATIVE_STDOUT_MAX_BYTES, onLineDropped: (limit) => ui.error(`native runtime line over ${limit} bytes skipped`) });
    } else {
      removeLineReader = lineReader(child.stdout, lineHandler, markActivity, {
        maxBytes: NATIVE_STDOUT_MAX_BYTES,
        onLineDropped: (limit) => ui.error(`native runtime line over ${limit} bytes skipped`),
      });
    }

    child.stderr.setEncoding("utf8");
    const onStderr = (d) => {
      markActivity();
      stderrBuf += d;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    };
    child.stderr.on("data", onStderr);

    child.on("error", (err) => {
      if (settled) return;
      if (termination) {
        verifyTermination();
        return;
      }
      ui.stopSpinner();
      const failure = spawnFailure(err, child);
      finish({ text: "", session: st.session, error: err.message, ...failure,
        ...(failure.turnDelivery === "not-dispatched" ? {} : { turnDelivery: delivery() }), appliedEffort });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (termination) {
        verifyTermination();
        return;
      }
      ui.streamEnd();
      ui.stopSpinner();
      const text = (st.finalText || st.text || "").trim();
      if (st.usage) ui.cost(st.usage);
      /*
       * ★표식 없이 완주했는데 산출물이 거절 고지문인 경우 — 실측: codex 한도는
       * 거절문이 agent_message로 오고 turn.completed로 끝난다(표식 0, exit 0).
       * 이 한 자리에서만 텍스트 판별을 허용하고, 출처를 heuristic으로 남긴다
       * (판별 규칙은 runtime-refusal.cjs 한 곳 — 여기서 정규식을 다시 쓰지 않는다).
       */
      if (kind === "agy" && code === 0 && !st.error && !text) {
        const empty = agyEmptyRunFailure(st);
        if (empty) markFailure(st, empty);
      }
      if (code === 0 && !st.error) {
        const refusal = detectRuntimeRefusal(text);
        if (refusal) {
          st.error = refusal.message;
          st.errorKind = refusal.kind;
          st.errorSource = "heuristic";
        }
      }
      // A gone Codex rollout refused the resume before anything ran: the session layer may start a fresh generation
      // from the journal (sessions/session.cjs; Desktop unattended-session-turns.ts rule 4).
      if (kind === "codex" && codexResumeGone(st, code, text, stripAnsi(stderrBuf))) {
        st.sessionGoneBeforeEffects = true;
        markFailure(st, { kind: "exit", code: "session_not_found", source: "marker", message: "codex could not resume the saved thread" });
      }
      const exitError = code === 0
        ? st.error
        : st.error || [
            `${kind} exited with code ${code == null ? "unknown" : code}`,
            stripAnsi(stderrBuf).slice(-4000),
          ].filter(Boolean).join("\n");
      if (exitError && !st.errorKind) { st.errorKind = "exit"; st.errorSource = st.errorSource || "exit"; }
      finish({
        text: st.agySessionGone ? "" : text, session: st.session, usage: st.usage, error: exitError,
        ...(st.contextInputTokens ? { contextInputTokens: st.contextInputTokens } : {}),
        ownerControlTerminal: !exitError && st.ownerControlTerminal === "completed" ? "completed" : "uncertain",
        ...(exitError ? {
          errorKind: st.errorKind, errorSource: st.errorSource,
          ...(st.errorCode ? { errorCode: st.errorCode } : {}),
          ...(st.retryAfterHint ? { retryAfterHint: st.retryAfterHint } : {}),
          ...(st.errorCode === "session_not_found" ? { sessionGoneBeforeEffects: st.sessionGoneBeforeEffects === true } : {}),
        } : {}),
        turnDelivery: delivery(),
        appliedEffort,
      });
    });

    armIdle();
    totalTimer = setTimeout(() => requestStop("total"), timeout.totalMs);
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function nativeProcessRows() {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,stat="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 1_000,
    });
    return String(output || "").split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), stat: match[3] }
        : null;
    }).filter(Boolean);
  } catch {
    return null;
  }
}

function nativeProcessTreeIds(rootPid, rows = nativeProcessRows()) {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || !Array.isArray(rows)) return [];
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const childPid of children.get(pid) || []) visit(childPid);
    ordered.push(pid);
  };
  visit(rootPid);
  return ordered;
}

function activeNativeProcessIds(pids, rows = nativeProcessRows()) {
  if (!Array.isArray(pids) || !pids.length) return [];
  if (!Array.isArray(rows)) return null;
  const wanted = new Set(pids);
  return rows
    .filter((row) => wanted.has(row.pid) && !String(row.stat || "").startsWith("Z"))
    .map((row) => row.pid);
}

function signalNativePid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function forceStopNativeProcessTree(child) {
  if (
    process.platform === "win32" &&
    child?.__agentlasNativeChild === true &&
    Number.isInteger(child.pid) &&
    child.pid > 1
  ) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
      return [child.pid];
    } catch {
      return [];
    }
  }
  if (
    !child ||
    child.__agentlasGroupedChild !== true ||
    !Number.isInteger(child.pid) ||
    child.pid <= 1
  ) return [];

  // Native model CLIs may place tool shells in their own process groups. A
  // group-only kill can therefore close the model process while a Bash tool
  // keeps writing in the background. Freeze the whole observed ancestry first
  // so no descendant can advance, take one more snapshot for races, then kill
  // every owned process. The caller does not report cancellation until all
  // captured non-zombie PIDs are gone.
  const firstRows = nativeProcessRows();
  if (!Array.isArray(firstRows)) return [];
  const first = nativeProcessTreeIds(child.pid, firstRows);
  for (const pid of first) signalNativePid(pid, "SIGSTOP");
  const secondRows = nativeProcessRows();
  const second = Array.isArray(secondRows) ? nativeProcessTreeIds(child.pid, secondRows) : [];
  const all = [...new Set([...first, ...second])];
  for (const pid of second) signalNativePid(pid, "SIGSTOP");
  for (const pid of all) signalNativePid(pid, "SIGKILL");
  return all;
}

function terminateNativeChild(child, signal = "SIGTERM") {
  if (!child) return false;
  let signalled = false;
  if (
    process.platform !== "win32" &&
    child.__agentlasGroupedChild === true &&
    Number.isInteger(child.pid) &&
    child.pid > 1
  ) {
    try {
      process.kill(-child.pid, signal);
      signalled = true;
    } catch {
      // The group may already be gone while the direct child is still
      // observable. Fall through to the direct-child signal.
    }
  }
  if (!signalled) {
    try {
      signalled = child.kill(signal);
    } catch {
      signalled = false;
    }
  }
  if (
    process.platform === "win32" &&
    signal === "SIGKILL" &&
    Number.isInteger(child.pid) &&
    child.pid > 1
  ) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      signalled = true;
    } catch {
      // Direct child.kill above remains the best available fallback.
    }
  }
  return signalled;
}

module.exports = {
  runNativeTurn,
  summarizeToolInput,
  parseEffortChoices,
  cliEffortChoices,
  nativeEffortLevel,
  claudeArgs,
  claudePermissionArgs,
  codexArgs,
  codexPermissionArgs,
  geminiArgs,
  geminiPermissionArgs,
  agyArgs,
  agyPermissionArgs,
  agyPromptBootstrap,
  prepareAgyLaunch,
  handleAgyLine,
  claudeMcpIsolationArgs,
  geminiMcpIsolationArgs,
  prepareCodexRuntimeEnv,
  codexTelemetryOptOuts,
  prepareGeminiRuntimeEnv,
  geminiMcpIsolationReadiness,
  runtimeEnvForKind,
  prepareClaudeRuntimeEnv,
  cliMcpConfigPath,
  codexMcpArgs,
  nativeTimeoutConfig,
  directNativeTimeoutConfig,
  nativeProcessTreeIds,
  activeNativeProcessIds,
  forceStopNativeProcessTree,
  terminateNativeChild,
  NATIVE_STDOUT_MAX_BYTES,
  lineReader,
};
