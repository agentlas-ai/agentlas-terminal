"use strict";

/*
 * memory-cli/curate — 어시스턴트 응답의 `## Memory Events` 큐레이션 파서/게이트.
 *
 * v1 모놀리스(engine/agentlas.cjs)의 parseMemoryEventsCli/curateCliReply
 * 슬라이스를 이식했다. 큐레이터(LLM)는 후보를 "제안"만 하고, 여기의 결정적
 * 게이트가 실제 durable 쓰기를 결정한다(제안 ≠ 승인).
 *
 * 불변식(v1 그대로):
 *  - permission=read 턴은 어떤 durable 쓰기도 하지 않는다(응답 정리만).
 *  - SECRET_RE에 걸리는 후보와 sensitivity=secret 후보는 무조건 버린다.
 *  - user_identity 승격은 confidence=high + 허용 kind에서만; 아니면 session 강등.
 *  - session/discard는 프로젝트 로그(memory-log.jsonl)로만 남는다.
 *  - 중복(scope+kind+content+project) 행은 재삽입하지 않고 기존 행을 재사용한다.
 */

const fs = require("node:fs");
const path = require("node:path");
const { tableExists, columnExists } = require("../core/db.cjs");

// 앱과 동일한 컴파일된 manifest — 빌트인 에이전트 + 메모리 아키텍처 상수.
let _arch = null;
function loadArch() {
  if (_arch) return _arch;
  try {
    _arch = require("../architecture.data.json");
  } catch {
    _arch = { version: "0", agents: [], emitterBlock: "", eventsHeading: "## Memory Events", memoryDir: ".agentlas", soulFile: "project-soul-memory.md", sitemapFile: "sitemap.json", logFile: "memory-log.jsonl", kinds: [], scopes: [] };
  }
  return _arch;
}

function ensureMemoryContextColumn(db) {
  try {
    if (tableExists(db, "memory_entries") && !columnExists(db, "memory_entries", "context_json")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  } catch { /* ignore */ }
}

const SECRET_RE = [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i];

/*
 * 프로젝트 메모리 로그 한 줄 추가. v1은 ensureProjectMemoryCli(전체 프로젝트
 * 스캐폴딩: soul/sitemap/ontology 등)를 거쳤지만, 그 스캐폴딩은 v2에서 프로젝트
 * 부트스트랩 모듈 소관이다. 큐레이션 관점의 계약(=.agentlas/memory-log.jsonl에
 * 결정 로그가 남는다)만 여기서 보장한다 — 로그 누락은 없고, 스캐폴딩 생성은
 * 이 모듈이 위장하지 않는다.
 */
function logCli(projectPath, rec) {
  if (!projectPath) return;
  try {
    const arch = loadArch();
    const dir = path.join(projectPath, arch.memoryDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, arch.logFile), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* ignore */ }
}

function coerceText(v, max) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function coerceNullableText(v, max) {
  if (v === null) return null;
  return coerceText(v, max);
}

function normalizeRequestContext(ev, ctx, projectPath) {
  const raw = ev && ev.request_context && typeof ev.request_context === "object" ? ev.request_context : {};
  const triggerTerms = Array.isArray(raw.trigger_terms)
    ? [...new Set(raw.trigger_terms.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))]
        .slice(0, 12)
        .map((x) => x.slice(0, 40))
    : undefined;
  const cwd = coerceNullableText(raw.cwd_at_request, 500) ?? ctx.cwdAtRequest ?? ctx.cwd ?? ctx.projectPath ?? null;
  const targetProject = coerceNullableText(raw.target_project, 120) ?? ctx.projectId ?? null;
  const targetPath = coerceNullableText(raw.target_path, 500) ?? projectPath ?? null;
  const out = {};
  const userIntent = coerceText(raw.user_intent, 240);
  const outcome = coerceNullableText(raw.outcome, 240);
  if (userIntent) out.user_intent = userIntent;
  if (triggerTerms && triggerTerms.length) out.trigger_terms = triggerTerms;
  if (cwd !== undefined) out.cwd_at_request = cwd;
  if (targetProject !== undefined) out.target_project = targetProject;
  if (targetPath !== undefined) out.target_path = targetPath;
  out.cross_context = typeof raw.cross_context === "boolean" ? raw.cross_context : !!(cwd && targetPath && cwd !== targetPath);
  if (outcome !== undefined) out.outcome = outcome;
  if (SECRET_RE.some((re) => re.test(JSON.stringify(out)))) return {};
  return Object.keys(out).length ? out : {};
}

