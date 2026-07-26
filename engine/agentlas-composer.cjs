"use strict";
/*
 * agentlas-composer: a raw-mode bottom input box (Claude Code / Hermes style).
 *
 *   ───────────────────────────────────────────────
 *   › your message
 *   ───────────────────────────────────────────────
 *   ◆ read + write · codex · Agent · / for commands
 *     (slash suggestions render here while typing /…)
 *
 * Single-line field with horizontal scroll (fixed 3-line box → flicker-free clear/redraw).
 * Full line editing, persisted history, Tab/path/slash completion, slash palette.
 * Zero external deps. Caller falls back to readline when stdin/stdout is not a TTY.
 */
const readline = require("node:readline");
const i18n = require("./agentlas-i18n.cjs");
const permissions = require("./agentlas-permissions.cjs");
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MARK_RE = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

// East-Asian width: CJK / Hangul / Kana / fullwidth glyphs occupy 2 terminal cells.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji / pictographs
  );
}
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20) return 0;
  if (
    cp === 0x200d || // zero-width joiner
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // emoji skin tones
    MARK_RE.test(ch)
  ) return 0;
  return isWide(cp) ? 2 : 1;
}
function graphemeSegments(value) {
  return [...GRAPHEME_SEGMENTER.segment(String(value || ""))];
}
function graphemeWidth(segment) {
  const text = String(segment || "");
  if (
    EXTENDED_PICTOGRAPHIC_RE.test(text) ||
    /[\u{1f1e6}-\u{1f1ff}]/u.test(text) ||
    text.includes("\u20e3")
  ) return 2;
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}
function previousGraphemeIndex(value, index) {
  const text = String(value || "");
  const cursor = Math.max(0, Math.min(Number(index) || 0, text.length));
  let previous = 0;
  for (const entry of GRAPHEME_SEGMENTER.segment(text)) {
    const end = entry.index + entry.segment.length;
    if (cursor <= entry.index) return previous;
    if (cursor <= end) return entry.index;
    previous = entry.index;
  }
  return previous;
}
function nextGraphemeIndex(value, index) {
  const text = String(value || "");
  const cursor = Math.max(0, Math.min(Number(index) || 0, text.length));
  for (const entry of GRAPHEME_SEGMENTER.segment(text)) {
    const end = entry.index + entry.segment.length;
    if (cursor < end) return end;
  }
  return text.length;
}
function visWidth(s) {
  const clean = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const entry of GRAPHEME_SEGMENTER.segment(clean)) n += graphemeWidth(entry.segment);
  return n;
}

