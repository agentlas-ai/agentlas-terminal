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
const capture = require("./capture.cjs");

// ── 런타임 해석 (v1 resolveRuntime의 워크포스 어댑터) ─────────────────────
// 워크포스 모듈이 기대하는 형태: {mode:"cli", kind, model?} | {mode:"api", backend, model}.
// v2 runtimes/resolve.cjs는 {kind, bin, source}만 주고 BYOK/Ollama를 모르므로,
// v1의 사다리(명시 override > prefs 저장값 > 공유 DB active_runtime(byok/ollama 포함)
// > PATH 탐지)를 여기서 복원한다. 아무것도 없으면 no_runtime 정직 정지 — 폴백 금지.
function resolveWorkforceRuntime(db, override) {
  if (!override) {
    try {
      const saved = require("../agentlas-config.cjs").loadPrefs(userDataDir()).runtime;
      if (saved && saved !== "auto" && capture.RUNTIME_BIN[saved] && capture.which(capture.RUNTIME_BIN[saved])) override = saved;
    } catch { /* prefs 없음 — 사다리 계속 */ }
  }
  const ar = db ? detect.activeRuntimeRow(db) : null;
  const activeCli = ar && capture.RUNTIME_BIN[ar.kind]
    ? {
        mode: "cli",
        kind: ar.kind,
        model: ar.model || null,
        capabilities: ["code", "tools", ...(ar.long_context ? ["long-context"] : [])],
        efforts: [],
      }
    : null;
  if (override) {
    if (!capture.RUNTIME_BIN[override]) {
      const error = new Error(`unknown workforce runtime: ${override} (capture drivers: ${Object.keys(capture.RUNTIME_BIN).join(", ")})`);
      error.code = "no_runtime";
      throw error;
    }
    return activeCli && activeCli.kind === override ? activeCli : { mode: "cli", kind: override };
  }
  if (activeCli) return activeCli;
  if (ar && ar.kind === "byok" && ar.backend) return { mode: "api", backend: ar.backend, model: ar.model };
  if (ar && ar.kind === "ollama") return { mode: "api", backend: "ollama", model: ar.model };
  for (const kind of Object.keys(capture.RUNTIME_BIN)) {
    if (capture.which(capture.RUNTIME_BIN[kind])) return { mode: "cli", kind };
  }
  const error = new Error("no_runtime: no agent CLI or connected API runtime found (claude / codex / gemini / BYOK / Ollama).");
  error.code = "no_runtime";
  throw error;
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
async function listWorkforceTools({ db, roster, cwd, env, timeoutMs, signal }) {
  const mcp = require("../mcp/index.cjs");
  const servers = mcp.readConsentedSystemMcpServers(db, {
    userDataDir: userDataDir(),
    createRuntimeHome: false,
  }).slice(0, 8);
  if (!servers.length) return [];
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
  const rows = [];
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
  if (!cookie) throw new Error("Agentlas sign-in is required for cross-session Workforce continuity.");
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
  if (!response.ok) throw new Error(`Agentlas account context failed with HTTP ${response.status}.`);
  const rpc = hubClient.parseHubJson(response, "Agentlas account context");
  const text = rpc?.result?.content?.[0]?.text;
  let payload;
  try { payload = JSON.parse(String(text || "")); } catch { payload = null; }
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
    const coreRoot = core.resolveCoreRuntimeRoot();
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
    prefsLang: () => ctx.lang || "en",
    userDataDir,
    projectCwd: capture.projectCwd,
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
    // Terminal 원샷 러너는 네이티브 per-tool 권한 부여 경계를 아직 증명하지 못했다.
    // 증명 없이 true를 돌려주면 권한 제조가 된다 — v1과 동일하게 항상 false.
    supportsWorkforceToolAuthority: async () => false,
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

module.exports = {
  buildWorkforceDeps,
  workforceRuntime,
  resolveWorkforceRuntime,
  receiptFile,
  appendReceipt,
  appendAuditReceipt,
  persistBenchmarkArtifact,
  listWorkforceTools,
  bindWorkforceGoal,
  loadWorkforceGoalRuntime,
  completeWorkforceGoal,
  recordWorkforceGoalTurn,
  projectContextSlice,
  workforceAccountContext,
};
