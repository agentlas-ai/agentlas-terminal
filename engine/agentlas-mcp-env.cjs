"use strict";

/**
 * Environment boundary for stdio MCP children owned by Agentlas Terminal.
 *
 * The native LLM provider keeps its normal environment so its own login can
 * work. The MCP server does not inherit that environment: it receives a small
 * launch environment plus only the credential names declared by the trusted,
 * private system registry row selected after consent.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MCP_LAUNCH_SCHEMA = "agentlas.mcp-child-launch.v1";
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

const SAFE_BASE_ENV_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
]);

const FORBIDDEN_CREDENTIAL_ENV_KEYS = new Set([
  "HOME", "PATH", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "TMPDIR", "TMP", "TEMP",
  "NODE_OPTIONS", "NODE_PATH", "PYTHONHOME", "PYTHONPATH", "RUBYOPT",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "ELECTRON_RUN_AS_NODE",
  "SSLKEYLOGFILE", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENSSL_CONF", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GRPC_PROXY", "NPM_CONFIG_PROXY",
  "AGENTLAS_SESSION", "AGENTLAS_USER_DATA_DIR", "AGENTLAS_MCP_BASE_URL",
  "AGENTLAS_WEB_BASE_URL", "AGENTLAS_API_BASE_URL", "AGENTLAS_HUB_BASE_URL",
  "AGENTLAS_CLOUD_BASE_URL",
]);

function normalizeCredentialKeyNames(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("MCP credential key metadata must be a bounded array");
  const names = [];
  const seen = new Set();
  for (const raw of value) {
    const key = String(raw || "");
    if (!ENV_NAME_RE.test(key)) throw new Error("MCP credential key metadata contains an invalid name");
    if (FORBIDDEN_CREDENTIAL_ENV_KEYS.has(key) || key.startsWith("AGENTLAS_")) {
      throw new Error("MCP credential key metadata requests a protected host variable");
    }
    if (!seen.has(key)) names.push(key), seen.add(key);
  }
  return names;
}

function findEnvValue(source, key) {
  if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  if (process.platform !== "win32") return undefined;
  const match = Object.keys(source || {}).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  return match ? source[match] : undefined;
}

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

function realPath(directory) {
  // Keep the non-native resolver on Windows so HOMEDRIVE/HOMEPATH retain the
  // normal Win32 spelling; POSIX still gets the platform's canonical path.
  return fs.realpathSync(path.resolve(directory));
}

function inspectPrivateDirectory(directory) {
  const requestedPath = path.resolve(String(directory || ""));
  const stat = fs.lstatSync(requestedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("MCP runtime home must be a real directory");
  }
  const realpath = realPath(requestedPath);
  // A swap between the first lstat and realpath must not become the anchor
  // returned to callers. Re-read the pathname and retain both identities.
  const verified = fs.lstatSync(requestedPath);
  if (!sameDirectoryIdentity(stat, verified)) {
    throw new Error("MCP runtime directory changed during inspection");
  }
  return { requestedPath, stat: verified, realpath };
}

function assertPrivateDirectoryIdentity(expected, label = "MCP runtime directory") {
  const actual = inspectPrivateDirectory(expected.requestedPath);
  if (!sameDirectoryIdentity(expected.stat, actual.stat) || !samePath(expected.realpath, actual.realpath)) {
    throw new Error(`${label} changed during setup`);
  }
  return actual;
}

function ensurePrivateDirectoryInfo(directory) {
  const requestedPath = path.resolve(String(directory || ""));
  fs.mkdirSync(requestedPath, { recursive: true, mode: 0o700 });
  const before = inspectPrivateDirectory(requestedPath);
  try { fs.chmodSync(requestedPath, 0o700); } catch { /* Windows/best-effort */ }
  const after = inspectPrivateDirectory(requestedPath);
  if (!sameDirectoryIdentity(before.stat, after.stat) || !samePath(before.realpath, after.realpath)) {
    throw new Error("MCP runtime directory changed during setup");
  }
  return after;
}

function isStrictChild(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function mcpRuntimeHome(dataDir, serverIdentity) {
  const root = ensurePrivateDirectoryInfo(path.resolve(dataDir || path.join(os.tmpdir(), "agentlas-mcp-runtime")));
  const parent = ensurePrivateDirectoryInfo(path.join(root.realpath, "mcp-runtime-homes"));
  if (!isStrictChild(root.realpath, parent.realpath)) throw new Error("MCP runtime home escaped its private root");
  assertPrivateDirectoryIdentity(root, "MCP runtime root");
  assertPrivateDirectoryIdentity(parent, "MCP runtime parent");

  const digest = crypto.createHash("sha256").update(String(serverIdentity || "mcp"), "utf8").digest("hex").slice(0, 32);
  const target = ensurePrivateDirectoryInfo(path.join(parent.realpath, digest));
  if (!isStrictChild(parent.realpath, target.realpath)) throw new Error("MCP runtime home escaped its private parent");
  assertPrivateDirectoryIdentity(root, "MCP runtime root");
  assertPrivateDirectoryIdentity(parent, "MCP runtime parent");
  assertPrivateDirectoryIdentity(target, "MCP runtime target");
  return target.realpath;
}

function safeBaseEnvironment(source, options = {}) {
  const home = ensurePrivateDirectoryInfo(path.resolve(options.runtimeHome || mcpRuntimeHome(null, options.serverIdentity)));
  const runtimeHome = home.realpath;
  const result = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = findEnvValue(source, key);
    if (typeof value === "string" && value && !value.includes("\0")) result[key] = value;
  }
  // Never expose the user's real home through the environment. MCPs that need
  // credentials must use their declared registry key, not ambient dotfiles.
  // Anchor HOME before creating TMP so a target/parent swap cannot redirect
  // the mkdir through a successor symlink.
  assertPrivateDirectoryIdentity(home, "MCP runtime home");
  const runtimeTmpInfo = ensurePrivateDirectoryInfo(path.join(runtimeHome, "tmp"));
  assertPrivateDirectoryIdentity(home, "MCP runtime home");
  const runtimeTmp = assertPrivateDirectoryIdentity(runtimeTmpInfo, "MCP runtime tmp").realpath;
  if (!samePath(path.dirname(runtimeTmp), runtimeHome)) throw new Error("MCP runtime tmp escaped its private home");
  const canonicalHome = assertPrivateDirectoryIdentity(home, "MCP runtime home").realpath;
  result.HOME = canonicalHome;
  result.TMPDIR = runtimeTmp;
  result.TMP = runtimeTmp;
  result.TEMP = runtimeTmp;
  if (process.platform === "win32") {
    result.USERPROFILE = canonicalHome;
    result.HOMEDRIVE = path.parse(canonicalHome).root.replace(/[\\/]$/, "") || "C:";
    result.HOMEPATH = canonicalHome.slice(result.HOMEDRIVE.length) || "\\";
  }
  return result;
}

