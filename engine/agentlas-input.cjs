"use strict";
/*
 * agentlas-input: terminal input ergonomics for the REPL.
 *   - persistent command history (load/save across sessions, per machine)
 *   - tab autocomplete (slash commands, agent/firm slugs, runtime kinds, perm levels, @paths, /cwd /import paths)
 *   - multiline composer (trailing backslash continues the line)
 * Self-contained, zero-dependency, TTY-aware. Pure functions are unit-testable under plain node.
 * (Ctrl-R reverse-i-search needs TTY keypress + rl internals → tracked separately; /history bridges it.)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const i18n = require("./agentlas-i18n.cjs");

function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

const HISTORY_MAX = 500;
const HISTORY_SCHEMA_VERSION = 2;
const HISTORY_LOCK_WAIT_MS = 2_000;
const HISTORY_LOCK_STALE_MS = 30_000;
function historyPath() {
  return path.join(userDataDir(), "cli-history.json");
}

function historyBackupPath() {
  return historyPath() + ".bak";
}

function normalizeHistoryDocument(raw) {
  if (Array.isArray(raw)) {
    // Legacy history had no project identity. Keep it quarantined on disk so
    // migration is non-destructive, but never surface it in another project.
    return {
      version: HISTORY_SCHEMA_VERSION,
      entries: [],
      legacyUnscoped: raw.filter((x) => typeof x === "string").slice(0, HISTORY_MAX),
    };
  }
  if (raw && raw.version === HISTORY_SCHEMA_VERSION && Array.isArray(raw.entries)) {
    return {
      version: HISTORY_SCHEMA_VERSION,
      entries: raw.entries,
      legacyUnscoped: Array.isArray(raw.legacyUnscoped) ? raw.legacyUnscoped.slice(0, HISTORY_MAX) : [],
    };
  }
  return null;
}

function readHistoryFile(file) {
  try {
    return normalizeHistoryDocument(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function historyScope(cwd = process.cwd()) {
  try { return path.resolve(String(cwd || process.cwd())); } catch { return String(cwd || process.cwd()); }
}

function readHistoryDocument() {
  const current = readHistoryFile(historyPath());
  if (current) return current;
  const backup = readHistoryFile(historyBackupPath());
  if (backup) return backup;
  return { version: HISTORY_SCHEMA_VERSION, entries: [], legacyUnscoped: [] };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* old Node fallback */ }
  }
}

function withHistoryLock(callback) {
  const lock = historyPath() + ".lock";
  const deadline = Date.now() + HISTORY_LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > HISTORY_LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("history lock timeout");
      sleepSync(10);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* another process will recover a stale lock */ }
  }
}

function atomicWriteHistoryFile(file, document) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(document), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* win32 */ }
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* already renamed or never created */ }
  }
}

function quarantineMalformedHistory() {
  const file = historyPath();
  if (!fs.existsSync(file) || readHistoryFile(file)) return;
  const quarantine = `${file}.corrupt-${Date.now()}-${process.pid}`;
  try { fs.renameSync(file, quarantine); } catch { /* keep fail-closed recovery from backup */ }
}

// readline keeps history with index 0 = most recent. Only the current working
// folder's entries are returned; legacy unscoped strings are never displayed.
function loadHistory(cwd = process.cwd()) {
  const scope = historyScope(cwd);
  return readHistoryDocument().entries
    .filter((entry) => entry && entry.cwd === scope && typeof entry.text === "string")
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .map((entry) => entry.text)
    .slice(0, HISTORY_MAX);
}

function saveHistory(list, cwd = process.cwd()) {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    const clean = (list || []).filter((x) => typeof x === "string" && x.trim()).slice(0, HISTORY_MAX);
    const scope = historyScope(cwd);
    return withHistoryLock(() => {
      const currentFileWasValid = Boolean(readHistoryFile(historyPath()));
      const document = readHistoryDocument();
      quarantineMalformedHistory();
      const existingScope = document.entries
        .filter((entry) => entry && entry.cwd === scope && typeof entry.text === "string")
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
      const mergedTexts = [...clean];
      for (const entry of existingScope) {
        if (!mergedTexts.includes(entry.text)) mergedTexts.push(entry.text);
      }
      const other = document.entries.filter((entry) => entry && entry.cwd !== scope && typeof entry.text === "string");
      const now = Date.now();
      const current = mergedTexts.slice(0, HISTORY_MAX).map((text, index) => ({ text, cwd: scope, ts: now - index }));
      const next = {
        version: HISTORY_SCHEMA_VERSION,
        entries: [...current, ...other]
          .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
          .slice(0, HISTORY_MAX),
        legacyUnscoped: document.legacyUnscoped,
      };
      if (currentFileWasValid) atomicWriteHistoryFile(historyBackupPath(), document);
      atomicWriteHistoryFile(historyPath(), next);
      return true;
    });
  } catch {
    return false;
  }
}
// Seed an interactive readline with saved history (no-op on non-TTY).
function attachHistory(rl, cwd = process.cwd()) {
  try {
    if (rl && rl.terminal && Array.isArray(rl.history)) rl.history = loadHistory(cwd);
  } catch {
    /* ignore */
  }
}
function persistHistory(rl, cwd = process.cwd()) {
  try {
    if (rl && Array.isArray(rl.history)) saveHistory(rl.history, cwd);
  } catch {
    /* ignore */
  }
}

