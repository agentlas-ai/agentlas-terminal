"use strict";

// Web owns the lease and canonical memory. This host only executes an admitted
// selected brain and returns its bounded judgment over the same authenticated transport.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { selectedAdapter } = require("../sessions/memory-worker.cjs");
const capture = require("../workforce/capture.cjs");
const memoryTurn = require("../sessions/memory-turn.cjs");
const { connectedModelTimeoutMs } = require("../agentlas-judgment.cjs");
const { loadCoreAcpRuntime } = require("../core/desktop-core.cjs");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const API_BACKENDS = new Set(["anthropic", "openai", "google", "upstage", "custom", "glm", "kimi", "deepseek", "ollama"]);
const MEMORY_TOOLS = new Set(["agentlas.record_agent_memory", "agentlas.memory_curation_request", "agentlas.decide_agent_learning"]);
const pending = new Set();

function requestIdentity(packet) {
  return digest([packet.schemaVersion, packet.owner, packet.bindingId, packet.sourceRef, packet.jobId,
    packet.inputDigest, packet.snapshotDigest, packet.system, packet.visibilityDomain, packet.originTaskId, packet.requestedRuntime,
    packet.maxOutputTokens, packet.requireNoTools, packet.tools, packet.completeTool]);
}

async function refreshOriginalRequest(packet, transport, signal) {
  await currentTransport(transport);
  const body = await responseJson(await transport.fetch(transport.base, { method: "POST",
    headers: { "content-type": "application/json", cookie: transport.cookie, accept: "application/json" }, signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
      params: { name: "agentlas.memory_curation_request", arguments: { jobId: packet.jobId } } }),
  }));
  if (body.error || body.result?.isError) throw new Error("remote_memory_source_refused");
  let result = body.result;
  if (Array.isArray(result?.content)) {
    const content = result.content.filter(item => item.type === "text");
    if (content.length !== 1 || typeof content[0].text !== "string" || Buffer.byteLength(content[0].text) > 256 * 1024) throw new Error("remote_memory_source_invalid");
    result = JSON.parse(content[0].text);
  }
  await currentTransport(transport);
  const current = packetFromResult("agentlas.memory_curation_request", result);
  return current && requestIdentity(current) === requestIdentity(packet) ? current : null;
}

/** The existing product run journal is a delivery receipt, never memory authority.
 * Only a freshly admitted server request may read it. No schema migration or
 * alternative cache file is allowed; missing custody defers before model spend. */
