"use strict";
// Credential/secret detection for every terminal write boundary that must never persist
// or transmit a live key. Three inline copies had drifted apart (memory import missed
// JWTs, generic `key=` assignments and bearer headers; governance missed sk_live_/
// github_pat_/glpat-; experience exchange missed Google AIza and JWTs), so the same
// secret was caught at one boundary and stored in plain text at another. One list, one
// behaviour: extend HERE, not at a call site. Mirrors the desktop's
// shared/secret-patterns.ts.
//
// Scope rule: match *credential shapes*, not the words around them. Ordinary prose that
// mentions "token", or a hyphenated phrase like "risk-management-notes", must not trip
// this — a false positive silently drops a user's memory, which is its own data loss.

/** Live-credential shapes across the providers this product actually touches. */
const SECRET_SHAPES = [
  // GitHub: classic PAT, OAuth/user/server/refresh tokens, fine-grained PAT.
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  // Slack bot/user/app tokens.
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  // AWS access key ids (long-lived and STS).
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  // Google / Firebase API keys.
  /AIza[0-9A-Za-z_-]{30,}/,
  // Stripe and similar: secret/restricted/publishable, live or test.
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  // OpenAI / Anthropic, including provider-segmented forms. The \b prevents an ordinary
  // hyphenated phrase ("ask-forgiveness-not-permission") from matching.
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}/,
  // HuggingFace, GitLab, npm.
  /hf_[A-Za-z0-9]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9]{20,}/,
  // JWTs (three base64url segments) — bearer tokens frequently land in pasted logs.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // Telegram bot tokens.
  /\b[0-9]{8,}:[A-Za-z0-9_-]{25,}\b/,
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** `password: hunter2` style assignments, where the value shape alone proves nothing. */
const SECRET_ASSIGNMENT_RE =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|cookie|bearer)\b\s*[:=]\s*['"]?[^\s,;'"]{6,}/i;

/** `Authorization: Bearer …` / `Basic …` headers. */
const AUTH_HEADER_RE = /\bauthorization\b\s*[:=]\s*['"]?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;

/** Single source of truth. Case-insensitive: providers are inconsistent about casing. */
const SECRET_PATTERNS = [
  ...SECRET_SHAPES.map((re) => new RegExp(re.source, "i")),
  SECRET_ASSIGNMENT_RE,
  AUTH_HEADER_RE,
];

/** True when the text contains something that looks like a live credential. */
function looksSecret(content) {
  const text = String(content || "");
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Replace credential-shaped substrings with a marker, preserving surrounding text. */
function redactSecrets(content, marker = "[redacted-secret]") {
  let out = String(content || "");
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), marker);
  }
  return out;
}

module.exports = { SECRET_PATTERNS, looksSecret, redactSecrets };