// ── multiline ─────────────────────────────────────────────
// A line ending in an odd number of trailing backslashes is a continuation.
function isContinuation(line) {
  const m = /\\+$/.exec(line || "");
  return !!m && m[0].length % 2 === 1;
}
function stripContinuation(line) {
  return (line || "").replace(/\\$/, "");
}

function tokenizeCommandLine(value) {
  const text = String(value || "");
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let escaped = false;
  const push = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  for (const char of text) {
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    token += char;
    tokenStarted = true;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("unclosed quote");
  push();
  return tokens;
}

// ── completion ────────────────────────────────────────────
const SLASH_COMMAND_META = [
  { command: "/help", description: "Show Agentlas terminal commands", category: "Help", usage: "/help", detail: "Open the command reference, shortcuts, and common flows." },
  { command: "/status", description: "Show model/runtime, agent, permission, and directory", category: "Session", usage: "/status", detail: "Print the current runtime, active agent or company, permission level, and cwd." },
  { command: "/skills", description: "List available Agentlas terminal skills", category: "Discovery", usage: "/skills", detail: "Show the slash-command skills Agentlas can run inside this terminal." },
  { command: "/career-graph", description: "Show or add Career Graph source refs", category: "Knowledge", usage: "/career-graph add ./docs", detail: "Career Graph routes agents to source Markdown, JSONL ledgers, sitemap, and code map before broad scans.", examples: ["/career-graph status", "/career-graph add ./docs", "/career-graph open"] },
  { command: "/ontology", description: "Turn on, list, or add project ontology sources", category: "Knowledge", usage: "/ontology add ./docs", detail: "Also understands natural text like /ontology use ./docs as company knowledge.", examples: ["/ontology list", "/ontology use ./docs as company knowledge", "/ontology open"] },
  { command: "/agents", description: "List installed agents", category: "Routing", usage: "/agents", detail: "Show local agents and their routed runtime." },
  { command: "/team", description: "View or pin each agent runtime", category: "Routing", usage: "/team <agent> <runtime|auto>", detail: "Pin one agent to claude-code, codex, gemini, or automatic routing." },
  { command: "/agent", description: "Switch to another agent", category: "Routing", usage: "/agent <name>", detail: "Switch the current conversation to an installed agent." },
  { command: "/firms", description: "List installed companies", category: "Routing", usage: "/firms", detail: "Show company CEOs available in this terminal." },
  { command: "/firm", description: "Switch to a company CEO", category: "Routing", usage: "/firm <name>", detail: "Switch the current conversation to a company CEO agent." },
  { command: "/runtime", description: "Switch runtime: claude-code, codex, agy, legacy gemini, BYOK, or Ollama", category: "Settings", usage: "/runtime agy", detail: "Change the engine Agentlas uses for subsequent turns." },
  { command: "/model", description: "Pin a model or return to auto allocation", category: "Settings", usage: "/model <id|auto>", detail: "An id is an explicit session pin; auto lets the higher-level allocator choose a provider-compatible tier." },
  { command: "/effort", description: "Pin reasoning effort or return to auto", category: "Settings", usage: "/effort low|medium|high|max|off|auto", detail: "A level is an explicit pin; auto lets the higher-level allocator choose per task; off is an explicit no-effort pin." },
  { command: "/permission", description: "Set read/write/full permission", category: "Settings", usage: "/permission full", detail: "No argument shows what read, write, and full mean.", aliases: ["/perm"] },
  { command: "/permissions", description: "Show or set current permission", category: "Settings", usage: "/permissions", detail: "Codex-style permission screen for Agentlas read/write/full." },
  { command: "/setup", description: "Run first-time setup again", category: "Settings", usage: "/setup", detail: "Re-run language, runtime, and default permission setup in-place." },
  { command: "/project", description: "Inspect or explicitly initialize local project state", category: "Files", usage: "/project status|init", detail: "Ordinary turns never seed project files. `init` explicitly creates private .agentlas state and updates local ignore/templates." },
  { command: "/config", description: "Explicit on/off for Stormbreaker and Workforce Ontology auto engagement", category: "Settings", usage: "/config [storm|network] [on|off]", detail: "Both engines default to off — no automatic activation. Turn one on to let direct-routed real-work prompts engage it; /storm and /network stay available explicitly either way.", examples: ["/config", "/config storm on", "/config network off"], aliases: ["/toggles"] },
  { command: "/cwd", description: "Show or change the working folder", category: "Files", usage: "/cwd <path>", detail: "Change the folder used for tools, file mentions, and local commands." },
  { command: "/memory", description: "Show the memory injected into this run", category: "Context", usage: "/memory", detail: "Print the project memory that Agentlas adds to agent turns." },
  { command: "/side", description: "Ask a side question without saving it to chat context", category: "Context", usage: "/side <question>", detail: "Runs a one-off answer using current context, then returns without appending to chat history.", aliases: ["/btw"] },
  { command: "/multimodal", description: "Show or set image, video, and audio fallback providers", category: "Settings", usage: "/multimodal", detail: "Inspect or change fallback providers for media work." },
  { command: "/mcp", description: "List configured MCP servers", category: "Settings", usage: "/mcp", detail: "Show MCP servers available only during explicit full-access turns." },
  { command: "/diff", description: "Show the current git diff", category: "Files", usage: "/diff", detail: "Print the working-tree diff for the current cwd." },
  { command: "/history", description: "Show recent inputs", category: "Session", usage: "/history", detail: "Show persisted terminal input history." },
  { command: "/resume", description: "Resume a recent runtime session", category: "Session", usage: "/resume [n]", detail: "List recent agent/runtime sessions and continue one (restores the native session thread)." },
  { command: "/compact", description: "Drop older transcript turns and keep recent context", category: "Context", usage: "/compact", detail: "Keep the newest conversation turns and discard older in-session context." },
  { command: "/cost", description: "Show session usage and cost by runtime", category: "Session", usage: "/cost", detail: "Show usage captured by Agentlas across routed runtimes." },
  { command: "/keybindings", description: "Show terminal shortcuts", category: "Help", usage: "/keybindings", detail: "Show slash, file mention, shell, multiline, history, and Ctrl-C controls." },
  { command: "/clear", description: "Clear the chat and redraw", category: "Session", usage: "/clear", detail: "Clear local conversation state and redraw the Agentlas banner." },
  { command: "/import", description: "Import a local agent or team folder", category: "Files", usage: "/import <path>", detail: "Install a local agent or team into Agentlas." },
  { command: "/marketplace", description: "Browse/install marketplace agents", category: "Routing", usage: "/marketplace", detail: "Show how to install agents from the Agentlas cloud marketplace or a local folder.", aliases: ["/market"] },
  { command: "/storm", description: "Run a force-robust Stormbreaker pipeline on a goal", category: "Engine", usage: "/storm <goal> [--research]", detail: "Route the goal through Hephaestus Stormbreaker and execute the verified pipeline; --research grounds it with Research Engine evidence." },
  { command: "/swarm", description: "Fan out an emergent agent swarm on a goal", category: "Engine", usage: "/swarm <goal> [--parallel N]", detail: "Parallel workers share a blackboard and spawn subtasks with ## Spawn; a synthesizer merges results into one answer." },
  { command: "/build", description: "Build/repair/package an agent or team (Hephaestus)", category: "Engine", usage: "/build <what to build>", detail: "Runs Hephaestus hep-build natively — deep interview, scaffolding, packaging." },
  { command: "/route", description: "Preview which agent/pipeline would take a request", category: "Engine", usage: "/route <request>", detail: "Runs the Hephaestus router without executing — shows the selected agent, candidates, and reasons." },
  { command: "/research", description: "Run the Hephaestus Research Engine", category: "Engine", usage: "/research search \"query\"", detail: "status|gather|search|read|plan — evidence-grade web research from the terminal." },
  { command: "/search", description: "Discover agents in the Hub", category: "Hub", usage: "/search <what you need>", detail: "Search the Agentlas Hub + local for an agent that fits the task (hep-search)." },
  { command: "/install", description: "Install an agent from the Hub by slug", category: "Hub", usage: "/install <slug>", detail: "Install a marketplace agent into this terminal." },
  { command: "/network", description: "Staff and execute an ontology-grounded task force", category: "Engine", usage: "/network <request> [--benchmark]", detail: "The active top host LLM creates the work order, searches the Hub workforce ontology, selects exact releases, and executes a receipt-backed task force.", aliases: ["/taskforce", "/workforce"] },
  { command: "/browser", description: "Real browser execution hardpoint", category: "Engine", usage: "/browser [sub]", detail: "Runs the Agentlas browser hardpoint (hep-browser)." },
  { command: "/connect", description: "Wire Telegram / platforms to an agent team", category: "Hub", usage: "/connect", detail: "Runs Hephaestus hep-connect for platform integration." },
  { command: "/doctor", description: "Check runtimes and local data", category: "Health", usage: "/doctor", detail: "Run local checks for runtimes, data, credentials, and setup." },
  { command: "/exit", description: "Quit Agentlas", category: "Session", usage: "/exit", detail: "Close the terminal session.", aliases: ["/quit"] },
];
const SLASH_COMMANDS = SLASH_COMMAND_META.flatMap((entry) => [entry.command].concat(entry.aliases || []));
// /runtime 이 받는 spec 전체(네이티브 CLI + API 백엔드) — 정본은 runtimes/kinds.cjs.
const RUNTIME_SPECS = require("./runtimes/kinds.cjs").RUNTIME_SPECS;
const PERM_LEVELS = ["read", "write", "full"];

const HELP_KEY_BY_COMMAND = {
  "/help": "help.help",
  "/status": "help.status",
  "/skills": "help.skills",
  "/career-graph": "help.careerGraph",
  "/ontology": "help.ontology",
  "/agents": "help.agents",
  "/team": "help.team",
  "/agent": "help.agent",
  "/firms": "help.firms",
  "/firm": "help.firms",
  "/runtime": "help.runtime",
  "/model": "help.model",
  "/effort": "help.effort",
  "/permission": "help.permission",
  "/permissions": "help.permissions",
  "/setup": "help.setup",
  "/project": "help.project",
  "/config": "help.config",
  "/cwd": "help.cwd",
  "/memory": "help.memory",
  "/side": "help.side",
  "/multimodal": "help.multimodal",
  "/mcp": "help.mcp",
  "/diff": "help.diff",
  "/history": "help.history",
  "/resume": "help.resume",
  "/compact": "help.compact",
  "/cost": "help.cost",
  "/keybindings": "help.keybindings",
  "/clear": "help.clear",
  "/import": "help.import",
  "/marketplace": "help.market",
  "/install": "help.install",
  "/storm": "help.storm",
  "/swarm": "help.swarm",
  "/build": "help.build",
  "/route": "help.route",
  "/research": "help.research",
  "/search": "help.search",
  "/network": "help.network",
  "/browser": "help.browser",
  "/connect": "help.connect",
  "/doctor": "help.doctor",
  "/exit": "help.exit",
};

function uniqStartsWith(cands, token) {
  const hits = cands.filter((c) => c.startsWith(token));
  return hits.length ? hits : cands;
}

function localizeSlashEntry(entry, lang) {
  const helpKey = HELP_KEY_BY_COMMAND[entry.command];
  const description = helpKey ? i18n.t(lang, helpKey) : entry.description;
  const category = entry.category ? i18n.t(lang, `category.${entry.category}`) : entry.category;
  const usage = lang === "ko"
    ? String(entry.usage || entry.command)
      .replaceAll("<goal>", "<목표>")
      .replaceAll("<request>", "<요청>")
      .replaceAll("<task>", "<작업>")
      .replaceAll("<question>", "<질문>")
      .replaceAll("<query>", "<검색어>")
      .replaceAll("<slug>", "<식별자>")
      .replaceAll("<path>", "<경로>")
      .replaceAll("<name>", "<이름>")
      .replaceAll("<what you need>", "<필요한 작업>")
      .replaceAll("<what to build>", "<빌드할 대상>")
      .replaceAll("\"query\"", "\"검색어\"")
      .replaceAll("[sub]", "[하위 명령]")
    : entry.usage;
  return {
    ...entry,
    description,
    category,
    usage,
    // English keeps the longer authored detail. Other languages must not fall back to
    // an English paragraph under an otherwise-localized command palette.
    detail: lang === "en" ? entry.detail : description,
  };
}

function slashCommandEntries(lang = "en") {
  const rows = [];
  for (const rawEntry of SLASH_COMMAND_META) {
    const entry = localizeSlashEntry(rawEntry, lang);
    rows.push({ ...entry, aliasOf: null });
    for (const alias of entry.aliases || []) {
      rows.push({
        command: alias,
        description: lang === "ko" ? `${entry.command} 별칭` : `Alias for ${entry.command}`,
        category: entry.category,
        usage: alias + (entry.usage && entry.usage.includes(" ") ? entry.usage.slice(entry.usage.indexOf(" ")) : ""),
        detail: entry.detail,
        examples: entry.examples,
        aliasOf: entry.command,
      });
    }
  }
  return rows;
}

function slashCommandQuery(line) {
  const value = String(line || "");
  if (!value.startsWith("/")) return null;
  if (isAbsolutePathTask(value)) return null;
  if (/\s/.test(value)) return null;
  return value;
}

function slashCommandSuggestions(line, limit = 12, lang = "en") {
  const query = slashCommandQuery(line);
  if (query == null) return [];
  const q = query.toLowerCase();
  const entries = slashCommandEntries(lang);
  const starts = entries.filter((entry) => entry.command.toLowerCase().startsWith(q));
  const contains = entries.filter(
    (entry) =>
      !entry.command.toLowerCase().startsWith(q) &&
      (entry.command.toLowerCase().includes(q.slice(1)) || entry.description.toLowerCase().includes(q.slice(1))),
  );
  if (q === "/") return entries.slice(0, limit);
  return starts.concat(contains).slice(0, limit);
}

function padVisible(value, width) {
  const current = visibleWidthLite(value);
  if (current >= width) return value;
  return value + " ".repeat(width - current);
}

function stripAnsiLite(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateVisible(value, width) {
  const clean = stripAnsiLite(value);
  if (visibleWidthLite(clean) <= width) return value;
  let out = "";
  let used = 0;
  const room = Math.max(0, width - 1);
  for (const ch of clean) {
    const cells = cellWidthLite(ch);
    if (used + cells > room) break;
    out += ch;
    used += cells;
  }
  return out + "…";
}

function cellWidthLite(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20) return 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) ? 2 : 1;
}

