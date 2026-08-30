"use strict";
/*
 * agents/import-local — 로컬 폴더 임포트 (데스크탑 electron/agents/import-local.ts 와 동일 규칙).
 * 터미널에서 "폴더 드래그" = `agentlas import <path>`. 앱과 같은 DB/라우트를 공유한다.
 * v1 모놀리스 890–1112 구간의 충실 이식 — 규칙 변경 금지(데스크탑과 판정 동형이어야 함).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { tableExists, columnExists } = require("../core/db.cjs");
const { routesMap, saveRoutes } = require("./routes.cjs");
const { userDataDir } = require("../core/paths.cjs");

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readFileSafe(p, maxChars) {
  try { const s = fs.readFileSync(p, "utf8"); return maxChars ? s.slice(0, maxChars) : s; } catch { return ""; }
}
function readFirst(dir, names, maxChars) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (exists(p) && !isDir(p)) { const s = readFileSafe(p, maxChars || 8000); if (s) return s; }
  }
  return "";
}

function detectRuntimeLabels(dir) {
  const labels = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDir(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDir(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (!labels.length) labels.push("generic");
  return labels;
}

// 팀 감지 — 루트뿐 아니라 .claude/ 중첩 구조도 인식한다 (appbridge 처럼).
function detectKind(dir) {
  const rootMarkers = ["TEAM.md", "ceo", "hr-departments", "projects"];
  for (const m of rootMarkers) if (exists(path.join(dir, m))) return "team";
  const nestedMarkers = [".claude/ceo", ".claude/hr-departments", ".claude/agents", ".claude/orgspec.yaml"];
  for (const m of nestedMarkers) if (exists(path.join(dir, m))) return "team";
  return "agent";
}

function readImportName(dir) {
  const text = readFirst(dir, ["manifest.md", "AGENT.md", "CLAUDE.md", "README.md"], 2000);
  const m = text.match(/^#\s+(.+)$/m);
  if (m) { const n = m[1].replace(/\(.*?\)/g, "").trim().slice(0, 60); if (n) return n; }
  return path.basename(dir);
}

function readImportTagline(dir) {
  const text = readFirst(dir, ["README.md", "soul.md", "AGENT.md"], 2000);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 140);
  }
  // 팀 orgspec mission 첫 줄 fallback
  const org = readFileSafe(path.join(dir, ".claude", "orgspec.yaml"), 4000);
  const mm = org.match(/mission:\s*\|?\s*\n?\s*(.+)/);
  if (mm) return mm[1].trim().slice(0, 140);
  return "";
}

const IMPORT_ENV_RE = /\b[A-Z][A-Z0-9_]{2,}(?:API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SERVICE_ACCOUNT|WEBHOOK_SECRET|CREDENTIALS|KEY)\b/g;
const IMPORT_PROCESS_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})/g;
const IMPORT_DOTENV_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;
const IMPORT_ENV_IGNORES = new Set(["CI", "HOME", "LANG", "NODE_ENV", "PATH", "PORT", "PWD", "SHELL", "TERM", "TMPDIR", "USER"]);

function detectImportEnvRequirements(dir, extraText) {
  const files = [".env", ".env.local", ".env.example", ".env.sample", ".env.template", "env.example", "README.md", "AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "manifest.md", "package.json", ".mcp.json"];
  const found = new Map();
  const add = (key, source, required) => {
    if (!key || IMPORT_ENV_IGNORES.has(key) || key.length < 4 || key.length > 96 || !/^[A-Z][A-Z0-9_]+$/.test(key)) return;
    const entry = found.get(key) || { sources: new Set(), required: false };
    entry.sources.add(source);
    entry.required = entry.required || required;
    found.set(key, entry);
  };
  const collect = (text, source) => {
    if (!text) return;
    for (const m of text.matchAll(IMPORT_DOTENV_LINE_RE)) add(m[1], source, true);
    for (const m of text.matchAll(IMPORT_PROCESS_ENV_RE)) add(m[1], source, true);
    for (const m of text.matchAll(IMPORT_ENV_RE)) add(m[0], source, source.includes(".env"));
  };
  for (const name of files) collect(readFileSafe(path.join(dir, name), 256 * 1024), name);
  collect(extraText || "", "system prompt");
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, info]) => ({
    key,
    label: key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()),
    labelEn: key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()),
    required: info.required,
    hint: "Detected in " + [...info.sources].slice(0, 3).join(", "),
    hintEn: "Detected in " + [...info.sources].slice(0, 3).join(", "),
  }));
}

// 팀이면 CEO 두뇌를 시스템 프롬프트로 잡고, 임의 cwd에서도 동작하도록 절대경로 헤더를 붙인다.
function buildImportSystemPrompt(dir, name, kind) {
  if (kind === "team") {
    const ceoBrain = readFileSafe(path.join(dir, ".claude", "ceo", "AGENT.md"));
    const rootAgents = readFileSafe(path.join(dir, "AGENTS.md"));
    const rootClaude = readFileSafe(path.join(dir, "CLAUDE.md"));
    const nestedClaude = readFileSafe(path.join(dir, ".claude", "CLAUDE.md"));
    const brain = ceoBrain || rootAgents || rootClaude || nestedClaude;
    const claudeRoot = path.join(dir, ".claude");
    const header =
      `You are the CEO / orchestrator of the "${name}" agent team, now launched through Agentlas.\n\n` +
      `TEAM ROOT: ${dir}\n` +
      `Team definition (org spec, playbooks, department & role agents) lives under: ${claudeRoot}\n` +
      `When the instructions below reference team files with relative paths (e.g. ./playbook.md, ../orgspec.yaml, .claude/...), resolve them as ABSOLUTE paths under that team root and read them as needed.\n\n` +
      `TARGET PROJECT: your current working directory is the user's target project. Do ALL building, file creation, and delivery in the current working directory — never inside the team root. Route work to the right department/specialist, sequence multi-step work, keep a brief CEO-style status in Korean, and apply read-only-first safety gates for high-risk actions (billing/auth/security/deploy).\n\n` +
      `--- TEAM BRAIN ---\n`;
    return (header + (brain || `Act as the orchestrating CEO of ${name}.`)).slice(0, 16000);
  }
  const sys = readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  return sys || `You are ${name}, a locally imported agent.`;
}

function readTeamDepartments(dir) {
  for (const root of [path.join(dir, "hr-departments"), path.join(dir, ".claude", "hr-departments")]) {
    try {
      if (isDir(root)) {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name).sort();
      }
    } catch { /* continue */ }
  }
  return [];
}

