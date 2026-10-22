"use strict";
// The Claude Code config dir an engine-run product turn uses: the person's ~/.claude minus their sessions and history.
// Same rule as the desktop (agentlas_desktop electron/runtime/claude-product-home.ts, owner 2026-10-13): product sessions
// never appear in the person's Claude app, the person stays signed in. CLAUDE_CONFIG_DIR points at the mirror and
// CLAUDE_SECURESTORAGE_CONFIG_DIR="" keeps the person's own keychain item (Claude Code 2.1.296 secure-storage naming).
// The mirror links only allowlisted configuration entries; Claude creates the mirror's own session stores.
//
// Owner 2026-10-06/10-11: the person's own settings and context never drive product agents. settings.json and
// .claude.json are the mirror's own files holding only an allowlist of the person's (same lists as the desktop,
// 2026-10-17): linked whole, every engine product turn ran the person's hooks (a Stop hook that ends dev app instances),
// got their env credentials (APP_STORE_CONNECT_*, GOOGLE_APPLICATION_CREDENTIALS) and their pre-approved commands.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Not linked, because the engine has no settings overlay to switch them off (the desktop excludes them per item there):
// CLAUDE.md and rules/ (the person's instructions), skills/ and commands/ (their skills), agents/ (their subagents).
// settings.json / settings.local.json are the mirror's own allowlisted file (productClaudeSettings).
const CLAUDE_CONFIG_ENTRIES = [
  "plugins", "output-styles", "keybindings.json", "policy-limits.json", "remote-settings.json", "managed-settings.json",
];
const isPersonalSessionEntry = (name) => !CLAUDE_CONFIG_ENTRIES.includes(name);
const CLAUDE_PERSONAL_SETTINGS_FILES = ["settings.json", "settings.local.json"];

/**
 * Kept from the person's settings, each for one reason: sign-in (apiKeyHelper, awsAuthRefresh, awsCredentialExport,
 * forceLoginMethod, forceLoginOrgUUID) and the model default the CLI falls back to (model, effortLevel). `env` keeps
 * only the endpoint, sign-in and network-path variables, and cloud credentials only when the same settings route Claude
 * through that cloud, plus the person's telemetry OPT-OUTS when switched on (owner decision 2026-10-17, every product
 * home: never an opt-in such as CLAUDE_CODE_ENABLE_TELEMETRY; otherwise the vendor default). enabledPlugins/
 * extraKnownMarketplaces keep only Agentlas's own marketplaces. Same rule as Desktop electron/runtime/claude-product-home.ts.
 */
const CLAUDE_SETTINGS_KEYS = new Set(["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod",
  "forceLoginOrgUUID", "model", "effortLevel"]);
const CLAUDE_ENV_KEYS = /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_SKIP_(?:BEDROCK|VERTEX|FOUNDRY)_AUTH|CLAUDE_CODE_CLIENT_(?:CERT|KEY|KEY_PASSPHRASE)|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS)$/;
const CLAUDE_OPT_OUT_ENV_KEYS = /^(?:DISABLE_TELEMETRY|DISABLE_ERROR_REPORTING|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)$/;
const switchedOn = (value) => value !== undefined && value !== null && value !== "" && value !== "0" && value !== 0 && value !== false && value !== "false";
const CLAUDE_CLOUD_ENV_KEYS = [
  { when: /^CLAUDE_CODE_USE_BEDROCK$/, keys: /^(?:AWS_[A-Z0-9_]+)$/ },
  { when: /^CLAUDE_CODE_USE_VERTEX$/, keys: /^(?:CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT)$/ },
];
const AGENTLAS_CLAUDE_MARKETPLACES = new Set(["agentlas-core-engine", "agentlas-sei"]);

const objectOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** The mirror's own settings.json from the person's settings.json and settings.local.json (the latter wins). */
function productClaudeSettings(settingsText, localText = null) {
  const read = (text) => { if (!text) return {}; try { return objectOf(JSON.parse(text)); } catch { return {}; } };
  const out = {}; const env = {}; const plugins = {}; const markets = {};
  for (const source of [read(settingsText), read(localText)]) {
    for (const [key, value] of Object.entries(source)) if (CLAUDE_SETTINGS_KEYS.has(key)) out[key] = value;
    const personalEnv = objectOf(source.env);
    for (const [key, value] of Object.entries(personalEnv)) {
      if (CLAUDE_ENV_KEYS.test(key)) env[key] = value;
      if (CLAUDE_OPT_OUT_ENV_KEYS.test(key) && switchedOn(value)) env[key] = value;
      for (const cloud of CLAUDE_CLOUD_ENV_KEYS) {
        const routed = Object.entries(personalEnv).some(([name, on]) => cloud.when.test(name) && on !== "" && on !== "0" && on !== false && on !== "false");
        if (routed && cloud.keys.test(key)) env[key] = value;
      }
    }
    for (const [id, value] of Object.entries(objectOf(source.enabledPlugins))) {
      if (AGENTLAS_CLAUDE_MARKETPLACES.has(id.slice(id.lastIndexOf("@") + 1))) plugins[id] = value;
    }
    for (const [name, value] of Object.entries(objectOf(source.extraKnownMarketplaces))) if (AGENTLAS_CLAUDE_MARKETPLACES.has(name)) markets[name] = value;
  }
  if (Object.keys(env).length > 0) out.env = env;
  if (Object.keys(plugins).length > 0) out.enabledPlugins = plugins;
  if (Object.keys(markets).length > 0) out.extraKnownMarketplaces = markets;
  return `${JSON.stringify(out, null, 2)}\n`;
}

function realClaudeConfigDir(env = process.env) {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"));
}
function personalGlobalConfigPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(realClaudeConfigDir(env), ".claude.json") : path.join(env.HOME || os.homedir(), ".claude.json");
}
function quietly(action) { try { action(); } catch { /* best effort */ } }

/**
 * Keys of the person's global config kept: sign-in (oauthAccount, primaryApiKey, customApiKeyResponses, userID), how the
 * shared install updates itself (installMethod, autoUpdates, autoUpdatesProtectedForNative), first-run and migration
 * state (hasCompletedOnboarding, lastOnboardingVersion, migrationVersion, *MigrationComplete). Everything else, user-scope
 * MCP servers and per-project history included, is left out by construction.
 */
const CLAUDE_GLOBAL_CONFIG_KEYS = new Set(["oauthAccount", "primaryApiKey", "customApiKeyResponses", "userID",
  "installMethod", "autoUpdates", "autoUpdatesProtectedForNative", "hasCompletedOnboarding", "lastOnboardingVersion", "migrationVersion"]);

/** The mirror's own global config: the allowlisted keys of the person's, the mirror's own projects, no MCP servers. */
function productClaudeGlobalConfig(text, previousOwn) {
  const source = JSON.parse(text);
  let own = {};
  if (previousOwn) { try { own = JSON.parse(previousOwn); } catch { own = {}; } }
  const kept = Object.fromEntries(Object.entries(source).filter(([key]) => CLAUDE_GLOBAL_CONFIG_KEYS.has(key) || /MigrationComplete$/.test(key)));
  return JSON.stringify({ ...kept, ...(own.projects ? { projects: own.projects } : {}), mcpServers: {} }, null, 2);
}

