"use strict";
/*
 * agents/agent-description — what an agent does, as one plain line.
 * Port of the Desktop's shared/agent-description.ts (commit ecae096ed). Same rules, same order, same limits: a package gets the
 * same description from the terminal import and from the Desktop import. Change one, change the other.
 *
 * Production 2026-10-31: 13 of the owner's 189 installed agents had package boot text as their tagline ("Read AGENTS.md with the
 * package file reader. agentlas.json declares it as the canonical entry ...", "1. Read [`AGENTS.md`](AGENTS.md) for the principles,
 * rules, workflow, and"): the import took the first non-heading line of the first markdown file, which for a thin adapter is its
 * own boot text. This module decides which line can describe an agent.
 *
 * Pure text rules, no file access. Nothing here names an agent: a line is judged by what it is (a list item, a file
 * instruction, the agent's own name), not by whose it is.
 */

const AGENT_DESCRIPTION_MAX_CHARS = 160;

// Lines the product writes itself when it found nothing better. They say nothing about the agent.
const PRODUCT_PLACEHOLDERS = new Set([
  "imported local agent",
  "imported local team",
  "portable agentlas cloud agent package.",
  "portable agentlas cloud agent package",
  "one team teammate",
  "owned agent cloud asset",
  "callable hub team",
  "hub profile",
]);

