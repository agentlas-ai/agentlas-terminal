"use strict";
/*
 * workforce/deps — engine/agentlas-workforce.cjs (Agent Workforce Ontology 런타임)의
 * 의존성 주머니(D bag) 조립.
 *
 * v1에서는 모놀리스(engine/agentlas.cjs)의 lazy 팩토리 workforce()가 이 D를 만들었다
 * (legacy-v1-engine-snapshot, 10727–10858행). v2에서는 각 멤버를 모듈 경계에 맞게
 * 다시 배선한다:
 *
 *   cloudSessionCookie/fetchHub  → engine/cloud/hub-client.cjs
 *   userDataDir                  → engine/core/paths.cjs
 *   captureRuntime/runApi/buildChildEnv/projectCwd → engine/workforce/capture.cjs
 *   MCP tools/list               → engine/mcp (동의된 시스템 서버만)
 *   goal 연속성/컨텍스트 슬라이스 → engine/agentlas-core-harness.cjs (Agentlas Core CLI)
 *
 * 불변식(오너 결정, 약화 금지):
 *  - fail-closed 툴 루프: 여기서는 어떤 어휘/키워드 폴백도 만들지 않는다. 런타임이
 *    없으면 code="no_runtime"으로 정직하게 던진다.
 *  - 정확-릴리스 선택권은 호스트 LLM에 있다. D는 검색/검증/준비 전송로만 제공한다.
 *  - Hub의 거절 코드는 원문 그대로 전파된다(워크포스 모듈 내부 callHubTool 폴백이
 *    담당). v1과 동일하게 callHubTool을 주입하지 않고 fetchHub+cookie만 준다 —
 *    v2 hub-client.callHubTool은 다른 envelope 계약이라 여기 끼우면 안 된다.
 *  - 영수증(JSONL)에 시크릿 금지: 여기 append 계열은 워크포스 모듈이 이미 다이제스트/
 *    요약으로 재구성한 영수증 객체만 받아 기록한다. 원문 프롬프트/env/키를 절대
 *    추가로 끼워 넣지 않는다. 파일 권한은 0700 디렉터리 / 0600 파일.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { userDataDir } = require("../core/paths.cjs");
const hubClient = require("../cloud/hub-client.cjs");
const detect = require("../runtimes/detect.cjs");
const { roleMembers } = require("../runtimes/roles.cjs");
const capture = require("./capture.cjs");

// ── 런타임 해석 (v1 resolveRuntime의 워크포스 어댑터) ─────────────────────
// 워크포스 모듈이 기대하는 형태:
//   {mode:"cli", kind, model?, effort?} | {mode:"api", backend, model, effort?}
// 반환 정본은 orchestrator 런타임이며 roleRuntimes에 두 역할의 실제 실행 런타임을
// 동봉한다. stage별 선택은 agentlas-workforce.cjs가 수행한다.
function runtimeFromSelection(selection) {
  if (!selection || !selection.kind) return null;
  const common = {
    model: selection.model || null,
    effort: selection.effort || null,
    capabilities: ["code", "tools", ...(selection.longContext ? ["long-context"] : [])],
    efforts: [],
    source: selection.sourceLayer || selection.source || null,
    role: selection.role || null,
  };
  if (capture.RUNTIME_BIN[selection.kind]) {
    return { mode: "cli", kind: selection.kind, ...common };
  }
  if (selection.kind === "byok" && selection.backend) {
    return { mode: "api", backend: selection.backend, ...common };
  }
  if (selection.kind === "ollama") {
    return { mode: "api", backend: "ollama", ...common };
  }
  return null;
}

function legacyWorkforceRuntime(db, override) {
  let selectedOverride = override;
  if (!selectedOverride) {
    try {
      const saved = require("../agentlas-config.cjs").loadPrefs(userDataDir()).runtime;
      if (
        saved &&
        saved !== "auto" &&
        capture.RUNTIME_BIN[saved] &&
        capture.which(capture.RUNTIME_BIN[saved])
      ) {
        selectedOverride = saved;
      }
    } catch { /* prefs 없음 — 사다리 계속 */ }
  }
  const ar = db ? detect.activeRuntimeRow(db) : null;
  const active = ar
    ? runtimeFromSelection({
        role: "orchestrator",
        kind: ar.kind,
        backend: ar.backend,
        source: ar.source,
        model: ar.model,
        effort: null,
        longContext: Boolean(ar.long_context),
        sourceLayer: "active-runtime",
      })
    : null;
  if (selectedOverride) {
    if (!capture.RUNTIME_BIN[selectedOverride]) {
      const error = new Error(
        `unknown workforce runtime: ${selectedOverride} (capture drivers: ${Object.keys(capture.RUNTIME_BIN).join(", ")})`,
      );
      error.code = "no_runtime";
      throw error;
    }
    return active && active.mode === "cli" && active.kind === selectedOverride
      ? active
      : { mode: "cli", kind: selectedOverride, model: null, effort: null };
  }
  if (active) return active;
  for (const kind of Object.keys(capture.RUNTIME_BIN)) {
    if (capture.which(capture.RUNTIME_BIN[kind])) {
      return { mode: "cli", kind, model: null, effort: null, source: "detected" };
    }
  }
  const error = new Error(
    "no_runtime: no agent CLI or connected API runtime found (claude / codex / Antigravity agy / legacy gemini / BYOK / Ollama).",
  );
  error.code = "no_runtime";
  throw error;
}