function writeIfChanged(at, content) {
  try { if (fs.readFileSync(at, "utf8") === content) return; } catch { /* absent */ }
  const tmp = `${at}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, at);
}

function syncClaudeProductHome(realDir, mirror, personalGlobal) {
  if (!fs.existsSync(realDir)) return { skip: "no-real-dir" };
  fs.mkdirSync(mirror, { recursive: true, mode: 0o700 });
  const wanted = new Set(fs.readdirSync(realDir).filter((name) => !isPersonalSessionEntry(name)));
  try {
    for (const name of wanted) {
      const at = path.join(mirror, name), target = path.join(realDir, name);
      let current = null;
      try { current = fs.readlinkSync(at); } catch { /* absent or not a link */ }
      if (current === target) continue;
      if (current !== null || fs.existsSync(at)) quietly(() => fs.rmSync(at, { recursive: false, force: true }));
      const isDir = fs.statSync(target).isDirectory();
      fs.symlinkSync(target, at, process.platform === "win32" && isDir ? "junction" : undefined);
    }
  } catch {
    return { skip: "links-unavailable" };
  }
  // Links to entries the person removed, or that are no longer linked at all (an older mirror's settings.json, agents,
  // skills...), go away; the mirror's own stores are never links and stay.
  for (const name of fs.readdirSync(mirror)) {
    if (wanted.has(name) || name === ".claude.json") continue;
    const at = path.join(mirror, name);
    quietly(() => {
      if (fs.lstatSync(at).isSymbolicLink() && (!isPersonalSessionEntry(name) || fs.readlinkSync(at) === path.join(realDir, name))) fs.unlinkSync(at);
    });
  }
  // The mirror's own settings.json; a failed write leaves the mirror without user settings (Claude's defaults).
  const personalSettings = (name) => { try { return fs.readFileSync(path.join(realDir, name), "utf8"); } catch { return null; } };
  for (const name of CLAUDE_PERSONAL_SETTINGS_FILES) quietly(() => { if (fs.lstatSync(path.join(mirror, name)).isSymbolicLink()) fs.unlinkSync(path.join(mirror, name)); });
  quietly(() => writeIfChanged(path.join(mirror, "settings.json"), productClaudeSettings(personalSettings("settings.json"), personalSettings("settings.local.json"))));
  const ownGlobal = path.join(mirror, ".claude.json");
  try {
    let previous;
    try { previous = fs.readFileSync(ownGlobal, "utf8"); } catch { previous = undefined; }
    writeIfChanged(ownGlobal, productClaudeGlobalConfig(fs.readFileSync(personalGlobal, "utf8"), previous));
  } catch { /* no global config yet: Claude creates the mirror's own */ }
  return { dir: mirror };
}

/** The run env: the mirror as config dir and the person's own sign-in. Unchanged env when the mirror cannot hold. */
function withClaudeProductHome(env, mirror) {
  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return env;
  const real = realClaudeConfigDir(env);
  const result = syncClaudeProductHome(real, mirror, personalGlobalConfigPath(env));
  if (!result.dir) return env;
  return { ...env, CLAUDE_CONFIG_DIR: result.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ? real : "" };
}

const CLAUDE_NATIVE_COMPACTION_ENV_KEYS = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"];
const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;
const CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE = 20_000;

/** Translate the selected window and native limit to Claude's output-reserve-adjusted threshold. */
function claudeNativeCompactionEnv(compaction, env = {}) {
  const { windowTokens: window, limitTokens: limit } = compaction;
  if (typeof window !== "number" || typeof limit !== "number" || !Number.isSafeInteger(window) || !Number.isSafeInteger(limit)) return null;
  if (window < CLAUDE_AUTO_COMPACT_WINDOW_MIN || window > CLAUDE_AUTO_COMPACT_WINDOW_MAX || limit <= 0 || limit >= window) return null;
  const maxOutput = Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const reserve = Number.isSafeInteger(maxOutput) && maxOutput > 0 ? Math.min(maxOutput, CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE) : CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE;
  const pct = Math.ceil((limit * 100 / (window - reserve)) * 1e6) / 1e6;
  if (!(pct > 0 && pct <= 100)) return null;
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) };
}

/** A run owns both compaction variables; unknown or unsupported windows leave Claude's default in charge. */
function withClaudeNativeCompaction(env, compaction) {
  const out = { ...env };
  for (const key of CLAUDE_NATIVE_COMPACTION_ENV_KEYS) delete out[key];
  const variables = claudeNativeCompactionEnv(compaction, out);
  return variables ? Object.assign(out, variables) : out;
}

module.exports = { CLAUDE_CONFIG_ENTRIES, withClaudeProductHome, syncClaudeProductHome, productClaudeGlobalConfig, productClaudeSettings,
  CLAUDE_NATIVE_COMPACTION_ENV_KEYS, claudeNativeCompactionEnv, withClaudeNativeCompaction };