// A list item or bullet: a step of some instruction, not a sentence about the agent.
const LIST_MARKER = /^\s*(?:\d{1,3}[.)]|[-*•+])\s/;
// Markup that starts something other than prose.
const NON_PROSE_START = /^\s*(?:#{1,6}\s|>|\||```|~~~|<|\[|\{|---|===|\*\*\*)/;
// Metadata written as `key: value`.
const METADATA_LINE = /^\s*(?:name|slug|id|version|type|entry|license|schema\w*|created\w*|updated\w*)\s*[:=]/i;
// An instruction to go and read a package file ("Before work read docs/guide.md ...", "See agentlas.json"), a line that starts with a file
// name, or a short label pointing at one ("Stage guides: docs/guide.md"). A description that only NAMES a file as the thing the agent works
// on ("Maintains CHANGELOG.md and release notes", "Validates package.json dependencies") describes the agent and is kept.
const FILE_REFERENCE = /(?:\b(?:read|see|open|load|follow|refer\s+to|consult)\b[^.!?\n]{0,80}?\b[\w-]+\.(?:md|markdown|json|ya?ml|toml)\b|^\s*[\w./-]*[\w-]+\.(?:md|markdown|json|ya?ml|toml)\b|^[^.!?\n]{0,40}:\s*[\w./-]*[\w-]+\.(?:md|markdown|json|ya?ml|toml)\b)/i;
// The least a description can be: 6 characters, but a word of Chinese, Japanese or Korean says as much in 3 (a tagline like "사진 보정").
function longEnough(text) {
  const spaceless = text.replace(/\s+/g, "");
  return /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? spaceless.length >= 3 : text.length >= 6;
}
// Wording of a boot instruction or a thin adapter pointing at the real definition.
const BOOT_TEXT = /\b(?:package file reader|canonical entry|this adapter|thin adapter|source of truth|navigation only|no rules live here|adds no policy|read (?:the )?(?:agents?|readme|claude|gemini)\b)/i;
const BOOT_IMPERATIVE = /^\s*(?:read|see|open)\s+(?:(?:the|this|its|your|our|these)\s+)?(?:[\w-]+\s+){0,2}(?:file|files|adapter|guide|guides|instructions|manifest|runbook|readme)\b/i;

function collapse(value) {
  return value.replace(/\s+/g, " ").trim();
}

// Markdown noise removed from a line that is otherwise prose: emphasis, inline code marks, link syntax.
function plain(value) {
  return collapse(value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])([*_])([^*_\n]+)\1(?![\w*])/g, "$2")
    .replace(/`([^`]*)`/g, "$1"));
}

function sameName(text, names) {
  const flat = (value) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const target = flat(text);
  if (!target) return true;
  return names.some((name) => typeof name === "string" && name.trim() !== "" && flat(name) === target);
}

// Whether ONE line of a file can be part of the agent's description (no list item, heading, quote, table, file instruction).
function isProseLine(line) {
  const text = line.trim();
  if (!text) return false;
  if (LIST_MARKER.test(text) || NON_PROSE_START.test(text) || METADATA_LINE.test(text)) return false;
  const flat = plain(text);
  return flat !== "" && !FILE_REFERENCE.test(flat) && !BOOT_TEXT.test(flat) && !BOOT_IMPERATIVE.test(flat);
}

/**
 * The line cleaned to plain text when it can describe the agent, otherwise null. `names` are the agent's own names (display,
 * package, English): a description that only repeats the name is no description.
 */
function usableAgentDescription(value, names = []) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (LIST_MARKER.test(raw) || NON_PROSE_START.test(raw) || METADATA_LINE.test(raw)) return null;
  const text = plain(raw);
  if (!longEnough(text) || !/\p{L}/u.test(text)) return null;
  if (PRODUCT_PLACEHOLDERS.has(text.toLowerCase())) return null;
  if (FILE_REFERENCE.test(text) || BOOT_TEXT.test(text) || BOOT_IMPERATIVE.test(text)) return null;
  if (sameName(text, names)) return null;
  return text;
}

// At most `max` characters: whole sentences while they fit (two at most), otherwise a cut at a word with an ellipsis.
function clampAgentDescription(text, max = AGENT_DESCRIPTION_MAX_CHARS) {
  const flat = collapse(text);
  if (flat.length <= max) return flat;
  // A period after one capital letter ("N.O.V.A.", "U.S.") is an abbreviation, not the end of a sentence.
  const sentences = flat.split(/(?<=[.!?。！？])(?<!\b[A-Z]\.)\s+/);
  let out = "";
  for (const sentence of sentences.slice(0, 2)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * The agent's own first lines of prose in a markdown file: after the title, skipping headings, quotes, lists, tables, code,
 * metadata and instructions to read other files. A paragraph's lines are joined until the first line that is not prose, so
 * "Produce X.\nBefore work read docs/guide.md ..." gives "Produce X." and a thin adapter gives nothing.
 */
function firstUsableParagraph(markdown, names = [], max = AGENT_DESCRIPTION_MAX_CHARS) {
  if (typeof markdown !== "string" || !markdown.trim()) return null;
  let text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    // A block is the run of lines up to the next blank line; one that does not start as prose is skipped whole.
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) break;
    if (!isProseLine(lines[index])) {
      // A heading is one line; any other non-prose block runs to its blank line.
      const heading = /^\s*#{1,6}\s/.test(lines[index]);
      index += 1;
      if (!heading) while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }
    const parts = [];
    let length = 0;
    while (index < lines.length && lines[index].trim() && isProseLine(lines[index])) {
      const piece = plain(lines[index]);
      parts.push(piece);
      length += piece.length + 1;
      index += 1;
      if (length > max * 2) break;
    }
    const usable = usableAgentDescription(parts.join(" "), names);
    if (usable) return clampAgentDescription(usable, max);
    while (index < lines.length && lines[index].trim()) index += 1;
  }
  return null;
}

// The first candidate that can describe the agent, as plain text of at most `max` characters.
function pickAgentDescription(candidates, names = [], max = AGENT_DESCRIPTION_MAX_CHARS) {
  for (const candidate of candidates) {
    const usable = usableAgentDescription(candidate, names);
    if (usable) return clampAgentDescription(usable, max);
  }
  return null;
}

module.exports = {
  AGENT_DESCRIPTION_MAX_CHARS,
  isProseLine,
  usableAgentDescription,
  clampAgentDescription,
  firstUsableParagraph,
  pickAgentDescription,
};