// 명시 override 또는 Dashboard에 저장된 role priority만 실행 권위다.
function resolveWorkforceRuntime(db, override) {
  if (override) {
    const exact = legacyWorkforceRuntime(db, override);
    return {
      ...exact,
      role: "orchestrator",
      roleRuntimes: {
        orchestrator: { ...exact, role: "orchestrator" },
        worker: { ...exact, role: "worker" },
      },
    };
  }
  const orchestrator = runtimeFromSelection(roleMembers(db, "orchestrator")[0] || null);
  const worker = runtimeFromSelection(roleMembers(db, "worker")[0] || null);
  if (!orchestrator || !worker) {
    const error = new Error("Dashboard orchestrator and worker priorities are required for Workforce execution.");
    error.code = "no_runtime_role_priority";
    throw error;
  }
  return {
    ...orchestrator,
    role: "orchestrator",
    roleRuntimes: {
      orchestrator: { ...orchestrator, role: "orchestrator" },
      worker: { ...worker, role: "worker" },
    },
  };
}

// ── 영수증 (v1 모놀리스의 JSONL 계약 포팅: userData 하위, 0700/0600) ──────
function receiptFile() {
  return path.join(userDataDir(), "workforce-execution-receipts.jsonl");
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function appendReceipt(receipt) {
  appendJsonl(receiptFile(), receipt);
}

function appendAuditReceipt(audit) {
  appendJsonl(path.join(userDataDir(), "workforce-orchestration-audits.jsonl"), audit);
}

function persistBenchmarkArtifact(artifact, executionIdHint) {
  const directory = path.join(userDataDir(), "workforce-benchmarks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 실패 런에는 executionReceipt가 없다. 이미 만들어진 run id를 써서 반복 실패가
  // workforce-run.json 하나를 조용히 덮지 않고 개별 포렌식 아티팩트로 남게 한다.
  const executionId = String(artifact?.executionReceipt?.executionId || executionIdHint || `workforce-run:${crypto.randomUUID()}`)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 180);
  const file = path.join(directory, `${executionId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

// ── 로컬 MCP tools/list 인벤토리 (v1 listWorkforceToolsCli 포팅) ──────────
// 동의된(consented) 시스템 MCP 서버만 프리플라이트한다. Terminal의 원샷 러너는
// 아직 "정확 per-tool 부착 경계"를 증명하지 못하므로, 실제 tools/list 관측은
// 보존하되 runtimeIds=[] / status="observed-not-executable"로 광고한다 —
// 필요 capability에 대해 워크포스 모듈이 플래너 전에 fail-closed 하게 된다.
// 권한을 제조하는 것보다 정직 정지가 계약이다.
// 워커가 실제로 부여받을 수 있는 유일한 네이티브 도구 집합 — 읽기 전용.
// claude-code는 plan 모드(쓰기·실행 거부) + --allowedTools 로 이 경계를 강제할 수 있어
// "정확 per-tool 부착"이 증명된다. 쓰기·셸·네트워크·MCP는 여전히 증명 불가라 잠긴 채다.
const READ_ONLY_NATIVE_TOOLS = ["Read", "Grep", "Glob"];
const READ_ONLY_BUILTIN_TOOL_ID = "builtin:file-read";
const READ_ONLY_CAPABILITY_IDS = ["tool:file-read"];
const READ_ONLY_RUNTIME_IDS = ["runtime:claude-code"];

function readOnlyBuiltinToolRows(roster, runtimeId) {
  if (!READ_ONLY_RUNTIME_IDS.includes(String(runtimeId || ""))) return [];
  const rows = [];
  for (const pinned of roster || []) {
    // 허브가 이 릴리스에 파일 읽기를 허용했을 때만. deny면 존중하고 부여하지 않는다.
    if (pinned?.permissionPolicy?.fileRead?.mode !== "manifest-allowlist") continue;
    rows.push({
      slotId: pinned.slotId,
      agentReleaseId: pinned.agentReleaseId,
      permissionPolicyDigest: pinned.permissionPolicyDigest,
      provider: "builtin",
      toolId: READ_ONLY_BUILTIN_TOOL_ID,
      // 내장 도구는 MCP 서버가 없다. validateToolInventory는 serverId가 정확히 null이
      // 아니면 거절한다(2026-07-27 라이브: "builtin" 문자열을 넣어 prepare 직후 전량 폐기).
      serverId: null,
      description: "Read-only project file access (Read/Grep/Glob, no write, no shell)",
      inputSchemaDigest: null,
      runtimeIds: [...READ_ONLY_RUNTIME_IDS],
      selectiveEnforcement: "exact-tool-allowlist",
      capabilityIds: [...READ_ONLY_CAPABILITY_IDS],
      status: "ready",
    });
  }
  return rows;
}

async function listWorkforceTools({ db, roster, cwd, env, timeoutMs, signal, runtimeId }) {
  const mcp = require("../mcp/index.cjs");
  // 읽기 전용 내장 도구는 MCP 서버 유무와 무관하게 항상 제공한다.
  const builtinRows = readOnlyBuiltinToolRows(roster, runtimeId);
  const servers = mcp.readConsentedSystemMcpServers(db, {
    userDataDir: userDataDir(),
    createRuntimeHome: false,
  }).slice(0, 8);
  if (!servers.length) return builtinRows;
  const deadline = Date.now() + Math.max(50, Math.min(12_000, Number(timeoutMs) || 12_000));
  const outcomes = new Array(servers.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= servers.length) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return;
      outcomes[index] = await mcp.probeSystemMcpServerConnection(servers[index], {
        cwd,
        env,
        userDataDir: userDataDir(),
        timeoutMs: Math.min(4_000, remaining),
        signal,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, servers.length) }, () => worker()));

  const safeId = /^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/;
  const rows = [...builtinRows];
  for (let index = 0; index < servers.length; index += 1) {
    const server = servers[index];
    const listed = outcomes[index];
    if (!listed?.connected || !Array.isArray(listed.tools)) continue;
    for (const tool of listed.tools.slice(0, 256)) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
      const declared = tool._meta?.agentlas || {};
      const toolId = typeof declared.toolId === "string" ? declared.toolId : String(tool.name || "");
      const capabilityIds = Array.isArray(declared.capabilityIds)
        ? [...new Set(declared.capabilityIds.filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,255}$/.test(String(id))))]
        : [];
      if (!safeId.test(toolId) || !capabilityIds.length) continue;
      const schemaJson = JSON.stringify(tool.inputSchema || {}, Object.keys(tool.inputSchema || {}).sort());
      for (const pinned of roster || []) {
        if (pinned?.permissionPolicy?.mcp?.mode !== "allowlist" || !pinned.permissionPolicy.mcp.allowedTools.includes(toolId)) continue;
        rows.push({
          slotId: pinned.slotId,
          agentReleaseId: pinned.agentReleaseId,
          permissionPolicyDigest: pinned.permissionPolicyDigest,
          provider: "mcp",
          toolId,
          serverId: server.id,
          description: "Ready consented host MCP tool",
          inputSchemaDigest: `sha256:${crypto.createHash("sha256").update(schemaJson).digest("hex")}`,
          // Terminal의 원샷 native/API 러너는 아직 정확 per-tool 부착 경계를 증명하지
          // 못한다. 실제 tools/list 관측은 보존하되 실행 가능한 런타임을 광고하지
          // 않는다 — collectToolInventory가 이 행을 걸러 required capability에 대해
          // 플래너 전에 fail-closed 한다.
          runtimeIds: [],
          selectiveEnforcement: "unavailable",
          capabilityIds,
          status: "observed-not-executable",
        });
      }
    }
  }
  return rows;
}

// ── Workforce goal 연속성 (v1 포팅 — Agentlas Core CLI 경유) ─────────────
// goal-bind / goal-runtime / goal-turn / goal-complete는 Core의 workforce
// 명령으로 실행된다. Core가 없으면 정직하게 실패한다(조용한 생략 금지 —
// 워크포스 모듈이 goal_binding_unavailable 계열로 fail-closed 처리).
function coreHarness() {
  return require("../agentlas-core-harness.cjs");
}

async function workforceAccountContext() {
  const cookie = await hubClient.cloudSessionCookie();
  // 가장 흔한 로그아웃 경로 — 마커가 없으면 표시 경계가 삼켜 "복구 중" 한 줄이 된다.
  if (!cookie) {
    throw Object.assign(
      new Error("Agentlas sign-in required — run `agentlas login`, then retry."),
      { code: "auth_required", honestStop: true },
    );
  }
  const webBase = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const mcpBase = (process.env.AGENTLAS_MCP_BASE_URL || `${webBase}/api/mcp/v1`).replace(/\/$/, "");
  const response = await hubClient.fetchHub(mcpBase, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie,
      origin: webBase,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: "agentlas.account_context", arguments: {} },
    }),
  });
  /*
   * 서버의 로그인 안내를 먼저 중계한다 (2026-08-11 존폐 판단 결함 4).
   * 실사고: 세션 만료 시 서버는 auth_required + 로그인 방법을 친절히 돌려줬는데,
   * 클라이언트가 그 필드를 안 보고 스키마 검사부터 실패시켜 "유효하지 않은 연속성
   * 영수증"으로 오진했고, 그 오진마저 표시 경계가 지웠다 — 안내가 세 번 소실됐다.
   * 기계 code를 달아 표시 경계(usage/honestStop 통과 조건)를 지나게 한다.
   */
  const authRequiredError = (detail) => Object.assign(
    new Error(detail || "Agentlas sign-in required — run `agentlas login`, then retry."),
    { code: "auth_required", honestStop: true },
  );
  if (response.status === 401 || response.status === 403) throw authRequiredError();
  if (!response.ok) throw new Error(`Agentlas account context failed with HTTP ${response.status}.`);
  const rpc = hubClient.parseHubJson(response, "Agentlas account context");
  const text = rpc?.result?.content?.[0]?.text;
  let payload;
  try { payload = JSON.parse(String(text || "")); } catch { payload = null; }
  const authMarker = [payload?.error, payload?.code, rpc?.error?.code, rpc?.error?.message]
    .map((v) => String(v || ""))
    .find((v) => /auth_required|unauthorized|not signed in/i.test(v));
  if (authMarker) {
    const hint = String(payload?.message || payload?.hint || rpc?.error?.message || "").slice(0, 400);
    throw authRequiredError(hint ? `${hint} — run \`agentlas login\`, then retry.` : null);
  }
  // 연속성 영수증은 스키마·계정 다이제스트·과금 권한을 정확히 검증한다 — 위조/구버전
  // 응답으로 goal 바인딩을 진행하면 안 된다.
  if (
    !payload ||
    payload.schemaVersion !== "agentlas.account-context.v1" ||
    !/^sha256:[0-9a-f]{64}$/.test(String(payload.accountSubject || "")) ||
    payload.leaseWindowHours !== 24 ||
    payload.billingAuthority !== "agentlas-web"
  ) {
    throw new Error("Agentlas account context returned an invalid continuity receipt.");
  }
  return { ...payload, webBase };
}

