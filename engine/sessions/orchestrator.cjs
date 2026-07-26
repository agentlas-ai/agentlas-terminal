"use strict";
/*
 * sessions/orchestrator — 오르카 계층: 멀티세션 스폰/전환/스티어/킬/브로드캐스트.
 *
 * 세션 번호는 s1, s2, … 로 붙는다(사람이 한 키로 지목할 수 있는 안정 번호).
 * 활성 세션 하나만 터미널에 스트리밍되고, 나머지는 백그라운드에서 이벤트를
 * 링버퍼에 쌓는다. 백그라운드 세션의 턴 종료는 'notice' 이벤트로 전면 세션에
 * 한 줄 알림된다.
 *
 * 동시 실행 상한: AGENTLAS_MAX_PARALLEL (기본 4). 상한 초과 스폰은 대기가 아니라
 * 정직한 거부 — 사용자가 세션을 정리하거나 상한을 올리게 안내한다.
 */
const { EventEmitter } = require("node:events");
const { Session } = require("./session.cjs");

function maxParallel() {
  const n = Number(process.env.AGENTLAS_MAX_PARALLEL);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 16) : 4;
}

class Orchestrator extends EventEmitter {
  constructor({ db, lang }) {
    super();
    this.db = db;
    this.lang = lang || "en";
    this.sessions = new Map(); // "s1" -> Session
    this._seq = 0;
    this.activeKey = null;
  }

  _nextKey() {
    this._seq += 1;
    return `s${this._seq}`;
  }

  runningCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.isBusy()) n += 1;
    return n;
  }

  /**
   * 세션 생성(+선택적 즉시 실행). parentKey를 주면 그 세션의 서브에이전트
   * (division 챗)로 붙는다.
   */
  spawn({ agent, runtime, permission, cwd, title, parentKey, activate = true, spawnImpl, timeoutConfig }) {
    const parent = parentKey ? this.sessions.get(parentKey) || null : null;
    const session = new Session({
      db: this.db,
      agent,
      runtime,
      permission,
      cwd,
      lang: this.lang,
      parent,
      title,
      spawnImpl,
      timeoutConfig,
    });
    const key = this._nextKey();
    session.key = key;
    this.sessions.set(key, session);
    if (parent) parent.children.push(key);

    session.on("event", (ev) => {
      this.emit("session-event", { key, session, ev });
      if (ev.type === "turn-end" && this.activeKey !== key) {
        this.emit("notice", {
          key,
          session,
          text: ev.ok
            ? `${key} ${session.agent.slug}: done`
            : `${key} ${session.agent.slug}: ${ev.error || "failed"}`,
          ok: !!ev.ok,
        });
      }
    });

    if (activate || !this.activeKey) this.activeKey = key;
    this.emit("sessions-changed");
    return session;
  }

  /** 실행 요청 — 동시 상한을 넘으면 스폰하지 않고 정직하게 throw. */
  sendTo(key, prompt) {
    const session = this.sessions.get(key);
    if (!session) throw new Error(`no such session: ${key}`);
    if (!session.isBusy() && this.runningCount() >= maxParallel()) {
      throw new Error(`parallel limit ${maxParallel()} reached (running: ${this.runningCount()}). /kill or raise AGENTLAS_MAX_PARALLEL`);
    }
    return session.send(prompt);
  }

  active() {
    return this.activeKey ? this.sessions.get(this.activeKey) || null : null;
  }

  setActive(key) {
    if (!this.sessions.has(key)) throw new Error(`no such session: ${key}`);
    this.activeKey = key;
    this.emit("sessions-changed");
    return this.sessions.get(key);
  }

  kill(key) {
    const session = this.sessions.get(key);
    if (!session) throw new Error(`no such session: ${key}`);
    session.kill();
    this.emit("sessions-changed");
  }

  remove(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.isBusy()) session.kill();
    this.sessions.delete(key);
    if (this.activeKey === key) {
      const rest = [...this.sessions.keys()];
      this.activeKey = rest.length ? rest[rest.length - 1] : null;
    }
    this.emit("sessions-changed");
  }

  broadcast(prompt) {
    const sent = [];
    for (const [key, session] of this.sessions) {
      if (session.status === "killed") continue;
      this.sendTo(key, prompt);
      sent.push(key);
    }
    return sent;
  }

  /** 세션 표: [{key, active, agent, status, elapsed, lastLine, parentKey, depth}] */
  list() {
    const rows = [];
    const walk = (key, depth) => {
      const s = this.sessions.get(key);
      if (!s) return;
      rows.push({
        key,
        active: key === this.activeKey,
        agent: s.agent.slug,
        status: s.status,
        busy: s.isBusy(),
        elapsedMs: s.startedAt ? (s.endedAt || Date.now()) - s.startedAt : 0,
        lastLine: s.lastLine,
        parentKey: s.parent ? s.parent.key : null,
        depth,
        queued: s.queue.length,
      });
      for (const c of s.children) walk(c, depth + 1);
    };
    for (const [key, s] of this.sessions) {
      if (!s.parent) walk(key, 0);
    }
    return rows;
  }

  /** 모든 세션 종료(REPL 종료 시). */
  shutdown() {
    for (const s of this.sessions.values()) {
      if (s.isBusy()) s.kill();
    }
  }
}

module.exports = { Orchestrator, maxParallel };
