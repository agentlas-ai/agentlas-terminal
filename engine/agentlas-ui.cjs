"use strict";
/*
 * Agentlas terminal UI primitives — self-contained, zero-dependency (CJS).
 *
 * Electron-as-Node로 실행되므로 외부 컬러 라이브러리(chalk v5 ESM 등)에 의존하지 않는다.
 * 24-bit truecolor ANSI를 직접 쓰고, NO_COLOR / 비-TTY 환경에서는 평문으로 폴백한다.
 * 브랜드 팔레트는 보스턴테리어 paw 마크(크림슨) + agentlas-desktop-banner.svg(그린/틸 액센트)에서 가져왔다.
 */

const i18n = require("./agentlas-i18n.cjs");
const readline = require("node:readline");
const taskEvents = require("./agentlas-tasks.cjs");

const RESET = "\x1b[0m";

function colorEnabled() {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  // clig.dev: TERM=dumb 인 터미널(에디터 내장 셸, 일부 CI)은 ANSI를 렌더하지 못한다.
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true") return true;
  if (process.env.AGENTLAS_NO_COLOR === "1") return false;
  return !!process.stdout.isTTY;
}

// 브랜드 색 (R,G,B). banner.svg / paw mark 기준.
const BRAND = {
  paw: [214, 69, 58], // 크림슨 (보스턴테리어 발바닥)
  pawDim: [138, 45, 38],
  emerald: [110, 231, 183], // #6EE7B7
  green: [52, 211, 153], // #34D399
  lime: [217, 249, 157], // #D9F99D
  blue: [147, 197, 253], // #93C5FD
  amber: [251, 191, 36], // #FBBF24
  pink: [244, 114, 182], // #F472B6
  text: [229, 231, 235], // #E5E7EB
  dim: [107, 114, 128], // #6B7280
  faint: [75, 85, 99],
};

