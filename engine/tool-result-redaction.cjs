"use strict";
/*
 * tool-result-redaction (G03) -- CJS sibling of the Desktop's harness/tool-result-store.ts redactToolText.
 *
 * A secret must never reach model-visible text, a UI preview/ring event or retained evidence. Every tool
 * output goes through redactSecrets first and carries three facts:
 *   redacted        true when the text that is kept differs from what the tool returned
 *   originalSha256  hash of the UNREDACTED bytes, computed in memory; the original itself is never stored
 *   storedSha256    hash of the bytes that were kept (equal to originalSha256 when redacted is false)
 * Binary content parts (data/blob beside a mimeType: images, owner artifacts) are kept as they are.
 */
const crypto = require("node:crypto");
const { redactSecrets } = require("./agentlas-secret-patterns.cjs");

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

function redactToolText(original) {
  const source = typeof original === "string" ? original : String(original ?? "");
  const text = redactSecrets(source);
  const originalSha256 = sha256Hex(source);
  const redacted = text !== source;
  return { text, redacted, originalSha256, storedSha256: redacted ? sha256Hex(text) : originalSha256 };
}

/** Redact every string inside a JSON-like value (keys untouched); binary data/blob strings stay. */
function redactToolJson(value) {
  const walk = (node) => {
    if (typeof node === "string") return redactSecrets(node);
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const binary = typeof node.mimeType === "string" || typeof node.media_type === "string";
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = binary && (key === "data" || key === "blob") && typeof child === "string" ? child : walk(child);
    }
    return out;
  };
  return walk(value);
}

/**
 * Redact a tool result's content. String content -> redactToolText. Structured content (array of parts or an
 * object) -> text parts redacted, binary parts untouched. Returns { content, redaction } where redaction is
 * { redacted, originalSha256, storedSha256 }.
 */
function redactToolContent(content) {
  if (typeof content === "string" || content == null) {
    const r = redactToolText(content ?? "");
    return { content: r.text, redaction: { redacted: r.redacted, originalSha256: r.originalSha256, storedSha256: r.storedSha256 } };
  }
  const originalJson = JSON.stringify(content);
  const next = redactToolJson(content);
  const storedJson = JSON.stringify(next);
  const redacted = storedJson !== originalJson;
  const originalSha256 = sha256Hex(originalJson);
  return { content: next, redaction: { redacted, originalSha256, storedSha256: redacted ? sha256Hex(storedJson) : originalSha256 } };
}

module.exports = { redactToolText, redactToolJson, redactToolContent, sha256Hex };
