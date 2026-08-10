"use strict";
/*
 * ui/width: 터미널 셀 폭·그래핌 유틸 정본.
 * agentlas-composer.cjs(데드코드가 된 바텀 입력 박스)에서 2026-08-11 추출 — 함수는
 * 바이트 동일. 소비자: agentlas-ui / agentlas-banner / agentlas-onboard /
 * ui/repl / hephaestus/runtime. pi-tui 이행(D3 Phase 1-3) 정지작업.
 */
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


module.exports = {
  visWidth,
  truncateWidth,
  splitWidth,
  wrapWidth,
  previousGraphemeIndex,
  nextGraphemeIndex,
};
