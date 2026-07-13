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
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const permissions = require("./agentlas-permissions.cjs");
const i18n = require("./agentlas-i18n.cjs");
const { wrapStdioServer } = require("./agentlas-mcp-env.cjs");

function uiText(ui, key, ...args) {
  return ui && typeof ui.t === "function" ? ui.t(key, ...args) : i18n.t("en", key, ...args);
}

const NATIVE_TIMEOUT_DEFAULTS = Object.freeze({
  idleMs: 10 * 60_000,
  totalMs: 4 * 60 * 60_000,
  killGraceMs: 3_000,
});

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

function writeManagedFile(file, content) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      // Windows cannot always replace an existing destination atomically.
      if (!error || !["EEXIST", "EPERM"].includes(error.code)) throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/best-effort */ }
}

function prepareCodexRuntimeEnv(env = process.env) {
  const base = { ...env };
  const sourceHome = path.resolve(base.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const dataHome = path.resolve(userDataDir(base));
  const explicitTarget = Boolean(base.AGENTLAS_CODEX_HOME);
  const targetHome = path.resolve(base.AGENTLAS_CODEX_HOME || path.join(dataHome, "runtime-homes", "codex"));
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(targetHome, 0o700); } catch { /* Windows/best-effort */ }
  const realDataHome = fs.realpathSync(dataHome);
  const realTargetHome = fs.realpathSync(targetHome);
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
  writeManagedFile(
    path.join(targetHome, "config.toml"),
    "# Managed by Agentlas Terminal. MCP is supplied only for explicit full-access turns.\n",
  );

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

  base.CODEX_HOME = realTargetHome;
  return base;
}