function visibleWidthLite(value) {
  let width = 0;
  for (const ch of stripAnsiLite(value)) width += cellWidthLite(ch);
  return width;
}

function renderSlashPalette(rows, selectedIndex, opts = {}) {
  if (!rows.length) return "";
  const columns = Math.max(12, Math.floor(Number(opts.columns || 88)));
  const fallbackColors = {
    faint: (s) => String(s),
    dim: (s) => String(s),
    text: (s) => String(s),
    blue: (s) => String(s),
    inverse: (s) => String(s),
  };
  const c = { ...fallbackColors, ...(opts.colors || {}) };
  const lang = opts.lang || "en";
  const lineWidth = Math.max(1, columns - 1);
  const desiredCommandWidth = Math.max(
    8,
    rows.reduce((n, row) => Math.max(n, visibleWidthLite(row.command)), 0) + 2,
  );
  const commandWidth = Math.min(
    24,
    desiredCommandWidth,
    Math.max(8, Math.floor((lineWidth - 2) * 0.55)),
  );
  const descWidth = Math.max(0, lineWidth - commandWidth - 1);
  const selected = rows[Math.max(0, Math.min(selectedIndex, rows.length - 1))] || rows[0];
  const head = [
    c.faint(truncateVisible(`${i18n.t(lang, "palette.title")}  ${i18n.t(lang, "palette.search")}`, lineWidth)),
    c.faint("─".repeat(lineWidth)),
  ];
  /*
   * 꼬리(구분선·선택 상세·조작 안내)를 먼저 만든다 — 목록만 예산에 맞춰 줄이고
   * 머리와 꼬리는 어떤 높이에서도 지키기 위해서다.
   */
  const tail = [c.faint("─".repeat(lineWidth))];
  const tailStart = tail.length; // 이 뒤는 자리가 모자라면 접는다 (상세 → 예시 순으로 버림)
  const out = head;
  if (selected) {
    const usage = truncateVisible(selected.usage || selected.command, lineWidth - 2);
    const detail = truncateVisible(selected.detail || selected.description || "", lineWidth - 2);
    const category = selected.category ? i18n.t(lang, "palette.category", selected.category) : "";
    const categoryRoom = Math.max(0, lineWidth - visibleWidthLite(usage) - 3);
    const categoryText = categoryRoom > 0 ? truncateVisible(category, categoryRoom) : "";
    tail.push(" " + c.text(usage) + (categoryText ? c.dim("  " + categoryText) : ""));
    if (detail) tail.push(" " + c.dim(detail));
    if (selected.examples && selected.examples.length) {
      tail.push(c.dim(truncateVisible(" " + i18n.t(lang, "palette.examples", selected.examples.slice(0, 2).join("  |  ")), lineWidth)));
    }
  }
  /*
   * 화면 높이 예산. 터미널보다 긴 프레임을 쏟으면 그리는 도중 스크롤이 나고, 그 순간
   * 오버레이가 제자리를 잃어 이전 프레임이 화면에 남는다(실측: 24행에서 18행짜리
   * 프레임 → 블록이 겹겹이 쌓이고 프롬프트가 화면 밖으로 밀려남).
   * 선택 항목이 잘려 나가지 않도록 강조 위치를 중심으로 창을 잡는다.
   */
  const controls = c.dim(truncateVisible(" " + i18n.t(lang, "palette.controls"), lineWidth));
  const budget = Math.max(1, Math.floor(Number(opts.maxRows) || (rows.length + head.length + tail.length + 1)));
  /*
   * 자리가 모자라면 선택 상세부터 접는다. 목록 한 줄과 조작 안내는 마지막까지 지킨다 —
   * 아무것도 못 고르는 팔레트나 나가는 법을 모르는 팔레트는 없느니만 못하다.
   * 최소 프레임은 5줄(제목·구분선·목록 1줄·구분선·조작 안내)이며, 그보다 좁은 예산도 5줄이다.
   */
  while (tail.length > tailStart && budget - head.length - tail.length - 1 < 1) tail.pop();
  const listBudget = Math.max(1, budget - head.length - tail.length - 1);
  const start = Math.min(
    Math.max(0, selectedIndex - listBudget + 1),
    Math.max(0, rows.length - listBudget),
  );
  rows.slice(start, start + listBudget).forEach((row, offset) => {
    const index = start + offset;
    const command = padVisible(truncateVisible(row.command, commandWidth), commandWidth);
    const desc = truncateVisible(row.description, descWidth);
    const body = " " + c.blue(command) + c.text(desc);
    out.push(index === selectedIndex ? c.inverse(padVisible(body, lineWidth)) : body);
  });
  return out.concat(tail, [controls]).join("\n");
}