function deptLabel(name) {
  return name.replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// 팀 폴더 → 회사(firm) upsert (앱의 upsertLocalTeamFirm 과 동일). slug 기준 멱등.
function upsertLocalTeamFirm(db, dir, ceoAgentId, agentSlug, name, tagline) {
  if (!tableExists(db, "firms")) return null;
  const depts = readTeamDepartments(dir);
  const orgChart = [
    { agentSlug, agentId: ceoAgentId, role: "CEO", reportsTo: null },
    ...depts.map((d) => ({ agentSlug: `${agentSlug}-${d}`, agentId: "", role: deptLabel(d), reportsTo: agentSlug })),
  ];
  const firmSlug = `firm-${agentSlug}`;
  const chartJson = JSON.stringify(orgChart);
  const existing = db.prepare("SELECT id FROM firms WHERE slug=?").get(firmSlug);
  if (existing) {
    db.prepare("UPDATE firms SET name=?, name_en=?, tagline=?, tagline_en=?, persona=?, ceo_agent_id=?, org_chart_json=? WHERE id=?")
      .run(name, name, tagline, tagline, "", ceoAgentId, chartJson, existing.id);
    return { id: existing.id, slug: firmSlug };
  }
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, firmSlug, name, name, tagline, tagline, "", ceoAgentId, chartJson, new Date().toISOString());
  return { id, slug: firmSlug };
}

