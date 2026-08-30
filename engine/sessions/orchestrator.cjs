"use strict";
/*
 * sessions/orchestrator — 프로젝트 Work의 컨트롤러/서브에이전트 실행 트리.
 *
 * 세션 번호는 s1, s2, … 로 붙는다(사람이 한 키로 지목할 수 있는 안정 번호).
 * 활성 세션 하나만 터미널에 스트리밍되고, 나머지는 백그라운드에서 이벤트를
 * 링버퍼에 쌓는다. 백그라운드 세션의 턴 종료는 'notice' 이벤트로 전면 세션에
 * 한 줄 알림된다.
 *
 * 동시 실행 상한: 공유 DB 의 agent_concurrency(데스크탑 슬라이더와 같은 값)가 기본이고,
 * AGENTLAS_MAX_PARALLEL 은 **override**다(명시했을 때만 이긴다 — 예전엔 이 env 가
 * 유일한 소스라 데스크탑과 터미널이 같은 머신에서 다른 예산을 들고 있었다).
 * 상한 초과 스폰은 대기가 아니라 정직한 거부 — 사용자가 세션을 정리하거나 상한을 올리게 안내한다.
 */
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { Session } = require("./session.cjs");

// 데스크탑 electron/store/concurrency.ts 와 같은 상수/공식 — 값이 갈리면 같은 머신의
// 두 제품이 다른 예산을 말한다. 바꿀 때는 반드시 양쪽을 함께 바꿀 것.
const AGENT_CONCURRENCY_HARD_MAX = 32;

/** 사양 기반 추천 동시성(데스크탑 recommendedConcurrency 와 동일 공식). */
function recommendedConcurrency() {
  let cores = 4;
  let totalMemGB = 8;
  try { cores = Math.max(1, os.cpus().length); } catch { /* fall back */ }
  try { totalMemGB = os.totalmem() / 1024 ** 3; } catch { /* fall back */ }
  const coreBound = Math.max(1, cores - 2);
  const memBound = Math.max(1, Math.floor((totalMemGB - 4) / 2));
  return Math.max(1, Math.min(coreBound, memBound, AGENT_CONCURRENCY_HARD_MAX));
}

/*
 * 공유 DB 핸들 — Orchestrator 생성 시 등록된다. maxParallel 이 배너 출력 등에서
 * 오케스트레이터 없이도 불리므로(ui/shell.cjs), 핸들이 없을 때는 추천값으로 답한다.
 */
let _concurrencyDb = null;
function setConcurrencyDb(db) {
  _concurrencyDb = db || null;
}

