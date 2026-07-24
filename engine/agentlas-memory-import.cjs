"use strict";

// `agentlas memory import <path> [--apply]` — Phase 1b.
//
// Promote legacy markdown memory into the shared agentlas.sqlite the desktop
// uses (same userData/agentlas.sqlite). Maps each substantive markdown section
// to a durable memory_entries row owned by the right layer of a team (member
// cell / orchestrator / shared team_memory) or a single agent. Mirrors the app's
// electron/memory/import.ts mapping so app and terminal agree. Dry-run by
// default (prints the preview table); --apply writes. Idempotent via a stable
// per-section source-hash sentinel embedded in evidence. Secrets are dropped.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const SOURCE_TOKEN_PREFIX = "mem-import:v1";
const MAX_FILES = 400;
const MAX_CONTENT = 4000;

// ── Section extraction (parity with electron/memory/import.ts) ───────────────
const TEMPLATE_LINE =
  /^\s*[-*]?\s*(Add\b|Fill in\b|Example:|Record\b|Link\b|Prefer\b|Note\b|Which\b|Date:\s*$|Topic:\s*$|Decision:\s*$|Why:\s*$|Risk accepted:\s*$)/i;
const META_HEADING =
  /^(How To Use|사용 규칙|사용법|구조|형식|사전 참조|누가 업데이트|Entries|Read First|Memory Rules|Recent Activity|Recently Touched|CROSS-REFERENCES|LEARNINGS LOG|ANTIPATTERNS|GOTCHAS|Repeated Failures|성공 패턴|발견 사항|안티패턴|에이전트 구성)/i;
const SHARED_HINT =
  /(team[-_ ]?memory|team_memory|glossary|handoff|scope[-_ ]?ownership|common[-_ ]?safety|safety|tone|language|dossier|operating[-_ ]?architecture|memory[-_ ]?architecture|용어|공통|안전|인계|톤)/i;
const RISK_HINT = /(security|attack|vuln|bug|gotcha|incident|보안|취약|버그|사고)/i;
const ALWAYS_KEEP_HINT = /(team[-_ ]?memory|glossary|dossier|handoff|safety|scope[-_ ]?ownership|tone)/i;