function parseMemoryEventsCli(text) {
  const heading = loadArch().eventsHeading;
  const idx = text.lastIndexOf(heading);
  if (idx < 0) return { events: [], cleaned: text.trim() };
  const after = text.slice(idx + heading.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events = [];
  if (fence) { try { const d = JSON.parse(fence[1].trim()); if (Array.isArray(d)) events = d; } catch { /* ignore */ } }
  let cut = text.length;
  if (fence && fence.index != null) cut = idx + heading.length + fence.index + fence[0].length;
  const before = text.slice(0, idx).replace(/<!--\s*$/u, "");
  const remainder = text.slice(cut).replace(/^\s*-->/u, "");
  return { events, cleaned: (before + remainder).trim() };
}

function curateCliReply(db, text, ctx) {
  const { events, cleaned } = parseMemoryEventsCli(text);
  const style = require("../agentlas-style.cjs");
  if (ctx && ctx.permission === "read") return style.sanitizeAssistantText(cleaned);
  if (!events.length || !tableExists(db, "memory_entries")) return style.sanitizeAssistantText(cleaned);
  ensureMemoryContextColumn(db);
  const arch = loadArch();
  const { randomUUID } = require("node:crypto");
  const now = new Date().toISOString();
  const rememberCurated = (memory) => {
    if (!ctx || !Array.isArray(ctx.curatedMemories) || !memory) return;
    if (!ctx.curatedMemories.some((item) => item.id === memory.id)) ctx.curatedMemories.push(memory);
  };
  for (const ev of events) {
    const content = ev && typeof ev.content === "string" ? ev.content.trim() : "";
    if (!content) continue;
    if (ev.sensitivity === "secret" || SECRET_RE.some((re) => re.test(content))) continue;
    const kind = arch.kinds.includes(ev.memory_kind) ? ev.memory_kind : "fact";
    let scope = ev.suggested_scope === "agent_team"
      ? "team_memory"
      : arch.scopes.includes(ev.suggested_scope) ? ev.suggested_scope : "session";
    const kindAllowsUserIdentity = ["fact", "decision", "preference", "procedure"].includes(kind);
    if (scope === "user_identity" && (ev.confidence !== "high" || !kindAllowsUserIdentity)) scope = "session";
    if (scope === "discard" || scope === "session") { logCli(ctx.projectPath, { action: scope, kind, content, at: now }); continue; }
    if (scope === "project" && !ctx.projectPath) scope = "team_memory";
    const ppath = scope === "project" ? ctx.projectPath : null;
    const requestContext = normalizeRequestContext(ev, ctx, ppath);
    try {
      const dup = db.prepare("SELECT id,scope,kind,content,confidence,sensitivity,context_json FROM memory_entries WHERE scope=? AND kind=? AND lower(trim(content))=? AND superseded_at IS NULL AND (project_path IS ? OR project_path=?) LIMIT 1").get(scope, kind, content.toLowerCase(), ppath, ppath);
      if (dup) {
        rememberCurated({ ...dup, requestContext });
        continue;
      }
      const memoryId = randomUUID();
      const confidence = ev.confidence || "medium";
      const sensitivity = ev.sensitivity || "internal";
      db.prepare("INSERT INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,context_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run(memoryId, scope, kind, content, ctx.projectId || null, ppath, ctx.agentId || null, null, confidence, sensitivity, JSON.stringify(Array.isArray(ev.evidence_refs) ? ev.evidence_refs : []), JSON.stringify(requestContext), now);
      rememberCurated({ id: memoryId, scope, kind, content, confidence, sensitivity, requestContext });
      logCli(ctx.projectPath, { action: "written", scope, kind, content, request_context: requestContext, at: now });
    } catch { /* ignore */ }
  }
  return style.sanitizeAssistantText(cleaned);
}

module.exports = {
  SECRET_RE,
  loadArch,
  ensureMemoryContextColumn,
  logCli,
  normalizeRequestContext,
  parseMemoryEventsCli,
  curateCliReply,
};