function buildMcpChildEnv(source, credentialKeyNames, options = {}) {
  const names = normalizeCredentialKeyNames(credentialKeyNames || []);
  const result = safeBaseEnvironment(source || {}, options);
  for (const key of names) {
    const value = findEnvValue(source || {}, key);
    if (typeof value === "string" && value && !value.includes("\0")) result[key] = value;
  }
  return result;
}

function hasSensitiveRuntimeArgument(command, args) {
  const values = [command, ...(args || [])].map((value) => String(value || ""));
  const joined = values.join("\n");
  if (/\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/i.test(joined)) return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(joined)) return true;
  if (/https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(joined)) return true;
  if (/[?&](?:api[-_]?key|token|secret|password|auth|authorization|cookie)=[^&\s]+/i.test(joined)) return true;
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(joined)) return true;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const credentialFlag = /^(?:--?)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret|password|passwd|private[-_]?key|authorization|cookie|credential)(?:=|:).+/i;
    const credentialFlagName = /^(?:--?)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret|password|passwd|private[-_]?key|authorization|cookie|credential)$/i;
    if (credentialFlag.test(value)) return true;
    if (credentialFlagName.test(value) && values[index + 1]) return true;
  }
  return false;
}

function validateLaunchDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid MCP launch descriptor");
  const expected = ["schema", "command", "args", "credentialKeyNames", "runtimeHome"];
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new Error("invalid MCP launch descriptor fields");
  if (value.schema !== MCP_LAUNCH_SCHEMA) throw new Error("unsupported MCP launch descriptor");
  if (typeof value.command !== "string" || !value.command.trim() || value.command.length > 4096 || /[\u0000\r\n]/.test(value.command)) {
    throw new Error("invalid MCP command");
  }
  if (!Array.isArray(value.args) || value.args.length > 128 || value.args.some((item) => typeof item !== "string" || item.length > 4096 || /[\u0000\r\n]/.test(item))) {
    throw new Error("invalid MCP arguments");
  }
  const credentialKeyNames = normalizeCredentialKeyNames(value.credentialKeyNames);
  if (hasSensitiveRuntimeArgument(value.command, value.args)) throw new Error("MCP executable metadata contains a credential-like value");
  if (typeof value.runtimeHome !== "string" || !path.isAbsolute(value.runtimeHome) || value.runtimeHome.length > 4096 || /[\u0000\r\n]/.test(value.runtimeHome)) {
    throw new Error("invalid MCP runtime home");
  }
  return {
    schema: MCP_LAUNCH_SCHEMA,
    command: value.command,
    args: [...value.args],
    credentialKeyNames,
    runtimeHome: value.runtimeHome,
  };
}

function encodeLaunchDescriptor(value) {
  const validated = validateLaunchDescriptor(value);
  const json = JSON.stringify(validated);
  if (Buffer.byteLength(json, "utf8") > MAX_DESCRIPTOR_BYTES) throw new Error("MCP launch descriptor is too large");
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeLaunchDescriptor(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_DESCRIPTOR_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid MCP launch descriptor encoding");
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid MCP launch descriptor encoding"); }
  return validateLaunchDescriptor(parsed);
}

function wrapStdioServer(server, options = {}) {
  const args = Array.isArray(server?.args) ? server.args : (() => {
    try { return JSON.parse(server?.args_json || "[]"); } catch { return null; }
  })();
  if (!server || typeof server.command !== "string" || !Array.isArray(args)) throw new Error("invalid MCP stdio server");
  const identity = String(server.catalog_id || server.id || server.name || "mcp");
  const runtimeHome = server.mcpRuntimeHome || mcpRuntimeHome(options.dataDir, identity);
  const credentialKeyNames = normalizeCredentialKeyNames(server.credentialKeyNames || []);
  const encoded = encodeLaunchDescriptor({
    schema: MCP_LAUNCH_SCHEMA,
    command: server.command,
    args,
    credentialKeyNames,
    runtimeHome,
  });
  return {
    command: options.nodePath || process.execPath,
    args: [path.join(__dirname, "agentlas-mcp-wrapper.cjs"), encoded],
  };
}

module.exports = {
  MCP_LAUNCH_SCHEMA,
  SAFE_BASE_ENV_KEYS,
  normalizeCredentialKeyNames,
  mcpRuntimeHome,
  safeBaseEnvironment,
  buildMcpChildEnv,
  hasSensitiveRuntimeArgument,
  validateLaunchDescriptor,
  encodeLaunchDescriptor,
  decodeLaunchDescriptor,
  wrapStdioServer,
};