function makePalette(enabled) {
  const fg = (rgb) => (s) => (enabled ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}` : String(s));
  const sgr = (code) => (s) => (enabled ? `\x1b[${code}m${s}${RESET}` : String(s));
  return {
    paw: fg(BRAND.paw),
    pawDim: fg(BRAND.pawDim),
    emerald: fg(BRAND.emerald),
    green: fg(BRAND.green),
    lime: fg(BRAND.lime),
    blue: fg(BRAND.blue),
    amber: fg(BRAND.amber),
    pink: fg(BRAND.pink),
    text: fg(BRAND.text),
    dim: fg(BRAND.dim),
    faint: fg(BRAND.faint),
    bold: sgr("1"),
    italic: sgr("3"),
    underline: sgr("4"),
    inverse: sgr("7"),
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function cellWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20) return 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) ? 2 : 1;
}

// ANSI 시퀀스를 제거한 실제 terminal cell 폭 (CJK/emoji 포함).
function visibleWidth(s) {
  let width = 0;
  for (const ch of stripAnsi(s)) width += cellWidth(ch);
  return width;
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function oneLine(value) {
  return stripAnsi(String(value || ""))
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCells(value, max) {
  const text = String(value || "");
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  const room = Math.max(0, max - 1);
  for (const ch of text) {
    const cells = cellWidth(ch);
    if (width + cells > room) break;
    out += ch;
    width += cells;
  }
  return out + "…";
}

function compactHomePath(value) {
  const home = process.env.HOME || "";
  return home && value.startsWith(home + "/") ? "~/" + value.slice(home.length + 1) : value;
}

function redactCommandSecrets(value) {
  return value
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/g, "$1=••••")
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s]+/gi, "$1 ••••")
    // Some remote MCPs put a bearer-like credential in the URL path instead of a header.
    // Keep the provider/path useful while ensuring activity summaries never print the secret.
    .replace(/(https?:\/\/[^\s]+\/)(ocm_[A-Za-z0-9_-]{12,})\b/gi, "$1[redacted]")
    .replace(/\bocm_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]");
}

// Runtime JSON often contains an entire heredoc or command chain. The terminal should show
// what is being done, not reproduce a second debug console inside the conversation.
function compactToolArg(name, value, max = 120) {
  let text = redactCommandSecrets(oneLine(value));
  if (!text) return "";
  const tool = String(name || "").toLowerCase();
  if (/bash|shell|command|terminal/.test(tool)) {
    text = text.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/i, "");
    const steps = text.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
    const heredoc = steps[0] && steps[0].replace(/\s*<<['"]?[A-Za-z0-9_-]+['"]?.*$/i, " <<…");
    text = heredoc || text;
    if (steps.length > 1) text += `  ·  ${steps.length} steps`;
  } else if (/read|write|edit|patch|file|glob|grep|search/.test(tool)) {
    text = compactHomePath(text);
  }
  return truncateCells(text, Math.max(8, max));
}

function compactResult(text, ok, toolName, maxCells = 120) {
  const clean = stripAnsi(String(text || "")).replace(/\r/g, "").trim();
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  const count = lines.length;
  if (!ok) {
    if (!count) return { headline: "error", details: [] };
    const first = oneLine(lines[0]);
    const last = count > 1 ? oneLine(lines[count - 1]) : "";
    return {
      headline: truncateCells(first, maxCells),
      details: last && last !== first ? [truncateCells(last, Math.max(8, maxCells - 6))] : [],
    };
  }

  if (!count || (count === 1 && /^(?:done|ok|success)$/i.test(lines[0]))) {
    return { headline: "done", details: [] };
  }

  const signalPatterns = [
    /\b\d+\s+(?:passed|failed|skipped|tests?)\b/i,
    /\b(?:PASS|FAIL|SUCCESS|ERROR)\b/i,
    /\b(?:created|updated|written|wrote|saved|modified)\b/i,
    /\bexit(?:ed)?\s+(?:code\s+)?\d+\b/i,
  ];
  let signal = "";
  for (let i = lines.length - 1; i >= 0 && !signal; i--) {
    if (signalPatterns.some((pattern) => pattern.test(lines[i]))) signal = oneLine(lines[i]);
  }

  const tool = String(toolName || "").toLowerCase();
  if (signal) return { headline: truncateCells(signal, maxCells), details: count > 1 ? [`${count} output lines`] : [] };
  if (/read|glob|grep|search|list/.test(tool)) return { headline: `${count} line${count === 1 ? "" : "s"} read`, details: [] };
  if (/write|edit|patch/.test(tool)) return { headline: "updated", details: count > 1 ? [`${count} output lines`] : [] };
  if (count === 1 && visibleWidth(oneLine(lines[0])) <= maxCells) return { headline: oneLine(lines[0]), details: [] };
  return { headline: "done", details: [`${count} output lines`] };
}

class Ui {
  constructor(opts = {}) {
    this.enabled = opts.color != null ? opts.color : colorEnabled();
    this.c = makePalette(this.enabled);
    this.out = opts.stream || process.stdout;
    this.input = opts.input || process.stdin;
    this.lang = opts.lang || "en";
    this.t = (key, ...args) => i18n.t(this.lang, key, ...args);
    this._spinTimer = null;
    this._spinText = "";
    this._spinFrame = 0;
    this._spinStart = 0;
    this._turnStart = null; // set by beginTurn() so the spinner shows total-turn elapsed
    this._streaming = false;
    this._atLineStart = true;
    this._lastUsage = null; // last per-turn usage (for session /cost ledger)
    this._turnActions = 0;
    this._turnFailures = 0;
    this._lastTool = null;
    this._turnChrome = null;
    this._footerDrawn = false;
    this._footerDrawnRows = 0;
    this._footerDrawnWidths = [];
    this._footerViewportRows = 0;
    this._footerScrollBottom = 0;
    this._footerSuspended = false;
    this._resumeSpinnerAfterStream = false;
    this._streamKeepsFooter = false;
    this._turnTasks = [];
    this._tasksExpanded = false;
    this._turnKeyHandler = null;
    this._turnInputWasRaw = false;
    this._turnResizeHandler = null;
    this._turnStatusShown = false;
  }

  write(s) {
    this.out.write(s);
    if (s.length) this._atLineStart = s.endsWith("\n");
  }
  line(s = "") {
    if (!this._turnChrome) this.stopSpinner();
    this.write(s + "\n");
  }
  // 줄 시작이 아니면 개행을 보장 (스트리밍/스피너 뒤 깔끔한 블록 시작용).
  ensureNl() {
    if (!this._atLineStart) this.write("\n");
  }

  rule(label) {
    const cols = (this.out.columns || 80);
    if (label) {
      const text = ` ${label} `;
      const dashes = Math.max(0, cols - visibleWidth(text) - 1);
      this.line(this.c.faint("─") + this.c.dim(text) + this.c.faint("─".repeat(dashes)));
    } else {
      this.line(this.c.faint("─".repeat(Math.max(0, cols - 1))));
    }
  }

  _footerLines() {
    if (!this._turnChrome) return [];
    const cols = Math.max(30, this.out.columns || 80);
    const width = cols - 1;
    const rule = this.c.faint("─".repeat(width));
    const prompt = this.c.text("› ");
    const start = this._turnStart || this._spinStart || Date.now();
    const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const frame = SPINNER_FRAMES[this._spinFrame % SPINNER_FRAMES.length];
    const status = this._spinText || (this.lang === "ko" ? "작업 중" : "Working");
    const stop = this.lang === "ko" ? "ctrl-c로 중단" : "ctrl-c to interrupt";
    const permission = this._turnChrome.permissionLabel || "";
    const contextBits = [permission, this._turnChrome.status].filter(Boolean);
    const meta = `(${secs}s · ${stop})${contextBits.length ? `  ·  ${contextBits.join("  ·  ")}` : ""}`;
    const available = Math.max(12, width - visibleWidth(frame + " "));
    const plain = truncateCells(`${status}  ${meta}`, available);
    const statusLine = this.c.emerald(frame + " ") + this.c.text(plain);
    const taskLines = [];
    if (this._turnTasks.length || this._tasksExpanded) {
      const completed = this._turnTasks.filter((task) => task.status === "completed").length;
      const toggle = this._tasksExpanded ? this.t("tasks.hide") : this.t("tasks.show");
      taskLines.push(this.c.bold(this.c.text(`${this.t("tasks.title")} ${completed}/${this._turnTasks.length}`)) + this.c.faint(`  ·  ${toggle}`));
      if (this._tasksExpanded) {
        const visible = this._turnTasks.slice(-8);
        for (let index = 0; index < visible.length; index++) {
          const task = visible[index];
          const last = index === visible.length - 1;
          const branch = last ? "└" : "├";
          const icon = task.status === "completed" ? "✓" : task.status === "failed" ? "!" : task.status === "in_progress" ? "■" : "□";
          const statusKey = task.status === "completed"
            ? "tasks.done"
            : task.status === "failed"
              ? "tasks.failed"
              : task.status === "in_progress"
                ? "tasks.progress"
                : "tasks.pending";
          const labelRoom = Math.max(8, width - visibleWidth(`${branch} ${icon}   ${this.t(statusKey)}`) - 4);
          const label = truncateCells(task.label, labelRoom);
          const paint = task.status === "completed" ? this.c.green : task.status === "failed" ? this.c.paw : task.status === "in_progress" ? this.c.emerald : this.c.dim;
          taskLines.push(this.c.faint(`${branch} `) + paint(`${icon} ${label}`) + this.c.faint(`  ${this.t(statusKey)}`));
        }
      }
    }
    // 턴 중에도 사용량 표시줄 유지 (chrome.usage: 문자열 또는 라이브 getter)
    const usageSrc = this._turnChrome.usage;
    const usageText = typeof usageSrc === "function" ? usageSrc() : usageSrc;
    const usageLine = usageText ? this.c.faint(truncateCells(String(usageText), width)) : null;
    return [...taskLines, rule, prompt, rule, statusLine, ...(usageLine ? [usageLine] : [])];
  }

  _eraseFooter() {
    this._footerDrawn = false;
    this._footerDrawnRows = 0;
    this._footerDrawnWidths = [];
    this._footerViewportRows = 0;
  }

  _setFooterScrollRegion(footerRows) {
    void footerRows;
  }

  _resetFooterScrollRegion() {
    this._footerScrollBottom = 0;
  }

  _drawFooter() {
    // Deliberately append-only during active turns. Multi-row live footers are
    // not scrollback-safe across tmux/macOS resize reflow: saved cursors,
    // relative erasure, absolute rows, and scroll regions can all either leave
    // ghosts or discard real output. The composer returns after the turn.
  }

  _redrawFooter() {
    // Active-turn output is append-only; resize requires no repaint.
  }

  // ── 스피너 (stderr가 아닌 메인 스트림에, 같은 줄을 갱신) ──
  startSpinner(text) {
    if (this._turnChrome) {
      this._spinText = text || this._spinText || "";
      if (!this._turnStatusShown && this._spinText) {
        this._turnStatusShown = true;
        this._spinStart = Date.now();
        const stop = this.lang === "ko" ? "Ctrl-C로 중단" : "Ctrl-C to interrupt";
        this.info(`${this._spinText}  ·  ${stop}`);
      }
      return;
    }
    if (!this.enabled || !this.out.isTTY) {
      // 폴백: 한 번만 상태 출력
      if (text && text !== this._spinText) this.line(this.c.dim("  " + text));
      this._spinText = text || "";
      return;
    }
    this._spinText = text || "";
    if (this._spinTimer) return;
    this._spinStart = Date.now();
    const tick = () => {
      const frame = SPINNER_FRAMES[this._spinFrame % SPINNER_FRAMES.length];
      this._spinFrame++;
      const start = this._turnStart || this._spinStart;
      const secs = Math.floor((Date.now() - start) / 1000);
      // Claude Code 스타일 라이브 메타: 경과초 + 중단 힌트 (1초 이상부터)
      const meta = secs >= 1 ? this.c.faint(`  (${secs}s · ${this.t ? this.t("spinnerStop") : "ctrl-c to stop"})`) : "";
      this.out.write("\r\x1b[2K" + this.c.emerald(frame) + " " + this.c.dim(this._spinText) + meta);
      this._atLineStart = false;
    };
    tick();
    this._spinTimer = setInterval(tick, 120);
    if (this._spinTimer.unref) this._spinTimer.unref();
  }

  // 턴 시작/끝 — 스피너가 (툴 사이에 멈췄다 다시 떠도) 총 턴 경과시간을 보여주도록.
  beginTurn(chrome) {
    this._turnStart = Date.now();
    this._turnActions = 0;
    this._turnFailures = 0;
    this._lastTool = null;
    this._turnTasks = [];
    this._tasksExpanded = false;
    this._spinText = chrome && typeof chrome === "object" && typeof chrome.activity === "string"
      ? chrome.activity
      : "";
    this._spinFrame = 0;
    this._turnStatusShown = false;
    if (chrome && this.out.isTTY) {
      this._turnChrome = typeof chrome === "string" ? { status: chrome } : { ...chrome };
      this._attachTurnKeys();
    }
  }
  endTurn() {
    this.stopSpinner(true);
    this._eraseFooter();
    this._resetFooterScrollRegion();
    this._detachTurnKeys();
    this._detachTurnResize();
    this._turnChrome = null;
    this._footerSuspended = false;
    this._turnStart = null;
    this._turnTasks = [];
    this._turnStatusShown = false;
  }

  _attachTurnKeys() {
    const input = this.input;
    if (this._turnKeyHandler || !input || !input.isTTY || !this.out.isTTY) return;
    this._turnInputWasRaw = !!input.isRaw;
    try { if (input.setRawMode) input.setRawMode(true); } catch { /* fallback to SIGINT/canonical input */ }
    readline.emitKeypressEvents(input);
    const handler = (_str, key = {}) => {
      if (key.ctrl && String(key.name || "").toLowerCase() === "t") {
        this._tasksExpanded = !this._tasksExpanded;
        this._printTaskSnapshot();
        return;
      }
      if (key.ctrl && String(key.name || "").toLowerCase() === "c" && this._turnChrome?.onInterrupt) {
        this._turnChrome.onInterrupt();
      }
    };
    this._turnKeyHandler = handler;
    input.prependListener("keypress", handler);
    try { input.resume?.(); } catch { /* ignore */ }
  }

  _detachTurnKeys() {
    const input = this.input;
    if (this._turnKeyHandler && input) input.removeListener("keypress", this._turnKeyHandler);
    this._turnKeyHandler = null;
    try { if (input?.setRawMode) input.setRawMode(this._turnInputWasRaw); } catch { /* ignore */ }
  }

  _attachTurnResize() {
    const out = this.out;
    if (this._turnResizeHandler || !out || typeof out.on !== "function") return;
    this._turnResizeHandler = () => this._redrawFooter();
    out.on("resize", this._turnResizeHandler);
  }

  _detachTurnResize() {
    const out = this.out;
    if (this._turnResizeHandler && out && typeof out.removeListener === "function") {
      out.removeListener("resize", this._turnResizeHandler);
    }
    this._turnResizeHandler = null;
  }

  _printTaskSnapshot() {
    if (!this._tasksExpanded) {
      this.info(this.lang === "ko" ? "작업 상세를 숨겼습니다." : "Task details hidden.");
      return;
    }
    const completed = this._turnTasks.filter((task) => task.status === "completed").length;
    this.line("");
    this.info(`${this.t("tasks.title")} ${completed}/${this._turnTasks.length}`);
    for (const task of this._turnTasks.slice(-8)) {
      const icon = task.status === "completed" ? "✓" : task.status === "failed" ? "!" : task.status === "in_progress" ? "■" : "□";
      const statusKey = task.status === "completed"
        ? "tasks.done"
        : task.status === "failed"
          ? "tasks.failed"
          : task.status === "in_progress"
            ? "tasks.progress"
            : "tasks.pending";
      this.info(`${icon} ${task.label}  ·  ${this.t(statusKey)}`);
    }
  }

  replaceTasks(payload, source) {
    const normalized = taskEvents.normalizeTaskList(payload, source);
    if (!normalized.length && !Array.isArray(payload) && !Array.isArray(payload?.todos) && !Array.isArray(payload?.items) && !Array.isArray(payload?.tasks)) return;
    this._turnTasks = normalized;
  }

  applyTaskTool(name, payload, toolId) {
    const next = taskEvents.applyTaskTool(this._turnTasks, name, payload, toolId);
    if (next === this._turnTasks) return;
    this._turnTasks = next;
  }

  applyTaskResult(name, payload, toolId) {
    const next = taskEvents.applyTaskResult(this._turnTasks, name, payload, toolId);
    if (next === this._turnTasks) return;
    this._turnTasks = next;
  }
  updateSpinner(text) {
    this._spinText = text || "";
    if (!this._spinTimer && this.out.isTTY && (this.enabled || this._turnChrome)) this.startSpinner(text);
  }
  stopSpinner(force = false) {
    if (this._turnChrome && !force) return;
    if (this._spinTimer) {
      clearInterval(this._spinTimer);
      this._spinTimer = null;
      if (!this._turnChrome) {
        this.out.write("\r\x1b[2K");
        this._atLineStart = true;
      }
    }
  }

  // ── 사용자/에이전트 라벨 ──
  promptLabel(name) {
    return this.c.paw("▌") + this.c.emerald(" › ");
  }
  agentHeader(name) {
    this.ensureNl();
    this.line("");
    this.line(this.c.paw("> ") + this.c.bold(this.c.text(name)));
  }

  // ── 스트리밍 텍스트 ──
  streamStart(keepFooter = false) {
    if (this._turnChrome && keepFooter) {
      this._streamKeepsFooter = true;
      this.ensureNl();
      this._streaming = true;
      return;
    }
    this._resumeSpinnerAfterStream = !!this._spinTimer;
    this.stopSpinner(true);
    if (this._turnChrome) {
      this._footerSuspended = true;
    }
    this.ensureNl();
    this._streaming = true;
  }
  streamDelta(text) {
    if (!text) return;
    this.stopSpinner();
    this.write(this.c.text(text));
    this._streaming = true;
  }
  streamEnd() {
    if (this._streaming) {
      this.ensureNl();
      this._streaming = false;
    }
    if (this._streamKeepsFooter) {
      this._streamKeepsFooter = false;
      return;
    }
    if (this._turnChrome) {
      this._footerSuspended = false;
      if (this._resumeSpinnerAfterStream) this.startSpinner(this._spinText);
    }
    this._resumeSpinnerAfterStream = false;
  }

  // ── 툴 호출/결과 라인 (claude/codex 스타일) ──
  tool(name, arg) {
    this.ensureNl();
    this._turnActions += 1;
    this._lastTool = { name: String(name || "tool"), arg: String(arg || "") };
    const columns = Math.max(24, this.out.columns || 100);
    const displayName = truncateCells(String(name || "tool"), Math.max(8, Math.min(28, columns - 12)));
    const headWidth = visibleWidth(`● ${displayName}  `);
    const room = Math.max(8, Math.min(140, columns - headWidth - 1));
    const summary = compactToolArg(name, arg, room);
    const head = this.c.green("● ") + this.c.bold(this.c.text(displayName));
    this.line(summary ? head + "  " + this.c.dim(summary) : head);
    this._spinText = this.lang === "ko" ? `${name} 실행 중` : `Running ${name}`;
  }
  toolResult(text, ok = true, options = {}) {
    if (!ok) this._turnFailures += 1;
    if (options.verbose) {
      const body = truncate(stripAnsi(String(text || "")).trim(), options.maxChars || 4_000);
      const lines = body ? body.split("\n") : [ok ? "done" : "error"];
      const marker = ok ? this.c.green("  └ ") : this.c.paw("  └ ");
      for (let index = 0; index < lines.length; index++) {
        this.line((index === 0 ? marker : "    ") + this.c.dim(lines[index]));
      }
      return;
    }
    const marker = ok ? this.c.green("  └ ✓ ") : this.c.paw("  └ ✗ ");
    const columns = Math.max(24, this.out.columns || 100);
    const summary = compactResult(
      text,
      ok,
      this._lastTool && this._lastTool.name,
      Math.max(8, columns - visibleWidth(stripAnsi(marker)) - 1),
    );
    this.line(marker + this.c.dim(summary.headline));
    for (const detail of summary.details) this.line(this.c.faint("      " + detail));
    const count = this._turnActions;
    this._spinText = this._turnFailures
      ? (this.lang === "ko" ? `${count}개 작업 · ${this._turnFailures}개 확인 필요` : `${count} actions · ${this._turnFailures} need attention`)
      : (this.lang === "ko" ? `${count}개 작업 완료 · 계속 진행 중` : `${count} action${count === 1 ? "" : "s"} complete · working`);
  }

  status(msg) {
    this.updateSpinner(msg);
  }
  _message(prefix, prefixPaint, messagePaint, msg) {
    const { wrapWidth } = require("./agentlas-composer.cjs");
    const columns = Math.max(8, Number(this.out.columns) || 80);
    const prefixWidth = visibleWidth(prefix);
    const lines = wrapWidth(stripAnsi(String(msg ?? "")), Math.max(2, columns - prefixWidth));
    lines.forEach((line, index) => {
      const lead = index === 0 ? prefixPaint(prefix) : " ".repeat(prefixWidth);
      this.line(lead + messagePaint(line));
    });
  }
  info(msg) {
    this._message("  ", this.c.dim, this.c.dim, msg);
  }
  ok(msg) {
    this.stopSpinner();
    this._message("✓ ", this.c.green, this.c.text, msg);
  }
  warn(msg) {
    this.stopSpinner();
    this._message("! ", this.c.amber, this.c.text, msg);
  }
  error(msg) {
    this.stopSpinner();
    // Last-resort presentation boundary for legacy/direct commands. Raw
    // provider text, stack messages, paths and codes must never become UI.
    // REPL/session paths route the private evidence to the controller before
    // reaching this boundary; direct commands get a neutral recovery state.
    void msg;
    this._message(
      "◆ ",
      this.c.amber,
      this.c.text,
      this.lang === "ko"
        ? "One이 상태를 확인하고 복구하고 있습니다."
        : "One is checking and recovering this operation.",
    );
  }

  // 최종 텍스트(비스트리밍 경로)에 가벼운 마크다운 강조 적용 후 출력.
  markdown(text) {
    this.stopSpinner();
    this.ensureNl();
    for (const raw of String(text).split("\n")) {
      this.line(this.renderInline(raw));
    }
  }
  renderInline(line) {
    if (!this.enabled) return line;
    let s = line;
    // 헤딩
    const h = s.match(/^(#{1,6})\s+(.*)$/);
    if (h) return this.c.bold(this.c.emerald(h[2]));
    // 인라인 코드 `x`
    s = s.replace(/`([^`]+)`/g, (_m, g) => this.c.amber(g));
    // 굵게 **x**
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, g) => this.c.bold(g));
    // 불릿
    s = s.replace(/^(\s*)([-*])\s+/, (_m, sp) => sp + this.c.emerald("• "));
    return this.c.text(s);
  }

  cost(usage) {
    this._lastUsage = usage || null;
    if (!usage) return;
    // During an active turn, usage remains available to the composer/session
    // ledger. Printing it into the transcript would look like model output.
    if (this._turnChrome) {
      return;
    }
    const bits = [];
    if (usage.input_tokens != null || usage.output_tokens != null) {
      bits.push(`${usage.input_tokens ?? "?"}→${usage.output_tokens ?? "?"} tok`);
    }
    // 달러 비용은 표시하지 않는다 — 토큰 수만 (사용자 결정 2026-07-09).
    if (usage.duration_ms != null) bits.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
    if (bits.length) this.line(this.c.faint("  " + bits.join("  ·  ")));
  }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

module.exports = { Ui, colorEnabled, BRAND, stripAnsi, visibleWidth, truncate, SPINNER_FRAMES };