function implicitWorkforceGoalId(workOrder) {
  const seed = String(workOrder?.workOrderId || "").trim();
  if (!seed) throw new Error("Workforce WorkOrder id is required for automatic continuity.");
  return `goal:auto:${crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 40)}`;
}

// 준비된 실행 계획은 핀·다이제스트를 담으므로 0700/0600 전용 임시 경로로만 Core에
// 전달하고 반드시 지운다(argv/공유 tmp 노출 금지).
async function withPrivateWorkforcePlan(plan, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-workforce-goal-"));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "prepared.json");
    fs.writeFileSync(file, `${JSON.stringify(plan)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await callback(file);
  } finally {
    try {
      const file = path.join(directory, "prepared.json");
      if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
      fs.rmdirSync(directory);
    } catch {
      // 임시 경로에는 이 호출의 prepared plan만 있다. 외부 스캐너가 unlink와 경합해도
      // 이후 OS temp 정리로 안전하다.
    }
  }
}

async function bindWorkforceGoal({ workOrder, candidateSet, selection, validationReceipt, prepared, cwd, goalId }) {
  const core = coreHarness();
  const coreRoot = core.resolveCoreRuntimeRoot();
  if (!coreRoot) throw new Error("Agentlas Core is unavailable for mandatory Workforce goal binding.");
  const account = await workforceAccountContext();
  const resolvedGoalId = String(goalId || "").trim() || implicitWorkforceGoalId(workOrder);
  const continuation = {
    schemaVersion: "agentlas.workforce-terminal-continuation.v1",
    status: "prepared",
    runtimeSourcePins: (prepared?.executionRoster || []).map((row) => ({
      slotId: row.slotId,
      agentReleaseId: row.agentReleaseId,
      source: "hub",
    })),
    workOrder,
    candidateSet,
    selection,
    validationReceipt,
    executionPlan: prepared,
  };
  return withPrivateWorkforcePlan(continuation, (file) =>
    core.captureCoreJson(
      "agentlas_cloud",
      [
        "workforce", "goal-bind", resolvedGoalId, file,
        "--project", path.resolve(cwd || process.cwd()),
        "--account-subject", account.accountSubject,
        "--hub-base-url", account.webBase,
        "--label", "automatic Terminal Workforce continuity",
      ],
      { cwd: path.resolve(cwd || process.cwd()) },
      coreRoot,
    )
  );
}

async function loadWorkforceGoalRuntime(cwd, goalId = null) {
  const core = coreHarness();
  const coreRoot = core.resolveCoreRuntimeRoot();
  if (!coreRoot) throw new Error("Agentlas Core is unavailable for Workforce continuation.");
  const account = await workforceAccountContext();
  const args = [
    "workforce", "goal-runtime",
    "--project", path.resolve(cwd || process.cwd()),
    "--account-subject", account.accountSubject,
    "--hub-base-url", account.webBase,
  ];
  if (goalId) args.push("--goal-id", String(goalId));
  return core.captureCoreJson(
    "agentlas_cloud",
    args,
    { cwd: path.resolve(cwd || process.cwd()) },
    coreRoot,
  );
}

async function completeWorkforceGoal(cwd, goalId = null, status = "completed") {
  const core = coreHarness();
  const coreRoot = core.resolveCoreRuntimeRoot();
  if (!coreRoot) throw new Error("Agentlas Core is unavailable for explicit Workforce completion.");
  const account = await workforceAccountContext();
  const project = path.resolve(cwd || process.cwd());
  let resolvedGoalId = String(goalId || "").trim();
  if (!resolvedGoalId) {
    const context = await loadWorkforceGoalRuntime(project);
    resolvedGoalId = String(context?.goals?.[0]?.goalId || "");
  }
  if (!resolvedGoalId) throw new Error("No active Workforce goal exists in this account/project.");
  return core.captureCoreJson(
    "agentlas_cloud",
    [
      "workforce", "goal-complete", resolvedGoalId,
      "--project", project,
      "--account-subject", account.accountSubject,
      "--hub-base-url", account.webBase,
      "--status", status === "cancelled" ? "cancelled" : "completed",
      "--reason", "explicit-terminal-user-command",
      "--explicit",
    ],
    { cwd: project },
    coreRoot,
  );
}

async function recordWorkforceGoalTurn({
  cwd,
  goalId,
  decision,
  usedRosterKeys = [],
  localSkillIds = [],
  gapCodes = [],
  hostRuntime = null,
  turnId = null,
}) {
  const core = coreHarness();
  const coreRoot = core.resolveCoreRuntimeRoot();
  if (!coreRoot) throw new Error("Agentlas Core is unavailable for Workforce turn receipts.");
  const account = await workforceAccountContext();
  const args = [
    "workforce", "goal-turn",
    String(goalId),
    String(turnId || `turn:terminal:${crypto.randomUUID()}`),
    String(decision),
    "--project", path.resolve(cwd || process.cwd()),
    "--account-subject", account.accountSubject,
    "--hub-base-url", account.webBase,
  ];
  if (hostRuntime) args.push("--host-runtime", String(hostRuntime));
  for (const key of usedRosterKeys) args.push("--use-roster", String(key));
  for (const skill of localSkillIds) args.push("--local-skill", String(skill));
  for (const gap of gapCodes) args.push("--gap", String(gap));
  return core.captureCoreJson(
    "agentlas_cloud",
    args,
    { cwd: path.resolve(cwd || process.cwd()) },
    coreRoot,
  );
}

// ── 프로젝트 컨텍스트 슬라이스 (v1 cliProjectContextSlice 포팅) ──────────
// Core context slice는 워크포스 계약상 "있으면 좋은" 보강이다: 워크포스 모듈은
// 빈 문자열을 '컨텍스트 없음'으로 취급한다(runModel 1678–1683행). 그래서 이 함수는
// Core 부재/타임아웃 시 조용히 ""를 반환한다 — 이것은 폴백이 아니라 계약된 부재다.
// 소스 경로/내용은 프로젝트 로컬에 머무르며 Network/Cloud 검색으로 절대 안 나간다.
function projectContextSlice(projectPath, task) {
  if (!projectPath || !String(task || "").trim()) return "";
  try {
    const core = coreHarness();
    const coreRoot = core.resolveContextMapCoreRoot();
    if (!coreRoot) return "";
    const result = core.captureCoreJsonSync(
      "agentlas_cloud",
      [
        "context", "slice",
        "--project", projectPath,
        "--task-stdin",
        "--no-refresh",
        "--render",
      ],
      {
        cwd: projectPath,
        input: String(task || "").slice(0, 12_000),
        timeout: 4_000,
      },
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
 * D bag 조립. ctx = { lang?, out? } (엔진 DI 객체의 부분집합).
 * 모든 멤버는 v1 workforce() 팩토리와 같은 계약 형태를 유지한다.
 */
function buildWorkforceDeps(ctx = {}) {
  return {
    now: () => new Date(),
    out: typeof ctx.out === "function" ? ctx.out : (s) => process.stdout.write(`${s}\n`),
    // Phase 1-2: 엔진 ctx의 Ui를 관통시킨다 — 워크포스가 자체 Ui를 만들지 않게.
    uiInstance: ctx.uiInstance || null,
    prefsLang: () => ctx.lang || "en",
    userDataDir,
    projectCwd: capture.projectCwd,
    // 무도구 핀 호출 전용 중립 작업 폴더 — 프로젝트 작업트리의 설정/지시문/디렉터리
    // 문맥이 자식 CLI로 새는 것을 끊는다(agentlas-workforce.cjs neutralCwd 계약).
    runCwd: capture.runCwd,
    cloudSessionCookie: hubClient.cloudSessionCookie,
    // v1과 동일: callHubTool은 주입하지 않는다. 워크포스 모듈 내부의 jsonrpc 경로가
    // 거절 코드 원문 전파·retryClass 계약을 소유하며, fetchHub는 버퍼드
    // {ok,status,headers,text} 어댑터 형태를 만족한다(3중 타임아웃 + 16MB 상한).
    // 워크포스 전용 타임아웃: prepare_execution은 서버가 로스터 번들을 조립하는 동안
    // 첫 바이트 없이 계산한다(1슬롯 실측 7.2s, 다슬롯은 그 배수). 기본 connect 15s는
    // 실제로는 "응답 헤더까지"를 재므로 다슬롯 준비를 처형한다(2026-07-27 전송오류
    // 2연속의 진범). 준비 상한을 여유 있게 준다 — idle/total 계약은 유지.
    fetchHub: (url, init) => hubClient.fetchHub(url, init, {
      timeoutConfig: { connectMs: 120_000, idleMs: 60_000, totalMs: 300_000 },
    }),
    resolveRuntime: resolveWorkforceRuntime,
    captureRuntime: capture.captureRuntime,
    runApi: capture.runApi,
    buildChildEnv: capture.buildChildEnv,
    receiptFile,
    appendReceipt,
    appendAuditReceipt,
    persistBenchmarkArtifact,
    listWorkforceTools,
    // 호스트가 자기 도구를 빌려주는 결정은 허브 후보 자격과 무관하다.
    // requiredToolCapabilities는 "이 허브 에이전트가 그 도구를 선언했는가"라는
    // 후보 필터라서, 선언한 에이전트가 사실상 0이라 그걸 쓰면 후보가 0건이 된다
    // (2026-07-27 실측: 그래서 리더가 절대 선언하지 않았고 부여가 영영 발동 안 됨).
    // 읽기 권한 대여는 허브가 그 릴리스에 파일 읽기를 허용했는지만 보면 된다.
    hostReadOnlyGrants: (roster, runtimeId) => readOnlyBuiltinToolRows(roster, runtimeId),
    // 읽기 전용 내장 도구는 claude-code plan 모드 + --allowedTools/--disallowedTools로
    // 정확 경계가 증명된다 → 부여 허용. 그 밖(쓰기·셸·네트워크·MCP)은 여전히 증명
    // 불가라 거부한다. 증명 없이 true를 돌려주면 권한 제조가 된다.
    supportsWorkforceToolAuthority: async ({ grantedToolIds }) =>
      Array.isArray(grantedToolIds)
      && grantedToolIds.length > 0
      && grantedToolIds.every((id) => id === READ_ONLY_BUILTIN_TOOL_ID),
    bindWorkforceGoal,
    loadWorkforceGoalRuntime,
    recordWorkforceGoalTurn,
    projectContextSlice,
  };
}

let _workforce = null;
/** 워크포스 런타임 lazy 싱글턴 — v1 workforce() 팩토리와 동일한 수명 규칙. */
function workforceRuntime(ctx = {}) {
  if (!_workforce) {
    _workforce = require("../agentlas-workforce.cjs").create(buildWorkforceDeps(ctx));
  }
  return _workforce;
}

/*
 * 로컬 Core 전송을 실은 1회용 런타임 (2026-08-05, hep-* 네이티브 배선).
 * 싱글턴을 쓰지 않는 이유: D.callHubTool은 명령 수명의 stdio 프로세스와 validate
 * 계보 상태를 붙잡는다 — 공유하면 다음 편성이 앞 편성의 계보를 이어받는다.
 * 원격 기본 경로(workforceRuntime)는 여기서 아무것도 바뀌지 않는다.
 */
function createLocalCoreWorkforceRuntime(ctx, transport) {
  const deps = buildWorkforceDeps(ctx);
  deps.callHubTool = transport.callHubTool;
  return require("../agentlas-workforce.cjs").create(deps);
}

module.exports = {
  buildWorkforceDeps,
  workforceRuntime,
  createLocalCoreWorkforceRuntime,
  resolveWorkforceRuntime,
  receiptFile,
  appendReceipt,
  appendAuditReceipt,
  persistBenchmarkArtifact,
  listWorkforceTools,
  readOnlyBuiltinToolRows,
  READ_ONLY_NATIVE_TOOLS,
  READ_ONLY_BUILTIN_TOOL_ID,
  bindWorkforceGoal,
  loadWorkforceGoalRuntime,
  completeWorkforceGoal,
  recordWorkforceGoalTurn,
  projectContextSlice,
  workforceAccountContext,
};
