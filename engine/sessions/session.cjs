"use strict";
/*
 * sessions/session — 살아있는 대화 하나.
 *
 * 세션 = 에이전트 + 챗(영속) + 런타임 resume 상태 + 이벤트 링버퍼.
 * 포그라운드/서브에이전트 구분 없이 실행 경로는 이것 하나다(제2 경로 금지).
 *
 * 스티어링: 네이티브 러너는 stdin이 닫힌 헤드리스 실행이므로 "실행 중 주입"이
 * 아니라 "다음 턴 큐잉"이다 — steer()로 넣은 메시지는 현재 턴이 끝나는 즉시
 * resume 세션으로 이어 실행된다. (조용히 버리지 않고 큐에 쌓였음을 이벤트로 알린다.)
 */
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const nativeHost = require("../agentlas-native-host.cjs");
const permissions = require("../agentlas-permissions.cjs");
const { EventSink } = require("./sink.cjs");
const store = require("./store.cjs");

const RING_LIMIT = 2000;

class Session extends EventEmitter {
  /**
   * @param {object} opts
   *   db, agent {id,slug,name,systemPrompt}, runtime {kind,bin,model?},
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
    this.startedAt = null;
    this.endedAt = null;
    this.usage = null;
    this.queue = [];
    this._child = null;
    this._events = [];
    this._turnPromise = null;
    // 계약 테스트용 spawn 주입(runNativeTurn의 req.spawn). 프로덕션 경로에선 null.
    this._spawnImpl = opts.spawnImpl || null;
    this._timeoutConfig = opts.timeoutConfig || null;

    this.chatId = opts.chatId || store.createChat(this.db, {
      agentId: this.agent.id,
      title: opts.title || (opts.parent ? `sub: ${this.agent.slug}` : "New chat"),
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

    this.fingerprint = crypto.createHash("sha256")
      .update(`${this.runtime.kind}\n${this.agent.id}\n${this.agent.systemPrompt || ""}`)
      .digest("hex");
    this.runtimeSession = store.loadRuntimeSession(this.db, this.chatId, this.runtime.kind, this.fingerprint);

    this._sink = new EventSink({
      lang: this.lang,
      onEvent: (ev) => this._record(ev),
    });
  }

  _record(ev) {
    this._events.push(ev);
    if (this._events.length > RING_LIMIT) this._events.splice(0, this._events.length - RING_LIMIT);
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

  /** 실행 중이면 큐잉, 아니면 즉시 실행. 반환: 최종 상태로 settle되는 Promise. */
  send(prompt) {
    const text = String(prompt || "").trim();
    if (!text) return Promise.resolve(null);
    if (this.isBusy()) {
      this.queue.push(text);
      this._record({ type: "queued", at: Date.now(), text });
      return this._turnPromise;
    }
    this._turnPromise = this._runLoop(text);
    return this._turnPromise;
  }

  async _runLoop(firstPrompt) {
    let prompt = firstPrompt;
    let result = null;
    while (prompt != null) {
      result = await this._runTurn(prompt);
      prompt = this.queue.length ? this.queue.shift() : null;
    }
    return result;
  }

