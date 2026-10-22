"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CAPTURE_RUNTIME_BIN, ACP_CLI_KINDS } = require("../runtimes/kinds.cjs");
const { userDataDir } = require("../core/paths.cjs");
const { connectedModelTimeoutMs } = require("../agentlas-judgment.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function fileIdentity(file, content = false) {
  try {
    const real = fs.realpathSync(file), stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error("memory_runtime_file_invalid");
    if (content && stat.size > 1024 * 1024) throw new Error("memory_runtime_config_too_large");
    return [hash(real), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
      content ? hash(fs.readFileSync(real)) : null];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Runtime credentials stay out of the adapter descriptor. Owner-session
 * credentials use only the detached child's ephemeral stdin, never storage. */
function configDigest(runtime, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const roots = [env.CODEX_HOME || path.join(home, ".codex"), env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    path.join(home, ".gemini"), path.join(home, ".config", "grok"), path.join(home, ".kimi"), path.join(home, ".cursor")];
  const files = runtime.kind === "codex"
    ? [path.join(roots[0], "config.toml"), path.join(roots[0], "auth.json")]
    : runtime.kind === "claude-code" ? [path.join(roots[1], "settings.json"), path.join(roots[1], ".credentials.json"), path.join(home, ".claude.json")]
      : ["agy", "gemini"].includes(runtime.kind) ? [path.join(roots[2], "settings.json"), path.join(roots[2], "oauth_creds.json")]
        : runtime.kind === "grok" ? [path.join(roots[3], "config.json")]
          : runtime.kind === "kimi" ? [path.join(roots[4], "config.json")]
            : runtime.kind === "cursor" ? [path.join(roots[5], "cli-config.json")]
              : [];
  const values = [env.OLLAMA_HOST ?? null, env.AGENTLAS_CLAUDE_KEEP_HOME ?? null, env.AGENTLAS_CODEX_HOME ?? null,
    env.XDG_CONFIG_HOME ?? null, env.APPDATA ?? null];
  return hash(JSON.stringify([runtime.kind, runtime.model, runtime.effort, values, files.map(file => [hash(file), fileIdentity(file, true)])]));
}

function selectedAdapter(runtime, core, env = process.env) {
  const selected = { kind: String(runtime.kind || ""), model: runtime.model || null, effort: runtime.effort || null };
  if (selected.kind === "ollama") {
    if (!selected.model) throw new Error("memory_selected_model_missing");
    return { ...selected, configDigest: configDigest(selected, env), executable: null, acp: null };
  }
  const capture = require("../workforce/capture.cjs");
  const acpKind = ACP_CLI_KINDS.includes(selected.kind) || selected.kind === "github-copilot-cli";
  let acp = null;
  if (acpKind) {
    const mod = core.require("runtime/acp");
    const spec = mod.ACP_AGENTS?.[selected.kind];
    if (!spec || typeof mod.createAcpRunner !== "function" || typeof spec.id !== "string" || !Array.isArray(spec.args)) {
      throw new Error("memory_selected_acp_unavailable");
    }
    acp = { id: spec.id, command: spec.command, args: [...spec.args], registryId: spec.registryId ?? null };
  } else if (!CAPTURE_RUNTIME_BIN[selected.kind]) throw new Error("memory_selected_adapter_unavailable");
  const command = runtime.bin || acp?.command || CAPTURE_RUNTIME_BIN[selected.kind];
  const executable = path.isAbsolute(command) ? command : capture.which(command);
  if (!executable || !fileIdentity(executable)) throw new Error("memory_selected_executable_unavailable");
  return { ...selected, bin: fs.realpathSync(executable), executable: fileIdentity(executable), acp,
    configDigest: configDigest(selected, env) };
}

function workerEnv(env) {
  const result = require("./memory-turn.cjs").curatorRuntimeEnv();
  for (const key of ["AGENTLAS_USER_DATA_DIR", "AGENTLAS_MEMORY_ROOT", "AGENTLAS_HOME", "AGENTLAS_DESKTOP_CORE",
    "AGENTLAS_CODEX_HOME", "AGENTLAS_CLAUDE_KEEP_HOME", "OLLAMA_HOST"]) if (env[key]) result[key] = env[key];
  return result;
}

/** No model wait in the completing turn; a failed child leaves the SQL job due. */
function wakeSelectedMemoryWorker(core, runtime, receipt, actorId, options = {}) {
  if (!receipt?.queued || typeof core.processAutomaticMemoryCuration !== "function") {
    return { status: "deferred", reason: "memory_selected_worker_unavailable" };
  }
  try {
    const store = core.getMemoryStoreInfo();
    const descriptor = selectedAdapter(runtime, core);
    const packet = { schemaVersion: "agentlas.selected-memory-worker.v1", ticketId: receipt.ticketId,
      ownerNamespace: store.ownerNamespace, intakeEpoch: store.revocationEpoch, productPath: path.resolve(core.getDb().name),
      coreRoot: path.resolve(core.root), actorId, descriptor };
    packet.ownerBinding = require("../core/memory-owner-binding.cjs").workerBinding();
    const child = (options.spawn || spawn)(process.execPath, [path.join(__dirname, "memory-worker.cjs")], {
      // These host-configured auth keys are for the owner worker only. The
      // model's curatorRuntimeEnv/workerEnv deliberately never receives them.
      cwd: userDataDir(), env: { ...workerEnv(process.env),
        ...(process.env.AGENTLAS_WEB_BASE_URL ? { AGENTLAS_WEB_BASE_URL: process.env.AGENTLAS_WEB_BASE_URL } : {}),
        ...(process.env.AGENTLAS_SESSION ? { AGENTLAS_SESSION: process.env.AGENTLAS_SESSION } : {}),
        AGENTLAS_STORE_PATH: packet.productPath, AGENTLAS_DESKTOP_CORE: packet.coreRoot, ELECTRON_RUN_AS_NODE: "1" },
      detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(packet));
    child.unref();
    return { status: "dispatched" };
  } catch { return { status: "deferred", reason: "memory_selected_worker_pin_unavailable" }; }
}

async function processSelectedMemoryPacket(packet, core) {
  if (!packet?.ownerBinding) throw new Error("memory_worker_owner_binding_missing");
  return require("../core/memory-owner-binding.cjs").withBinding(core, () => processBoundMemoryPacket(packet, core), packet.ownerBinding);
}

async function processBoundMemoryPacket(packet, core) {
  if (packet?.schemaVersion !== "agentlas.selected-memory-worker.v1" || typeof packet.ticketId !== "string"
    || typeof packet.actorId !== "string" || !Number.isSafeInteger(packet.intakeEpoch)) throw new Error("memory_worker_packet_invalid");
  const store = core.getMemoryStoreInfo();
  if (store.ownerNamespace !== packet.ownerNamespace || store.revocationEpoch !== packet.intakeEpoch
    || path.resolve(core.getDb().name) !== packet.productPath || path.resolve(core.root) !== packet.coreRoot) throw new Error("memory_worker_custody_changed");
  const source = core.getMemoryDb().prepare("SELECT agent_id FROM memory_tickets WHERE ticket_id=?").get(packet.ticketId);
  if (!source || source.agent_id !== packet.actorId) throw new Error("memory_worker_actor_changed");
  const current = selectedAdapter(packet.descriptor, core);
  if (JSON.stringify(current) !== JSON.stringify(packet.descriptor)) throw new Error("memory_worker_runtime_changed");
  const judge = async request => {
    await require("../core/memory-owner-binding.cjs").revalidate();
    if (request.requireNoTools !== true) throw new Error("memory_no_tools_contract_required");
    if (JSON.stringify(selectedAdapter(packet.descriptor, core)) !== JSON.stringify(packet.descriptor)) throw new Error("memory_worker_runtime_changed");
    if (!current.acp) {
      const result = await require("./memory-turn.cjs").invokeMemoryModel({ runtime: current }, request.input, request.systemPrompt, request.timeoutMs);
      await require("../core/memory-owner-binding.cjs").revalidate();
      if (JSON.stringify(selectedAdapter(packet.descriptor, core)) !== JSON.stringify(packet.descriptor)) throw new Error("memory_worker_runtime_changed");
      return result;
    }
    const mod = core.require("runtime/acp"), spec = mod.ACP_AGENTS[current.kind];
    // Registry identity/configuration is exact, never an invented agent id.
    const runner = mod.createAcpRunner(spec);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("memory_curator_timeout")), connectedModelTimeoutMs(request.timeoutMs));
    const onAbort = () => controller.abort(request.signal.reason);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (controller.signal.aborted) return null;
      const stopped = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
      const call = runner({ systemPrompt: request.systemPrompt, userPrompt: request.input, history: [],
        cwd: require("./memory-turn.cjs").curatorRuntimeDir(), env: workerEnv(process.env), runtimeSource: current.bin,
        model: current.model || undefined, effort: current.effort || undefined, backendLabel: spec.label,
        permission: "read", untrustedNoTools: true, judgmentOnly: true, singleUse: true,
        agentId: packet.actorId, chatId: `memory-curator:${packet.ticketId}`, locale: "en", signal: controller.signal },
      { onStatus: () => {}, onPartial: () => {}, onTool: () => {} });
      void Promise.resolve(call).catch(() => {});
      const result = await Promise.race([call, stopped]);
      await require("../core/memory-owner-binding.cjs").revalidate();
      if (JSON.stringify(selectedAdapter(packet.descriptor, core)) !== JSON.stringify(packet.descriptor)) throw new Error("memory_worker_runtime_changed");
      return !result.failure && !controller.signal.aborted ? result.text : null;
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); }
  };
  return core.processAutomaticMemoryCuration(judge, { ticketId: packet.ticketId, ownerNamespace: packet.ownerNamespace, intakeEpoch: packet.intakeEpoch });
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; if (Buffer.byteLength(input) > 16 * 1024) process.exit(1); });
  process.stdin.on("end", async () => {
    try {
      // Only this exact job is dispatched in a one-shot worker. Its own
      // lease/retry survives exit; no unrelated configured-pool timer runs.
      process.env.AGENTLAS_MEMORY_AUTOMATIC_JOBS = "0";
      const core = require("../core/desktop-core.cjs").loadDesktopCore();
      if (!core || core.error || typeof core.processAutomaticMemoryCuration !== "function") return;
      await processSelectedMemoryPacket(JSON.parse(input), core);
    } catch { /* Durable queued/retry state remains for a later trusted host. */ }
  });
}
module.exports = { wakeSelectedMemoryWorker, processSelectedMemoryPacket, selectedAdapter, configDigest };
