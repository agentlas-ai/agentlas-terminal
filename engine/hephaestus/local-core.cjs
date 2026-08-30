"use strict";
/*
 * hephaestus/local-core — 로컬 Agentlas Core(`hephaestus mcp serve`)의 stdio MCP 클라이언트.
 *
 * 배경(2026-08-05, 감사 결함 E): 터미널의 편성 루프(agentlas-workforce.cjs)는 원격
 * agentlas.cloud MCP만 쳤다. 그 서버는 공개 Hub 메뉴만 주므로 로컬·오너 Cloud를
 * 포함한 연합(sourceScope network/local/cloud)은 물리적으로 불가능했고, hep-*
 * 명령들은 외부 CLI 스텁(exit 3 host_llm_required)에 배선돼 있었다. 연합을
 * 소유한 것은 로컬 Core다 — 실측(2026-08-05): `hephaestus mcp serve`가
 * workforce.search_candidates/validate_selection/prepare_execution을 전부 노출하고,
 * sourceScope:"local" 검색이 CandidateSet v1(reference-first)을 반환했다.
 *
 * 계약:
 *  - 프로세스 수명 = 클라이언트 수명. 명령이 끝나면 반드시 close(). 데몬화 금지.
 *  - 폴백 금지: Core 바이너리가 없으면 code="local_core_unavailable"로 정직하게
 *    던진다 — 원격 Hub로 조용히 내려가면 스코프가 거짓이 된다.
 *  - 응답은 MCP content[0].text의 JSON. Core가 {status:"rejected", error:…}를 주면
 *    그 코드를 그대로 던진다(거절 원문 보존 — 재작성 금지).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_CORE_STDOUT_LINE_BYTES = 16 * 1024 * 1024;

function localCoreBin() {
  const candidates = [
    process.env.HEPHAESTUS_BIN,
    path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus"),
  ];
  if (process.platform === "win32") return null;
  for (const candidate of candidates) {
    try {
      if (!candidate) continue;
      const stat = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (stat.isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function coreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * createLocalCoreClient({cwd, timeoutMs}) → { call(name,args), close() }
 * call은 initialize를 게으르게 1회 수행한 뒤 tools/call을 보낸다.
 */
function createLocalCoreClient({ cwd, timeoutMs = 60_000 } = {}) {
  const bin = localCoreBin();
  if (!bin) {
    throw coreError(
      "local_core_unavailable",
      "Agentlas-OS local core (hephaestus) is not installed — federated staffing needs it. Install Agentlas-OS or set HEPHAESTUS_BIN.",
    );
  }
  const child = spawn(bin, ["mcp", "serve"], {
    cwd: cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 프로세스 수명 = 클라이언트 수명 계약의 백스톱. close() 를 못 부르고 부모가
  // 죽는 경로(오류 → process.exit)에서 Core 가 고아로 남는다 — 실측: 프로브
  // 세션에서 `hephaestus mcp serve` 17개 누적. exit 훅으로 반드시 걷는다.
  const reap = () => { try { child.kill(); } catch { /* already gone */ } };
  process.once("exit", reap);
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let initialized = null;
  const pending = new Map();
  let exited = false;

  const failPending = (code, message) => {
    if (exited) return;
    exited = true;
    for (const [, entry] of pending) {
      entry.reject(coreError(code, message));
    }
    pending.clear();
  };
  child.once("error", (error) => {
    failPending("local_core_spawn_failed", `the local core process could not start: ${(error && error.message) || error}`);
  });
  child.on("exit", () => {
    failPending("local_core_exited", "the local core process exited before responding");
  });
  // Always drain stderr. Leaving the pipe unread lets a verbose Core fill the
  // kernel buffer and deadlock an otherwise healthy tools/call.
  child.stderr.on("data", () => {});
  child.stdin.on("error", (error) => {
    failPending("local_core_transport_error", `the local core input stream failed: ${(error && error.message) || error}`);
  });
  child.stdout.on("data", (chunk) => {
    if (exited) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length + bytes.length > MAX_CORE_STDOUT_LINE_BYTES) {
      failPending(
        "local_core_response_too_large",
        `the local core emitted a response line larger than ${MAX_CORE_STDOUT_LINE_BYTES} bytes`,
      );
      buffer = Buffer.alloc(0);
      try { child.kill(); } catch { /* already gone */ }
      return;
    }
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
    let index;
    while ((index = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, index).toString("utf8");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = message && message.id != null ? pending.get(message.id) : null;
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (exited) { reject(coreError("local_core_exited", "the local core process already exited")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(coreError("local_core_timeout", `${method} did not respond within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(coreError("local_core_transport_error", `${method} could not be written to the local core: ${error.message}`));
      });
    } catch (error) {
      const entry = pending.get(id);
      pending.delete(id);
      if (entry) entry.reject(coreError("local_core_transport_error", `${method} could not be written to the local core: ${error.message}`));
    }
  });

  async function ensureInitialized() {
    if (!initialized) {
      initialized = (async () => {
        const response = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agentlas-terminal", version: "2" },
        });
        if (response.error) {
          throw coreError("local_core_initialize_failed", `initialize: ${response.error.message || JSON.stringify(response.error)}`);
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
        return response;
      })();
    }
    return initialized;
  }

  async function call(name, args) {
    await ensureInitialized();
    const response = await rpc("tools/call", { name, arguments: args });
    if (response.error) {
      throw coreError("local_core_rpc_error", `${name}: ${response.error.message || JSON.stringify(response.error)}`);
    }
    const text = response?.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw coreError("local_core_invalid_response", `${name} returned no text content`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw coreError("local_core_invalid_response", `${name} returned non-JSON content`);
    }
    // Core의 거절/오류는 원문 코드로 전파한다 — 사람 문장으로 바꾸면 기계 표식이
    // 죽는다. (실측: 경계 거절은 status:"rejected", 계약 오류는 status:"error".)
    if (parsed && (parsed.status === "rejected" || parsed.status === "error")) {
      const code = typeof parsed.error === "string" ? parsed.error : `local_core_${parsed.status}`;
      // 경계 거절의 issues(무엇이 어느 path에서 걸렸나)는 유일한 진단 근거다 —
      // 코드만 전파하면 다음 사람이 다시 프로브부터 시작한다(2026-08-05 실측 2회).
      const issues = Array.isArray(parsed?.boundary?.issues)
        ? parsed.boundary.issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")
        : "";
      const error = coreError(code, `${name} ${parsed.status}: ${code}${issues ? ` [${issues}]` : ""}`);
      error.detail = parsed;
      throw error;
    }
    return parsed;
  }

  function close() {
    process.removeListener("exit", reap);
    try { child.kill(); } catch { /* already gone */ }
  }

  return { call, close };
}

module.exports = { createLocalCoreClient, localCoreBin, MAX_CORE_STDOUT_LINE_BYTES };