function truncateWidth(value, max) {
  const text = String(value || "");
  if (visWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  const room = Math.max(0, max - 1);
  for (const entry of GRAPHEME_SEGMENTER.segment(text)) {
    const cells = graphemeWidth(entry.segment);
    if (width + cells > room) break;
    out += entry.segment;
    width += cells;
  }
  return out + "…";
}

function splitWidth(value, max) {
  const text = String(value || "");
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  const lines = [];
  let line = "";
  let width = 0;
  for (const entry of GRAPHEME_SEGMENTER.segment(text)) {
    const cells = graphemeWidth(entry.segment);
    if (line && width + cells > limit) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += entry.segment;
    width += cells;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function wrapWidth(value, max) {
  const limit = Math.max(2, Math.floor(Number(max) || 2));
  const lines = [];
  const pushWord = (word, state) => {
    if (!word) return;
    const cells = visWidth(word);
    if (state.line && state.width + 1 + cells <= limit) {
      state.line += " " + word;
      state.width += 1 + cells;
      return;
    }
    if (state.line) {
      lines.push(state.line);
      state.line = "";
      state.width = 0;
    }
    if (cells <= limit) {
      state.line = word;
      state.width = cells;
      return;
    }
    let chunk = "";
    let chunkWidth = 0;
    for (const entry of GRAPHEME_SEGMENTER.segment(word)) {
      const width = graphemeWidth(entry.segment);
      if (chunk && chunkWidth + width > limit) {
        lines.push(chunk);
        chunk = "";
        chunkWidth = 0;
      }
      chunk += entry.segment;
      chunkWidth += width;
    }
    state.line = chunk;
    state.width = chunkWidth;
  };
  const paragraphs = String(value || "").split(/\r?\n/);
  paragraphs.forEach((paragraph) => {
    const state = { line: "", width: 0 };
    for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) pushWord(word, state);
    if (state.line) lines.push(state.line);
    else if (!paragraph.trim()) lines.push("");
  });
  return lines.length ? lines : [""];
}

function identityPalette() {
  const id = (value) => String(value);
  return { faint: id, emerald: id, text: id, paw: id, amber: id, blue: id, dim: id, inverse: id };
}

function permissionPresentation(ctx, c) {
  const permission = permissions.normalize(ctx.permission, "write");
  const fallback = permissions.copy(permission, ctx.lang || "en").label;
  const label = ctx.permissionLabel || fallback;
  if (permission === "full") return c.paw("▶▶ " + label);
  if (permission === "read") return c.blue("◇ " + label);
  return c.amber("◆ " + label);
}

// Pure frame builder so layout can be regression-tested without taking over a real TTY.
function buildComposerFrame(state, ctx = {}, palette, width = 80) {
  const c = palette || identityPalette();
  const w = Math.max(29, width);
  const fieldW = Math.max(8, w - 2);

  // horizontal scroll by visual width — keep the cursor visible (CJK-safe)
  let start = Math.min(state.scroll, state.cur);
  while (start < state.cur && visWidth(state.buf.slice(start, state.cur)) > fieldW - 2) {
    start = nextGraphemeIndex(state.buf, start);
  }
  state.scroll = start;

  let shown = "";
  let shownWidth = 0;
  for (const entry of GRAPHEME_SEGMENTER.segment(state.buf.slice(start))) {
    const cw = graphemeWidth(entry.segment);
    if (shownWidth + cw > fieldW - 2) break;
    shown += entry.segment;
    shownWidth += cw;
  }

  const prefix = (ctx.glyph || "›") + " ";
  const top = c.faint("─".repeat(w));
  const mid = c.text(prefix) + c.text(shown);
  const bot = c.faint("─".repeat(w));
  const lines = [top, mid, bot];
  if (ctx.status || ctx.permission) {
    const permission = permissions.normalize(ctx.permission, "write");
    const fallback = permissions.copy(permission, ctx.lang || "en").label;
    const permissionLabel = ctx.permissionLabel || fallback;
    const permissionText = (permission === "full" ? "▶▶ " : permission === "read" ? "◇ " : "◆ ") + permissionLabel;
    const available = Math.max(0, w - visWidth(permissionText) - 5);
    const rest = ctx.status && available > 0 ? c.faint("  ·  " + truncateWidth(ctx.status, available)) : "";
    lines.push(permissionPresentation(ctx, c) + rest);
  }
  // 연결 LLM 세션 사용량 상시 표시줄 — 입력박스 바로 아래에 항상 유지된다.
  const usageText = typeof ctx.usage === "function" ? ctx.usage() : ctx.usage;
  if (usageText) lines.push(c.faint(truncateWidth(String(usageText), w)));
  if (state.notice) lines.push(c.faint(truncateWidth(String(state.notice), w)));
  if (ctx.confirmation) {
    const prefix = ctx.confirmationTone === "danger" ? "! " : "✓ ";
    const paint = ctx.confirmationTone === "danger" && c.paw ? c.paw : c.green || c.emerald || ((value) => value);
    lines.push(paint(truncateWidth(prefix + ctx.confirmation, w)));
  }

  const rows = state.suggest || [];
  const terminalRows = Math.max(5, Number(ctx.rows) || 24);
  const maxSuggestions = Math.min(8, Math.max(0, terminalRows - lines.length - 1));
  const selected = Math.max(0, Math.min(Number(state.suggestSel) || 0, Math.max(0, rows.length - 1)));
  const startRow = Math.min(
    Math.max(0, selected - maxSuggestions + 1),
    Math.max(0, rows.length - maxSuggestions),
  );
  rows.slice(startRow, startRow + maxSuggestions).forEach((row, offset) => {
    const index = startRow + offset;
    const cmd = String(row.command || "").padEnd(16);
    const desc = String(row.description || "");
    const descRoom = Math.max(0, w - visWidth(" " + cmd + " "));
    const clippedDesc = truncateWidth(desc, descRoom);
    const label = " " + cmd + " " + clippedDesc;
    lines.push(index === state.suggestSel ? c.inverse(label) : " " + c.blue(cmd) + " " + c.dim(clippedDesc));
  });
  if (rows.length && lines.length < terminalRows) {
    lines.push(c.faint("  " + i18n.t(ctx.lang || "en", "palette.controls")));
  }

  return { lines, curCol: visWidth(prefix) + visWidth(state.buf.slice(start, state.cur)) };
}

function createComposer(opts) {
  const out = opts.stream || process.stdout;
  const inp = opts.input || process.stdin;
  const ui = opts.ui;
  const c = ui.c;
  const loadHistory = opts.loadHistory || (() => []);
  const saveHistory = opts.saveHistory || (() => {});
  const getHistoryScope = opts.getHistoryScope || (() => "");
  let loadedHistoryScope = String(getHistoryScope() || "");
  let history = (loadHistory() || []).filter((x) => typeof x === "string"); // index 0 = most recent
  let idleExitArmedUntil = 0;

  function cols() {
    return Math.max(30, out.columns || process.stdout.columns || 80);
  }
  function boxWidth() {
    return Math.min(cols() - 1, 120);
  }

  // Build the rendered block (array of lines) + the cursor target column on the input line.
  function frame(state, ctx) {
    return buildComposerFrame(
      state,
      { ...ctx, rows: out.rows || process.stdout.rows || 24 },
      c,
      boxWidth(),
    );
  }

  function render(state, ctx) {
    const f = frame(state, ctx);
    let seq = "";
    if (state.drawn > 0) seq += "\r\x1b[1A\x1b[0J"; // from input line: col0, up to top border, clear down
    seq += f.lines.join("\r\n");
    const up = f.lines.length - 1 - 1; // from last line up to the input line (index 1)
    if (up > 0) seq += "\x1b[" + up + "A";
    seq += "\r";
    if (f.curCol > 0) seq += "\x1b[" + f.curCol + "C";
    out.write(seq);
    state.drawn = f.lines.length;
  }

  function clearBox(state) {
    if (state.drawn > 0) {
      out.write("\r\x1b[1A\x1b[0J");
      state.drawn = 0;
    }
  }

  function read(ctx) {
    ctx = ctx || {};
    const nextHistoryScope = String(getHistoryScope() || "");
    if (nextHistoryScope !== loadedHistoryScope) {
      history = (loadHistory() || []).filter((x) => typeof x === "string");
      loadedHistoryScope = nextHistoryScope;
    }
    return new Promise((resolve) => {
      const state = { buf: "", cur: 0, scroll: 0, drawn: 0, suggest: [], suggestSel: 0, hist: -1, stash: "", dismissed: null, notice: null };
      let scheduledDraw = null;

      function refreshSuggest() {
        if (ctx.suggest && state.buf !== state.dismissed) {
          state.suggest = ctx.suggest(state.buf) || [];
        } else {
          state.suggest = [];
        }
        if (state.suggestSel >= state.suggest.length) state.suggestSel = 0;
      }
      function draw() {
        if (scheduledDraw) {
          clearImmediate(scheduledDraw);
          scheduledDraw = null;
        }
        refreshSuggest();
        render(state, ctx);
      }
      function drawSoon() {
        if (scheduledDraw) return;
        scheduledDraw = setImmediate(() => {
          scheduledDraw = null;
          refreshSuggest();
          render(state, ctx);
        });
      }

      const wasRaw = !!inp.isRaw;
      try { if (inp.setRawMode) inp.setRawMode(true); } catch { /* ignore */ }
      readline.emitKeypressEvents(inp);
      inp.resume();

      function done(result) {
        if (scheduledDraw) {
          clearImmediate(scheduledDraw);
          scheduledDraw = null;
        }
        if (typeof out.removeListener === "function") out.removeListener("resize", drawSoon);
        inp.removeListener("keypress", onKey);
        try { if (inp.setRawMode) inp.setRawMode(wasRaw); } catch { /* ignore */ }
        resolve(result);
      }
      function setBuf(s, cur, deferDraw = false) {
        state.buf = s;
        state.cur = cur == null ? s.length : Math.max(0, Math.min(cur, s.length));
        state.dismissed = null;
        if (deferDraw) drawSoon();
        else draw();
      }
      function submit() {
        const value = state.buf;
        clearBox(state);
        out.write(c.paw("▌") + c.emerald(" › ") + c.text(value) + "\r\n");
        if (value.trim()) {
          history = history.filter((h) => h !== value);
          history.unshift(value);
          saveHistory(history);
        }
        done({ value });
      }

      function onKey(str, key) {
        key = key || {};
        const name = key.name;
        const shiftTab = name === "tab" && key.shift;
        // Node's keypress decoder keeps a lone Escape open briefly in case it
        // starts a longer sequence. If Ctrl-C arrives in that window, the
        // event can be reported as meta-C with sequence ESC+ETX and
        // `key.ctrl === false`. ETX still means cancel; never leave the prior
        // buffer armed for the next submitted command.
        const keySequence = String(key.sequence ?? str ?? "");
        const ctrlC = (key.ctrl && name === "c") || keySequence.includes("\x03");
        if (!ctrlC) {
          state.notice = null;
          idleExitArmedUntil = 0;
        }

        if (!shiftTab && ctx.onPermissionCycleCancel) {
          const hadConfirmation = Boolean(ctx.confirmation);
          const next = ctx.onPermissionCycleCancel();
          if (next && typeof next === "object") Object.assign(ctx, next);
          if (hadConfirmation && !ctx.confirmation) draw();
        }

        if (ctrlC) {
          if (ctx.continuation) {
            clearBox(state);
            return done({ cancel: true });
          }
          if (state.buf.length) { idleExitArmedUntil = 0; return setBuf("", 0); }
          const now = Date.now();
          if (now < idleExitArmedUntil) {
            idleExitArmedUntil = 0;
            clearBox(state);
            return done({ exit: true });
          }
          idleExitArmedUntil = now + 3000;
          state.notice = i18n.t(ctx.lang || "en", "ctrlcAgain");
          return draw();
        }
        if (key.ctrl && name === "d") {
          if (!state.buf.length) { clearBox(state); return done({ eof: true }); }
          return;
        }
        if (name === "return" || name === "enter") return submit();
        if (name === "escape") {
          if (state.suggest.length) { state.dismissed = state.buf; state.suggest = []; return render(state, ctx); }
          return setBuf("", 0);
        }
        if (name === "backspace" || (key.ctrl && name === "h")) {
          if (state.cur > 0) {
            const previous = previousGraphemeIndex(state.buf, state.cur);
            setBuf(state.buf.slice(0, previous) + state.buf.slice(state.cur), previous, true);
          }
          return;
        }
        if (name === "delete") {
          const next = nextGraphemeIndex(state.buf, state.cur);
          return setBuf(state.buf.slice(0, state.cur) + state.buf.slice(next), state.cur, true);
        }
        if (name === "left") {
          if (state.cur > 0) {
            state.cur = previousGraphemeIndex(state.buf, state.cur);
            draw();
          }
          return;
        }
        if (name === "right") {
          if (state.cur < state.buf.length) {
            state.cur = nextGraphemeIndex(state.buf, state.cur);
            draw();
          }
          return;
        }
        if (name === "home" || (key.ctrl && name === "a")) { state.cur = 0; draw(); return; }
        if (name === "end" || (key.ctrl && name === "e")) { state.cur = state.buf.length; draw(); return; }
        if (key.ctrl && name === "u") return setBuf(state.buf.slice(state.cur), 0, true);
        if (key.ctrl && name === "k") return setBuf(state.buf.slice(0, state.cur), state.cur, true);
        if (key.ctrl && name === "w") {
          const left = state.buf.slice(0, state.cur).replace(/\s*\S+\s*$/, "");
          return setBuf(left + state.buf.slice(state.cur), left.length, true);
        }
        if (name === "up") {
          if (state.suggest.length) { state.suggestSel = (state.suggestSel - 1 + state.suggest.length) % state.suggest.length; state.buf = state.suggest[state.suggestSel].command; state.cur = state.buf.length; return render(state, ctx); }
          return histNav(1);
        }
        if (name === "down") {
          if (state.suggest.length) { state.suggestSel = (state.suggestSel + 1) % state.suggest.length; state.buf = state.suggest[state.suggestSel].command; state.cur = state.buf.length; return render(state, ctx); }
          return histNav(-1);
        }
        if (shiftTab) {
          if (ctx.onCyclePermission) {
            const next = ctx.onCyclePermission(ctx.permission);
            if (next && typeof next === "object") Object.assign(ctx, next);
            draw();
          }
          return;
        }
        if (name === "tab") {
          if (state.suggest.length) { const cmd = state.suggest[state.suggestSel].command; state.dismissed = cmd; return setBuf(cmd, cmd.length); }
          if (ctx.complete) {
            const res = ctx.complete(state.buf) || [];
            const hits = res[0] || [];
            const token = res[1] || "";
            if (hits.length === 1) {
              const head = token ? state.buf.slice(0, state.buf.length - token.length) : state.buf;
              return setBuf(head + hits[0]);
            }
          }
          return;
        }
        // printable insert (single char or paste). Strip control/newlines → single-line field.
        if (str && !key.ctrl && !key.meta) {
          const text = String(str).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f]/g, "");
          if (text) return setBuf(state.buf.slice(0, state.cur) + text + state.buf.slice(state.cur), state.cur + text.length, true);
        }
      }

      function histNav(dir) {
        if (!history.length) return;
        if (state.hist === -1 && dir === 1) state.stash = state.buf;
        let i = state.hist + dir;
        if (i < -1) i = -1;
        if (i >= history.length) i = history.length - 1;
        state.hist = i;
        const v = i === -1 ? state.stash : history[i];
        state.buf = v;
        state.cur = v.length;
        // A recalled slash command is history, not a newly opened palette.
        // Keep Up/Down on history until the user edits the recalled value.
        state.dismissed = v;
        draw();
      }

      inp.on("keypress", onKey);
      // stdout emits `resize` when the real terminal changes dimensions. The
      // composer owns the visible frame while read() is pending, so repaint it
      // immediately instead of leaving a stale soft-wrapped footer until the
      // next keypress.
      if (typeof out.on === "function") out.on("resize", drawSoon);
      draw();
    });
  }

  return { read, setHistory: (h) => { history = (h || []).filter((x) => typeof x === "string"); } };
}

module.exports = {
  createComposer,
  visWidth,
  buildComposerFrame,
  truncateWidth,
  splitWidth,
  wrapWidth,
  previousGraphemeIndex,
  nextGraphemeIndex,
};
