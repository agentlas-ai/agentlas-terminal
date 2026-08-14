"use strict";
/*
 * sessions/prompt — 세션 턴의 시스템 프롬프트 조립 (데스크탑 러너 동형).
 *
 * 조립 순서(v1 augmentSystem과 동일):
 *   언어/말투 지시 → 에이전트 시스템 프롬프트 → 전역 연결 스킬 →
 *   거버넌스 메모리 컨텍스트(프로젝트 soul + Context Map 슬라이스 + scoped timeline) →
 *   메모리 이미터(항상 150토큰 이하 코어; 메모리 의도 감지 시에만 전체 스키마) →
 *   자격증명 인덱스 리마인더(배포/결제/인증 의도 시에만).
 *
 * 계약(memory-prompt-budget 테스트가 고정):
 *  - TERMINAL_MEMORY_CORE는 150토큰(≈byte/3) 이하. 평상시 턴은 코어만 받는다.
 *  - 전체 스키마에도 request_context / Local Credential Index를 넣지 않는다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadArch, tableExists, columnExists } = require("../core/db.cjs");
const { userDataDir } = require("../core/paths.cjs");
const { responseDirective } = require("../agentlas-style.cjs");
const memoryGovernance = require("../agentlas-memory-governance.cjs");
const { resolveContextMapCoreRoot, captureCoreJsonSync } = require("../agentlas-core-harness.cjs");

const TERMINAL_MEMORY_CORE_MAX_TOKENS = 150;
const TERMINAL_MEMORY_CORE = [
  "## Memory governance",
  "End every completed reply with hidden `## Memory Events` plus fenced JSON:",
  '{"turn_id":"<stable-id>","observation":{"outcome":"completed","summary":"safe short outcome"},"candidates":[]}',
  "Candidates 0..N: memory_kind,content,suggested_scope,confidence.",
  "Scopes: user_global|team|agent|project|session|discard.",
  "No raw prompts/transcripts, secrets, logs, or absolute paths. Curator suggests; deterministic gates decide writes.",
].join("\n");
const MEMORY_DETAIL_RE = /\b(?:remember|memory|save this|record this|memory event)\b|기억|메모리|저장해|기록해|남겨/i;
const CREDENTIAL_INDEX_RE = /\b(?:deploy|release|billing|auth|oauth|credential|api key|secret key|cloud)\b|배포|릴리스|출시|결제|인증|자격 증명|API\s*키|시크릿|클라우드/i;

function approximatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 3);
}
if (approximatePromptTokens(TERMINAL_MEMORY_CORE) > TERMINAL_MEMORY_CORE_MAX_TOKENS) {
  throw new Error("Terminal always-on memory core exceeds 150 tokens");
}

function memoryEmitterPromptFor(request, arch = loadArch(), turnId = null, permission = "write") {
  const stableId = String(turnId || "").replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 160);
  let prompt = TERMINAL_MEMORY_CORE;
  if (stableId) {
    prompt += `\nUse exactly this turn_id: ${stableId}\nPermission: ${permission === "read" ? "receipt-only" : "curated-write"}.`;
  }
  if (!MEMORY_DETAIL_RE.test(String(request || ""))) return prompt;
  const kinds = Array.isArray(arch?.kinds) && arch.kinds.length ? arch.kinds.join("|") : "fact|decision|preference|risk|procedure";
  prompt += [
    "",
    `Allowed memory_kind: ${kinds}.`,
    "Global requires explicit owner authorization; suggest only, never promote.",
    "Do not emit request_context; put only a safe, short outcome in observation.",
  ].join("\n");
  return prompt;
}

function credentialIndexReminderFor(request) {
  if (!CREDENTIAL_INDEX_RE.test(String(request || ""))) return "";
  return [
    "## Local credential lookup (triggered)",
    "Before saying a deploy, release, billing, auth, API, or cloud credential is missing, read `.agentlas/local-credentials.map.json` and the Local Credential Index in `.agentlas/project-soul-memory.md`.",
    "Use only env names and local relative references; never copy credential values into memory or output.",
  ].join("\n");
}

function loadGlobalConnectionSkill() {
  // 앱 빌드 산출물이 없는 standalone에선 v1과 동일한 인라인 스킬을 쓴다.
  return [
    "## Connecting accounts for the user (always-on background skill)",
    "When the task needs Slack, Gmail, Google Cloud, Firebase, a database, store release access, or another third-party service, open the provider website with the browser tool when available, guide the user one tiny step at a time, and save the issued credential with `agentlas creds save --provider <name> --key <ENV_NAME> --value \"<value>\" --project \"<cwd>\"` or `agentlas creds file --source <path> --provider <name> --env <ENV_NAME> --project \"<cwd>\"`.",
    "Do not lecture the user about security in this local single-user setup; make the connection effortless.",
  ].join("\n\n");
}

function contextLine(json) {
  try {
    const ctx = JSON.parse(json || "{}");
    const parts = [
      ctx.user_intent || ctx.userIntent,
      (ctx.target_project || ctx.targetProject) ? `target:${ctx.target_project || ctx.targetProject}` : null,
      Array.isArray(ctx.trigger_terms || ctx.triggerTerms) && (ctx.trigger_terms || ctx.triggerTerms).length
        ? `terms:${(ctx.trigger_terms || ctx.triggerTerms).join(",")}`
        : null,
    ].filter(Boolean);
    return parts.length ? ` (context: ${parts.join("; ").slice(0, 180)})` : "";
  } catch {
    return "";
  }
}

// 사본 3벌을 하나로 합치고 커넥션당 1회로 줄였다. 이 파일의 호출부는 **매 턴** 도는
// 자리라(cliMemoryContext), 여기가 공유 DB 에 쓰기 락을 가장 자주 잡던 지점이었다.
// 실패는 여전히 다음 호출에서 재시도된다 — 실패를 "완료"로 기억하지 않는다.
const { ensureMemoryContextColumn } = require("../core/schema-ensure.cjs");

/** Context Map 슬라이스 — Core 부재 시 정직하게 빈 문자열 (조작된 지도 금지). */
function cliProjectContextSlice(projectPath, task) {
  if (!projectPath || !String(task || "").trim()) return "";
  try {
    const coreRoot = resolveContextMapCoreRoot();
    if (!coreRoot) return "";
    const result = captureCoreJsonSync(
      "agentlas_cloud",
      ["context", "slice", "--project", projectPath, "--task-stdin", "--no-refresh", "--render"],
      { cwd: projectPath, input: String(task || "").slice(0, 12_000), timeout: 4_000 },
      coreRoot,
    );
    return result
      && result.schemaVersion === "agentlas.context-slice.v1"
      && typeof result.rendered === "string"
      ? result.rendered.trim()
      : "";
  } catch {
    return "";
  }
}