function runtimeEnvForKind(kind, env = process.env, options = {}) {
  if (kind === "codex") return prepareCodexRuntimeEnv(env);
  if (kind === "gemini") return prepareGeminiRuntimeEnv(env, options);
  return env;
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
  for (const server of selectedMcpServers(servers, options)) {
    const wrapped = wrapStdioServer(server, { dataDir: userDataDir(options.env || process.env) });
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
  const dir = path.join(userDataDir(options.env || process.env), "mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
  const mcpServers = wrappedMcpServerMap(servers, options);
  const body = JSON.stringify({ mcpServers }, null, 2);
  // 서로 다른 동시 실행이 하나의 agentlas-cli-mcp.json을 덮어쓰지 않도록 내용 주소 파일을 쓴다.
  const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 20);
  const file = path.join(dir, `agentlas-cli-mcp-${digest}.json`);
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch { /* first write */ }
  if (current !== body) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/best-effort */ }
  return { file, names: Object.keys(mcpServers) };
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
function lineReader(stream, onLine, onActivity) {
  let buf = "";
  stream.setEncoding("utf8");
  const onData = (chunk) => {
    if (onActivity) onActivity();
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
  const onEnd = () => {
    if (buf.trim()) onLine(buf);
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

// ── claude-code ──────────────────────────────────────────
function claudePermissionArgs(permission) {
  const level = permissions.normalize(permission);
  if (level === "full") return ["--dangerously-skip-permissions"];
  if (level === "write") return ["--permission-mode", "acceptEdits"];
  return ["--permission-mode", "plan"];
}

function claudeArgs({ prompt, systemPrompt, permission, session, model, effort, mcpServers, mcpAllowlistMode, env }) {
  const level = permissions.normalize(permission);
  const perm = claudePermissionArgs(level);
  // /effort → Claude Code는 think 키워드로 reasoning 예산을 올린다(전용 CLI 플래그 없음).
  const thinkKw =
    effort === "max" ? "Ultrathink. " : effort === "high" ? "Think hard. " : effort === "medium" ? "Think. " : "";
  const args = [
    "-p",
    thinkKw + prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...perm,
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
  } else if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

// ANSI 제거 (에러 stderr 정리용) — 외부 의존성 없이.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function handleClaudeLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
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
          // 인자가 다 모이는 content_block_stop에서 한 줄로(⏺ Name(arg)) 출력 — Claude Code 스타일
        } else if (cb.type === "thinking") {
          st.think[ev.index] = "";
          ui.status(uiText(ui, "runtime.thinking"));
        } else if (cb.type === "text") {
          ui.streamStart();
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
    case "result":
      st.finalText = typeof obj.result === "string" ? obj.result : st.text;
      st.usage = {
        input_tokens: obj.usage && obj.usage.input_tokens,
        output_tokens: obj.usage && obj.usage.output_tokens,
        cost_usd: obj.total_cost_usd,
        duration_ms: obj.duration_ms,
      };
      if (obj.is_error) st.error = obj.result || "claude error";
      return;
    case "rate_limit_event":
      if (obj.rate_limit_info && obj.rate_limit_info.status === "rejected") {
        ui.warn(uiText(ui, "runtime.rateLimit", "Claude"));
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

function codexArgs({ prompt, systemPrompt, permission, session, cwd, model, effort, mcpServers, mcpAllowlistMode, env }) {
  const level = permissions.normalize(permission);
  const sandbox = codexPermissionArgs(level);
  const mcp = level === "full" ? codexMcpArgs(mcpServers, { exactAllowlist: mcpAllowlistMode === "exact", env }) : [];
  const mdl = model ? ["-m", model] : []; // /model parity
  // Current Codex model inventory advertises max directly; preserve the user's
  // explicit pin instead of silently weakening it to high.
  const eff = effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
  const full = systemPrompt && !(session && session.id) ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt;
  // -C/--sandbox/--skip-git-repo-check 는 `codex exec` 옵션이라 `resume <id>` 토큰 *앞에* 와야 한다.
  // (codex-cli 0.133: resume 뒤에 두면 `unexpected argument` 로 거부 → 멀티턴 전부 실패. 실측 검증됨.)
  const base = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...mdl, ...eff, ...sandbox, ...mcp];
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
  switch (obj.type) {
    case "thread.started":
      if (obj.thread_id) st.session.id = obj.thread_id;
      return;
    case "turn.started":
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
      if (obj.usage) {
        st.usage = {
          input_tokens: obj.usage.input_tokens,
          output_tokens: obj.usage.output_tokens,
        };
      }
      st.finalText = st.text;
      return;
    case "turn.failed":
    case "error":
      st.error = (obj.error && (obj.error.message || obj.error)) || "codex error";
      ui.error(String(st.error));
      st.errorShown = true;
      return;
    default:
      return;
  }
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
        const ok = item.exit_code == null || item.exit_code === 0;
        if (out) ui.toolResult(out, ok);
        else ui.toolResult(ok ? "done" : `exit ${item.exit_code}`, ok);
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
      if (done && item.diff) ui.toolResult(item.diff, true);
      return;
    }
    case "mcp_tool_call":
    case "tool_call": {
      if (!st.itemSeen[item.id]) {
        ui.tool(item.name || item.tool || "tool", argSummary(item));
        st.itemSeen[item.id] = true;
      }
      if (done && (item.result || item.output)) ui.toolResult(item.result || item.output, true);
      return;
    }
    case "todo_list": {
      // Codex 0.144 JSONL exposes actual plan state as a todo_list item. Keep this
      // separate from ordinary Bash/Edit activity so Ctrl-T never invents tasks.
      ui.replaceTasks?.(item, "codex");
      return;
    }
    default:
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
  const managed = path.resolve(userDataDir(env), "mcp");
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
  const mcpServers = wrappedMcpServerMap(options.mcpServers, { exactAllowlist, env: base });
  if (!Object.keys(mcpServers).length) return base;
  const readiness = geminiMcpIsolationReadiness(base);
  if (!readiness.ready) {
    const error = new Error("Gemini MCP isolation is unavailable because host system settings must be preserved");
    error.code = "AGENTLAS_GEMINI_MCP_ISOLATION_UNAVAILABLE";
    throw error;
  }
  const dir = path.join(userDataDir(base), "mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
  const names = Object.keys(mcpServers);
  const body = JSON.stringify({ mcpServers, mcp: { allowed: names } }, null, 2);
  const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 20);
  const file = path.join(dir, `agentlas-gemini-mcp-${digest}.json`);
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch { /* first write */ }
  if (current !== body) writeManagedFile(file, body);
  base.GEMINI_CLI_SYSTEM_SETTINGS_PATH = file;
  return base;
}

function geminiPermissionArgs(permission) {
  const level = permissions.normalize(permission);
  const approvalMode = level === "full" ? "yolo" : level === "write" ? "auto_edit" : "plan";
  return ["--approval-mode", approvalMode];
}

function geminiArgs({ prompt, systemPrompt, permission, model, mcpServers, mcpAllowlistMode, env }) {
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
      if (st.geminiStreaming) {
        ui.streamEnd();
        st.geminiStreaming = false;
      }
      const s = obj.stats || {};
      st.usage = {
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        duration_ms: s.duration_ms,
      };
      st.finalText = st.text;
      if (obj.status && obj.status !== "success") st.error = `gemini ${obj.status}`;
      return;
    }
    default:
      return;
  }
}

// ── 공통 실행기 ───────────────────────────────────────────
// req = { kind, bin, prompt, systemPrompt, cwd, permission, session, ui, env, signal }
// 반환: Promise<{ text, session, usage, error }>
function runNativeTurn(req) {
  const { kind, bin, ui } = req;
  const cwd = req.cwd;
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

  let args;
  let lineHandler;
  let plainStream = false;
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
    } else {
      return Promise.resolve({ text: "", session: st.session, error: `unknown runtime: ${kind}` });
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    ui.error(uiText(ui, "runtime.failed", kind, message));
    return Promise.resolve({ text: "", session: st.session, error: message });
  }

  const timeout = req.timeoutConfig ? directNativeTimeoutConfig(req.timeoutConfig) : nativeTimeoutConfig(req.env || process.env);
  return new Promise((resolve) => {
    ui.status(uiText(ui, "runtime.starting", kind === "claude-code" ? "Claude" : kind));
    let child;
    try {
      const spawnImpl = req.spawn || spawn;
      const childEnv = launchReq.prepareRuntimeEnv === false
        ? (launchReq.env || process.env)
        : runtimeEnvForKind(kind, launchReq.env || process.env, launchReq);
      child = spawnImpl(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (e) {
      ui.error(uiText(ui, "runtime.failed", kind, e.message));
      return resolve({ text: "", session: st.session, error: e.message });
    }

    let settled = false;
    let termination = null;
    let idleTimer = null;
    let totalTimer = null;
    let killTimer = null;
    let forceTimer = null;
    let removeLineReader = () => {};
    let stderrBuf = "";
    const clearWatchdogs = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      idleTimer = totalTimer = killTimer = forceTimer = null;
    };
    const cleanup = () => {
      clearWatchdogs();
      removeLineReader();
      child.stderr?.removeListener("data", onStderr);
      if (req.signal) req.signal.removeEventListener?.("abort", onAbort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminationResult = () => {
      ui.streamEnd();
      ui.stopSpinner();
      const text = (st.finalText || st.text || "").trim();
      if (st.usage) ui.cost(st.usage);
      finish({ text, session: st.session, usage: st.usage, error: termination ? termination.message : "native runtime stopped" });
    };
    const requestStop = (reason) => {
      if (termination || settled) return;
      const message = reason === "abort" ? "aborted" : nativeTimeoutMessage(reason, reason === "idle" ? timeout.idleMs : timeout.totalMs);
      termination = { reason, message };
      st.error = message;
      st.errorShown = true;
      if (reason !== "abort") ui.error(message);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = totalTimer = null;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        if (settled) return;
        forceTimer = setTimeout(terminationResult, Math.max(250, Math.min(1_000, timeout.killGraceMs)));
      }, timeout.killGraceMs);
    };
    const onAbort = () => requestStop("abort");
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
      }, markActivity);
    } else {
      removeLineReader = lineReader(child.stdout, lineHandler, markActivity);
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
        terminationResult();
        return;
      }
      ui.stopSpinner();
      ui.error(uiText(ui, "runtime.failed", kind, err.message));
      finish({ text: "", session: st.session, error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (termination) {
        terminationResult();
        return;
      }
      ui.streamEnd();
      ui.stopSpinner();
      const text = (st.finalText || st.text || "").trim();
      const errTail = stripAnsi(stderrBuf).replace(/\s+/g, " ").trim(); // ANSI 제거 + 한 줄로
      if (st.error && !st.errorShown) {
        // claude `result` is_error 등 — 이전에 표시되지 않은 에러를 노출
        ui.error(String(st.error));
      } else if (code !== 0 && !text) {
        // Runtime Doctor — 아는 시스템 원인(미인증 OAuth MCP 플러그인 등)이면 즉시 수리하고
        // 1회 자동 재시도한다(2026-07-08 notion@openai-curated가 codex 전멸시킨 사고).
        if (!req._doctorRetried) {
          try {
            const { runRuntimeDoctor } = require("./agentlas-doctor.cjs");
            const report = runRuntimeDoctor(`${kind} exited with code ${code}\n${stripAnsi(stderrBuf)}`);
            if (report.repaired) {
              ui.warn(uiText(ui, "runtime.doctor", report.summary));
              for (const act of report.actions) ui.warn(`   ${act.title} — ${act.detail}`);
              ui.warn(uiText(ui, "runtime.doctorRetry"));
              settled = true;
              cleanup();
              resolve(runNativeTurn({ ...req, _doctorRetried: true }));
              return;
            }
          } catch {
            /* 닥터 실패는 원래 에러 표출을 막지 않는다 */
          }
        }
        ui.error(uiText(ui, "runtime.exited", kind, String(code)) + (errTail ? `\n  ${errTail.slice(-400)}` : ""));
      } else if (!text && !st.error) {
        // 정상 종료인데 출력이 비어 있음(거부/차단 등) — 무음 실패 방지
        ui.warn(uiText(ui, "runtime.noOutput", kind) + (errTail ? ` (${errTail.slice(-200)})` : ""));
      }
      if (st.usage) ui.cost(st.usage);
      finish({ text, session: st.session, usage: st.usage, error: st.error });
    });

    armIdle();
    totalTimer = setTimeout(() => requestStop("total"), timeout.totalMs);
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = {
  runNativeTurn,
  summarizeToolInput,
  claudeArgs,
  claudePermissionArgs,
  codexArgs,
  codexPermissionArgs,
  geminiArgs,
  geminiPermissionArgs,
  claudeMcpIsolationArgs,
  geminiMcpIsolationArgs,
  prepareCodexRuntimeEnv,
  prepareGeminiRuntimeEnv,
  geminiMcpIsolationReadiness,
  runtimeEnvForKind,
  cliMcpConfigPath,
  codexMcpArgs,
  nativeTimeoutConfig,
  directNativeTimeoutConfig,
};
