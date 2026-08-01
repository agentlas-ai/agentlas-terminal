"use strict";
/*
 * sessions/sink — native-host의 ui 인터페이스를 "이벤트"로 변환하는 싱크.
 *
 * 세션은 터미널에 직접 그리지 않는다. 모든 런타임 출력은 타입드 이벤트로
 * 세션 링버퍼에 쌓이고, 렌더러(REPL)가 "활성 세션"의 이벤트만 실시간으로
 * 그린다 — 이것이 오르카식 멀티세션의 기반이다(백그라운드 세션 전환 시
 * 버퍼 테일 재생 + 라이브 구독).
 *
 * 구현 인터페이스(native-host가 호출): status, warn, error, line, tool,
 * toolResult, streamStart, streamDelta, streamEnd, applyTaskTool,
 * applyTaskResult, c(팔레트 — 렌더러가 색을 정하므로 여기선 무색 passthrough), t(i18n).
 */
const i18n = require("../agentlas-i18n.cjs");

const NOOP_PALETTE = new Proxy({}, { get: () => (s) => String(s) });

class EventSink {
  constructor({ lang = "en", onEvent, onPrivateEvidence } = {}) {
    this.lang = lang;
    this.t = (key, ...args) => i18n.t(this.lang, key, ...args);
    this.c = NOOP_PALETTE;
    this._onEvent = onEvent || (() => {});
    this._onPrivateEvidence = onPrivateEvidence || (() => {});
    this._streamOpen = false;
  }

  _emit(type, data) {
    this._onEvent({ type, at: Date.now(), ...data });
  }

  status(text) { this._emit("status", { text: String(text || "") }); }
  warn(text) { this._emit("warn", { text: String(text || "") }); }
  // Runtime/provider failures are recovery evidence, never presentation copy.
  // Session owns the recovery loop and may give this evidence to the controller;
  // Renderer must never receive it first.
  error(text) { this._onPrivateEvidence(String(text || "")); }
  line(text) { this._emit("line", { text: String(text || "") }); }
  tool(name, summary) { this._emit("tool", { name: String(name || "tool"), summary: String(summary || "") }); }
  toolResult(text, ok) {
    if (ok === false) {
      this._onPrivateEvidence(String(text || ""));
      return;
    }
    this._emit("tool-result", { text: String(text || ""), ok: true });
  }
  streamStart() {
    if (!this._streamOpen) { this._streamOpen = true; this._emit("stream-start", {}); }
  }
  streamDelta(text) {
    if (!this._streamOpen) this.streamStart();
    this._emit("stream-delta", { text: String(text || "") });
  }
  streamEnd() {
    if (this._streamOpen) { this._streamOpen = false; this._emit("stream-end", {}); }
  }
  applyTaskTool(name, input, id) { this._emit("task-tool", { name, input, id }); }
  applyTaskResult(name, result, id) { this._emit("task-result", { name, result, id }); }
  info(text) { this._emit("line", { text: String(text || "") }); }
  cost(usage) { this._emit("cost", { usage }); }
  stopSpinner() { /* 스피너는 렌더러 소관 — 이벤트 불필요 */ }
}

module.exports = { EventSink };