/**
 * 거버넌스 스코프 메모리 컨텍스트 (v1 cliMemoryContext 충실 이식).
 * 프로젝트 B가 프로젝트 A의 로컬 메모리를 소환하지 못하는 스코프 규칙이 핵심 —
 * 레거시 행도 user-global/현재 프로젝트/현재 소유자만 통과한다(옛 전역 팀메모리
 * 누수 쿼리를 되살리지 않는다).
 */
function cliMemoryContext(db, projectPath, agentId = null, task = "") {
  const sections = [];
  const arch = loadArch();
  ensureMemoryContextColumn(db);
  if (projectPath) {
    try {
      const soulPath = path.join(projectPath, arch.memoryDir || ".agentlas", arch.soulFile || "project-soul-memory.md");
      if (fs.existsSync(soulPath)) {
        let s = fs.readFileSync(soulPath, "utf8");
        if (s.length > 1800) s = s.slice(0, 1800) + "\n…(truncated)";
        if (s.trim()) sections.push(`### Project memory (${projectPath})\n${s.trim()}`);
      }
    } catch { /* ignore */ }
    const contextSlice = cliProjectContextSlice(projectPath, task);
    if (contextSlice) sections.push(contextSlice);
  }
  if (tableExists(db, "memory_entries")) {
    try {
      const governed = memoryGovernance.listScopedTimeline(db, { projectPath, agentId, limit: 16 });
      const seen = new Set(governed.map((row) => row.id));
      const legacy = projectPath
        ? db.prepare(`
            SELECT id,kind,content,context_json,created_at
            FROM memory_entries
            WHERE superseded_at IS NULL AND (
              (scope='user_identity' AND project_path IS NULL)
              OR (scope='project' AND project_path=?)
              OR (scope IN ('team_memory','agent_team','agent_repo') AND agent_id=? AND (project_path IS NULL OR project_path=?))
            )
            ORDER BY created_at DESC LIMIT 16
          `).all(projectPath, agentId, projectPath)
        : db.prepare(`
            SELECT id,kind,content,context_json,created_at
            FROM memory_entries
            WHERE superseded_at IS NULL AND (
              (scope='user_identity' AND project_path IS NULL)
              OR (scope IN ('team_memory','agent_team','agent_repo') AND agent_id=? AND project_path IS NULL)
            )
            ORDER BY created_at DESC LIMIT 16
          `).all(agentId);
      const rows = [...governed, ...legacy.filter((row) => !seen.has(row.id))].slice(0, 16);
      if (rows.length) {
        sections.push(
          (projectPath ? "### Scoped global + current-project memory timeline\n" : "### Curated user-global memory\n") +
          rows.map((r) => `- [${r.kind}] ${r.content}${contextLine(r.context_json)}`).join("\n"),
        );
      }
    } catch { /* ignore */ }
  }
  if (!sections.length) return "";
  return "## Agentlas memory (read before answering; governed scope recall)\n\n" + sections.join("\n\n");
}

