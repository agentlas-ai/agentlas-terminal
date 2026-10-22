"use strict";
/*
 * sessions/prompt — 세션 턴의 시스템 프롬프트 조립 (데스크탑 러너 동형).
 *
 * 조립 순서(고정 → 변동, docs/PROMPT-COMPOSITION-POLICY.md):
 *   말투 지시 → 전역 연결 스킬 → 메모리 이미터(항상 150토큰 이하 코어; 메모리 의도 시에만 전체 스키마) →
 *   자격증명 인덱스 리마인더(배포/결제/인증 의도 시에만) → 에이전트 시스템 프롬프트 → One 지시문 →
 *   언어 지시 → 도구 접근 고지 → 거버넌스 메모리 컨텍스트(프로젝트 soul + Context Map 슬라이스 + scoped timeline) →
 *   이미터 턴 바인딩(turn_id/permission).
 *
 * 계약(memory-prompt-budget 테스트가 고정):
 *  - TERMINAL_MEMORY_CORE는 150토큰(≈byte/3) 이하. 평상시 턴은 코어만 받는다.
 *  - 전체 스키마에도 request_context / Local Credential Index를 넣지 않는다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadArch, tableExists, columnExists } = require("../core/db.cjs");
const { userDataDir } = require("../core/paths.cjs");
const { responseLanguageDirective, responseStyleDirective } = require("../agentlas-style.cjs");
const memoryGovernance = require("../agentlas-memory-governance.cjs");
const { resolveContextMapCoreRoot, captureCoreJsonSync } = require("../agentlas-core-harness.cjs");
const { composeDeclaredPrompt } = require("../prompt-order.cjs");

const TERMINAL_MEMORY_CORE_MAX_TOKENS = 150;
// The automatic receipt is one English sentence (owner decisions 06 D11, same meaning as the Desktop memory-ticket
// turn_summary); candidates are an optional explicit proposal, never a per-turn obligation — the host's automatic
// intake reads the reply itself. The Terminal wire (turn_id, observation) stays as it was.
const TERMINAL_MEMORY_CORE = [
  "## Memory governance",
  "end each reply: hidden `## Memory Events` + fenced JSON:",
  '{"turn_id":"<stable-id>","observation":{"outcome":"completed","summary":"<one English sentence>"}}',
  'optional "candidates" only for a durable learning: memory_kind,content,suggested_scope,confidence',
  "scope: user_global|team|agent|project|session|discard",
  "never: raw prompts/transcripts, secrets, logs, absolute paths. gates decide writes",
].join("\n");
const MEMORY_DETAIL_RE = /\b(?:remember|memory|save this|record this|memory event)\b|기억|메모리|저장해|기록해|남겨/i;
const CREDENTIAL_INDEX_RE = /\b(?:deploy|release|billing|auth|oauth|credential|api key|secret key|cloud)\b|배포|릴리스|출시|결제|인증|자격 증명|API\s*키|시크릿|클라우드/i;
const PROJECT_SOUL_MAX_CHARS = 1_800;
const ONE_STATE_MAX_CHARS = 64 * 1024;

function sameFileIdentity(left, right) {
  return left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

/**
 * Read a small local prompt file through one descriptor. The lstat/fstat
 * identity check detects a path swap between the check and open; O_NOFOLLOW
 * rejects symlink aliases, and the second fstat detects a concurrent rewrite.
 * The byte cap is deliberately larger than the character cap for UTF-8 while
 * still bounding the amount retained before decoding and slicing.
 */