function sharedDbConcurrency() {
  if (!_concurrencyDb) return null;
  try {
    const row = _concurrencyDb.prepare("SELECT value FROM meta WHERE key='agent_concurrency'").get();
    if (!row || row.value == null || row.value === "") return null;
    const parsed = Number(row.value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.max(1, Math.min(Math.floor(parsed), AGENT_CONCURRENCY_HARD_MAX));
  } catch {
    // meta 테이블이 없는 옛/부분 DB — 추천값으로 폴백(조용한 실패가 아니라 설계된 폴백).
    return null;
  }
}

function maxParallel() {
  // 1) env 는 명시적 override — 사람이 이번 셸에서 일부러 정한 값이 항상 이긴다.
  const n = Number(process.env.AGENTLAS_MAX_PARALLEL);
  if (Number.isInteger(n) && n > 0) return Math.min(n, AGENT_CONCURRENCY_HARD_MAX);
  // 2) 공유 DB 의 사용자 슬라이더 값(데스크탑과 동일 예산).
  const shared = sharedDbConcurrency();
  if (shared !== null) return shared;
  // 3) 둘 다 없으면 사양 기반 추천값(데스크탑의 미설정 동작과 동일).
  return recommendedConcurrency();
}

class Orchestrator extends EventEmitter {
  constructor({ db, lang }) {
    super();
    this.db = db;
    // 공유 DB 를 동시성 기본값의 소스로 등록 — 데스크탑 슬라이더와 같은 예산을 쓴다.
    if (db) setConcurrencyDb(db);
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
    for (const s of this.sessions.values()) {
      if (s.isBusy()) {
        n += 1;
        continue;
      }
      // kill() fences the session immediately, but native/API cancellation is
      // asynchronous. Keep the slot occupied until Session has released its
      // child or abort controller; otherwise a replacement turn can start
      // while the killed provider is still consuming a process/slot.
      if (s.status === "killed" && (s._child || s._apiAbort)) n += 1;
    }
    return n;
  }

  /**
   * 세션 생성(+선택적 즉시 실행). parentKey를 주면 그 세션의 서브에이전트
   * (division 챗)로 붙는다.
   */
  spawn({ agent, runtime, permission, cwd, title, parentKey, activate = true, spawnImpl, apiTurnImpl, timeoutConfig, chatId }) {
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
      apiTurnImpl,
      timeoutConfig,
      chatId,
    });
    const key = this._nextKey();
    session.key = key;
    session.orchestrator = this; // apply-fences 가 ## Delegate 스폰 시 쓰는 오르카 역참조
    this.sessions.set(key, session);
    if (parent) parent.children.push(key);

    session.on("event", (ev) => {
      this.emit("session-event", { key, session, ev });
      if (ev.type === "turn-end" && ev.ok && this.activeKey !== key) {
        this.emit("notice", {
          key,
          session,
          text: `${key} ${session.agent.slug}: done`,
          ok: true,
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

    // 부모를 지워도 자식 세션은 살아 있다(실행 중이며 병렬 슬롯을 쥔 채일 수 있다).
    // 자식의 parent 포인터가 지워진 세션을 계속 가리키면 list()의 루트 판정
    // (!s.parent)에서 탈락하고, 어떤 루트에서도 닿지 않아 /sessions·/tree 에서
    // 통째로 사라진다 — 실행 중인데 보이지도 끌 수도 없는 유령 세션이 된다.
    // 그래서 세션이 맵을 떠날 때 트리를 함께 정리한다: 남은 자식은 살아 있는
    // 조부모로 승계하고(없으면 루트로 승격), 지워진 키는 부모 목록에서 뗀다.
    const grandparent = session.parent && this.sessions.has(session.parent.key) ? session.parent : null;
    for (const childKey of session.children) {
      const child = this.sessions.get(childKey);
      if (!child) continue;
      child.parent = grandparent;
      if (grandparent && !grandparent.children.includes(childKey)) grandparent.children.push(childKey);
    }
    session.children = [];
    if (session.parent) {
      const siblings = session.parent.children;
      const at = siblings.indexOf(key);
      if (at >= 0) siblings.splice(at, 1);
    }

    if (this.activeKey === key) {
      const rest = [...this.sessions.keys()];
      this.activeKey = rest.length ? rest[rest.length - 1] : null;
    }
    this.emit("sessions-changed");
  }

  /**
   * 전 세션 브로드캐스트 — {sent, skipped}를 반환한다(throw 하지 않는다).
   *
   * WHY: 예전엔 루프 안에서 sendTo()의 throw가 그대로 올라갔다. 동시 상한(기본 4)보다
   * 유휴 세션이 많으면 앞의 몇 개는 이미 프롬프트를 받아 실행을 시작한 뒤 상한 세션에서
   * 터졌고, 그때까지 모은 sent 배열은 스택과 함께 버려졌다. 호출자(REPL)는 상한 에러
   * 한 줄만 찍어 "전부 실패"로 보고했지만 실제로는 4개 세션이 그 지시를 받아 토큰을
   * 쓰고 쓰기 작업까지 할 수 있는 상태였다 — 부분 성공을 전면 실패로 오보하는 것은
   * 브로드캐스트에서 가장 위험한 거짓말이다.
   * 그래서 실패는 세션 단위로 모으고, 실제 전달된 목록은 무슨 일이 있어도 반환한다.
   * (sendTo/spawn의 "상한 초과는 정직한 거부" 계약 자체는 그대로 둔다.)
   */
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

module.exports = { Orchestrator, maxParallel, setConcurrencyDb };