function decisionJournal(packet, transport, host) {
  const file = path.resolve(process.env.AGENTLAS_STORE_PATH || require("../core/paths.cjs").dbPath());
  const identity = () => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("remote_memory_store_invalid");
    return digest([fs.realpathSync(file), stat.dev, stat.ino]);
  };
  const productIdentity = identity();
  const db = require("../core/db.cjs").openRaw(file);
  try {
    require("../core/store-schema.cjs").assertStoreSchemaCompatible(db, file);
    db.exec("PRAGMA synchronous=FULL");
    const epoch = () => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_forget_clock'").get();
      if (!exists) return null; // Remote admission owns its epoch; no invented local clock.
      const clock = db.prepare("SELECT epoch FROM memory_forget_clock WHERE id=1").get();
      if (!clock) return null;
      if (!Number.isSafeInteger(clock?.epoch) || clock.epoch < 0) throw new Error("remote_memory_store_epoch_invalid");
      return clock.epoch;
    };
    const intakeEpoch = epoch();
    const runId = "remote-memory:" + digest([transport.base, packet.owner, packet.bindingId, packet.sourceRef, packet.jobId]);
    const admission = { schemaVersion: "agentlas.remote-memory-decision.v1", productIdentity, intakeEpoch,
      authDigest: digest([transport.base, transport.cookie]), requestDigest: requestIdentity(packet),
      runtimeIdentity: host.identity, model: host.model };
    const check = () => {
      if (identity() !== productIdentity || epoch() !== intakeEpoch) throw new Error("remote_memory_store_changed");
    };
    const write = work => require("../agentlas-sqlite-policy.cjs").runWriteTransaction(db, () => { check(); const out = work(); check(); return out; });
    const discard = retainedAdmission => write(() => db.prepare("UPDATE run_events SET payload_json=? WHERE run_id=? AND seq=0 AND kind='remote_memory_pending_decision'")
      .run(JSON.stringify(retainedAdmission ? { state: "revoked", admission: retainedAdmission } : { state: "retired" }), runId));
    return {
      close: () => db.close(), discard,
      read() {
        check();
        // Inspect only custody metadata before exposing any stored judgment.
        const metadata = db.prepare("SELECT json_extract(payload_json,'$.admission') AS admission_json,json_extract(payload_json,'$.state') AS state FROM run_events WHERE run_id=? AND seq=0 AND kind='remote_memory_pending_decision'").get(runId);
        if (!metadata || metadata.state === "retired") return null;
        const original = metadata.admission_json ? JSON.parse(metadata.admission_json) : null;
        if (metadata.state === "revoked" || !original) throw new Error("remote_memory_journal_revoked");
        if (original.productIdentity !== productIdentity || original.intakeEpoch !== intakeEpoch || original.authDigest !== admission.authDigest) {
          discard(original); throw new Error("remote_memory_journal_custody_changed");
        }
        if (digest(original) !== digest(admission)) { discard(); return null; }
        const row = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND seq=0 AND kind='remote_memory_pending_decision'").get(runId);
        if (!row) return null;
        if (typeof row.payload_json !== "string" || Buffer.byteLength(row.payload_json) > 80 * 1024) { discard(); return null; }
        let stored; try { stored = JSON.parse(row.payload_json); } catch { discard(); return null; }
        if (digest(stored.admission) !== digest(admission)) { discard(); return null; }
        if (typeof stored.output !== "string" || !stored.output.trim() || Buffer.byteLength(stored.output) > 64 * 1024
          || digest(stored.output) !== stored.outputDigest) { discard(); return null; }
        check();
        return stored.output;
      },
      persist(output) {
        if (typeof output !== "string" || !output.trim() || Buffer.byteLength(output) > 64 * 1024) throw new Error("remote_memory_output_invalid");
        const payload = JSON.stringify({ admission, output, outputDigest: digest(output) });
        return write(() => {
          // The first committed judgment for this exact snapshot wins. A crash
          // before this commit can repeat the model; after it, reuse is durable.
          const prior = this.read();
          if (prior) return prior;
          db.prepare("INSERT INTO run_events(id,run_id,seq,ts,kind,payload_json) VALUES(?,?,0,?,'remote_memory_pending_decision',?) ON CONFLICT(run_id,seq) DO UPDATE SET payload_json=excluded.payload_json,ts=excluded.ts WHERE run_events.kind='remote_memory_pending_decision'")
            .run(runId, runId, new Date().toISOString(), payload);
          if (this.read() !== output) throw new Error("remote_memory_journal_conflict");
          return output;
        });
      },
    };
  } catch (error) { db.close(); throw error; }
}