function readBoundedText(file, maxChars) {
  const charLimit = Math.max(0, Number(maxChars) || 0);
  const byteLimit = Math.max(1, charLimit * 4 + 4);
  const expected = fs.lstatSync(file);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
    throw new Error(`prompt file is not a single-link regular file: ${file}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  try {
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(expected, opened)) {
      throw new Error(`prompt file identity changed before read: ${file}`);
    }
    const size = Number.isSafeInteger(Number(opened.size)) ? Number(opened.size) : byteLimit;
    const readLimit = Math.min(size, byteLimit);
    const data = Buffer.allocUnsafe(readLimit);
    let offset = 0;
    while (offset < readLimit) {
      const count = fs.readSync(fd, data, offset, readLimit - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    const changed = !sameFileIdentity(opened, after)
      || after.nlink !== 1
      || Number(after.size) !== Number(opened.size)
      || (after.mtimeNs != null && opened.mtimeNs != null
        ? String(after.mtimeNs) !== String(opened.mtimeNs)
        : after.mtimeMs !== opened.mtimeMs);
    if (changed) throw new Error(`prompt file changed while reading: ${file}`);
    const text = data.subarray(0, offset).toString("utf8");
    return {
      text: text.slice(0, charLimit),
      truncated: offset < Number(opened.size) || text.length > charLimit,
    };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function approximatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 3);
}
if (approximatePromptTokens(TERMINAL_MEMORY_CORE) > TERMINAL_MEMORY_CORE_MAX_TOKENS) {
  throw new Error("Terminal always-on memory core exceeds 150 tokens");
}

// 이미터를 고정(코어+상세)과 턴 바인딩(turn_id/permission)으로 나눈다. 바인딩은 턴마다 달라
// 프롬프트 맨 끝으로 가고, 고정 부분은 앞쪽 캐시 가능 구간에 놓인다.
// The output contract (format line + JSON template) closes the prompt with the turn binding (final-boundary):
// measured 2026-10-14, with it near the top Claude followed a later global "## Memory events" block and dropped
// turn_id 3 of 3 times; codex kept it either way. The rest of the governance core stays in the fixed prefix.
const TERMINAL_MEMORY_OUTPUT_CONTRACT = TERMINAL_MEMORY_CORE.split("\n").slice(1, 3).join("\n");
const TERMINAL_MEMORY_GOVERNANCE = [TERMINAL_MEMORY_CORE.split("\n")[0], ...TERMINAL_MEMORY_CORE.split("\n").slice(3)].join("\n");
function memoryEmitterParts(request, arch = loadArch(), turnId = null, permission = "write") {
  const stableId = String(turnId || "").replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 160);
  let binding = TERMINAL_MEMORY_OUTPUT_CONTRACT;
  if (stableId) {
    binding += `\nturn_id: ${stableId}\npermission: ${permission === "read" ? "receipt-only" : "curated-write"}`;
  }
  let fixed = TERMINAL_MEMORY_GOVERNANCE, detail = "";
  if (MEMORY_DETAIL_RE.test(String(request || ""))) {
    const kinds = Array.isArray(arch?.kinds) && arch.kinds.length ? arch.kinds.join("|") : "fact|decision|preference|risk|procedure";
    detail = [
      `memory_kind: ${kinds}`,
      "global: needs explicit owner authorization, suggest only",
      "no request_context; observation.summary: one English sentence",
    ].join("\n");
    fixed += `\n${detail}`;
  }
  // `contract` / `turnBinding` are the two halves of `binding`, for a retained native session (augmentSystemParts).
  const turnBinding = stableId ? `turn_id: ${stableId}\npermission: ${permission === "read" ? "receipt-only" : "curated-write"}` : "";
  // A request-dependent detail is turn content for a retained session (augmentSystemParts); `fixed` keeps it for one request.
  return { fixed, binding, governance: TERMINAL_MEMORY_GOVERNANCE, detail, contract: TERMINAL_MEMORY_OUTPUT_CONTRACT, turnBinding };
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
    `memory_kind: ${kinds}`,
    "global: needs explicit owner authorization, suggest only",
    "no request_context; observation.summary: one English sentence",
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
      const bounded = readBoundedText(soulPath, PROJECT_SOUL_MAX_CHARS);
      let s = bounded.text;
      if (bounded.truncated) s += "\n…(truncated)";
      if (s.trim()) sections.push(`### Project memory (${projectPath})\n${s.trim()}`);
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
    const path = require("node:path");
    const state = JSON.parse(readBoundedText(path.join(root, "state.json"), ONE_STATE_MAX_CHARS).text);
    if (!state || state.on !== true) return "";
    const bounded = readBoundedText(path.join(root, "directive.md"), ONE_DIRECTIVE_MAX_CHARS);
    const text = bounded.text.trim();
    // 상한을 둔다 — 지시문이 남의 토큰 예산을 잠식하면 안 된다(메모리 예산과 같은 규칙).
    return text;
  } catch {
    return "";
  }
}

/** [튜닝값, 근거 없음] — 현재 정본 지시문이 약 3.7KB 라 두 배 여유를 둔다. */
const ONE_DIRECTIVE_MAX_CHARS = 8000;

/**
 * Declared modules of the session prompt (docs/PROMPT-COMPOSITION-POLICY.md; ledger terminal.session.turn.system,
 * terminal.session.native.stable, terminal.session.native.turn-context). Each module names its lifetime and what changes
 * it; composeDeclaredPrompt (prompt-order.cjs, generated from the Desktop canonical prompt-order.ts) orders them
 * fixed → variable with the closing output contract last. A request-matched block (memory detail, credential reminder)
 * is turn content: present on some requests only, so it sits below the fixed and configured modules.
 */
