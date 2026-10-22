"use strict";
/*
 * sessions/session — 살아있는 대화 하나.
 *
 * 세션 = 에이전트 + 챗(영속) + 런타임 resume 상태 + 이벤트 링버퍼.
 * 포그라운드/서브에이전트 구분 없이 실행 경로는 이것 하나다(제2 경로 금지).
 *
 * Interactive owner directions use the canonical durable inbox and common
 * brain-boundary pump inside one invocation. Child/automation sessions retain
 * their own scoped custody and never inherit this interactive control inbox.
 */
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const nativeHost = require("../agentlas-native-host.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { RUNTIME_BIN, whichSync } = require("../runtimes/detect.cjs");
const { CLI_EXECUTABLE_KINDS } = require("../runtimes/resolve.cjs");
const ACP_RUNTIME_KINDS = new Set(require("../runtimes/kinds.cjs").ACP_CLI_KINDS);
const { roleMembers } = require("../runtimes/roles.cjs");
const { EventSink } = require("./sink.cjs");
const store = require("./store.cjs");
const memoryTurn = require("./memory-turn.cjs");
const generation = require("./generation.cjs");
const turnOutcome = require("./turn-outcome.cjs");
const i18n = require("../agentlas-i18n.cjs");
const { composeDeclaredPrompt } = require("../prompt-order.cjs");

const RING_LIMIT = 2000;
const RING_BYTE_LIMIT = 8 * 1024 * 1024;

function eventBytes(event) {
  try { return Buffer.byteLength(JSON.stringify(event), "utf8"); }
  catch { return 1024; }
}

/**
 * The native binding identity (sessions/generation.cjs, native-harness NH12): runtime kind + agent, plus the declared
 * vendor limits (ACP permission mode fixed at session/new; gemini/agy conversations owned by their model). A model,
 * prompt or agent-revision change keeps the conversation: Claude/Codex/ACP resume with `--model` / a held-session model
 * switch, and changed instructions reach a resumed session as one current-version block (Desktop agent-context.ts
 * keeps the model out of the native binding the same way).
 */
function runtimeSessionFingerprint(runtime, agent, permission) {
  return generation.bindingIdentity({
    kind: runtime && runtime.kind,
    model: runtime && runtime.model,
    agentId: agent && agent.id,
    permission: ACP_RUNTIME_KINDS.has(runtime && runtime.kind) ? permissions.normalize(permission) : null,
  });
}

class Session extends EventEmitter {
  /**
   * @param {object} opts
   *   db, agent {id,slug,name,systemPrompt}, runtime {kind,bin,model?,effort?},
   *   permission, cwd, lang, parent (Session|null), title, chatId?(재개)
   */
  constructor(opts) {
    super();
    this.db = opts.db;
    this.agent = opts.agent;
    this.runtime = opts.runtime;
    this.permission = permissions.normalize(opts.permission);
    this.cwd = opts.cwd || process.cwd();
    this.lang = opts.lang || "en";
    this.parent = opts.parent || null;
    this.children = [];
    this.status = "idle"; // idle | running | done | failed | killed
    this.lastLine = "";
    this.lastError = null;
    // True once a renderer drew this turn's failure as a line of its own (a failure-marked `warn` event), so a surface that
    // also prints lastError does not say it twice. Cleared at the next turn's start.
    this.lastErrorAnnounced = false;
    this._privateRecoveryEvidence = [];
    this.startedAt = null;
    this.endedAt = null;
    this.usage = null;
    this.queue = [];
    this._child = null;
    this._events = [];
    this._eventBytes = 0;
    this._turnPromise = null;
    // 계약 테스트용 spawn 주입(runNativeTurn의 req.spawn). 프로덕션 경로에선 null.
    this._spawnImpl = opts.spawnImpl || null;
    this._apiTurnImpl = opts.apiTurnImpl || null;
    this._timeoutConfig = opts.timeoutConfig || null;
    this._apiAbort = null;
    this._activeRunId = null;
    this._runInFlight = false;
    this._ownerControl = null;
    this._ownerControlOptions = opts.ownerControlOptions || {};
    this._initialHistory = null;
    this._nativeChildren = new Set();

    this.chatId = opts.chatId || store.createChat(this.db, {
      agentId: this.agent.id,
      title: opts.title || (opts.parent ? `sub: ${this.agent.slug}` : "New project task"),
      kind: opts.parent ? "division" : "user",
      parentChatId: opts.parent ? opts.parent.chatId : null,
      workingFolder: this.cwd,
    });
    // 이 세션이 붙은 챗의 kind — apply-fences의 division 재귀 가드가 parent 없는
    // 기존 division 챗(자동화 marker 세션 등)에도 걸리게 한다.
    // 데스크탑은 chat.kind !== 'division' 조건으로 같은 가드를 건다(client.ts:3493).
    this.chatKind = opts.parent ? "division" : "user";
    if (opts.chatId) {
      try {
        const chatRow = this.db.prepare("SELECT kind FROM chats WHERE id=?").get(opts.chatId);
        if (chatRow && chatRow.kind === "division") this.chatKind = "division";
      } catch { /* kind 열이 없는 구형 DB — user 취급(레거시 NULL=user 계약) */ }
    }

    this._loadNativeBinding();

    this._sink = new EventSink({
      lang: this.lang,
      onEvent: (ev) => this._record(ev),
      onPrivateEvidence: (text) => {
        if (!text) return;
        this._privateRecoveryEvidence.push(text.slice(0, 4000));
        if (this._privateRecoveryEvidence.length > 16) this._privateRecoveryEvidence.shift();
      },
    });
  }

  /** The (chat, kind, agent) native binding: generation, provider id (resumable kinds only), delivered instructions. */
  _loadNativeBinding() {
    this.fingerprint = runtimeSessionFingerprint(this.runtime, this.agent, this.permission);
    this.nativeBinding = store.loadNativeBinding(this.db, this.chatId, this.runtime.kind, this.agent.id, this.fingerprint);
    // The gemini adapter cannot resume: a stored id is never handed back (every turn replays the journal).
    this.runtimeSession = this.nativeBinding.id && generation.NATIVE_RESUME_KINDS.has(this.runtime.kind)
      ? { id: this.nativeBinding.id } : {};
  }

  _record(ev) {
    this._events.push(ev);
    this._eventBytes += eventBytes(ev);
    while (this._events.length > RING_LIMIT || this._eventBytes > RING_BYTE_LIMIT) {
      const removed = this._events.shift();
      this._eventBytes = Math.max(0, this._eventBytes - eventBytes(removed));
    }
    if (ev.type === "stream-delta") {
      const tail = (this.lastLine + ev.text).split(/\r?\n/).filter((l) => l.trim());
      this.lastLine = tail.length ? tail[tail.length - 1].slice(0, 200) : this.lastLine;
    } else if (ev.type === "status" || ev.type === "tool") {
      this.lastLine = ev.type === "tool" ? `${ev.name}(${ev.summary || ""})`.slice(0, 200) : ev.text.slice(0, 200);
    } else if (ev.type === "error") {
      this.lastError = ev.text;
    }
    this.emit("event", ev);
  }

  eventsTail(n = 200) {
    return this._events.slice(-n);
  }

  isBusy() {
    return this.status === "running";
  }

  currentTurn() {
    return this.isBusy() && this._ownerControl
      ? { runId: this._activeRunId, runtime: this.runtime.kind } : null;
  }

  steerCurrentTurn(input) {
    if (!this._ownerControl) throw new Error("invocation_current_turn_steer_no_active_run");
    return this._ownerControl.accept(input);
  }

  currentTurnSteerReceipt({ intentId }) {
    return this._ownerControl?.store.getCurrentTurnSteer(this.chatId, intentId) ?? null;
  }

  /** Busy interactive input settles at durable intake, independently of the brain. */
  send(prompt, options = {}) {
    const text = String(prompt || "").trim();
    if (!text) return Promise.resolve(null);
    if (this.isBusy()) {
      if (!this._ownerControl) return Promise.reject(new Error("session_scoped_control_not_interactive"));
      try {
        return Promise.resolve(this.steerCurrentTurn({ chatId: this.chatId,
          expectedRunId: this._activeRunId, intentId: options.intentId || crypto.randomUUID(), text }));
      } catch (error) { return Promise.reject(error); }
    }
    if (this._runInFlight) return Promise.reject(new Error("session_invocation_still_closing"));
    this._activeRunId = `terminal-${this.chatId}-${crypto.randomUUID()}`;
    this._apiAbort = new AbortController();
    this.status = "running";
    this._runInFlight = true;
    try {
      this._ownerControl = !this.parent && this.chatKind === "user"
        ? require("./owner-control.cjs").createSessionOwnerControl(this, this._activeRunId, this._ownerControlOptions) : null;
      this._initialHistory = store.chatHistory(this.db, this.chatId).map(row => ({ role: row.role, text: row.text }));
      store.appendMessage(this.db, this.chatId, "user", text);
    } catch (error) {
      this.status = "failed";
      try { this._ownerControl?.release(); } catch { /* retain unavailable custody */ }
      this._runInFlight = false;
      this._apiAbort = null;
      this._activeRunId = null;
      return Promise.reject(error);
    }
    this._turnPromise = this._runTurn(text).catch(error => {
      if (this.status !== "killed") this.status = "failed";
      this.lastError = error?.message || String(error);
      throw error;
    }).finally(async () => {
      await this._waitForNativeDrain();
      try { this._ownerControl?.finish(this.status === "killed" ? "owner_control_cancelled"
        : "owner_control_invocation_closed"); }
      finally {
        try { this._ownerControl?.release(); }
        finally { this._runInFlight = false; this._apiAbort = null; this._activeRunId = null; this._initialHistory = null; }
      }
    });
    return this._turnPromise;
  }

  /**
   * 이미 동의된 시스템 MCP 서버 목록. `full` 권한이 아니면 빈 배열이다.
   *
   * 권한 확인을 여기서 한 번 더 하는 이유: native-host 도 `full` 게이트를 갖고
   * 있지만, 권한이 낮은 턴에서 목록을 **읽는 것 자체를** 하지 않는 편이 낫다.
   * 읽지 않은 값은 실수로 새 나갈 수 없다.
   */
  _consentedMcpServers() {
    if (permissions.normalize(this.permission) !== "full") return [];
    try {
      const consent = require("../mcp/consent.cjs");
      return consent.readConsentedSystemMcpServers(this.db, { env: process.env }) || [];
    } catch {
      // 동의 상태를 못 읽으면 MCP 없이 간다. 여기서 실패해 턴을 죽이면,
      // MCP 는 부가 기능인데 대화 자체가 불가능해진다.
      return [];
    }
  }

  _nextRecoveryRuntime() {
    // Per-automation exact pins are authoritative. A provider/model failure is
    // surfaced to the run receipt; it must never jump into a Dashboard role
    // pool and make the unattended run use a different provider.
    if (this.runtime.pinAuthoritative) return null;
    const role = this.runtime.role === "worker" ? "worker" : "orchestrator";
    const members = roleMembers(this.db, role);
    const current = members.findIndex((member) =>
      member.kind === this.runtime.kind &&
      (member.model || null) === (this.runtime.model || null),
    );
    if (current < 0) return null;
    for (const member of members.slice(current + 1)) {
      if (!CLI_EXECUTABLE_KINDS.has(member.kind)) continue;
      const bin = whichSync(RUNTIME_BIN[member.kind]);
      if (!bin) continue;
      return {
        kind: member.kind,
        bin,
        model: member.model || undefined,
        effort: member.effort || undefined,
        role,
        source: "model-role-pool-recovery",
      };
    }
    return null;
  }

  async _runTurn(prompt) {
    // External CLI adapters may lazily read skill/tool files. Until every read
    // uses an immutable snapshot, a shared lease blocks activation for the
    // entire invocation (including children). Never expire a crashed lease by
    // wall clock: recovery must reconcile the owning process/run explicitly.
    if (this.agent.builtin) return this._executeTurn(prompt);
    let revisions;
    const runId = this._activeRunId;
    this.status = "running";
    let acquired = false;
    let revisionReceipt = null;
    try {
      revisions = require("../agent-workspace.cjs").workspaceService();
      const lease = await revisions.acquireAgentWorkspaceRunLease(this.agent.id, runId);
      acquired = true;
      const workspace = await revisions.getAgentWorkspace(this.agent.id);
      if (workspace.treeDigest !== lease.treeDigest || !workspace.canonicalEntry) throw new Error("agent_revision_changed: refresh the agent before execution");
      const entry = await revisions.readAgentWorkspaceFile(this.agent.id, workspace.canonicalEntry);
      const expected = workspace.files.find((file) => file.path === workspace.canonicalEntry);
      if (!expected || entry.binary || entry.blobHash !== expected.blobHash) throw new Error("agent_revision_changed: canonical instructions no longer match the pinned revision");
      this.agent = { ...this.agent, systemPrompt: entry.content, revisionId: lease.revisionId };
      this._loadNativeBinding();
      if (this.status === "killed") return { text: "", error: "session killed" };
      revisionReceipt = { agentId: this.agent.id, runId, revisionId: lease.revisionId, treeDigest: lease.treeDigest };
      require("../agent-workspace.cjs").recordRevisionRun(this.db, { ...revisionReceipt, status: "started" });
      this._record({ type: "agent-revision-pinned", runId, revisionId: lease.revisionId, treeDigest: lease.treeDigest, at: Date.now() });
      return await this._executeTurn(prompt);
    } catch (error) {
      if (this.status !== "killed") this.status = "failed";
      throw error;
    } finally {
      try {
        if (revisionReceipt) require("../agent-workspace.cjs").recordRevisionRun(this.db, {
          ...revisionReceipt, status: this.status === "killed" ? "killed" : this.status === "failed" ? "failed" : "succeeded",
        });
      } finally {
        if (acquired) await revisions.releaseAgentWorkspaceRunLease(this.agent.id, runId);
      }
    }
  }

  async _executeTurn(prompt) {
    const core = require("../core/desktop-core.cjs").loadDesktopCore();
    const run = () => this._executeBoundTurn(prompt, core);
    if (!core || core.error || typeof core.getMemoryStoreInfo !== "function") return run();
    return require("../core/memory-owner-binding.cjs").withBinding(core, () => {
      return typeof core.withModelCallScope === "function"
        ? core.withModelCallScope({ runId: this._activeRunId || undefined, chatId: this.chatId, agentId: this.agent.id }, run)
        : run();
    });
  }

  async _executeBoundTurn(prompt, core) {
    const runtimeSessionAtTurnStart = {
      kind: this.runtime.kind,
      id: this.runtimeSession && this.runtimeSession.id ? String(this.runtimeSession.id) : "",
    };
    // The binding state this turn started from: its ACK (and a rotation) may only advance exactly this row.
    let bindingAtTurnStart = { ...this.nativeBinding };
    let deliveredInstructions = this.nativeBinding.instructionsDigest;
    this.status = "running";
    this.startedAt = Date.now();
    this.lastError = null;
    this.lastErrorAnnounced = false;
    this._sink.resetToolOutcomes();
    this._privateRecoveryEvidence.length = 0;
    this._record({ type: "turn-start", at: Date.now(), prompt });
    // ACP agents that cannot load a provider-side session need prior conversation
    // reattached on a fresh session. Capture it before appending this turn so the
    // current user prompt is not duplicated in both history and userPrompt.
    const priorHistory = this._initialHistory || [];
    let governedTurn = null;
    try {
      governedTurn = memoryTurn.beginSessionMemoryTurn(this, prompt);
    } catch (error) {
      this._privateRecoveryEvidence.push(`memory turn begin failed: ${(error && error.message) || String(error)}`.slice(0, 4000));
    }
    // 데스크탑처럼 첫 프롬프트로 자동 제목 — "New chat"으로 남는 목록 방지(실사용 테스트 발견).
    try {
      const row = this.db.prepare("SELECT title FROM chats WHERE id=?").get(this.chatId);
      if (row && (["New chat", "New project task"].includes(row.title) || !row.title)) {
        store.retitleChat(this.db, this.chatId, prompt.slice(0, 60));
      }
    } catch { /* 제목은 장식 — 실패해도 턴 진행 */ }

    // 데스크탑 러너 동형 프롬프트 조립: 언어지시 + 에이전트 프롬프트 + 연결 스킬 +
    // 거버넌스 메모리 컨텍스트 + 메모리 이미터 코어(+의도 시 전체 스키마/자격증명 리마인더).
    // projectPath는 명시 초기화(.agentlas 존재) 프로젝트만 — project init 경계 유지.
    let systemPrompt = this.agent.systemPrompt || "";
    // A retained native session gets the session-stable part as its system text and this turn's part as turn context
    // (prompt.cjs augmentSystemParts); one-shot runtimes keep the joined prompt.
    let systemPromptStable = "", turnContext = "";
    try {
      const { augmentSystemParts } = require("./prompt.cjs");
      const projectPath = governedTurn ? governedTurn.projectPath : memoryTurn.initializedProjectPath(this.cwd);
      // 이번 턴에 실제로 붙는 도구를 고지에 넘긴다. 권한이 낮아 목록을 읽지 않는 턴은
      // 빈 배열이 되고, 고지는 "붙은 도구가 없다"고 정확히 말한다 — 침묵하지 않는다.
      const consentedServers = this._consentedMcpServers();
      const toolNames = consentedServers
        .map((server) => String((server && (server.name || server.id)) || "").trim())
        .filter(Boolean);
      const augmented = augmentSystemParts(this.db, systemPrompt, {
        lang: this.lang,
        projectPath,
        agentId: this.agent.id,
        turnId: governedTurn && governedTurn.memoryTurn.turnId,
        permission: this.permission,
        availableTools: toolNames,
        // Hub 카탈로그는 hephaestus-network MCP를 통해서만 보인다.
        hubCatalogAvailable: toolNames.some((name) => /hephaestus[-_]?network|agentlas/i.test(name)),
      }, true, prompt);
      systemPrompt = augmented.joined; systemPromptStable = augmented.stable; turnContext = augmented.turn;
    } catch { /* 프롬프트 증강 실패는 턴을 막지 않는다 — 원 프롬프트로 진행 */ }

    const signal = this._apiAbort.signal;
    let ollamaChoice;
    if (this.runtime.kind === "ollama") {
      const { resolveOllamaModel } = require("../runtimes/ollama.cjs");
      ollamaChoice = await resolveOllamaModel(this.runtime.model, { env: process.env,
        fetch: (url, options = {}) => fetch(url, { ...options,
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }) });
    }
    const episodeResults = [];
    const sourceRunner = (fn) => typeof core?.withMemorySourceRunner === "function" ? core.withMemorySourceRunner(fn) : fn;
    const runOnce = async (controlRequest) => {
      this._ownerControl?.assertOwned();
      if (signal.aborted) throw new Error("session killed");
      let result;
      if (this.runtime.kind === "ollama") {
        const apiTurn = this._apiTurnImpl || require("../agentlas-api-agent.cjs").runApiTurn;
        result = await sourceRunner(apiTurn)({ backend: "ollama", model: ollamaChoice.model, system: systemPrompt,
          messages: [...controlRequest.history.map(row => ({ role: row.role, content: row.text })),
            { role: "user", content: controlRequest.userPrompt }],
          ctx: { cwd: this.cwd, permission: this.permission, env: process.env, signal,
            db: this.db, chatId: this.chatId, agentId: this.agent.id }, ui: this._sink, signal });
      } else {
        const kind = this.runtime.kind;
        const windowTokens = generation.contextWindowTokens(kind, this.runtime.model);
        const resuming = generation.NATIVE_RESUME_KINDS.has(kind)
          && Boolean(controlRequest.runtimeSessionId || (this.runtimeSession && this.runtimeSession.id));
        const stableDigest = generation.instructionsDigest(systemPromptStable);
        // A resumed session that keeps its first system text gets changed instructions once, as the current version.
        const instructionsUpdate = resuming && stableDigest && generation.INSTRUCTIONS_FIXED_AT_START_KINDS.has(kind)
          && stableDigest !== deliveredInstructions ? generation.instructionsBlock(systemPromptStable) : "";
        // A fresh generation (or a host-replay runtime) starts from the journal, not from nothing. The shared ACP runner
        // renders `history` itself on a fresh session.
        const journalSeed = !resuming && systemPromptStable && !ACP_RUNTIME_KINDS.has(kind)
          ? generation.renderJournalSeed(this._journalHistory(controlRequest.history), this.lang, windowTokens) : "";
        const callTurnContext = systemPromptStable ? composeDeclaredPrompt([
          { id: "terminal.session.instructions-update", stability: "versioned-content", changeTriggers: ["agent-instructions"], text: instructionsUpdate },
          { id: "terminal.session.journal-seed", stability: "task-context", changeTriggers: ["checkpoint", "runtime"], text: journalSeed },
          { id: "terminal.session.turn-part", stability: "turn-context", changeTriggers: ["owner-input", "retrieval", "permission"], text: turnContext },
        ]) : turnContext;
        if (systemPromptStable && (!resuming || instructionsUpdate || !generation.INSTRUCTIONS_FIXED_AT_START_KINDS.has(kind))) {
          deliveredInstructions = stableDigest;
        }
        const req = { kind: this.runtime.kind, bin: this.runtime.bin, ui: this._sink, cwd: this.cwd,
          prompt: controlRequest.userPrompt, systemPrompt, permission: this.permission,
          ...(systemPromptStable ? { systemPromptStable, turnContext: callTurnContext } : {}),
          compactTokenLimit: generation.nativeCompactionLimit(windowTokens),
          ...(generation.HOST_REPLAY_KINDS.has(kind) && journalSeed ? { historySeed: journalSeed } : {}),
          session: { ...this.runtimeSession, ...(controlRequest.runtimeSessionId ? { id: controlRequest.runtimeSessionId } : {}) },
          history: controlRequest.history, chatId: this.chatId, agentId: this.agent.id, locale: this.lang,
          // The shared store: ACP permission requests are answered from its capability rules (acp-driver arbiter).
          db: this.db,
          // The generation is part of the seed: the shared ACP runner keys its stored session and resident pool by it.
          sessionFingerprintSeed: `${this.fingerprint}:g${this.nativeBinding.generation}`,
          model: this.runtime.model, effort: this.runtime.effort,
          mcpServers: this._consentedMcpServers(), signal, onSpawn: child => {
            this._child = child;
            this._nativeChildren.add(child);
            child.once("close", () => {
              this._nativeChildren.delete(child);
              if (this._child === child) this._child = null;
            });
          },
          ...(this._spawnImpl ? { spawn: this._spawnImpl } : {}),
          ...(this._timeoutConfig ? { timeoutConfig: this._timeoutConfig } : {}) };
        result = await sourceRunner(nativeHost.runNativeTurn)(req);
        // A resumed conversation that no longer exists (agy silently started a new one; claude has no such session)
        // and proved no effect: retire the binding to the next generation and run this same turn once fresh, seeded
        // from the journal — the fresh-generation path, never a replay of anything that acted.
        if (resuming && result?.errorCode === "session_not_found" && result.sessionGoneBeforeEffects === true
          && this.status !== "killed" && !signal.aborted) {
          const from = { ...this.nativeBinding };
          const next = { identity: this.fingerprint, generation: from.generation + 1, sessionId: "", instructionsDigest: null };
          if (store.saveNativeBinding(this.db, this.chatId, kind, this.agent.id, next, bindingAtTurnStart)) {
            this._record({ type: "session-generation", at: Date.now(), runtime: kind, fromGeneration: from.generation,
              toGeneration: next.generation, reason: "session_not_found", inputTokens: null, contextWindowTokens: windowTokens });
            this._loadNativeBinding();
            bindingAtTurnStart = { ...this.nativeBinding };
            this.runtimeSession = {};
            const freshSeed = systemPromptStable && !ACP_RUNTIME_KINDS.has(kind)
              ? generation.renderJournalSeed(this._journalHistory(controlRequest.history), this.lang, windowTokens) : "";
            deliveredInstructions = generation.instructionsDigest(systemPromptStable);
            result = await sourceRunner(nativeHost.runNativeTurn)({ ...req, session: {},
              ...(systemPromptStable ? { turnContext: composeDeclaredPrompt([
                { id: "terminal.session.journal-seed", stability: "task-context", changeTriggers: ["checkpoint", "runtime"], text: freshSeed },
                { id: "terminal.session.turn-part", stability: "turn-context", changeTriggers: ["owner-input", "retrieval", "permission"], text: turnContext },
              ]) } : {}),
              ...(generation.HOST_REPLAY_KINDS.has(kind) && freshSeed ? { historySeed: freshSeed } : {}),
              sessionFingerprintSeed: `${this.fingerprint}:g${this.nativeBinding.generation}` });
          }
        }
        // Non-interactive recovery retains its original scoped authority. The
        // common interactive invocation never replays a failed provider effect.
        if (!this._ownerControl && result?.error && this.status !== "killed") {
          const nextRuntime = this._nextRecoveryRuntime();
          if (nextRuntime) {
            this.runtime = nextRuntime;
            this._loadNativeBinding();
            this.runtimeSession = {};
            bindingAtTurnStart = { ...this.nativeBinding };
            deliveredInstructions = generation.instructionsDigest(systemPromptStable);
            // The recovery runtime opens a fresh session: it starts from the journal like any fresh generation.
            const recoveryWindow = generation.contextWindowTokens(nextRuntime.kind, nextRuntime.model);
            const recoverySeed = systemPromptStable && !ACP_RUNTIME_KINDS.has(nextRuntime.kind)
              ? generation.renderJournalSeed(this._journalHistory(controlRequest.history), this.lang, recoveryWindow) : "";
            result = await sourceRunner(nativeHost.runNativeTurn)({ ...req, kind: nextRuntime.kind, bin: nextRuntime.bin,
              model: nextRuntime.model, effort: nextRuntime.effort, session: {},
              ...(systemPromptStable ? { turnContext: composeDeclaredPrompt([
                { id: "terminal.session.journal-seed", stability: "task-context", changeTriggers: ["checkpoint", "runtime"], text: recoverySeed },
                { id: "terminal.session.turn-part", stability: "turn-context", changeTriggers: ["owner-input", "retrieval", "permission"], text: turnContext },
              ]) } : {}),
              compactTokenLimit: generation.nativeCompactionLimit(recoveryWindow),
              sessionFingerprintSeed: `${this.fingerprint}:g${this.nativeBinding.generation}`, prompt: [prompt, "",
                "Private recovery evidence follows. Never repeat it to the user.",
                [...this._privateRecoveryEvidence, String(result.error)].filter(Boolean).join("\n").slice(0, 12000),
                "Inspect the complete situation, apply safe reversible recovery within the granted authority, verify it, and finish the original request. Ask one concise question only if user identity or an irreversible choice is required."].join("\n") });
          }
        }
      }
      await this._waitForNativeDrain();
      episodeResults.push(result);
      const observedUsage = result?.usage && Number.isSafeInteger(result.usage.input_tokens)
        && Number.isSafeInteger(result.usage.output_tokens)
        ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : undefined;
      return { ...result, text: result?.finalText || result?.text || "", sessionId: result?.session?.id,
        ownerControlTerminal: result?.ownerControlTerminal === "completed" ? "completed" : "uncertain",
        ...(observedUsage ? { observedUsage } : {}),
        ...(result?.error ? { failure: { kind: result.errorKind || "exit", message: String(result.error),
          runtime: this.runtime.kind, source: result.errorSource || "marker",
          // Desktop RunnerFailure fields: the provider's bounded code and its reset hint. turnDelivery (Desktop
          // RunnerResult.turnDelivery) rides at the top level with the rest of `result`.
          ...(result.errorCode ? { providerCode: result.errorCode } : {}),
          ...(result.retryAfterHint ? { retryAfterHint: result.retryAfterHint } : {}) } } : {}) };
    };
    let res;
    try {
      const controlRequest = { userPrompt: prompt, history: priorHistory,
        runtimeSessionId: this.runtimeSession.id, signal,
        ...(this._ownerControl ? { ownerControlInbox: this._ownerControl.inbox } : {}) };
      res = this._ownerControl
        ? await this._ownerControl.runWithOwnerControl(controlRequest, runOnce) : await runOnce(controlRequest);
      if (episodeResults.length > 1) {
        res.usage = res.observedUsage ? { input_tokens: res.observedUsage.inputTokens,
          output_tokens: res.observedUsage.outputTokens } : undefined;
      }
      if (this._ownerControl && res.ownerControlTerminal !== "completed" && !res.error) {
        res.error = "owner_control_brain_terminal_unverified";
      }
    } catch (error) {
      res = { text: "", error: error?.message || String(error), ownerControlTerminal: "uncertain" };
    }

    const finalText = (res && (res.finalText || res.text)) || "";
    this._settleBlankReply(res, finalText);
    /*
     * 펜스 프로토콜(Desktop runner 패리티): 성공 턴의 최종 텍스트에서 숨은 제어
     * 블록(## Memory Events / ## Delegate / ## Automation / <<agentlas-ask>>)을
     * 파싱하고, 영속·표시에는 cleanText 만 남긴다. 실패/킬 턴은 파싱하지 않는다 —
     * 반쯤 죽은 응답의 위임/자동화를 실행하지 않기 위해. 파서 예외 시 원문 보존
     * (데이터 유실이 오폭보다 낫다). require 는 lazy — orchestrator 와의 로드
     * 사이클 방지.
     */
    let persistText = finalText;
    let governedResult = null;
    let parsedFences = null;
    if (finalText && !(res && res.error) && this.status !== "killed") {
      try {
        governedResult = await memoryTurn.completeSessionMemoryTurn(this, governedTurn, {
          text: finalText,
          prompt,
          outcome: "succeeded",
        });
        // Decode non-memory controls from the original. Memory authority belongs
        // only to the completed governed turn, including legacy envelopes.
        parsedFences = require("./fences.cjs").parseReplyFences(finalText);
        persistText = parsedFences.cleanText;
      } catch {
        parsedFences = null;
        try {
          parsedFences = require("./fences.cjs").parseReplyFences(finalText);
          persistText = parsedFences.cleanText;
        } catch {
          persistText = finalText;
        }
      }
    } else if (governedTurn && this.status !== "killed") {
      try {
        governedResult = await memoryTurn.completeSessionMemoryTurn(this, governedTurn, {
          text: finalText,
          prompt,
          outcome: "failed",
          invokeCurator: false,
        });
        if (governedResult) {
          persistText = String(governedResult.cleaned || "").replace(/<!--\s*$/u, "").trim();
        }
      } catch { /* original runtime failure remains authoritative */ }
    }
    if (persistText) store.appendMessage(this.db, this.chatId, "assistant", persistText);
    // ACK: only a completed turn advances the binding (a failed or stopped turn leaves the row it started from).
    if (res && res.session && res.session.id && !res.error && this.status !== "killed") {
      const acked = { identity: this.fingerprint, generation: this.nativeBinding.generation,
        sessionId: String(res.session.id), instructionsDigest: deliveredInstructions };
      if (store.saveNativeBinding(this.db, this.chatId, this.runtime.kind, this.agent.id, acked, bindingAtTurnStart)) {
        this.nativeBinding = { id: acked.sessionId, generation: acked.generation, instructionsDigest: acked.instructionsDigest,
          fingerprint: generation.encodeBinding(acked) };
        this.runtimeSession = generation.NATIVE_RESUME_KINDS.has(this.runtime.kind) ? { id: acked.sessionId } : {};
        this._maybeRotateGeneration(res);
      }
    }
    if (res && res.usage) this.usage = res.usage;
    // The turn's last model request for the context inspector (agentlas context, Desktop, mobile).
    if (res && (res.usage || res.contextWindowTokens)) {
      require("../context-inspect.cjs").recordTerminalModelCall(this.db, {
        chatId: this.chatId, agentId: this.agent && this.agent.id, runtimeKind: this.runtime.kind, model: this.runtime.model,
        usage: res.usage, contextWindowTokens: res.contextWindowTokens, durationMs: Date.now() - this.startedAt, resumed: Boolean(runtimeSessionAtTurnStart && runtimeSessionAtTurnStart.id),
        failed: Boolean(res.error),
      });
    }

    // Experience intake is downstream of the governed episode receipt. It
    // records the successful exact-agent run even when the curator correctly
    // retains zero durable memories; promotion remains a separate policy.
    if (!this.agent.revisionId && governedResult && !(res && res.error) && this.status !== "killed") {
      try {
        const memoryContext = require("../project/memory-context.cjs");
        const installedAgent = this.db.prepare("SELECT * FROM installed_agents WHERE id=?").get(this.agent.id);
        const exactBase = installedAgent
          ? memoryContext.exactAgentBaseForExecution(this.db, installedAgent, null)
          : null;
        if (exactBase) {
          const taskSignatures = await memoryTurn.resolveSessionTaskSignatures(this, prompt);
          memoryContext.finalizeExperienceExecutionCli(this.db, {
          agentId: this.agent.id,
          projectPath: governedTurn && governedTurn.projectPath,
          cwd: this.cwd,
          runtime: this.runtime.kind === "ollama"
            ? { mode: "api", backend: "ollama", model: this.runtime.model }
            : { mode: "cli", kind: this.runtime.kind, model: this.runtime.model },
          permission: this.permission,
          model: this.runtime.model,
          mcpServers: this._consentedMcpServers(),
          curatedMemories: governedResult.curatedMemories || [],
          taskHint: prompt,
          taskSignatures,
          outcome: { status: "succeeded", failureCode: null },
          usage: res && res.usage,
          durationMs: Date.now() - this.startedAt,
          runId: governedTurn.memoryTurn.turnId,
          lang: this.lang,
          });
        }
      } catch (error) {
        this._privateRecoveryEvidence.push(`experience intake failed: ${(error && error.message) || String(error)}`.slice(0, 4000));
      }
    }

    // Every consumer (run --print, automation, firms) receives the same clean
    // result that was persisted. Never hand the raw control envelope back.
    if (res && typeof res === "object") {
      res.controlText = finalText;
      res.text = persistText;
      res.finalText = persistText;
    }

    this.endedAt = Date.now();
    if (this.status === "killed") {
      this._record({ type: "turn-end", at: Date.now(), ok: false, killed: true });
      return res;
    }
    if (res && res.error) {
      this.status = "failed";
      /*
       * ★사유를 버리지 않는다. 예전에는 여기서 null로 지워서, daemon이 run_history에
       * "runtime turn failed"라는 고정 문자열만 남기고 run/build는 아무 말 없이 exit 1이었다
       * — 사람이 알아야 고칠 수 있는 것(한도 리셋 시각, 로그인 필요)을 아는 쪽이 지웠다.
       * 렌더러 완곡 문구는 Ui 계층이 따로 지킨다(recovery-presentation-contract) —
       * 기록과 화면은 다른 문제다.
       */
      this.lastError = String(res.error).slice(0, 2000);
      this._record({ type: "turn-end", at: Date.now(), ok: false, recoveryRequired: true });
    } else {
      this.status = "done";
      // 링버퍼 표시 이벤트에도 raw 대신 cleanText — 제어 블록이 패널/lastLine 에 새지 않게.
      this._record({ type: "turn-end", at: Date.now(), ok: true, text: persistText });
    }
    // 적용은 상태 확정 후 — 이 세션이 더 이상 running 으로 집계되지 않아 위임 스폰이
    // 동시 상한을 자기 자신으로 소모하지 않는다. 적용 실패는 이벤트로 표면화.
    if (parsedFences) {
      try {
        require("./apply-fences.cjs").applyReplyFences(this, parsedFences, {
          orch: this.orchestrator, governedMemory: governedResult,
        });
      } catch (e) {
        this._privateRecoveryEvidence.push(`fence apply failed: ${(e && e.message) || String(e)}`.slice(0, 4000));
      }
    }
    return res;
  }

  /**
   * A turn that ended normally with no reply text is not a finished turn when (H2, Desktop agentlas_desktop 248ec2093;
   * sessions/turn-outcome.cjs) every tool call it made failed or came back as an empty collection, or when it made no tool call
   * and showed no sign of tool use at all (the model's empty answer; Desktop settleNormalEnd outcome `empty`). It used to end
   * `done` with a blank reply, exit 0 and no reason; the interactive Terminal draws nothing for a returned failure, so the person
   * could not tell it from a slow answer. It now ends `failed` with the reason in `res.error` (lastError, which `run --print`,
   * `one`, the ACP server and the firm flows read) and one host-authored line the renderer draws (a failure-marked `warn` event;
   * the renderer sets `lastErrorAnnounced`, so a surface that also prints lastError does not say it twice). Nothing is sent
   * again: this runs after the executor's own recovery.
   *
   * Only an owner-facing chat turn: a delegate or firm division (parent / division chat), an automation marker session
   * (division chat), a stopped turn and a turn the executor did not end normally keep their callers' rules for an empty text.
   * A tool-only turn whose tools worked, or ran a tool this host draws no row for, is untouched (the work happened through its tools).
   *
   * An executor that typed the model's empty answer ITSELF (antigravity's agyEmptyRunFailure, the ACP core's `empty`) returns an
   * error of its own, in its own words (English only, or the raw "ACP stopReason=end_turn"), and the interactive Terminal draws
   * no returned failure: the person saw nothing. When the sink's facts agree (no text, no tool use of any kind) and the error
   * carries no machine code of its own, the same sentence, code and failure line replace it, so every executor says the same
   * thing in the person's language. The executor's own words stay in `res.failure.message`. Any other error keeps its own cause.
   */
  _settleBlankReply(res, finalText) {
    if (!res) return false;
    if (this.parent || this.chatKind !== "user" || this.status === "killed" || (this._apiAbort && this._apiAbort.signal.aborted)) return false;
    const facts = { text: finalText, reportedToolCalls: res.toolCalls, outcomes: this._sink.toolOutcomes() };
    let kind = null;
    if (res.error) {
      if (turnOutcome.executorTypedEmptyAnswer({ ...facts, failure: { kind: res.errorKind, code: res.errorCode } })) kind = "no_tools";
    } else if (res.ownerControlTerminal === "completed") {
      kind = turnOutcome.blankReplyKind(facts);
    }
    if (!kind) return false;
    const sentence = i18n.t(this.lang, kind === "tools_unusable" ? "runtime.emptyAfterUnusableTools" : "runtime.emptyAnswer");
    res.error = sentence;
    res.errorKind = "empty";
    res.errorSource = "marker";
    res.errorCode = kind === "tools_unusable" ? turnOutcome.EMPTY_AFTER_UNUSABLE_TOOLS_CODE : turnOutcome.EMPTY_ANSWER_CODE;
    this._sink.warn(sentence, { failure: true });
    return true;
  }

  /** The whole journal before this turn's message (a fresh generation is seeded from all of it, folded to the budget). */
  _journalHistory(fallback) {
    try {
      const rows = store.chatHistory(this.db, this.chatId, -1);
      // The current owner message was appended at send(); the seed carries what came before it.
      if (rows.length && rows[rows.length - 1].role === "user") rows.pop();
      return rows.map((row) => ({ role: row.role, text: row.text, created_at: row.created_at }));
    } catch {
      return Array.isArray(fallback) ? fallback : [];
    }
  }

  /**
   * A native session whose last model request reached 80% of the model's own window gives way to the next generation
   * for the NEXT turn, seeded from the journal (generation.cjs; Desktop session-generation.ts). Background only: a
   * machine event in the ring, nothing on screen.
   */
  _maybeRotateGeneration(res) {
    const kind = this.runtime.kind;
    if (!generation.NATIVE_RESUME_KINDS.has(kind)) return;
    const contextWindowTokens = res.contextWindowTokens ?? generation.contextWindowTokens(kind, this.runtime.model);
    const decision = generation.decideGeneration({ kind, contextWindowTokens, lastInputTokens: res.contextInputTokens ?? null });
    if (decision.action !== "new_generation") return;
    const from = this.nativeBinding;
    const next = { identity: this.fingerprint, generation: from.generation + 1, sessionId: "", instructionsDigest: null };
    if (!store.saveNativeBinding(this.db, this.chatId, kind, this.agent.id, next, from)) return; // another turn moved it
    this._record({ type: "session-generation", at: Date.now(), runtime: kind, fromGeneration: from.generation,
      toGeneration: next.generation, reason: decision.reason, inputTokens: res.contextInputTokens ?? null, contextWindowTokens });
    this._loadNativeBinding();
  }

  async _waitForNativeDrain() {
    await require("./native-child-drain.cjs").waitForNativeChildren(this._nativeChildren);
    if (this._child && !this._nativeChildren.has(this._child)) this._child = null;
  }

  /** Stop always aborts the shared brain signal and independently kills the child tree. */
  kill() {
    this.queue.length = 0;
    try { this._ownerControl?.markSettling(); } catch { /* cancellation cannot depend on custody storage */ }
    if (this.status === "running" || this._runInFlight) this.status = "killed";
    try { this._apiAbort?.abort(new Error("session killed")); } catch { /* already aborted */ }
    if (this._child) {
      try { nativeHost.terminateNativeChild(this._child); } catch { /* already dead */ }
    }
    try { this._ownerControl?.finish("owner_control_cancelled"); }
    catch (error) { this._privateRecoveryEvidence.push(`control settlement failed: ${error?.message || error}`.slice(0, 4000)); }
  }

}

module.exports = { Session, runtimeSessionFingerprint };