function packetFromResult(name, result) {
  if (!MEMORY_TOOLS.has(name) || !result || typeof result !== "object") return null;
  const packet = name === "agentlas.memory_curation_request" ? result.request : result.curation;
  if (!packet || packet.schemaVersion !== "agentlas.automatic-memory-request.v1" || packet.requireNoTools !== true
    || packet.completeTool !== "agentlas.complete_memory_curation" || !Array.isArray(packet.tools) || packet.tools.length
    || typeof packet.input !== "string" || Buffer.byteLength(packet.input) > 128 * 1024 || packet.input.includes("\0")
    || typeof packet.system !== "string" || Buffer.byteLength(packet.system) > 16 * 1024 || packet.system.includes("\0")
    || !/^[a-f0-9]{64}$/.test(packet.inputDigest) || digest(packet.input) !== packet.inputDigest
    || !/^[a-f0-9]{64}$/.test(packet.snapshotDigest)
    || ![packet.jobId, packet.leaseToken, packet.bindingId, packet.owner?.workspaceId, packet.owner?.userId]
      .every(value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))
    || typeof packet.sourceRef !== "string" || !packet.sourceRef.length || packet.sourceRef.length > 1024 || packet.sourceRef.includes("\0")
    || ![packet.visibilityDomain, packet.originTaskId].every(value => value === null || (typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0")))
    || !Number.isInteger(packet.maxOutputTokens) || packet.maxOutputTokens < 1 || packet.maxOutputTokens > 1600
    || !Number.isInteger(packet.timeoutMs) || packet.timeoutMs < 250 || packet.timeoutMs > 300_000) return null;
  // Snapshot the actual top-level protocol object. Never scan prose, examples or nested data for packets.
  return structuredClone(packet);
}

function endpointValid(base) {
  try {
    const url = new URL(base);
    return !url.username && !url.password && !url.search && !url.hash
      && ["/api/mcp/v1", "/api/mcp/hephaestus-network"].includes(url.pathname)
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

function foregroundResult(name, result, state) {
  const envelope = name === "agentlas.memory_curation_request" ? result?.request : result?.curation;
  if (!MEMORY_TOOLS.has(name) || envelope?.schemaVersion !== "agentlas.automatic-memory-request.v1") return result;
  const visible = { ...result };
  delete visible.curation;
  delete visible.request;
  delete visible.nextAction;
  delete visible.source;
  visible.automaticMemory = { state: ["background_pending", "awaiting_runtime", "deferred"].includes(state) ? state : "deferred" };
  return visible;
}

function supportsSelectedHost(selection) {
  return typeof selection?.model === "string" && Boolean(selection.model.trim()) && selection.permission !== "read"
    && (selection.mode === "cli" ? ["claude-code", "codex", "grok", "kimi", "cursor", "github-copilot-cli"].includes(selection.kind)
      : selection.mode === "api" && API_BACKENDS.has(selection.backend));
}

async function responseJson(response) {
  if (!response?.ok) throw new Error("remote_memory_transport_refused");
  if (typeof response.json === "function") return response.json();
  if (typeof response.text === "string") return JSON.parse(response.text);
  throw new Error("remote_memory_transport_invalid");
}

async function currentTransport(transport) {
  if (!transport?.cookie || !endpointValid(transport.base) || typeof transport.fetch !== "function") throw new Error("remote_memory_auth_unavailable");
  const current = await transport.readCurrent();
  if (!current || current.cookie !== transport.cookie || current.base !== transport.base || current.fetch !== transport.fetch || current.upstreamFetch !== transport.upstreamFetch) throw new Error("remote_memory_auth_changed");
}

async function verifyOwner(packet, transport, signal) {
  await currentTransport(transport);
  const url = new URL("/api/auth/session", transport.base).href;
  const session = await responseJson(await transport.fetch(url, { method: "GET", headers: { cookie: transport.cookie, accept: "application/json" }, signal }));
  if (session.authenticated !== true || session.user?.id !== packet.owner.userId || session.workspace?.id !== packet.owner.workspaceId) throw new Error("remote_memory_owner_changed");
  await currentTransport(transport);
}

/** Created only by the native D composition, from the host's selected runtime. */
async function captureSelectedHost(selection, isSelectionCurrent, options = {}) {
  if (!selection || typeof selection.model !== "string" || !selection.model.trim() || !["cli", "api"].includes(selection.mode) || selection.permission === "read") return null;
  const chosen = structuredClone(selection);
  const runner = options.capture || capture;
  const env = options.env || process.env;
  const modelFetch = options.fetch || globalThis.fetch;
  let descriptor, acpModule, acpFactory, key = null, apiBase = null;
  if (chosen.mode === "cli") {
    // Antigravity's read permission does not remove built-in tools; do not weaken its no-tools refusal.
    if (chosen.kind === "agy" || chosen.kind === "antigravity") return null;
    const core = ["grok", "kimi", "cursor", "github-copilot-cli"].includes(chosen.kind) ? options.acp || loadCoreAcpRuntime() : null;
    const shim = { require: () => core?.module };
    descriptor = (options.selectedAdapter || selectedAdapter)({ kind: chosen.kind, bin: chosen.bin, model: chosen.model, effort: chosen.effort || null }, shim, env);
    if (descriptor.acp) { acpModule = core?.module; acpFactory = acpModule?.createAcpRunner; }
    if (descriptor.acp && typeof acpModule?.createAcpRunner !== "function") return null;
    if (!descriptor.acp && !["claude-code", "codex"].includes(chosen.kind)) return null;
  } else {
    if (!API_BACKENDS.has(chosen.backend)) return null;
    key = chosen.backend === "ollama" ? null : await runner.apiKey(chosen.backend);
    if (chosen.backend !== "ollama" && !key) return null;
    apiBase = chosen.backend === "custom" ? runner.readCustomApiBaseUrl() : chosen.backend === "ollama" ? (env.OLLAMA_HOST || "http://127.0.0.1:11434") : null;
    descriptor = { mode: "api", backend: chosen.backend, model: chosen.model, effort: chosen.effort || null, credentialDigest: digest(key), apiBase };
  }
  const identity = digest(descriptor);
  const current = async () => {
    if (!(await isSelectionCurrent()) || (!options.fetch && globalThis.fetch !== modelFetch)) throw new Error("remote_memory_selected_runtime_changed");
    if (chosen.mode === "cli") {
      const core = ["grok", "kimi", "cursor", "github-copilot-cli"].includes(chosen.kind) ? options.acp || loadCoreAcpRuntime() : null;
      const fresh = (options.selectedAdapter || selectedAdapter)({ kind: chosen.kind, bin: chosen.bin, model: chosen.model, effort: chosen.effort || null }, { require: () => core?.module }, options.env || process.env);
      if ((descriptor.acp && (core?.module !== acpModule || core.module.createAcpRunner !== acpFactory)) || digest(fresh) !== identity) throw new Error("remote_memory_selected_config_changed");
    } else {
      const freshKey = chosen.backend === "ollama" ? null : await runner.apiKey(chosen.backend);
      const freshBase = chosen.backend === "custom" ? runner.readCustomApiBaseUrl() : chosen.backend === "ollama" ? ((options.env || process.env).OLLAMA_HOST || "http://127.0.0.1:11434") : null;
      if (digest(freshKey) !== descriptor.credentialDigest || freshBase !== apiBase) throw new Error("remote_memory_selected_credentials_changed");
    }
  };
  return { model: chosen.model, identity, current, async invoke(packet, signal) {
    await current();
    let result;
    if (chosen.mode === "api") {
      // Existing text-only API adapter, with captured key/base, exact model and bounded output.
      const boundedFetch = (url, init) => {
        const body = JSON.parse(init.body);
        if (body.tools?.length || body.functions?.length || (body.model && body.model !== chosen.model)) throw new Error("remote_memory_no_tools_changed");
        if (chosen.backend === "ollama") body.options = { ...(body.options || {}), num_predict: packet.maxOutputTokens };
        else if (chosen.backend === "google") body.generationConfig = { maxOutputTokens: packet.maxOutputTokens };
        else body.max_tokens = packet.maxOutputTokens;
        return modelFetch(url, { ...init, body: JSON.stringify(body), signal });
      };
      result = await runner.runApi(chosen.backend, chosen.model, packet.system, packet.input, {
        apiKey: key, customBaseUrl: apiBase, signal, effort: chosen.effort || undefined, fetch: boundedFetch,
      });
    } else if (descriptor.acp) {
      const spec = acpModule.ACP_AGENTS[chosen.kind];
      result = await acpFactory(spec)({ systemPrompt: packet.system, userPrompt: packet.input, history: [],
        cwd: memoryTurn.curatorRuntimeDir(), env: memoryTurn.curatorRuntimeEnv(), runtimeSource: descriptor.bin,
        model: chosen.model, effort: chosen.effort || undefined, backendLabel: spec.label,
        permission: "read", untrustedNoTools: true, judgmentOnly: true, singleUse: true,
        agentId: packet.bindingId, chatId: `remote-memory:${packet.jobId}`, locale: "en", signal,
      }, { onStatus() {}, onPartial() {}, onTool() {} });
      if (result?.failure) throw new Error("remote_memory_model_refused");
      result = result?.text;
    } else {
      result = await runner.captureRuntime(chosen.kind, packet.system, packet.input, {
        cwd: memoryTurn.curatorRuntimeDir(), env: memoryTurn.curatorRuntimeEnv(), binOverride: descriptor.bin,
        permission: "read", model: chosen.model, effort: chosen.effort || null, authorityMode: "no-authority", signal,
        outputLimitBytes: 64 * 1024, timeoutConfig: { idleMs: connectedModelTimeoutMs(packet.timeoutMs), totalMs: connectedModelTimeoutMs(packet.timeoutMs), killGraceMs: 500 },
      });
    }
    await current();
    if (typeof result !== "string" || !result.trim() || Buffer.byteLength(result) > 64 * 1024) throw new Error("remote_memory_output_invalid");
    JSON.parse(result.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    return result;
  } };
}

function scheduleAuthenticatedResult(name, result, transport, captureHost) {
  const packet = packetFromResult(name, result);
  if (!packet || typeof captureHost !== "function" || !transport?.cookie || !endpointValid(transport.base)) return { status: "deferred" };
  const key = digest([transport.base, transport.cookie, packet.owner, packet.bindingId, packet.sourceRef, packet.jobId, packet.inputDigest]);
  if (pending.has(key)) return { status: "pending" };
  const work = (async () => {
    // Start in a separate microtask; the original tools/call response returns immediately.
    const controller = new AbortController();
    const onAbort = () => controller.abort(transport.signal?.reason || new Error("remote_memory_host_aborted"));
    if (transport.signal?.aborted) onAbort();
    else transport.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("remote_memory_timeout")), connectedModelTimeoutMs(packet.timeoutMs));
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    controller.signal.addEventListener("abort", () => rejectAbort(controller.signal.reason), { once: true });
    try {
      const execute = async () => {
        if (controller.signal.aborted) return;
        await verifyOwner(packet, transport, controller.signal);
        const host = await captureHost();
        if (!host) return;
        await host.current();
        const journal = decisionJournal(packet, transport, host);
        try {
          let admitted = await refreshOriginalRequest(packet, transport, controller.signal);
          if (!admitted) { journal.discard(); return; }
          await verifyOwner(packet, transport, controller.signal);
          await host.current();
          const prior = journal.read();
          const judged = prior ?? await host.invoke(admitted, controller.signal);
          if (controller.signal.aborted) return;
          await currentTransport(transport);
          await host.current();
          // Persist before another network attempt, including the owner/source
          // rechecks. Offline delivery never erases an already paid judgment.
          const output = prior ?? journal.persist(judged);
          await verifyOwner(packet, transport, controller.signal);
          await host.current();
          admitted = await refreshOriginalRequest(packet, transport, controller.signal);
          if (!admitted) { journal.discard(); return; }
          if (controller.signal.aborted) return;
          const completed = await responseJson(await transport.fetch(transport.base, { method: "POST", headers: { "content-type": "application/json", cookie: transport.cookie, accept: "application/json" }, signal: controller.signal,
            body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: packet.completeTool,
              arguments: { jobId: admitted.jobId, leaseToken: admitted.leaseToken, inputDigest: admitted.inputDigest, model: host.model, output } } }),
          }));
          if (completed.error || completed.result?.isError) throw new Error("remote_memory_completion_refused");
          journal.discard();
        } finally { journal.close(); }
      };
      await Promise.race([execute(), aborted]);
    } catch { /* The server lease remains pending/retryable; no fabricated success or local memory write. */ }
    finally { clearTimeout(timer); transport.signal?.removeEventListener("abort", onAbort); pending.delete(key); }
  })();
  pending.add(key);
  // The work is deliberately not awaited by the foreground tool call.
  work.catch(() => {});
  return { status: "scheduled" };
}

module.exports = { packetFromResult, foregroundResult, supportsSelectedHost, captureSelectedHost, scheduleAuthenticatedResult };