/**
 * 최종 시스템 프롬프트 조립. ctx = { lang, projectPath, agentId, turnId, permission }.
 * withEmitter=false 는 이미터/리마인더 없이(캡처·판정 등 내부 턴용).
 */
/**
 * Agentlas One 지시문. 켜져 있을 때만, 그리고 정본 파일이 실재할 때만 싣는다.
 * 상태 파일이 없으면 조용히 빈 문자열 — 꺼진 One 의 지시문을 흘리지 않는다.
 */
function loadOneDirective() {
  try {
    const root = process.env.AGENTLAS_ONE_DIR
      || require("node:path").join(require("node:os").homedir(), ".agentlas", "one");
    const fs = require("node:fs");
    const path = require("node:path");
    const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
    if (!state || state.on !== true) return "";
    const text = fs.readFileSync(path.join(root, "directive.md"), "utf8").trim();
    // 상한을 둔다 — 지시문이 남의 토큰 예산을 잠식하면 안 된다(메모리 예산과 같은 규칙).
    return text.length > ONE_DIRECTIVE_MAX_CHARS ? text.slice(0, ONE_DIRECTIVE_MAX_CHARS) : text;
  } catch {
    return "";
  }
}

/** [튜닝값, 근거 없음] — 현재 정본 지시문이 약 3.7KB 라 두 배 여유를 둔다. */
const ONE_DIRECTIVE_MAX_CHARS = 8000;

function augmentSystem(db, baseSystem, ctx, withEmitter, request = "") {
  const arch = loadArch();
  let sys = baseSystem || "";
  // 언어/말투 지시를 맨 앞에 둔다. imported/cloud/company agents도 같은 전역 계약을 따른다.
  const lang = (ctx && ctx.lang) || "en";
  sys = responseDirective(lang) + (sys ? "\n\n" + sys : "");
  const connectionSkill = loadGlobalConnectionSkill();
  if (connectionSkill) sys += "\n\n" + connectionSkill;
  // Agentlas One 이 켜져 있으면 그 지시문을 싣는다. R4 기준 터미널의 "매 턴 주입 지점"이 여기다.
  // 정본은 `~/.agentlas/one/directive.md` 하나 — CLAUDE.md/AGENTS.md 의 마커 블록은 그 사본이다.
  const oneDirective = loadOneDirective();
  if (oneDirective) sys += "\n\n" + oneDirective;
  const mem = cliMemoryContext(db, ctx && ctx.projectPath, ctx && ctx.agentId, request);
  if (mem) sys += "\n\n" + mem;
  // 도구 접근 고지 — 터미널에는 이게 아예 없었다. 도구가 붙지 않은 턴에서 CLI는 아무
  // 말도 하지 않았고, 에이전트는 "이 기계엔 도구가 없다"고 단정하거나 없는 도구를
  // 불렀다. Desktop `shared/tool-access-notice.ts`와 같은 문장을 낸다(패리티 테스트로 고정).
  //
  // ★메모리 블록보다 **앞**에 둔다. 메모리 코어 예산은 `## Memory` 이후를 잘라서 재므로
  // (test/memory-prompt-budget.cjs), 뒤에 붙이면 도구 고지가 메모리 예산으로 잘못 계산된다.
  // 고지는 메모리 블록의 일부가 아니다.
  try {
    const { buildToolAccessNotice } = require("../tools/access-notice.cjs");
    sys += "\n\n" + buildToolAccessNotice({
      availableTools: (ctx && Array.isArray(ctx.availableTools)) ? ctx.availableTools : [],
      // 터미널은 Hub 카탈로그를 hephaestus-network MCP로만 본다. 그 서버가 이번 턴에
      // 붙지 않았으면 "찾아보라"고 말하면 안 된다 — 부를 수 없는 도구를 안내하는 셈이다.
      hubCatalogAvailable: Boolean(ctx && ctx.hubCatalogAvailable),
    });
  } catch { /* 고지 실패가 턴을 막지 않는다 */ }
  if (withEmitter) {
    sys += "\n\n" + memoryEmitterPromptFor(request, arch, ctx && ctx.turnId, ctx && ctx.permission);
    const credentialReminder = credentialIndexReminderFor(request);
    if (credentialReminder) sys += "\n\n" + credentialReminder;
  }
  return sys;
}

module.exports = {
  TERMINAL_MEMORY_CORE,
  TERMINAL_MEMORY_CORE_MAX_TOKENS,
  approximatePromptTokens,
  memoryEmitterPromptFor,
  credentialIndexReminderFor,
  cliMemoryContext,
  cliProjectContextSlice,
  augmentSystem,
  loadGlobalConnectionSkill,
};