function attachSlashPalette(rl, opts = {}) {
  const stream = opts.stream || rl.output || process.stdout;
  const inputStream = rl.input || process.stdin;
  const paletteEnabled = opts.force || process.env.AGENTLAS_SLASH_PALETTE === "1";
  const isTty = paletteEnabled && Boolean(rl.terminal && inputStream.isTTY && stream.isTTY);
  if (!rl || !inputStream || !stream || !isTty) {
    return { clear() {}, detach() {}, setEnabled() {}, active: () => false };
  }
  const colors = opts.colors || (opts.ui && opts.ui.c) || {};
  /*
   * 후보 출처는 주입 가능하다. 이 모듈의 SLASH_COMMAND_META 는 v1 REPL 전용
   * 목록이라, v2 처럼 명령 표면이 다른 호출자가 그대로 쓰면 오버레이가 없는
   * 명령을 광고한다(engine/ui/palette.cjs 상단 주석의 그 사고). 호출자가
   * 자기 정본을 넘기면 그것만 뜬다.
   */
  const suggest = typeof opts.suggest === "function" ? opts.suggest : slashCommandSuggestions;
  const state = {
    enabled: true,
    selected: 0,
    selectedCommand: null,
    visible: false,
    navigated: false,
    dismissedForLine: null,
  };

  readline.emitKeypressEvents(inputStream, rl);

  function rows() {
    if (!state.enabled) return [];
    const list = suggest(rl.line || "", 12, opts.lang || (opts.ui && opts.ui.lang) || "en");
    return Array.isArray(list) ? list : [];
  }
  function active() {
    return rows().length > 0 && state.dismissedForLine !== (rl.line || "");
  }
  function replaceLine(value) {
    const next = String(value || "");
    /*
     * keypress 리스너 안에서 rl.write(Ctrl-U) → rl.write(text)를 재진입시키면
     * Node readline의 원래 Tab/Enter 핸들러가 아직 같은 키를 처리하는 중이라
     * 기존 `/s` 뒤에 선택값을 붙였다(`/s/team`, `/s/skills` 실측). line/cursor는
     * readline의 공개 관측 상태이고 `_refreshLine`은 그 상태를 그리는 유일한
     * 부수효과라, 한 번에 교체해 재진입을 피한다. 구형 Node만 기존 키 시퀀스로
     * 폴백한다.
     */
    if (typeof rl._refreshLine === "function") {
      rl.line = next;
      rl.cursor = next.length;
      rl._refreshLine();
      return;
    }
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(next);
  }
  /*
   * 커서 복원은 상대 이동으로만 한다.
   *
   * 예전 구현은 DECSC/DECRC(`\x1b7`/`\x1b8`)로 절대 위치를 저장·복원했다. 그런데 REPL은
   * 프롬프트가 화면 맨 아래에 있는 게 보통이라, 그 아래로 프레임을 그리면 반드시 스크롤이
   * 난다. 스크롤 뒤 저장된 절대 행은 다른 내용을 가리키므로 복원이 어긋나고, 다음 렌더의
   * "커서 아래 전부 지우기"가 이전 프레임을 못 지운다 — 화면에 팔레트가 겹겹이 쌓였다.
   * (pyte 에뮬레이션 실측: 24행에서 ↓ 3회 → 잔상 블록 + 프롬프트 유실.)
   * `\x1b[nA` 같은 상대 이동은 내용과 함께 밀리므로 스크롤이 나도 어긋나지 않는다.
   */
  function promptColumn() {
    const prompt = typeof rl.getPrompt === "function" ? rl.getPrompt() : "";
    const typed = String(rl.line || "").slice(0, rl.cursor);
    return visibleWidthLite(String(prompt)) + visibleWidthLite(typed) + 1;
  }
  function clear() {
    if (!state.visible) return;
    // 그린 뒤에는 프롬프트 아래에 자리가 있으므로 커서 아래로 이동은 스크롤을 만들지 않는다.
    stream.write(`\x1b[1B\r\x1b[0J\x1b[1A\x1b[${promptColumn()}G`);
    state.visible = false;
  }
  function render() {
    if (!state.enabled) {
      clear();
      return;
    }
    const list = rows();
    if (!list.length || state.dismissedForLine === (rl.line || "")) {
      clear();
      return;
    }
    const selectedByCommand = state.selectedCommand
      ? list.findIndex((entry) => entry.command === state.selectedCommand)
      : -1;
    if (selectedByCommand >= 0) state.selected = selectedByCommand;
    if (state.selected < 0 || state.selected >= list.length) state.selected = 0;
    const body = renderSlashPalette(list, state.selected, {
      columns: stream.columns || process.stdout.columns || 88,
      // 프롬프트 줄과 여유 한 줄을 남긴다 — 프레임이 화면을 다 먹으면 제자리 갱신이 불가능하다.
      maxRows: Math.max(5, (stream.rows || process.stdout.rows || 24) - 2),
      colors,
      lang: opts.lang || (opts.ui && opts.ui.lang) || "en",
    });
    if (!body) { clear(); return; }
    const lines = body.split("\n");
    /*
     * 첫 줄바꿈은 프롬프트 아래로 내려가며, 자리가 없으면 여기서 화면이 한 번 밀린다.
     * 그린 만큼 그대로 되올라오므로 이후 갱신은 제자리에서 일어난다.
     *
     * 복귀 후에는 커서 열만 맞춘다. readline 의 prompt(true) 로 프롬프트 줄을 다시
     * 그리면 refreshLine 이 커서 아래를 지워 방금 그린 프레임까지 함께 날아간다
     * (실측: 리사이즈 없이도 팔레트가 통째로 사라짐). 프롬프트 줄 자체는 지운 적이
     * 없으므로 평상시에는 화면에 그대로 남아 있다.
     *
     * 남은 한계: 창 크기를 줄이면 터미널이 프롬프트 줄을 리플로우하며 지울 수 있고,
     * 그때는 다음 입력 전까지 프롬프트가 보이지 않는다(40행→18행 축소에서 실측).
     * 팔레트는 리사이즈를 구독하지 않는다.
     */
    stream.write(`\r\n\x1b[0J${lines.join("\r\n")}\x1b[${lines.length}A\x1b[${promptColumn()}G`);
    state.visible = true;
  }
  /*
   * 화살표는 강조만 옮긴다 — 사용자가 친 질의는 그대로 둔다.
   *
   * 예전에는 여기서 선택 항목을 입력 줄에 써 넣었다(replaceLine(selectedCommand)).
   * 그러면 후보 목록이 "질의로 거른 결과"가 아니라 "선택의 함수"가 되어 되먹임이 생긴다:
   * `/s` 에서 ↓ 두 번이면 줄이 `/switch` 로 바뀌며 후보가 9개→2개로 접히고,
   * 그 아래 항목(/spawn·/steer·/search·/storm·/swarm)엔 영원히 닿지 못했다.
   * 오너가 본 "방향키 무브 안 됨"의 정체다(PTY 실측).
   *
   * 다만 readline 은 up/down 을 히스토리 이동으로 처리하고, prependListener 로는 그
   * 기본 동작을 막을 수 없다(전파 중단이 없다). 팔레트가 열려 있는 동안 화살표의 의미는
   * 목록 이동이므로, readline 이 줄을 건드렸으면 원래 질의로 되돌린다.
   */
  function move(delta) {
    const list = rows();
    if (!list.length) return false;
    state.selected = (state.selected + delta + list.length) % list.length;
    state.selectedCommand = list[state.selected].command;
    state.navigated = true;
    const query = rl.line || "";
    setImmediate(() => {
      if ((rl.line || "") !== query) replaceLine(query);
      render();
    });
    return true;
  }
  function select() {
    const list = rows();
    if (!list.length) return false;
    if (state.selected < 0 || state.selected >= list.length) state.selected = 0;
    const row = list[state.selected];
    /*
     * 인자를 받는 명령은 확정 즉시 스페이스까지 넣는다 (2026-08-06, 레퍼런스
     * 대조): Tab 후 바로 인자를 타이핑하게 — 스페이스를 손으로 넣는 한 박자가
     * 모든 인자형 명령에서 반복되는 마찰이었다. 인자 없는 명령(/help 등)은
     * 그대로 — Enter 로 즉시 실행하는 흐름을 깨지 않는다.
     */
    const takesArgs = Boolean(String(row.usage || row.args || "").trim())
      && String(row.usage || `${row.command} ${row.args || ""}`).trim() !== row.command;
    state.selectedCommand = row.command + (takesArgs ? " " : "");
    replaceLine(state.selectedCommand);
    clear();
    return true;
  }
  function onKeypress(_str, key = {}) {
    if (!state.enabled) return;
    const name = key.name || "";
    if (name === "escape" && state.visible) {
      state.dismissedForLine = rl.line || "";
      clear();
      return;
    }
    if (active() && (name === "down" || name === "up")) {
      move(name === "down" ? 1 : -1);
      return;
    }
    // Tab 은 완성이다 — 강조된 항목으로 줄을 채운다.
    // Shift-Tab 은 팔레트 확정 키가 아니다(호출자 REPL 의 권한 순환 단축키다).
    if (active() && name === "tab" && !key.shift) {
      if (select()) {
        /*
         * prependListener는 readline 자체 Tab 처리를 중단시키지 못한다. 선택을 먼저
         * 반영한 뒤, 기본 완성기가 같은 키로 줄을 다시 바꿔도 다음 tick에 exact
         * 선택을 한 번 재적용한다.
         */
        const selected = state.selectedCommand;
        setImmediate(() => {
          if (selected) replaceLine(selected);
        });
      }
      return;
    }
    /*
     * Enter 는 사용자가 실제로 목록을 훑었을 때만 강조 항목을 확정한다.
     *
     * 예전에는 팔레트가 떠 있기만 하면 Enter 가 무조건 select() 를 불렀고,
     * 훑은 적이 없으면 state.selected 는 0이라 "목록 첫 줄"이 대신 실행됐다.
     * `/s`(활성 세션 전환)를 치고 Enter 하면 `/sessions` 가 돌아간다 — 친 것과
     * 다른 명령이 실행되는 것이다(pty 실측). 게다가 피해 대상은 팔레트 정렬의
     * 함수라, 명령 목록을 손볼 때마다 어떤 명령이 가로채이는지가 조용히 바뀐다.
     */
    if (active() && name === "return") {
      if (state.navigated) select();
      else clear();
      return;
    }
    // 타이핑이 이어지면 "훑었다"는 사실은 무효가 된다 — 질의가 달라졌기 때문.
    state.navigated = false;
    state.dismissedForLine = null;
    setImmediate(render);
  }

  inputStream.prependListener("keypress", onKeypress);
  rl.on("line", clear);
  rl.on("close", clear);
  setImmediate(render);

  return {
    active,
    clear,
    setEnabled(value) {
      state.enabled = Boolean(value);
      if (!state.enabled) clear();
    },
    detach() {
      inputStream.removeListener("keypress", onKeypress);
      clear();
    },
  };
}

