"use strict";
/*
 * cloud/hub-client — Agentlas Hub/Cloud HTTP 클라이언트 (v1에서 검증된 강화판 이식).
 *
 * 강화 계약(절대 약화 금지 — v1 timeout-regression이 지키던 속성):
 *  - connect/idle/total 3중 타임아웃 (AGENTLAS_HUB_*_TIMEOUT_MS로 조정)
 *  - 응답 크기 상한 16MB (HUB_RESPONSE_MAX_BYTES)
 *  - 업스트림 AbortSignal 전파
 * 세션 쿠키 해석 순서: AGENTLAS_SESSION env → auth/cli-session.v1.json → (레거시) keytar.
 */
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

const HUB_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const HUB_TIMEOUT_DEFAULTS = Object.freeze({ connectMs: 15_000, idleMs: 30_000, totalMs: 180_000 });

function mcpBaseUrl() {
  return (process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1").replace(/\/$/, "");
}

function webBaseUrl() {
  return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
}

function finiteTimeoutMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function hubTimeoutConfig(env = process.env) {
  const totalMs = finiteTimeoutMs(env.AGENTLAS_HUB_TOTAL_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.totalMs, 5_000, 900_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(env.AGENTLAS_HUB_CONNECT_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.connectMs, 1_000, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(env.AGENTLAS_HUB_IDLE_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.idleMs, 1_000, 300_000)),
    totalMs,
  };
}

function directHubTimeoutConfig(value = {}) {
  const totalMs = finiteTimeoutMs(value.totalMs, HUB_TIMEOUT_DEFAULTS.totalMs, 10, 900_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(value.connectMs, HUB_TIMEOUT_DEFAULTS.connectMs, 10, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(value.idleMs, HUB_TIMEOUT_DEFAULTS.idleMs, 10, 300_000)),
    totalMs,
  };
}

function hubTimeoutError(kind, ms) {
  const message = kind === "connect"
    ? `Hub 연결 제한 시간(${ms}ms)을 초과했습니다.`
    : kind === "idle"
      ? `Hub 응답이 ${ms}ms 동안 멈췄습니다.`
      : `Hub 요청 전체 제한 시간(${ms}ms)을 초과했습니다.`;
  const error = new Error(message);
  error.code = `AGENTLAS_HUB_${kind.toUpperCase()}_TIMEOUT`;
  return error;
}

/** Hub/Cloud fetch + body reader. Headers 전 connect, chunk 사이 idle, 전 구간 total timeout. */
async function fetchHub(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this runtime.");
  const timeout = options.timeoutConfig ? directHubTimeoutConfig(options.timeoutConfig) : hubTimeoutConfig(options.env || process.env);
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let connectTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let reader = null;
  let terminalError = null;
  let rejectTerminal;
  const terminal = new Promise((_, reject) => { rejectTerminal = reject; });
  const stop = (error) => {
    if (terminalError) return;
    terminalError = error;
    try { controller.abort(error); } catch { controller.abort(); }
    rejectTerminal(error);
  };
  const onUpstreamAbort = () => {
    const reason = upstreamSignal && upstreamSignal.reason;
    const error = reason instanceof Error ? reason : new Error("Hub 요청이 취소되었습니다.");
    if (!error.code) error.code = "ABORT_ERR";
    stop(error);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(hubTimeoutError("idle", timeout.idleMs)), timeout.idleMs);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  connectTimer = setTimeout(() => stop(hubTimeoutError("connect", timeout.connectMs)), timeout.connectMs);
  totalTimer = setTimeout(() => stop(hubTimeoutError("total", timeout.totalMs)), timeout.totalMs);

  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal })),
      terminal,
    ]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    const chunks = [];
    let bytes = 0;
    armIdle();
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      while (true) {
        const part = await Promise.race([reader.read(), terminal]);
        if (part.done) break;
        armIdle();
        const chunk = Buffer.from(part.value || []);
        bytes += chunk.length;
        if (bytes > HUB_RESPONSE_MAX_BYTES) {
          const error = new Error(`Hub 응답이 허용 크기(${HUB_RESPONSE_MAX_BYTES} bytes)를 초과했습니다.`);
          error.code = "AGENTLAS_HUB_RESPONSE_TOO_LARGE";
          stop(error);
          throw error;
        }
        chunks.push(chunk);
      }
    } else {
      const raw = Buffer.from(await Promise.race([response.arrayBuffer(), terminal]));
      bytes = raw.length;
      if (bytes > HUB_RESPONSE_MAX_BYTES) throw new Error(`Hub response exceeds the allowed size (${HUB_RESPONSE_MAX_BYTES} bytes).`);
      chunks.push(raw);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const text = Buffer.concat(chunks, bytes).toString("utf8");
    return { ok: response.ok, status: response.status, headers: response.headers, text };
  } catch (error) {
    if (terminalError) throw terminalError;
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (upstreamSignal) upstreamSignal.removeEventListener?.("abort", onUpstreamAbort);
    if (reader && terminalError) {
      try { await reader.cancel(terminalError); } catch { /* ignore */ }
    }
  }
}

function parseHubJson(response, label) {
  try {
    return JSON.parse(response.text || "null");
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

// ── 세션 쿠키 ──
function cliSessionPath() {
  return path.join(userDataDir(), "auth", "cli-session.v1.json");
}

function readCliSessionValue() {
  try {
    const j = JSON.parse(fs.readFileSync(cliSessionPath(), "utf8"));
    return (j && typeof j.value === "string" && j.value) || null;
  } catch {
    return null;
  }
}

function readKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

async function cloudSessionCookie() {
  if (process.env.AGENTLAS_SESSION) return `agentlas_session=${process.env.AGENTLAS_SESSION}`;
  const fileValue = readCliSessionValue();
  if (fileValue) return `agentlas_session=${fileValue}`;
  const keytar = readKeytar();
  if (!keytar) return null;
  try {
    const value = await keytar.getPassword("Agentlas Session", "default");
    return value ? `agentlas_session=${value}` : null;
  } catch {
    return null;
  }
}

class HubError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

/**
 * Hub MCP tool 호출 (POST <mcp base>/tools/call).
 * 서버가 exact refusal(insufficient_credits 등)을 주면 그 문구를 그대로 전달한다 —
 * 로컬 대체 실행으로 위장하지 않는다(오너 결정).
 */
async function callHubTool(name, args, { requireSession = false, fetch: fetchImpl, timeoutConfig } = {}) {
  const headers = { "content-type": "application/json" };
  const cookie = await cloudSessionCookie();
  if (requireSession && !cookie) {
    throw new HubError("Agent Cloud sign-in is required. Run `agentlas login` first.", { code: "not_signed_in" });
  }
  if (cookie) headers.cookie = cookie;
  const resp = await fetchHub(`${mcpBaseUrl()}/tools/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: name, params: { name, arguments: args || {} } }),
  }, { fetch: fetchImpl, timeoutConfig });
  if (!resp.ok) throw new HubError(`${name} failed with HTTP ${resp.status}`, { status: resp.status });
  const json = parseHubJson(resp, name);
  if (json.error) throw new HubError(`${name}: ${json.error.message || "unknown error"}`, { code: json.error.code });
  return json.result || null;
}

module.exports = {
  HUB_RESPONSE_MAX_BYTES,
  HUB_TIMEOUT_DEFAULTS,
  mcpBaseUrl,
  webBaseUrl,
  hubTimeoutConfig,
  directHubTimeoutConfig,
  hubTimeoutError,
  fetchHub,
  parseHubJson,
  cliSessionPath,
  readCliSessionValue,
  cloudSessionCookie,
  callHubTool,
  HubError,
};
