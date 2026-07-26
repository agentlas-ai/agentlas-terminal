"use strict";
/*
 * ui/renderer — 세션 이벤트를 Ui(터미널)로 그리는 유일한 곳.
 * 활성 세션 하나에만 attach된다. 백그라운드 세션 이벤트는 orchestrator의
 * notice로만 표면화된다(오르카 규칙: 화면은 한 세션, 나머지는 상태로).
 */

class Renderer {
  constructor(ui) {
    this.ui = ui;
    this.session = null;
    this._listener = null;
  }

  attach(session, { replay = true } = {}) {
    this.detach();
    this.session = session;
    if (replay) this._replayTail(session);
    this._listener = (ev) => this._render(ev);
    session.on("event", this._listener);
    if (session.isBusy()) this._beginChrome();
  }

  detach() {
    if (this.session && this._listener) this.session.removeListener("event", this._listener);
    if (this.session) this.ui.endTurn();
    this.session = null;
    this._listener = null;
  }

  _beginChrome() {
    this.ui.beginTurn({
      permissionLabel: this.session ? this.session.permission : "",
      status: this.session ? this.session.agent.slug : "",
    });
  }

  _replayTail(session) {
    const tail = session.eventsTail(120);
    if (!tail.length) return;
    this.ui.ensureNl();
    this.ui.rule(`${session.key || ""} ${session.agent.slug} · ${session.status}`);
    // 마지막 턴의 스트림 텍스트만 복원한다(도구 소음 제외) — 전환 시 맥락 파악용.
    let text = "";
    for (const ev of tail) {
      if (ev.type === "turn-start") text = "";
      else if (ev.type === "stream-delta") text += ev.text;
    }
    const lines = text.trim().split(/\r?\n/).slice(-12);
    for (const l of lines) this.ui.line("  " + l);
    if (session.lastError) this.ui.error(session.lastError);
  }

  _render(ev) {
    const ui = this.ui;
    switch (ev.type) {
      case "turn-start": this._beginChrome(); return;
      case "turn-end":
        ui.endTurn();
        if (!ev.ok && ev.error) ui.error(ev.error);
        return;
      case "status": ui.status(ev.text); return;
      case "warn": ui.warn(ev.text); return;
      case "error":
        // 사용자가 의도적으로 중단(kill)한 턴의 종료 에러(SIGTERM exit 등)는 소음 —
        // 실사용 테스트에서 확인된 UX 결함. 중단 안내는 REPL이 이미 출력했다.
        if (this.session && this.session.status === "killed") return;
        ui.error(ev.text);
        return;
      case "line": ui.line(ev.text); return;
      case "tool": ui.tool(ev.name, ev.summary); return;
      case "tool-result": ui.toolResult(ev.text, ev.ok); return;
      case "stream-start": ui.streamStart(); return;
      case "stream-delta": ui.streamDelta(ev.text); return;
      case "stream-end": ui.streamEnd(); return;
      case "task-tool": ui.applyTaskTool(ev.name, ev.input, ev.id); return;
      case "task-result": ui.applyTaskResult(ev.name, ev.result, ev.id); return;
      case "cost": ui.cost(ev.usage); return;
      case "queued": ui.line(ui.c.dim(`  ↳ queued for next turn: ${ev.text}`)); return;
      default: return;
    }
  }
}

module.exports = { Renderer };