function importLocalFolder(db, absPath) {
  const requested = path.resolve(absPath);
  const unsafe = new Set([path.parse(requested).root, path.resolve(os.homedir()), path.resolve(userDataDir())]);
  if (unsafe.has(requested)) throw new Error(`Refusing to import a broad user/system directory: ${absPath}`);
  let stat;
  try { stat = fs.lstatSync(requested); } catch { throw new Error(`Not a directory: ${absPath}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Imported agent path must be a real non-symbolic-link directory: ${absPath}`);
  const dir = fs.realpathSync(requested);
  if (unsafe.has(dir)) throw new Error(`Refusing to import a broad user/system directory: ${absPath}`);
  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  const kind = detectKind(dir);
  const name = readImportName(dir);
  const tagline = readImportTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt = buildImportSystemPrompt(dir, name, kind);
  const envRequirements = detectImportEnvRequirements(dir, systemPrompt);
  const envReqsJson = JSON.stringify(envRequirements);

  // 같은 경로가 이미 임포트돼 있으면 그 에이전트를 갱신(멱등).
  const routes = routesMap();
  let existingId = null;
  for (const [aid, r] of Object.entries(routes)) {
    if (r && path.resolve(r.path || "") === dir) { existingId = aid; break; }
  }
  const now = new Date().toISOString();
  const TONES = ["blue", "green", "purple", "amber", "peach"];
  let id, slug;
  if (existingId) {
    id = existingId;
    const row = db.prepare("SELECT slug FROM installed_agents WHERE id=?").get(id);
    slug = row ? row.slug : null;
    if (slug) {
      if (columnExists(db, "installed_agents", "visibility")) {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, env_requirements_json=?, visibility='visible' WHERE id=?")
          .run(name, name, tagline, tagline, systemPrompt, envReqsJson, id);
      } else {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, env_requirements_json=? WHERE id=?")
          .run(name, name, tagline, tagline, systemPrompt, envReqsJson, id);
      }
    } else { existingId = null; }
  }
  if (!existingId) {
    const base = "local-" + (path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent");
    slug = base; let n = 1;
    while (db.prepare("SELECT 1 FROM installed_agents WHERE slug=?").get(slug)) slug = `${base}-${++n}`;
    id = crypto.randomUUID();
    let h = 0; for (let i = 0; i < slug.length; i++) h = (h << 5) - h + slug.charCodeAt(i);
    const tone = TONES[Math.abs(h) % TONES.length];
    if (columnExists(db, "installed_agents", "visibility")) {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, visibility) VALUES (?,?,?,?,?,?,?,'[]',?,NULL,'A',?,?,0,'visible')",
      ).run(id, slug, name, name, tagline, tagline, systemPrompt, envReqsJson, now, tone);
    } else {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin) VALUES (?,?,?,?,?,?,?,'[]',?,NULL,'A',?,?,0)",
      ).run(id, slug, name, name, tagline, tagline, systemPrompt, envReqsJson, now, tone);
    }
  }
  // detectKind 결과를 DB에도 기록 — needsImage의 팀 body-veto 등 능력 판정이
  // 데스크탑이 써준 entity_kind에 무임승차하지 않고 터미널 단독 임포트에서도 성립한다.
  if (columnExists(db, "installed_agents", "entity_kind")) {
    db.prepare("UPDATE installed_agents SET entity_kind=? WHERE id=?").run(kind, id);
  }
  // 라우트 저장
  routes[id] = { agentId: id, path: dir, runtime, labels, kind, importedAt: now };
  saveRoutes(routes);

  // 팀이면 회사(firm)로도 등록 → 앱 FIRMS 목록 + `agentlas firm <slug>` 사용 가능. slug 기준 멱등.
  let firm = null;
  if (kind === "team") {
    try { firm = upsertLocalTeamFirm(db, dir, id, slug, name, tagline); } catch { /* best-effort */ }
  }
  return { id, slug, name, tagline, runtime, labels, kind, path: dir, updated: !!existingId, firmSlug: firm ? firm.slug : null };
}

module.exports = {
  importLocalFolder,
  detectKind,
  detectRuntimeLabels,
  detectImportEnvRequirements,
  buildImportSystemPrompt,
  upsertLocalTeamFirm,
};