  async _runTurn(prompt) {
    this.status = "running";
    this.startedAt = Date.now();
    this.lastError = null;
    this._record({ type: "turn-start", at: Date.now(), prompt });
    store.appendMessage(this.db, this.chatId, "user", prompt);
    // 데스크탑처럼 첫 프롬프트로 자동 제목 — "New chat"으로 남는 목록 방지(실사용 테스트 발견).
    try {
      const row = this.db.prepare("SELECT title FROM chats WHERE id=?").get(this.chatId);
      if (row && (row.title === "New chat" || !row.title)) {
        store.retitleChat(this.db, this.chatId, prompt.slice(0, 60));
      }
    } catch { /* 제목은 장식 — 실패해도 턴 진행 */ }

    // 데스크탑 러너 동형 프롬프트 조립: 언어지시 + 에이전트 프롬프트 + 연결 스킬 +
    // 거버넌스 메모리 컨텍스트 + 메모리 이미터 코어(+의도 시 전체 스키마/자격증명 리마인더).
    // projectPath는 명시 초기화(.agentlas 존재) 프로젝트만 — project init 경계 유지.
    let systemPrompt = this.agent.systemPrompt || "";
    try {
      const { augmentSystem } = require("./prompt.cjs");
      const fs = require("node:fs");
      const path = require("node:path");
      const projectPath = fs.existsSync(path.join(this.cwd, ".agentlas")) ? this.cwd : null;
      systemPrompt = augmentSystem(this.db, systemPrompt, {
        lang: this.lang,
        projectPath,
        agentId: this.agent.id,
        turnId: `${this.chatId}:${Date.now()}`,
        permission: this.permission,
      }, true, prompt);
    } catch { /* 프롬프트 증강 실패는 턴을 막지 않는다 — 원 프롬프트로 진행 */ }

    const req = {
      kind: this.runtime.kind,
      bin: this.runtime.bin,
      ui: this._sink,
      cwd: this.cwd,
      prompt,
      systemPrompt,
      permission: this.permission,
      session: { ...this.runtimeSession },
      model: this.runtime.model,
      onSpawn: (child) => { this._child = child; },
    };
    if (this._spawnImpl) req.spawn = this._spawnImpl;
    if (this._timeoutConfig) req.timeoutConfig = this._timeoutConfig;

    let res;
    try {
      res = await nativeHost.runNativeTurn(req);
    } catch (e) {
      res = { text: "", session: req.session, error: (e && e.message) || String(e) };
    }
    this._child = null;

    const finalText = (res && (res.finalText || res.text)) || "";
    /*
     * 펜스 프로토콜(Desktop runner 패리티): 성공 턴의 최종 텍스트에서 숨은 제어
     * 블록(## Memory Events / ## Delegate / ## Automation / <<agentlas-ask>>)을
     * 파싱하고, 영속·표시에는 cleanText 만 남긴다. 실패/킬 턴은 파싱하지 않는다 —
     * 반쯤 죽은 응답의 위임/자동화를 실행하지 않기 위해. 파서 예외 시 원문 보존
     * (데이터 유실이 오폭보다 낫다). require 는 lazy — orchestrator 와의 로드
     * 사이클 방지.
     */
    let persistText = finalText;
    let parsedFences = null;
    if (finalText && !(res && res.error) && this.status !== "killed") {
      try {
        parsedFences = require("./fences.cjs").parseReplyFences(finalText);
        persistText = parsedFences.cleanText;
      } catch {
        parsedFences = null;
        persistText = finalText;
      }
    }
    if (persistText) store.appendMessage(this.db, this.chatId, "assistant", persistText);
    if (res && res.session && res.session.id) {
      this.runtimeSession = { id: res.session.id };
      store.saveRuntimeSession(this.db, this.chatId, this.runtime.kind, this.runtimeSession, this.fingerprint);
    }
    if (res && res.usage) this.usage = res.usage;

    this.endedAt = Date.now();
    if (this.status === "killed") {
      this._record({ type: "turn-end", at: Date.now(), ok: false, killed: true });
      return res;
    }
    if (res && res.error) {
      this.status = "failed";
      this.lastError = res.error;
      this._record({ type: "turn-end", at: Date.now(), ok: false, error: res.error });
    } else {
      this.status = "done";
      // 링버퍼 표시 이벤트에도 raw 대신 cleanText — 제어 블록이 패널/lastLine 에 새지 않게.
      this._record({ type: "turn-end", at: Date.now(), ok: true, text: persistText });
    }
    // 적용은 상태 확정 후 — 이 세션이 더 이상 running 으로 집계되지 않아 위임 스폰이
    // 동시 상한을 자기 자신으로 소모하지 않는다. 적용 실패는 이벤트로 표면화.
    if (parsedFences) {
      try {
        require("./apply-fences.cjs").applyReplyFences(this, parsedFences, { orch: this.orchestrator });
      } catch (e) {
        this._record({ type: "error", at: Date.now(), text: `fence apply failed: ${(e && e.message) || String(e)}` });
      }
    }
    return res;
  }

  /** 실행 중 턴을 중단한다. 큐는 비운다. */
  kill() {
    this.queue.length = 0;
    if (this._child) {
      this.status = "killed";
      try { nativeHost.terminateNativeChild(this._child); } catch { /* already dead */ }
    } else if (this.status === "running") {
      this.status = "killed";
    }
  }
}

module.exports = { Session };