// List filesystem entries under the partial path `token` relative to `cwd`.
// Returns candidates in the SAME shape as the token (so readline substitutes the last word).
function completePath(token, cwd, prefixChar) {
  let p = token;
  const lead = prefixChar || "";
  try {
    const hasSlash = p.includes("/");
    const dirPart = hasSlash ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    const basePart = hasSlash ? p.slice(p.lastIndexOf("/") + 1) : p;
    const absDir = path.resolve(cwd || ".", dirPart || ".");
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const hits = entries
      .filter((e) => e.name.startsWith(basePart) && !e.name.startsWith("."))
      .slice(0, 100)
      .map((e) => lead + dirPart + e.name + (e.isDirectory() ? "/" : ""))
      .sort();
    return hits;
  } catch {
    return [];
  }
}

function isAbsolutePathTask(line) {
  const value = String(line || "").trim();
  if (!value.startsWith("/")) return false;
  const first = value.split(/\s+/)[0] || "";
  if (first === "/") return false;
  if (!first || SLASH_COMMANDS.includes(first)) return false;
  if (!path.isAbsolute(first)) return false;
  if (fs.existsSync(first)) return true;
  const parts = first.split("/").filter(Boolean);
  if (parts.length >= 2) return true;
  return /^(?:\/Users|\/Volumes|\/Applications|\/tmp|\/private|\/var|\/opt|\/home)(?:\/|$)/.test(first);
}

