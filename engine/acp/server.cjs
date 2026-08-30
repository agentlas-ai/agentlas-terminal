"use strict";
/*
 * acp/server — Agentlas as an ACP *agent* (PRD 2026-08-15 Phase B-3, plan-acp §2 (B)).
 *
 * `agentlas acp` speaks the Agent Client Protocol v1 on stdio (JSON-RPC 2.0, ndjson)
 * as the AGENT side. Any ACP client — Zed, JetBrains IDEs, VS Code extensions,
 * Emacs/neovim, other Agentlas surfaces — can now run Agentlas' project controller
 * (the agent Desktop/Terminal already run for `agentlas run`) on the runtime the
 * user subscribes to (Claude Code, Codex, Antigravity, …), inside their editor.
 *
 * BYOM stays true: Agentlas has no model of its own. A prompt turn is exactly an
 * `agentlas run` turn (engine/sessions/session.cjs → native-host / ACP driver),
 * projected onto ACP notifications:
 *   stream-delta → agent_message_chunk · tool → tool_call(completed) ·
 *   tool-result → tool_call_update · status → (dropped) · error → stopReason/refusal
 * Nothing here executes anything a plain `agentlas run` would not; the same
 * permission model (prefs.permission, default read for a remote client) applies.
 *
 * Wire choices, all measured against the registry matrix behaviour:
 *   protocolVersion 1 only (v2 is a draft) · authMethods [] (Agentlas login is a
 *   separate `agentlas login`; nothing to authenticate over ACP) ·
 *   session/cancel kills the child · unknown methods → -32601.
 */
const readline = require("node:readline");
const path = require("node:path");

const PROTOCOL_VERSION = 1;

function pkgVersion() {
  try { return require(path.join(__dirname, "..", "..", "package.json")).version || "0.0.0"; } catch { return "0.0.0"; }
}

function textOfPrompt(blocks) {
  if (!Array.isArray(blocks)) return String(blocks || "");
  return blocks.map((b) => {
    if (!b || typeof b !== "object") return "";
    if (b.type === "text") return String(b.text || "");
    if (b.type === "resource" && b.resource && typeof b.resource.text === "string") return `\n[resource ${b.resource.uri || ""}]\n${b.resource.text}\n`;
    if (b.type === "resource_link") return `[${b.name || "resource"}](${b.uri || ""})`;
    return "";
  }).join("");
}

/**
 * Turn-execution boundary. Production uses engine/sessions (Orchestrator + project
 * controller); contract tests inject a fake `runTurn` so no runtime is spawned.
 *
 * runTurn(ctx, {cwd, prompt, permission, runtimeKind?, sessionKey?, events}) →
 *   Promise<{ text, error, errorKind, session }>
 * events: { onDelta(text), onTool(name, summary, id), onToolResult(text, ok, id), onStatus(text) }
 * cancel(sessionKey) → void
 */