const SESSION_PROMPT_MODULES = Object.freeze({
  style: { id: "terminal.session.style", stability: "fixed-policy", changeTriggers: ["release"] },
  connection: { id: "terminal.session.connection-skill", stability: "fixed-policy", changeTriggers: ["release"] },
  governance: { id: "terminal.session.memory-governance", stability: "fixed-policy", changeTriggers: ["release"] },
  agent: { id: "terminal.session.agent-instructions", stability: "versioned-content", changeTriggers: ["agent-instructions"] },
  one: { id: "terminal.session.one-directive", stability: "versioned-content", changeTriggers: ["owner-profile"] },
  language: { id: "terminal.session.language", stability: "configuration", changeTriggers: ["locale"] },
  toolNotice: { id: "terminal.session.tool-access-notice", stability: "configuration", changeTriggers: ["capability-inventory", "permission"] },
  memoryDetail: { id: "terminal.session.memory-detail", stability: "turn-context", changeTriggers: ["owner-input"], order: 0 },
  credential: { id: "terminal.session.credential-reminder", stability: "turn-context", changeTriggers: ["owner-input"], order: 1 },
  recall: { id: "terminal.session.memory-recall", stability: "turn-context", changeTriggers: ["retrieval", "project-instructions"], order: 2 },
  contract: { id: "terminal.session.memory-output-contract", stability: "final-boundary", changeTriggers: ["release", "permission", "owner-input"] },
  sessionContract: { id: "terminal.session.memory-output-contract.session", stability: "final-boundary", changeTriggers: ["release"] },
  turnBinding: { id: "terminal.session.turn-binding", stability: "final-boundary", changeTriggers: ["permission", "owner-input"] },
});
const sessionPart = (key, text) => ({ ...SESSION_PROMPT_MODULES[key], text: text || "" });

/**
 * The session prompt in the three shapes a turn can need (docs/PROMPT-COMPOSITION-POLICY.md):
 *  - `joined`: one request (fresh or stateless runtime) — the memory output contract and this turn's binding close it
 *    (augmentSystem returns exactly this);
 *  - `stable` + `turn`: a retained native session. `stable` keeps the same bytes every spawn and ends with the output
 *    contract ("turn_id: given in each turn's context"); `turn` carries what changes per turn — this request's credential
 *    reminder, recalled memory and the turn_id/permission lines — as turn context in front of the user message.
 * Measured 2026-10-14 with random turn ids: a resumed Claude turn without system text kept guessing the previous id (0/4);
 * re-appending the whole prompt with the new id in the system tail also failed (0/2); a Codex thread keeps the
 * developer instructions it started with, so an id there sticks (0/5 on resume). The split shape passed 3/3 resumed turns
 * on Claude and on Codex (Codex reads `stable` as developer_instructions; in the user message it ignored the contract).
 */
function augmentSystemParts(db, baseSystem, ctx, withEmitter, request = "") {
  const arch = loadArch();
  // imported/cloud/company agents follow the same global contract.
  const lang = (ctx && ctx.lang) || "en";
  const emitter = withEmitter ? memoryEmitterParts(request, arch, ctx && ctx.turnId, ctx && ctx.permission) : null;
  const credentialReminder = withEmitter ? credentialIndexReminderFor(request) : "";
  // Agentlas One's directive when it is on (canonical `~/.agentlas/one/directive.md`; CLAUDE.md/AGENTS.md blocks copy it).
  const oneDirective = loadOneDirective();
  // Tool access notice: the same sentence as Desktop `shared/tool-access-notice.ts` (parity test). A turn without tools
  // says so instead of staying silent; a failure never blocks the turn.
  let toolNotice = "";
  try {
    const { buildToolAccessNotice } = require("../tools/access-notice.cjs");
    toolNotice = buildToolAccessNotice({
      availableTools: (ctx && Array.isArray(ctx.availableTools)) ? ctx.availableTools : [],
      // The Hub catalog is reachable only through the hephaestus-network MCP; without it this turn, never point there.
      hubCatalogAvailable: Boolean(ctx && ctx.hubCatalogAvailable),
    });
  } catch { /* notice failure never blocks the turn */ }
  const recall = cliMemoryContext(db, ctx && ctx.projectPath, ctx && ctx.agentId, request);
  const fixedAndConfigured = [
    sessionPart("style", responseStyleDirective()),
    sessionPart("connection", loadGlobalConnectionSkill()),
    sessionPart("governance", emitter ? emitter.governance : ""),
    sessionPart("agent", baseSystem),
    sessionPart("one", oneDirective),
    sessionPart("language", responseLanguageDirective(lang)),
    sessionPart("toolNotice", toolNotice),
  ];
  const turnParts = [
    sessionPart("memoryDetail", emitter ? emitter.detail : ""),
    sessionPart("credential", credentialReminder),
    sessionPart("recall", recall),
  ];
  return {
    joined: composeDeclaredPrompt([...fixedAndConfigured, ...turnParts, sessionPart("contract", emitter ? emitter.binding : "")]),
    stable: composeDeclaredPrompt([...fixedAndConfigured,
      sessionPart("sessionContract", emitter ? `${emitter.contract}\nturn_id: given in each turn's context` : "")]),
    turn: composeDeclaredPrompt([...turnParts, sessionPart("turnBinding", emitter ? emitter.turnBinding : "")]),
  };
}

function augmentSystem(db, baseSystem, ctx, withEmitter, request = "") {
  return augmentSystemParts(db, baseSystem, ctx, withEmitter, request).joined;
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
  augmentSystemParts,
  SESSION_PROMPT_MODULES,
  loadGlobalConnectionSkill,
  readBoundedText,
};