// makeCompleter({ getAgentSlugs, getFirmSlugs, getCwd }) → readline completer(line) → [hits, token]
function makeCompleter(ctx) {
  const getAgents = ctx.getAgentSlugs || (() => []);
  const getFirms = ctx.getFirmSlugs || (() => []);
  const getCwd = ctx.getCwd || (() => process.cwd());
  return function completer(line) {
    const lineStr = line || "";
    const tokens = lineStr.split(/\s+/);
    const last = tokens[tokens.length - 1] || "";

    // @file mention anywhere in the last token
    if (last.startsWith("@")) {
      return [completePath(last.slice(1), getCwd(), "@"), last];
    }

    // first token = the command itself
    if (tokens.length === 1) {
      if (isAbsolutePathTask(lineStr)) return [completePath(lineStr, getCwd(), ""), last];
      if (lineStr.startsWith("/")) return [uniqStartsWith(SLASH_COMMANDS, last), last];
      return [[], last]; // free-text prompt — no completion
    }

    const cmd = tokens[0];
    switch (cmd) {
      case "/runtime":
        return [uniqStartsWith(RUNTIME_SPECS, last), last];
      case "/permission":
      case "/perm":
      case "/permissions":
        return [uniqStartsWith(PERM_LEVELS, last), last];
      case "/agent":
        return [uniqStartsWith(getAgents(), last), last];
      case "/firm":
        return [uniqStartsWith(getFirms(), last), last];
      case "/team":
        if (tokens.length === 2) return [uniqStartsWith(getAgents(), last), last];
        return [uniqStartsWith(RUNTIME_SPECS.concat(["auto"]), last), last];
      case "/cwd":
      case "/import":
      case "/career-graph":
      case "/ontology":
        return [completePath(last, getCwd(), ""), last];
      default:
        return [[], last];
    }
  };
}

module.exports = {
  userDataDir,
  historyPath,
  loadHistory,
  saveHistory,
  attachHistory,
  persistHistory,
  attachSlashPalette,
  isContinuation,
  stripContinuation,
  tokenizeCommandLine,
  isAbsolutePathTask,
  makeCompleter,
  completePath,
  slashCommandEntries,
  slashCommandSuggestions,
  renderSlashPalette,
  SLASH_COMMANDS,
  RUNTIME_SPECS,
  PERM_LEVELS,
  HISTORY_MAX,
};