function productionTurnRunner(options = {}) {
  const sessions = new Map(); // currently running acp sessionId → Session
  const createSession = options.createSession || ((ctx, spec, prompt) => {
    const { Orchestrator } = require("../sessions/orchestrator.cjs");
    const orch = new Orchestrator({ db: ctx.db(), lang: ctx.lang });
    const session = orch.spawn({
      agent: spec.agent,
      runtime: spec.runtime,
      permission: spec.permission,
      cwd: spec.cwd,
      title: prompt.slice(0, 60),
    });
    return { orch, session };
  });
  return {
    async newSession(ctx, { cwd, runtimeKind, agentSlug }) {
      const { projectCwd } = require("../project/paths.cjs");
      const { resolveProjectController, withProjectControllerContext } = require("../project/controller.cjs");
      const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
      const { ensureTerminalProjectForExecutionCli } = require("../project/state.cjs");
      const { findAgent } = require("../agents/registry.cjs");
      const permissions = require("../agentlas-permissions.cjs");
      const db = ctx.db();
      const workdir = cwd || projectCwd();
      // Same ladder as `agentlas run [agent]`: an explicit installed agent
      // (session/new _meta.agentlas.agent) is the advanced direct call; otherwise
      // the folder's project controller — and no silent substitution when neither.
      let agent = null;
      let resolved = null;
      if (agentSlug) {
        agent = findAgent(db, String(agentSlug));
        if (!agent) throw new Error(`unknown agent: ${agentSlug} (agentlas agents lists installed agents)`);
      } else {
        resolved = resolveProjectController(db, workdir);
        agent = withProjectControllerContext(resolved.controller, resolved.project);
      }
      const runtime = resolveRuntimeForAgent({ db, prefs: ctx.prefs, explicit: runtimeKind || null, role: "orchestrator", agentId: agent.id });
      // A remote editor client is unattended: never widen beyond the saved preference, default read.
      const permission = permissions.normalize((ctx.prefs && ctx.prefs.permission) || "read");
      ensureTerminalProjectForExecutionCli(db, workdir, permission, "terminal-acp");
      return { agent, runtime, permission, cwd: workdir, project: resolved ? resolved.project : null };
    },
    async runTurn(ctx, spec, prompt, events) {
      // An ACP session is conversational. Recreating Terminal's Session here on
      // every prompt gave each editor turn a new chat/runtime fingerprint even
      // though the client kept sending the same ACP sessionId. Keep one Session
      // on the session spec so DB history and provider resume state survive.
      if (!spec.session) {
        const created = await createSession(ctx, spec, prompt);
        spec.orch = created && created.orch || null;
        spec.session = created && created.session || created;
      }
      const session = spec.session;
      if (!session || typeof session.send !== "function") throw new Error("ACP session runner failed to create a Terminal session");
      sessions.set(spec.acpSessionId, session);
      const listener = (ev) => {
        try {
          if (ev.type === "stream-delta") events.onDelta(ev.text);
          else if (ev.type === "tool") events.onTool(ev.name, ev.summary, ev.id);
          else if (ev.type === "tool-result") events.onToolResult(ev.text, ev.ok, ev.id);
          else if (ev.type === "status") events.onStatus(ev.text);
        } catch { /* a projection failure must not break the turn */ }
      };
      session.on("event", listener);
      try {
        const res = await session.send(prompt);
        return {
          text: (res && (res.finalText || res.text)) || "",
          error: session.status === "failed" ? (session.lastError || (res && res.error) || "failed") : (res && res.error) || null,
          errorKind: res && res.errorKind,
          cancelled: session.status === "killed",
        };
      } finally {
        session.removeListener("event", listener);
        if (sessions.get(spec.acpSessionId) === session) sessions.delete(spec.acpSessionId);
      }
    },
    cancel(acpSessionId) {
      const s = sessions.get(acpSessionId);
      if (s) { try { s.kill(); } catch { /* best effort */ } }
    },
    closeSession(spec) {
      if (!spec) return;
      const session = spec.session;
      if (session) {
        try { session.kill(); } catch { /* best effort */ }
      }
      if (spec.acpSessionId && sessions.get(spec.acpSessionId) === session) {
        sessions.delete(spec.acpSessionId);
      }
      if (spec.orch && typeof spec.orch.shutdown === "function") {
        try { spec.orch.shutdown(); } catch { /* best effort */ }
      }
      spec.session = null;
      spec.orch = null;
    },
  };
}

class AcpAgentServer {
  /**
   * @param {object} opts { ctx, input?, output?, runner? }
   *   ctx: agentlas command ctx (db(), prefs, lang) — may be null in tests with a fake runner
   */
  constructor(opts) {
    this.ctx = opts.ctx || null;
    this.input = opts.input || process.stdin;
    this.output = opts.output || process.stdout;
    this.runner = opts.runner || productionTurnRunner();
    this.sessions = new Map(); // sessionId → spec
    this.initialized = false;
    this.nextSessionSeq = 1;
    this.closed = false;
  }

  send(obj) {
    if (this.closed) return;
    this.output.write(JSON.stringify(obj) + "\n");
  }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  reply(id, result) { this.send({ jsonrpc: "2.0", id, result }); }
  error(id, code, message, data) { this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }

  start() {
    const rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      if (!msg || typeof msg !== "object" || !msg.method) return;
      void this.handle(msg);
    });
    rl.on("close", () => {
      this.closed = true;
      // stdin을 닫은 ACP client는 이 서버의 모든 session 소유권을 내려놓았다.
      // idle conversation의 Orchestrator도, 진행 중 native child도 남기지 않는다.
      for (const spec of this.sessions.values()) {
        try {
          if (typeof this.runner.closeSession === "function") this.runner.closeSession(spec);
          else this.runner.cancel(spec.acpSessionId);
        } catch { /* connection close must still settle */ }
      }
      this.sessions.clear();
    });
    return new Promise((resolve) => rl.on("close", resolve));
  }

  async handle(msg) {
    const { id, method } = msg;
    const params = msg.params || {};
    try {
      switch (method) {
        case "initialize": {
          const requested = Number(params.protocolVersion);
          if (requested !== PROTOCOL_VERSION) {
            return this.error(id, -32602, `unsupported protocolVersion ${params.protocolVersion}; this agent speaks v${PROTOCOL_VERSION}`);
          }
          this.initialized = true;
          return this.reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
              mcpCapabilities: { http: false, sse: false },
            },
            authMethods: [],
            agentInfo: { name: "agentlas", title: "Agentlas", version: pkgVersion() },
          });
        }
        case "authenticate":
          return this.reply(id, {});
        case "session/new": {
          if (!this.initialized) return this.error(id, -32002, "initialize first");
          const sessionId = `agentlas-${process.pid}-${this.nextSessionSeq++}`;
          const meta = (params._meta && params._meta.agentlas) || params._meta || {};
          const spec = await this.runner.newSession(this.ctx, { cwd: params.cwd, runtimeKind: meta.runtime, agentSlug: meta.agent });
          spec.acpSessionId = sessionId;
          this.sessions.set(sessionId, spec);
          const rt = spec.runtime || {};
          return this.reply(id, {
            sessionId,
            configOptions: [
              {
                id: "runtime", category: "mode", type: "select", name: "Runtime",
                currentValue: rt.kind || "",
                options: [{ value: rt.kind || "", name: `${rt.kind || "runtime"}${rt.model ? ` · ${rt.model}` : ""}` }],
              },
              ...(rt.model ? [{ id: "model", category: "model", type: "select", name: "Model", currentValue: rt.model, options: [{ value: rt.model, name: rt.model }] }] : []),
            ],
            _meta: {
              agentlas: {
                controller: spec.agent && (spec.agent.slug || spec.agent.name),
                project: spec.project && spec.project.name,
                permission: spec.permission,
                runtime: rt.kind,
              },
            },
          });
        }
        case "session/prompt": {
          const spec = this.sessions.get(String(params.sessionId));
          if (!spec) return this.error(id, -32602, "unknown sessionId");
          // readline dispatches messages concurrently. Session.send() queues a
          // second prompt and returns the first turn's promise, which would make
          // both JSON-RPC requests stream each other's events and settle with the
          // wrong result. ACP clients must wait for the current prompt response.
          if (spec.promptInFlight) return this.error(id, -32001, "session prompt already in progress");
          const prompt = textOfPrompt(params.prompt).trim();
          if (!prompt) return this.reply(id, { stopReason: "end_turn" });
          const sid = spec.acpSessionId;
          spec.promptInFlight = true;
          let streamed = false;
          const events = {
            onDelta: (text) => {
              if (!text) return;
              streamed = true;
              this.notify("session/update", { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
            },
            onTool: (name, summary, toolId) => {
              this.notify("session/update", { sessionId: sid, update: {
                sessionUpdate: "tool_call", toolCallId: String(toolId || `${name}-${Date.now()}`), title: [name, summary].filter(Boolean).join(" "),
                kind: kindOfTool(name), status: "completed",
              } });
            },
            onToolResult: (text, ok, toolId) => {
              if (!toolId) return;
              this.notify("session/update", { sessionId: sid, update: {
                sessionUpdate: "tool_call_update", toolCallId: String(toolId), status: ok === false ? "failed" : "completed",
                content: text ? [{ type: "content", content: { type: "text", text: String(text).slice(0, 4000) } }] : undefined,
              } });
            },
            onStatus: () => {},
          };
          try {
            const res = await this.runner.runTurn(this.ctx, spec, prompt, events);
            if (res && res.cancelled) return this.reply(id, { stopReason: "cancelled" });
            if (res && res.error) {
              const kind = String(res.errorKind || "");
              if (kind === "refused") return this.reply(id, { stopReason: "refusal" });
              if (kind === "auth") return this.error(id, -32000, `auth_required: ${res.error}`);
              // Non-marker failures: surface the runtime's own words as the answer, then end the turn.
              if (!streamed) events.onDelta(String(res.error));
              return this.reply(id, { stopReason: "end_turn", _meta: { agentlas: { error: String(res.error), errorKind: kind || null } } });
            }
            if (!streamed && res && res.text) events.onDelta(res.text);
            return this.reply(id, { stopReason: "end_turn" });
          } finally {
            spec.promptInFlight = false;
          }
        }
        case "session/cancel": {
          const spec = this.sessions.get(String(params.sessionId));
          if (spec) this.runner.cancel(spec.acpSessionId);
          return; // notification: no reply
        }
        case "session/set_mode":
        case "session/set_model":
          return this.error(id, -32601, `Method not found: ${method}`);
        default:
          if (id !== undefined) return this.error(id, -32601, `Method not found: ${method}`);
          return;
      }
    } catch (e) {
      if (id !== undefined) this.error(id, -32603, (e && e.message) || String(e));
    }
  }
}

function kindOfTool(name) {
  const n = String(name || "").toLowerCase();
  if (/^(bash|shell|exec|command|run)/.test(n)) return "execute";
  if (/read|cat|view|open/.test(n)) return "read";
  if (/edit|write|patch|apply|create/.test(n)) return "edit";
  if (/delete|remove|rm/.test(n)) return "delete";
  if (/move|rename/.test(n)) return "move";
  if (/grep|search|find|glob/.test(n)) return "search";
  if (/fetch|http|web|browse/.test(n)) return "fetch";
  if (/think|plan/.test(n)) return "think";
  return "other";
}

module.exports = { AcpAgentServer, PROTOCOL_VERSION, textOfPrompt, kindOfTool, productionTurnRunner };