// Minimal secret guard (a subset of the shared secret-patterns chokepoint) so a
// stray key in legacy notes never becomes a durable memory row.
const SECRET_RE =
  /(sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;

function looksSecret(content) {
  return SECRET_RE.test(String(content || ""));
}

function substantiveBody(body) {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const real = lines.filter((l) => !TEMPLATE_LINE.test(l) && l.replace(/^#+\s*/, "").length >= 12);
  return real.join("\n");
}

function kindForHeading(heading, fallback) {
  const m = /\[([A-Z_]+)\]/.exec(heading);
  const tag = m ? m[1] : "";
  if (["SUCCESS", "DISCOVERY"].includes(tag)) return "procedure";
  if (["ANTIPATTERN", "GOTCHA", "SECURITY", "CONFIRMED", "REGRESSION", "FALSE_POSITIVE", "BLOCKED_BY_GUARD", "FAILURE"].includes(tag)) {
    return "risk";
  }
  return fallback;
}

function keepSection(heading, body, alwaysKeep) {
  if (META_HEADING.test(heading.replace(/\[[A-Z_]+\]\s*/, "").trim())) return false;
  const hasDate = /\(20\d\d-\d\d-\d\d\)|Date:\s*20\d\d-\d\d-\d\d/.test(heading + "\n" + body);
  const hasTag = /\[[A-Z_]+\]/.test(heading);
  const real = substantiveBody(body);
  if (alwaysKeep) return real.length >= 60;
  if (hasDate || hasTag) return real.length >= 40;
  return real.length >= 160;
}

function splitSections(md) {
  const lines = md.split("\n");
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^#{2,3}\s+\S/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line.replace(/^#{2,3}\s+/, "").trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function splitDatedBullets(md) {
  const idx = md.indexOf("- Date:");
  if (idx === -1) return [];
  return md
    .slice(idx)
    .split(/\n(?=- Date:)/)
    .map((p) => p.trim())
    .filter((p) => /Date:\s*20\d\d-\d\d-\d\d/.test(p))
    .map((p) => {
      const topic = /Topic:\s*(.+)/.exec(p);
      const date = /Date:\s*(20\d\d-\d\d-\d\d)/.exec(p);
      return { heading: `Decision ${date ? date[1] : ""}: ${topic ? topic[1].trim() : ""}`.trim(), body: p };
    });
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function resolveTarget(db, agentId) {
  let firms = [];
  try {
    firms = db.prepare("SELECT id, ceo_agent_id, org_chart_json FROM firms").all();
  } catch {
    firms = [];
  }
  const firm =
    firms.find((f) => f.id === agentId) ||
    firms.find((f) => f.ceo_agent_id === agentId) ||
    null;
  if (!firm) return { agentId, kind: "agent", members: [] };
  let chart = [];
  try {
    const parsed = JSON.parse(firm.org_chart_json);
    if (Array.isArray(parsed)) chart = parsed;
  } catch {
    chart = [];
  }
  const members = chart
    .filter((node) => node && node.agentId && node.agentId !== firm.ceo_agent_id)
    .map((node) => ({ agentId: node.agentId, role: node.role || node.agentSlug, slug: node.agentSlug }));
  return { agentId: firm.ceo_agent_id, kind: "team", members };
}

function matchMember(fileTokens, target) {
  if (!target.members.length) return null;
  let best = null;
  for (const member of target.members) {
    const roleTokens = normalizeToken(member.role).split(" ").filter((t) => t.length >= 3);
    const slugTokens = normalizeToken(member.slug).split(" ").filter((t) => t.length >= 3);
    const tokens = [...new Set([...roleTokens, ...slugTokens])];
    let score = 0;
    for (const token of tokens) if (fileTokens.includes(token)) score += token.length;
    if (score > 0 && (!best || score > best.score)) best = { agentId: member.agentId, role: member.role, score };
  }
  return best ? { agentId: best.agentId, role: best.role } : null;
}

function decideOwner(relFile, target) {
  const lower = relFile.toLowerCase();
  const fileTokens = normalizeToken(relFile);
  const alwaysKeep = ALWAYS_KEEP_HINT.test(lower);
  if (SHARED_HINT.test(lower)) {
    return {
      scope: "team_memory",
      ownerAgentId: null,
      ownerLabel: "team_memory",
      fallbackKind: /glossary|dossier|용어/i.test(lower) ? "fact" : "procedure",
      alwaysKeep,
    };
  }
  if (target.kind === "team") {
    const member = matchMember(fileTokens, target);
    if (member) {
      return { scope: "agent_repo", ownerAgentId: member.agentId, ownerLabel: member.role, fallbackKind: RISK_HINT.test(lower) ? "risk" : "procedure", alwaysKeep };
    }
    return { scope: "agent_repo", ownerAgentId: target.agentId, ownerLabel: "orchestrator", fallbackKind: RISK_HINT.test(lower) ? "risk" : "decision", alwaysKeep };
  }
  return { scope: "agent_repo", ownerAgentId: target.agentId, ownerLabel: "agent", fallbackKind: RISK_HINT.test(lower) ? "risk" : "procedure", alwaysKeep };
}

function collectMarkdown(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return /\.(md|markdown|mdx|txt)$/i.test(root) ? [{ abs: root, rel: path.basename(root) }] : [];
  }
  const out = [];
  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.(md|markdown|mdx|txt)$/i.test(entry.name)) out.push({ abs, rel: path.relative(root, abs) });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function stableToken(relFile, heading) {
  const hash = createHash("sha256").update(`${SOURCE_TOKEN_PREFIX}|${relFile}|${heading}`).digest("hex").slice(0, 16);
  return `${SOURCE_TOKEN_PREFIX}:${hash}`;
}

function buildEntries(sourcePath, target) {
  const built = [];
  for (const { abs, rel } of collectMarkdown(sourcePath)) {
    let md;
    try {
      md = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const owner = decideOwner(rel, target);
    const sections = /decisions\.md$/i.test(rel) ? splitDatedBullets(md) : splitSections(md);
    for (const sec of sections) {
      if (!keepSection(sec.heading, sec.body, owner.alwaysKeep)) continue;
      const bodyText = sec.body.replace(/\n{3,}/g, "\n\n").trim();
      const content = `${sec.heading}\n${bodyText}`.trim().slice(0, MAX_CONTENT);
      if (content.length < 40) continue;
      built.push({
        token: stableToken(rel, sec.heading),
        relFile: rel,
        heading: sec.heading,
        content,
        scope: owner.scope,
        kind: kindForHeading(sec.heading, owner.fallbackKind),
        ownerAgentId: owner.ownerAgentId,
        ownerLabel: owner.ownerLabel,
        redacted: looksSecret(content),
      });
    }
  }
  return built;
}

function existsByToken(db, token) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM memory_entries WHERE evidence_json LIKE ? LIMIT 1").get(`%${token}%`));
  } catch {
    return false;
  }
}

/**
 * cmdMemory — `agentlas memory <sub> ...`. Currently: import.
 * @param {{db:any,args:string[],out:(s:string)=>void,fail:(s:string)=>void}} ctx
 */
function cmdMemory(ctx) {
  const { db, out, fail } = ctx;
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const sub = args[0] || "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    out("usage: agentlas memory import <folder-or-file> --agent <agentId> [--apply]");
    out("  dry-run by default (prints the preview table); --apply writes to the shared DB.");
    return;
  }
  if (sub !== "import") return fail(`Unknown memory subcommand: ${sub} (import)`);

  const apply = args.includes("--apply");
  const agentIdx = args.indexOf("--agent");
  const agentId = agentIdx >= 0 ? String(args[agentIdx + 1] || "").trim() : "";
  const positional = args.slice(1).filter((a, i, arr) => a !== "--apply" && a !== "--agent" && arr[i - 1] !== "--agent");
  const rawPath = positional[0];
  if (!rawPath) return fail('usage: agentlas memory import <folder-or-file> --agent <agentId> [--apply]');
  if (!agentId) return fail("memory import requires --agent <agentId> (the single agent or team to import into).");
  const sourcePath = path.resolve(rawPath);
  if (!fs.existsSync(sourcePath)) return fail(`Import source not found: ${sourcePath}`);

  const target = resolveTarget(db, agentId);
  const entries = buildEntries(sourcePath, target);

  out(`== memory import (${apply ? "APPLY" : "DRY-RUN"}) ==`);
  out(`source: ${sourcePath}`);
  out(`target: ${agentId} (${target.kind})`);
  out("");
  out(pad("OWNER", 26) + pad("KIND", 10) + pad("STATUS", 8) + "SECTION");
  const byOwner = {};
  let newCount = 0;
  let dupCount = 0;
  let redacted = 0;
  for (const e of entries) {
    const status = e.redacted ? "skip" : existsByToken(db, e.token) ? "dup" : "new";
    if (status === "new") {
      newCount += 1;
      byOwner[e.ownerLabel] = (byOwner[e.ownerLabel] || 0) + 1;
    } else if (status === "dup") dupCount += 1;
    else redacted += 1;
    out(pad(e.ownerLabel, 26) + pad(e.kind, 10) + pad(status, 8) + e.heading.slice(0, 70));
  }
  out("");
  out(`total ${entries.length} · new ${newCount} · duplicate ${dupCount} · redacted ${redacted}`);

  if (!apply) {
    out("");
    out("dry-run — nothing written. Re-run with --apply to write to the shared agentlas.sqlite.");
    return;
  }

  const now = new Date().toISOString();
  let imported = 0;
  const insert = db.prepare(
    "INSERT INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,context_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
  );
  const write = db.transaction((list) => {
    for (const e of list) {
      if (e.redacted || existsByToken(db, e.token)) continue;
      const confidence = /\(20\d\d-\d\d-\d\d\)|Date:\s*20\d\d/.test(e.content) ? "high" : "medium";
      const context = JSON.stringify({ userIntent: `Imported memory: ${e.heading}`.slice(0, 200), outcome: "imported-from-existing-memory" });
      const evidence = JSON.stringify([e.token, `source:memory-import/${e.relFile}`]);
      insert.run(randomUUID(), e.scope, e.kind, e.content, null, null, e.ownerAgentId, null, confidence, "internal", evidence, context, now);
      imported += 1;
    }
  });
  write(entries);

  out("");
  out(`imported ${imported} memory entries into the shared DB. (Embedding runs in the desktop app on next open.)`);
}

function pad(value, width) {
  const s = String(value == null ? "" : value);
  return s.length >= width ? s.slice(0, width - 1) + " " : s + " ".repeat(width - s.length);
}

module.exports = { cmdMemory, buildEntries, resolveTarget, decideOwner };
