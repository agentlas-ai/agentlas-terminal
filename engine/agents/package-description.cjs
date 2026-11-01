"use strict";
/*
 * agents/package-description — what an agent package says it does, read from the package itself.
 * Port of the Desktop's electron/agents/package-description.ts (commit ecae096ed): same sources, same order, same bounds, so the
 * terminal import stores the line the Desktop import would store for the same folder, and `resolveInstalledDescription` gives an
 * installed agent the same line the Desktop shows (the terminal's list and router read it, so a row an older build stored as a thin
 * adapter's boot text reads right at once; nothing is rewritten in the database).
 *
 * Sources, best first:
 *   1. .agentlas/agent-card.json  summary | description | tagline
 *   2. agentlas.json / manifest.json  description | summary | tagline
 *   3. .agentlas/routing-card.json  summary | description   (its description is sometimes only the agent's name: rejected)
 *   4. package.json  description
 *   5. the package's markdown: its first lines of prose (README, TEAM, soul, then AGENTS / AGENT / agent)
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DESCRIPTION_MAX_CHARS,
  firstUsableParagraph,
  pickAgentDescription,
  usableAgentDescription,
} = require("./agent-description.cjs");

const JSON_SOURCES = [
  { file: ".agentlas/agent-card.json", keys: ["summary", "description", "tagline"] },
  { file: "agentlas.json", keys: ["description", "summary", "tagline"] },
  { file: "manifest.json", keys: ["description", "summary", "tagline"] },
  { file: ".agentlas/routing-card.json", keys: ["summary", "description"] },
  { file: "package.json", keys: ["description"] },
];
const MARKDOWN_SOURCES = ["README.md", "TEAM.md", "soul.md", "AGENTS.md", "AGENT.md", "agent.md"];
// A file read is bounded: cards and entry files are small, and a huge one is never a description.
const MAX_READ_BYTES = 256 * 1024;

function readBounded(file) {
  try {
    // A link inside the package could point anywhere on the disk; only the package's own bytes describe it.
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The package's own description as plain text (at most `max` characters), or null when it says none. Reads files; never throws. */
function readPackageDescription(dir, options = {}) {
  if (typeof dir !== "string" || !dir) return null;
  const names = [...(options.names ?? []), path.basename(dir)];
  const max = options.max ?? AGENT_DESCRIPTION_MAX_CHARS;
  for (const source of JSON_SOURCES) {
    const text = readBounded(path.join(dir, source.file));
    if (text === null) continue;
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const found = pickAgentDescription(source.keys.map((key) => parsed[key]), names, max);
    if (found) return found;
  }
  for (const file of MARKDOWN_SOURCES) {
    const text = readBounded(path.join(dir, file));
    if (text === null) continue;
    const found = firstUsableParagraph(text, names, max);
    if (found) return found;
  }
  return null;
}

/** Candidate files whose change can change the answer, for the cache signature. */
const WATCHED_FILES = [...JSON_SOURCES.map((source) => source.file), ...MARKDOWN_SOURCES];
const RECHECK_AFTER_MS = 5_000;
const cache = new Map();

function signatureOf(dir) {
  return WATCHED_FILES.map((file) => {
    try {
      const stat = fs.lstatSync(path.join(dir, file));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "-";
    }
  }).join("|");
}

/**
 * The line to show as an installed agent's description. A stored tagline that can describe the agent is kept as it is; one that is
 * package boot text, a list step or a placeholder is replaced by the package's own description, read now. When the package says
 * nothing better the stored line stays, never an empty one. Cached per package folder for a few seconds and by file stamps, because
 * lists are read often and only a few rows need this. Port of the Desktop's resolveInstalledDescription.
 */
function resolveInstalledDescription(stored, options = {}) {
  const current = typeof stored === "string" ? stored : "";
  const names = options.names ?? [];
  if (usableAgentDescription(current, names)) return current;
  const dir = options.dir;
  if (!dir) return current;
  const key = `${dir}\u0000${names.join("\u0001")}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.checkedAt < RECHECK_AFTER_MS) return hit.value ?? current;
  const signature = signatureOf(dir);
  if (hit && hit.signature === signature) {
    hit.checkedAt = now;
    return hit.value ?? current;
  }
  const value = readPackageDescription(dir, { names });
  cache.set(key, { checkedAt: now, signature, value });
  if (cache.size > 512) cache.delete(cache.keys().next().value);
  return value ?? current;
}

/** Tests only: forget what was read. */
function forgetInstalledDescriptions() {
  cache.clear();
}

module.exports = { readPackageDescription, resolveInstalledDescription, forgetInstalledDescriptions };
