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

      /* ── 펜스 영수증 (apply-fences.cjs) ──────────────────────────────────
       * WHY: 펜스 블록은 cleanText 에서 통째로 제거되므로, 이 case 들이 없으면
       * default 로 떨어져 화면에 아무 흔적도 남지 않는다. 그 결과 이미 enabled
       * 상태로 등록된 반복 자동화(데몬/데스크탑 스케줄러가 실제로 실행한다)나
       * 스폰된 위임 세션이 사용자 모르게 생기고, 에이전트의 확인 질문(ask)은
       * 본문에서 삭제된 채 영영 묻지 않는다. 부작용에는 반드시 영수증이 따른다 —
       * 새 펜스 이벤트를 apply-fences 에 추가하면 여기에도 case 를 추가할 것. */
      case "ask": {
        const p = ev.payload || {};
        ui.ensureNl();
        if (p.header) ui.line(ui.c.dim(`  ${p.header}`));
        ui.warn(p.question || "(question)");
        (p.options || []).forEach((o, i) => {
          const desc = o && o.description ? ` — ${o.description}` : "";
          ui.line(ui.c.dim(`    ${i + 1}. ${(o && o.label) || ""}${desc}`));
        });
        ui.line(ui.c.dim(`    ↳ 답을 그대로 입력하세요${p.multiSelect ? " (복수 선택 가능)" : ""}`));
        return;
      }
      case "automation-registered": {
        const steps = ev.stepsIgnored ? ` · steps ${ev.stepsIgnored}개 무시(터미널은 그래프 합성 없음)` : "";
        ui.ok(`automation registered: ${ev.name} · ${ev.schedule} · next ${ev.nextRunAt}${steps}`);
        // 취소 경로를 함께 제시한다. 실제 서브커맨드는 off (commands/automation.cjs:125).
        ui.line(ui.c.dim(`    ↳ agentlas automation list  ·  agentlas automation off ${String(ev.id || "").slice(0, 8)}`));
        return;
      }
      case "automation-refused": ui.warn(`automation refused: ${ev.name} — ${ev.reason}`); return;
      case "delegate-spawned":
        ui.ok(`delegate spawned: ${ev.target} → ${ev.key}`);
        return;
      case "delegate-refused": ui.warn(`delegate refused: ${ev.target} — ${ev.reason}`); return;
      case "fence-error": ui.error(`fence: ${ev.text}`); return;
      case "memory-curated":
        ui.line(ui.c.dim(`  ↳ memory: ${ev.written}/${ev.candidates} written (permission: ${ev.permission})`));
        return;

      default: return;
    }
  }
}

module.exports = { Renderer };
