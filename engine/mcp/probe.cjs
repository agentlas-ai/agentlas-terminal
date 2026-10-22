"use strict";
/*
 * mcp/probe — stdio MCP 서버 연결 프리플라이트.
 *
 * initialize → notifications/initialized → tools/list 핸드셰이크만 수행하고
 * 즉시 종료한다. 툴 호출은 절대 하지 않는다("연결됨 ≠ 툴 성공" 계약).
 * 자식 env는 agentlas-mcp-env의 buildMcpChildEnv 경계(agentlas.mcp-child-launch.v1)
 * 를 그대로 재사용한다 — 여기서 env를 따로 구성하면 격리 계약이 깨진다.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildMcpChildEnv, mcpRuntimeHome } = require("../agentlas-mcp-env.cjs");
const { parseRuntimeServerArgs } = require("./contract.cjs");

const MCP_PROBE_CONCURRENCY = 3;
const MCP_PROBE_PER_SERVER_TIMEOUT_MS = 8_000;
const MCP_PROBE_TOTAL_TIMEOUT_MS = 12_000;

function envValue(env, name) {
  const key = Object.keys(env || {}).find((candidate) => candidate.toUpperCase() === name);
  return key ? String(env[key] || "") : "";
}

/**
 * Windows: the .cmd/.bat file `command` resolves to through the child's PATH and PATHEXT, or null when it resolves
 * to an .exe/.com (spawnable directly) or not at all. npx, uvx and most npm launchers are .cmd shims, which spawn()
 * without a shell cannot start (ENOENT, or EINVAL on Node >= 18.20.2).
 */
function windowsBatchShim(command, env) {
  const name = String(command || "");
  if (!name || name.includes("\0")) return null;
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExt = exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const dirs = /[\\/]/.test(name) ? [""] : envValue(env, "PATH").split(";").filter(Boolean);
  for (const rawDir of dirs) {
    const dir = rawDir.length >= 2 && rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir;
    for (const ext of hasExt ? [""] : exts) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      return /\.(cmd|bat)$/i.test(candidate) ? candidate : null;
    }
  }
  return null;
}

// cmd.exe quoting, as cross-spawn does it (https://qntm.org/cmd).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdEscapeCommand(value) {
  return String(value).replace(CMD_META, "^$1");
}
function cmdEscapeArgument(value, doubleEscape) {
  let arg = String(value)
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`.replace(CMD_META, "^$1");
  return doubleEscape ? arg.replace(CMD_META, "^$1") : arg;
}

/** The spawn() call for `command args` — a .cmd/.bat shim on Windows goes through cmd.exe /d /s /c. */
function probeLaunch(command, args, env) {
  if (process.platform !== "win32") return { command, args, extra: {} };
  const shim = windowsBatchShim(command, env);
  if (!shim) return { command, args, extra: {} };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(shim);
  const line = [cmdEscapeCommand(shim), ...args.map((arg) => cmdEscapeArgument(arg, doubleEscape))].join(" ");
  return {
    command: envValue(env, "COMSPEC") || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    extra: { windowsVerbatimArguments: true, windowsHide: true },
  };
}

function probeSystemMcpServerConnection(server, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(50, Math.min(30_000, Math.trunc(requestedTimeout)))
    : MCP_PROBE_PER_SERVER_TIMEOUT_MS;
  const spawnImpl = options.spawn || spawn;
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let initialized = false;
    let abortHandler = null;
    let forceKillTimer = null;
    let childClosed = false;
    let writeMessage = () => false;
    let treeKilled = false;
    const terminateChild = (signal) => {
      const pid = Number(child?.pid);
      // detached 자식은 프로세스 그룹(-pid)째로 종료해야 패키지 매니저가 띄운
      // 손자 프로세스가 고아로 남지 않는다.
      if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
        try { process.kill(-pid, signal); return; } catch { /* fall through */ }
      }
      // Windows has no process groups: cmd.exe -> node -> server is ended as a tree, once.
      if (process.platform === "win32" && Number.isInteger(pid) && pid > 0 && !treeKilled) {
        treeKilled = true;
        try {
          const killer = spawnImpl("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer?.once?.("error", () => {});
          killer?.unref?.();
        } catch { /* fall through to the direct kill */ }
      }
      try { child?.kill(signal); } catch { /* noop */ }
    };
    const finish = (connected, reason, tools = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal && abortHandler) options.signal.removeEventListener?.("abort", abortHandler);
      try { child?.stdin?.end(); } catch { /* noop */ }
      if (!childClosed) {
        terminateChild("SIGTERM");
        forceKillTimer = setTimeout(() => terminateChild("SIGKILL"), 250);
        forceKillTimer.unref?.();
      }
      const result = { connected, reason };
      // tools 목록은 프리플라이트 참고 정보일 뿐 공개 투영에 실리면 안 된다.
      Object.defineProperty(result, "tools", {
        value: Array.isArray(tools) ? tools : [],
        enumerable: false,
      });
      resolve(result);
    };
    const onMessage = (message) => {
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id === 1) {
        if (message.error || !message.result) return finish(false, "initialize_failed");
        initialized = true;
        if (!writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })) return;
        writeMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (message.id === 2 && initialized) {
        finish(
          !message.error && Boolean(message.result),
          message.error ? "tools_list_failed" : "connected",
          message.result?.tools,
        );
      }
    };
    const drain = () => {
      // 서버가 Content-Length 프레이밍과 개행 구분 JSON 중 무엇을 쓰든 수용한다.
      while (buffer.length) {
        const header = buffer.toString("ascii", 0, Math.min(buffer.length, 64 * 1024)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
        if (header) {
          const headerBytes = Buffer.byteLength(header[0], "ascii");
          const bodyBytes = Number(header[1]);
          if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 1024 * 1024) return finish(false, "invalid_protocol_frame");
          if (buffer.length < headerBytes + bodyBytes) return;
          const body = buffer.subarray(headerBytes, headerBytes + bodyBytes).toString("utf8");
          buffer = buffer.subarray(headerBytes + bodyBytes);
          try { onMessage(JSON.parse(body)); } catch { /* ignore non-JSON noise */ }
          continue;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8").trim();
        buffer = buffer.subarray(newline + 1);
        if (!line || /^Content-Length:/i.test(line)) continue;
        try { onMessage(JSON.parse(line)); } catch { /* ignore banners */ }
      }
    };
    const timer = setTimeout(() => finish(false, "connection_timeout"), timeoutMs);
    const runtimeArgs = parseRuntimeServerArgs(server.args_json);
    if (!runtimeArgs) {
      finish(false, "invalid_runtime_args");
      return;
    }
    try {
      const childEnv = buildMcpChildEnv(options.env || process.env, server.credentialKeyNames || [], {
        runtimeHome: server.mcpRuntimeHome || mcpRuntimeHome(options.userDataDir, server.catalog_id || server.id || server.command),
      });
      const launch = probeLaunch(server.command, runtimeArgs, childEnv);
      child = spawnImpl(launch.command, launch.args, {
        cwd: options.cwd || process.cwd(),
        env: childEnv,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
        ...launch.extra,
      });
      child.once("error", () => finish(false, "connection_failed"));
      child.stdin.on?.("error", () => finish(false, "connection_failed"));
      child.once("close", () => {
        childClosed = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        forceKillTimer = null;
        finish(false, "connection_closed");
      });
      child.stdout.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > 1024 * 1024) return finish(false, "protocol_output_limit");
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        drain();
      });
      writeMessage = (message) => {
        if (settled) return false;
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error) finish(false, "connection_failed");
          });
          return true;
        } catch {
          finish(false, "connection_failed");
          return false;
        }
      };
      writeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agentlas-terminal-build", version: "1" },
        },
      });
      if (options.signal) {
        abortHandler = () => finish(false, "connection_timeout");
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener?.("abort", abortHandler, { once: true });
      }
    } catch {
      finish(false, "connection_failed");
    }
  });
}

module.exports = {
  MCP_PROBE_CONCURRENCY,
  MCP_PROBE_PER_SERVER_TIMEOUT_MS,
  MCP_PROBE_TOTAL_TIMEOUT_MS,
  probeSystemMcpServerConnection,
};
