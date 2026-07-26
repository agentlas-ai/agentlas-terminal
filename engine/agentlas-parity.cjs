"use strict";
/*
 * agentlas-parity: 데스크탑 앱 전용이던 기능의 터미널 패리티 구현.
 *
 *   storm      — Agentlas-owned Goal/UltraCode harness (Hephaestus route evidence + local parallel workers)
 *   swarm      — emergent 에이전트 스웜 (블랙보드 + `## Spawn` 그래프 성장 + 종합)
 *   automation — 앱 스케줄러가 실행하는 자동화의 등록/목록/토글 (같은 SQLite)
 *   usage      — 로컬 실행/자동화/세션 집계
 *   telegram   — 텔레그램 바인딩 현황 (읽기 전용; 페어링은 앱 Connect)
 *   cloud search — 마켓플레이스 검색 (MCP marketplace.search_agents)
 *
 * agentlas.cjs 가 create(deps)로 주입한 헬퍼(captureRuntime/runApi/resolveRuntime 등)만
 * 사용한다 — 이 파일은 DB 스키마와 프로세스 스폰 외에 자체 상태를 갖지 않는다.
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Ui } = require("./agentlas-ui.cjs");
const { truncateWidth, visWidth, wrapWidth } = require("./agentlas-composer.cjs");
const permissionPolicy = require("./agentlas-permissions.cjs");
const workloadRouting = require("./agentlas-workload-routing.cjs");
const {
  CONTEXT_MAP_MIN_CORE_VERSION,
  loadCoreStormbreakerHarness,
  resolveCoreRuntimeRoot,
  spawnCoreModule,
} = require("./agentlas-core-harness.cjs");

// ── 스웜 상수 (앱 mcp/swarm-run.ts 와 동일한 안전 상한) ──
const SWARM_MAX_TASKS = 24;
const SWARM_SPAWN_PER_TURN = 12;

// Agentlas-OS/Hephaestus 내부 시스템 에이전트(마켓 제품 아님) — 검색/목록에서 숨긴다.
// 데스크탑 electron/agents/hired-agents.ts isInternalAgentSlug 와 규칙 동일.
function isInternalAgentSlug(slug) {
  const s = String(slug || "").toLowerCase();
  return /^researcher-\d+/.test(s) || s === "research-intelligence-desk" || s.startsWith("hephaestus-");
}

const LOGIN_CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 180_000;
const MAX_LOGIN_SESSION_BYTES = 16 * 1024;

function createLoginState(randomBytes = crypto.randomBytes) {
  const bytes = Buffer.from(randomBytes(32));
  if (bytes.length !== 32) throw new Error("Could not create the login state.");
  return bytes.toString("base64url");
}

function loginStatesMatch(actual, expected) {
  const left = Buffer.from(String(actual || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function routePreviewModel(value) {
  const json = value && typeof value === "object" ? value : {};
  const execution = json.execution && typeof json.execution === "object" ? json.execution : {};
  const hubResults = Array.isArray(json.hub?.results) ? json.hub.results : [];
  const idOf = (candidate) => {
    if (typeof candidate === "string") return candidate;
    return candidate && (candidate.slug || candidate.id || candidate.agent || candidate.name) || null;
  };
  const lookup = (candidate) => {
    const id = idOf(candidate);
    if (!id) return null;
    const match = hubResults.find((item) => idOf(item) === id);
    const source = match || (candidate && typeof candidate === "object" ? candidate : {});
    return {
      id,
      name: source.name || source.nameEn || source.title || id,
      nameEn: source.nameEn || source.name_en || source.name || source.title || id,
      kind: source.kind || source.entityKind || "",
    };
  };
  const selected = lookup(json.selected);
  const primary = lookup(execution.primary_agent || execution.recommended_agents?.[0]);
  const candidates = [];
  const add = (candidate) => {
    const normalized = lookup(candidate);
    if (!normalized || candidates.some((item) => item.id === normalized.id)) return;
    candidates.push(normalized);
  };
  add(selected);
  add(primary);
  for (const candidate of hubResults) add(candidate);
  for (const candidate of execution.recommended_agents || []) add(candidate);
  for (const candidate of execution.alternatives || []) add(candidate);
  return {
    selected,
    primary,
    candidates: candidates.slice(0, 6),
    scope: json.scope || json.hub?.scope || null,
    receiptId: json.receipt_id || null,
    needsRouter: !selected && json.router_agent?.mode === "escalate_to_router_agent",
  };
}

function researchPreviewModel(value) {
  const json = value && typeof value === "object" ? value : {};
  const request = json.request && typeof json.request === "object" ? json.request : {};
  const receipt = json.receipt && typeof json.receipt === "object" ? json.receipt : {};
  const policy = receipt.policy && typeof receipt.policy === "object"
    ? receipt.policy
    : (json.policy && typeof json.policy === "object" ? json.policy : {});
  const capability = json.capability_summary && typeof json.capability_summary === "object"
    ? json.capability_summary
    : {};
  const quality = policy.evidence_quality && typeof policy.evidence_quality === "object"
    ? policy.evidence_quality
    : {};
  const coverage = policy.evidence_coverage && typeof policy.evidence_coverage === "object"
    ? policy.evidence_coverage
    : {};
  const attempts = Array.isArray(receipt.attempts) ? receipt.attempts : [];
  const results = Array.isArray(json.results) ? json.results : [];
  const summary = json.summary && typeof json.summary === "object" ? json.summary : {};
  const modules = [
    ...(Array.isArray(receipt.module_chain) ? receipt.module_chain : []),
    ...(Array.isArray(json.ready_mounted_modules) ? json.ready_mounted_modules : []),
    ...(Array.isArray(json.mounted_modules) ? json.mounted_modules : []),
  ].filter((item, index, array) => item && array.indexOf(item) === index);
  const intent = request.intent || (
    String(json.schema || "").includes(".status.") ? "status"
      : String(json.schema || "").includes(".plan.") ? "plan"
        : "research"
  );
  const maxRequests = request.max_cost?.requests
    ?? policy.request_budget?.max_requests
    ?? policy.max_cost_requests
    ?? null;
  const totalEvidenceFailure = ["search", "read", "gather"].includes(intent)
    && results.length === 0
    && (
      capability.status === "missing_evidence"
      || capability.trust?.can_use_for_build_context === false
      || quality.status === "none"
      || coverage.status === "missing"
    );
  return {
    schema: json.schema || "",
    status: json.status || "unknown",
    intent,
    query: request.query || "",
    loadout: request.loadout || policy.loadout?.name || "",
    depth: request.depth || "",
    maxRequests,
    networkWillRun: json.network_will_run ?? policy.network_will_run,
    receiptWillBeWritten: policy.receipt_will_be_written,
    privateHostsBlocked: policy.private_hosts_blocked,
    browserMounted: policy.browser_modules_mounted,
    goalReady: json.goal_ready,
    coreReady: summary.core_engine_ok,
    publicFallbackReady: summary.public_social_fallbacks_ok,
    browserReady: summary.browser_hardpoint_ok,
    socialReady: summary.credentialed_social_ok,
    incompleteCount: summary.incomplete_count,
    missingProofs: Array.isArray(summary.missing_or_unready_proofs) ? summary.missing_or_unready_proofs : [],
    modules,
    attempts,
    results,
    qualityStatus: quality.status || "",
    qualityScore: quality.score,
    coverageStatus: coverage.status || "",
    warnings: Array.isArray(capability.trust?.warnings) ? capability.trust.warnings : [],
    canUseForBuildContext: capability.trust?.can_use_for_build_context,
    receiptId: receipt.receipt_id || json.receipt_id || "",
    totalEvidenceFailure,
  };
}

/**
 * OAuth loopback callback의 1회용 state guard. `/callback` GET이 도착하면 성공/실패와
 * 무관하게 transaction을 소비한다. 따라서 잘못된 state 뒤에 공격자 세션을 재주입하거나,
 * 성공 URL을 재생해 다른 세션으로 덮어쓸 수 없다.
 */
function createLoginCallbackGuard(expectedState) {
  let consumed = false;
  return {
    consume(rawUrl, method = "GET") {
      let url;
      try {
        url = new URL(String(rawUrl || "/"), "http://127.0.0.1");
      } catch {
        return { handled: true, final: false, ok: false, statusCode: 400, message: "Invalid login callback." };
      }
      if (url.pathname !== LOGIN_CALLBACK_PATH) {
        return { handled: false, final: false, ok: false, statusCode: 404, message: "not found" };
      }
      if (method !== "GET") {
        return { handled: true, final: false, ok: false, statusCode: 405, message: "method not allowed" };
      }
      if (consumed) {
        return { handled: true, final: false, ok: false, statusCode: 410, message: "Login callback has already been used." };
      }
      consumed = true;

      if (!loginStatesMatch(url.searchParams.get("state"), expectedState)) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "Login callback state validation failed. Run agentlas login again.",
        };
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const safeCode = /^[A-Za-z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "oauth_error";
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: `Agentlas login denied: ${safeCode}`,
        };
      }
      const value = url.searchParams.get("session") || url.searchParams.get("token") || "";
      if (!value) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "The callback did not include a session value.",
        };
      }
      if (Buffer.byteLength(value, "utf8") > MAX_LOGIN_SESSION_BYTES) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "The login session value is too large.",
        };
      }
      return { handled: true, final: true, ok: true, statusCode: 200, value, message: "Agentlas login complete" };
    },
    isConsumed() { return consumed; },
  };
}

function create(deps) {
  const D = deps;
  const isKo = () => D.prefsLang && D.prefsLang() === "ko";

  function newUi(lang) {
    return new Ui({ lang: lang || D.prefsLang() });
  }

  // ── Hephaestus 런타임 해석 (설치 런처 우선, 앱 번들 폴백) ──
  function hephaestusBin() {
    const candidates = [
      process.env.HEPHAESTUS_BIN,
      path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus"),
    ];
    for (const c of process.platform === "win32" ? [] : candidates) {
      try {
        if (c && fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return { kind: "bin", exec: c };
        }
      } catch { /* 다음 후보 */ }
    }
    const root = resolveCoreRuntimeRoot();
    if (root) return { kind: "python", root };
    return null;
  }

  function careerGraphRuntime() {
    const binCandidates = [
      process.env.HEPHAESTUS_CAREER_GRAPH_BIN,
      process.env.HEPHAESTUS_BIN ? path.join(path.dirname(process.env.HEPHAESTUS_BIN), "career-graph") : null,
      path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "career-graph"),
    ];
    for (const c of binCandidates) {
      try {
        if (c && fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return { kind: "bin", exec: c };
        }
      } catch { /* 다음 후보 */ }
    }
    const roots = [
      process.env.HEPHAESTUS_RUNTIME_ROOT,
      path.join(os.homedir(), ".agentlas", "runtime", "current"),
    ];
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "Hephaestus"));
    if (process.platform === "darwin") roots.push("/Applications/Agentlas.app/Contents/Resources/Hephaestus");
    roots.push(path.resolve(__dirname, "..", "..", "agentlas_desktop", "Hephaestus"));
    for (const root of roots) {
      try {
        if (root && fs.existsSync(path.join(root, "career_graph", "__main__.py"))) return { kind: "python", root };
      } catch { /* 다음 후보 */ }
    }
    return null;
  }

  function spawnHephaestus(args, opts) {
    const found = hephaestusBin();
    if (!found) return null;
    if (found.kind === "bin") return spawn(found.exec, args, opts);
    return spawnCoreModule("agentlas_cloud", args, opts, found.root);
  }

  function renderRoutePreview(json, ui) {
    const model = routePreviewModel(json);
    const ko = ui.lang === "ko";
    const room = Math.max(28, (ui.out.columns || 80) - 2);
    const emit = (prefix, value, paint = (text) => ui.c.text(text)) => {
      const label = String(prefix || "");
      const continuation = " ".repeat(visWidth(label));
      const lines = wrapWidth(String(value || ""), Math.max(2, room - visWidth(label)));
      lines.forEach((line, index) => {
        ui.line("  " + (index === 0 ? ui.c.faint(label) : continuation) + paint(line));
      });
    };
    const scope = model.scope === "cloud"
      ? (ko ? "내 Agent Cloud 보관함" : "my Agent Cloud library")
      : model.scope === "network"
        ? (ko ? "공개 Agentlas Hub" : "public Agentlas Hub")
        : (model.scope || (ko ? "자동" : "automatic"));
    ui.line("");
    ui.rule(ko ? "라우팅 미리보기" : "Route preview");
    emit(ko ? "범위: " : "Scope: ", scope);
    if (model.selected) {
      emit(ko ? "선택: " : "Selected: ", `${model.selected.name} (${model.selected.id})`, (text) => ui.c.emerald(text));
    } else {
      emit(
        ko ? "결정: " : "Decision: ",
        ko ? "아직 자동 선택하지 않음" : "no automatic selection yet",
        (text) => ui.c.amber(text),
      );
    }
    if (model.candidates.length) {
      emit(ko ? "후보: " : "Candidates: ", ko ? `${model.candidates.length}개` : String(model.candidates.length));
      model.candidates.forEach((candidate, index) => {
        const primary = model.primary && candidate.id === model.primary.id
          ? (ko ? " · 우선 후보" : " · primary candidate")
          : "";
        const name = ko ? candidate.name : candidate.nameEn;
        emit(`${index + 1}. `, `${name} (${candidate.id})${primary}`);
      });
    }
    if (model.needsRouter) {
      emit(
        ko ? "이유: " : "Why: ",
        ko
          ? "관련 후보는 찾았지만 자동 선택 확신이 부족합니다."
          : "Candidates matched, but confidence was too low for an automatic choice.",
      );
    } else if (!model.candidates.length) {
      emit(
        ko ? "이유: " : "Why: ",
        ko ? "일치하는 후보를 찾지 못했습니다." : "No matching candidate was found.",
      );
    }
    if (!model.selected && model.primary) {
      emit(
        ko ? "다음: " : "Next: ",
        `agentlas call "${model.primary.id}" "<request>"`,
        (text) => ui.c.emerald(text),
      );
    }
    if (model.receiptId) emit(ko ? "영수증: " : "Receipt: ", model.receiptId);
  }

  function captureHephaestus(args, opts = {}) {
    const cwd = opts.cwd || D.runCwd();
    const maxBytes = 2 * 1024 * 1024;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30_000;
    return new Promise((resolve) => {
      const child = spawnHephaestus(args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      if (!child) return resolve({ code: 1, stdout: "", stderr: "Hephaestus runtime unavailable.", unavailable: true });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      const append = (target, chunk) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          overflow = true;
          child.kill("SIGTERM");
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk) => append(stdout, Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => append(stderr, Buffer.from(chunk)));
      const onInterrupt = () => child.kill("SIGINT");
      process.once("SIGINT", onInterrupt);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const done = (code, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.removeListener("SIGINT", onInterrupt);
        resolve({
          code: overflow || timedOut || error ? 1 : (code ?? 0),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: error ? String(error.message || error) : Buffer.concat(stderr).toString("utf8"),
          overflow,
          timedOut,
        });
      };
      child.on("error", (error) => done(1, error));
      child.on("close", (code) => done(code));
    });
  }

  async function runHephaestusRoute(args, opts = {}) {
    const raw = args.includes("--json");
    const cleanArgs = args.filter((arg) => arg !== "--json");
    if (raw) return runHephaestusInteractive(cleanArgs, { ...opts, human: false });
    if (!hephaestusBin()) return runHephaestusInteractive(cleanArgs, { ...opts, human: false });
    const ui = opts.ui || newUi();
    const result = await captureHephaestus(cleanArgs, opts);
    let json = null;
    try {
      const start = result.stdout.indexOf("{");
      const end = result.stdout.lastIndexOf("}");
      if (start >= 0 && end > start) json = JSON.parse(result.stdout.slice(start, end + 1));
    } catch { /* handled below */ }
    const renderError = (message) => {
      const room = Math.max(28, (ui.out.columns || 80) - 2);
      wrapWidth(message, Math.max(2, room - 2)).forEach((line, index) => {
        ui.line("  " + (index === 0 ? ui.c.paw("✗ ") : "  ") + ui.c.text(line));
      });
    };
    if (json) renderRoutePreview(json, ui);
    else {
      const detail = (result.stderr || result.stdout || "").trim();
      const message = detail || (ui.lang === "ko" ? "라우팅 결과를 읽지 못했습니다." : "Could not read the route result.");
      renderError(message);
    }
    if (result.overflow) renderError(ui.lang === "ko" ? "라우팅 출력이 2MB 제한을 넘었습니다." : "Route output exceeded the 2 MB limit.");
    if (result.timedOut) renderError(ui.lang === "ko" ? "라우팅이 30초 제한을 넘었습니다." : "Route timed out after 30 seconds.");
    return result.code;
  }

  function renderResearchPreview(json, ui) {
    const model = researchPreviewModel(json);
    const ko = ui.lang === "ko";
    const room = Math.max(28, (ui.out.columns || 80) - 2);
    const emit = (prefix, value, paint = (text) => ui.c.text(text)) => {
      const label = String(prefix || "");
      const continuation = " ".repeat(visWidth(label));
      const lines = wrapWidth(String(value ?? ""), Math.max(2, room - visWidth(label)));
      lines.forEach((line, index) => {
        ui.line("  " + (index === 0 ? ui.c.faint(label) : continuation) + paint(line));
      });
    };
    const ready = (value) => value === true
      ? (ko ? "준비됨" : "ready")
      : value === false
        ? (ko ? "준비 안 됨" : "not ready")
        : (ko ? "확인 안 됨" : "unknown");
    const status = model.status === "ok"
      ? (ko ? "성공" : "ok")
      : model.status === "partial"
        ? (ko ? "일부만 완료" : "partial")
        : model.status;
    const title = model.intent === "status"
      ? (ko ? "리서치 준비 상태" : "Research status")
      : model.intent === "plan"
        ? (ko ? "리서치 실행 계획" : "Research plan")
        : model.intent === "read"
          ? (ko ? "리서치 읽기 결과" : "Research read")
          : model.intent === "gather"
            ? (ko ? "리서치 수집 결과" : "Research gather")
            : (ko ? "리서치 검색 결과" : "Research search");
    ui.line("");
    ui.rule(title);
    emit(ko ? "상태: " : "Status: ", status, model.status === "ok" ? (text) => ui.c.emerald(text) : (text) => ui.c.amber(text));
    if (model.query) emit(ko ? "질문: " : "Query: ", model.query);

    if (model.intent === "status") {
      emit(ko ? "전체: " : "Overall: ", ready(model.goalReady));
      emit(ko ? "코어: " : "Core: ", ready(model.coreReady));
      emit(ko ? "공개 소스: " : "Public sources: ", ready(model.publicFallbackReady));
      emit(ko ? "브라우저: " : "Browser proof: ", ready(model.browserReady));
      emit(ko ? "소셜: " : "Social proof: ", ready(model.socialReady));
      if (model.incompleteCount != null) emit(ko ? "누락: " : "Missing: ", String(model.incompleteCount));
      const proofNames = {
        reddit_oauth_live_check: ko ? "Reddit OAuth 실시간 증거" : "Reddit OAuth live proof",
        threads_live_graph_check: ko ? "Threads Graph 실시간 증거" : "Threads Graph live proof",
        browser_hardpoint_live_check: ko ? "브라우저 hardpoint 실시간 증거" : "browser hardpoint live proof",
      };
      for (const proof of model.missingProofs.slice(0, 5)) emit("• ", proofNames[proof] || proof);
      emit(ko ? "네트워크: " : "Network: ", model.networkWillRun ? (ko ? "실행함" : "will run") : (ko ? "실행 안 함" : "will not run"));
      return;
    }

    if (model.intent === "plan") {
      if (model.loadout) emit(ko ? "구성: " : "Loadout: ", model.loadout);
      if (model.depth) emit(ko ? "깊이: " : "Depth: ", model.depth);
      if (model.maxRequests != null) emit(ko ? "요청 한도: " : "Request limit: ", String(model.maxRequests));
      emit(ko ? "네트워크: " : "Network: ", model.networkWillRun ? (ko ? "실행함" : "will run") : (ko ? "계획 단계에서는 실행 안 함" : "not run during planning"));
      if (model.receiptWillBeWritten != null) {
        emit(ko ? "영수증: " : "Receipt: ", model.receiptWillBeWritten ? (ko ? "기록함" : "will be written") : (ko ? "계획 단계에서는 기록 안 함" : "not written during planning"));
      }
      if (model.privateHostsBlocked != null) emit(ko ? "사설 주소: " : "Private hosts: ", model.privateHostsBlocked ? (ko ? "차단" : "blocked") : (ko ? "허용" : "allowed"));
      if (model.browserMounted != null) emit(ko ? "브라우저: " : "Browser: ", model.browserMounted ? (ko ? "포함" : "mounted") : (ko ? "포함 안 함" : "not mounted"));
      if (model.modules.length) emit(ko ? "모듈: " : "Modules: ", model.modules.join(", "));
      return;
    }

    if (model.loadout) emit(ko ? "구성: " : "Loadout: ", model.loadout);
    if (model.maxRequests != null) {
      emit(
        ko ? "요청: " : "Requests: ",
        `${model.attempts.length}/${model.maxRequests}`,
      );
    }
    if (model.coverageStatus) {
      const coverage = {
        search_only: ko ? "검색 스니펫만" : "search snippets only",
        direct_read: ko ? "본문 직접 읽음" : "direct read",
        missing: ko ? "증거 없음" : "missing",
      };
      emit(ko ? "증거: " : "Evidence: ", coverage[model.coverageStatus] || model.coverageStatus);
    }
    if (model.qualityStatus) {
      const score = model.qualityScore == null ? "" : ` · ${model.qualityScore}/100`;
      emit(ko ? "품질: " : "Quality: ", `${model.qualityStatus}${score}`);
    }
    if (model.modules.length) emit(ko ? "모듈: " : "Modules: ", model.modules.join(", "));
    emit(ko ? "결과: " : "Results: ", String(model.results.length));
    model.results.slice(0, 5).forEach((result, index) => {
      emit(`${index + 1}. `, result.title || result.name || (ko ? "제목 없음" : "Untitled"), (text) => ui.c.emerald(text));
      if (result.url) {
        const urlLabel = ko ? "주소: " : "URL: ";
        emit(urlLabel, truncateWidth(result.url, Math.max(8, room - visWidth(urlLabel))));
      }
      const meta = [result.confidence, result.freshness].filter(Boolean).join(" · ");
      if (meta) emit(ko ? "근거: " : "Evidence: ", meta);
    });
    for (const warning of model.warnings.slice(0, 3)) {
      const text = warning === "search_snippets_need_followup"
        ? (ko ? "검색 스니펫은 원문 확인이 더 필요합니다." : "Search snippets still need a direct read.")
        : warning;
      emit(ko ? "주의: " : "Warning: ", text, (line) => ui.c.amber(line));
    }
    if (model.totalEvidenceFailure) {
      emit(
        ko ? "실패: " : "Failure: ",
        ko ? "사용할 수 있는 증거를 얻지 못했습니다." : "No usable evidence was obtained.",
        (text) => ui.c.paw(text),
      );
    }
    if (model.receiptId) emit(ko ? "영수증: " : "Receipt: ", model.receiptId);
  }

  async function runHephaestusResearch(args, opts = {}) {
    if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
      return runHephaestusInteractive(args, { ...opts, human: false });
    }
    const raw = args.includes("--json");
    const cleanArgs = args.filter((arg) => arg !== "--json");
    if (!hephaestusBin()) return runHephaestusInteractive(cleanArgs, { ...opts, human: false });
    const ui = opts.ui || newUi();
    if (!raw) ui.startSpinner(ui.lang === "ko" ? "리서치 실행 중…" : "Running research…");
    const result = await captureHephaestus(cleanArgs, {
      ...opts,
      timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000,
    });
    if (!raw) ui.stopSpinner();
    let json = null;
    try {
      const start = result.stdout.indexOf("{");
      const end = result.stdout.lastIndexOf("}");
      if (start >= 0 && end > start) json = JSON.parse(result.stdout.slice(start, end + 1));
    } catch { /* handled below */ }
    const preview = json ? researchPreviewModel(json) : null;
    const code = result.code !== 0 || preview?.totalEvidenceFailure ? 1 : 0;
    if (raw) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return code;
    }
    const renderError = (message) => {
      const room = Math.max(28, (ui.out.columns || 80) - 2);
      wrapWidth(message, Math.max(2, room - 2)).forEach((line, index) => {
        ui.line("  " + (index === 0 ? ui.c.paw("✗ ") : "  ") + ui.c.text(line));
      });
    };
    if (json) {
      renderResearchPreview(json, ui);
    } else {
      const message = (result.stderr || result.stdout || "").trim()
        || (ui.lang === "ko" ? "리서치 결과를 읽지 못했습니다." : "Could not read the research result.");
      renderError(message);
    }
    if (result.overflow) renderError(ui.lang === "ko" ? "리서치 출력이 2MB 제한을 넘었습니다." : "Research output exceeded the 2 MB limit.");
    if (result.timedOut) renderError(ui.lang === "ko" ? "리서치가 60초 제한을 넘었습니다." : "Research timed out after 60 seconds.");
    return code;
  }

  // ── storm — Agentlas 자체 Goal/UltraCode 하네스 ──
  // Core owns the exact Goal/UltraCode prompt. Terminal supplies only host
  // runtime inventory, worker context, and execution; no local prompt fallback.
  // ctx: { ui?, cwd?, research?, background?, runtimeOverride? }
  async function stormRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: storm <goal>  [--research]");
      return { ok: false };
    }
    if (goal.startsWith("-")) {
      ui.error("goal cannot start with '-'.");
      return { ok: false };
    }
    const cwd = ctx.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd());
    let executionHarness;
    try {
      executionHarness = await loadCoreStormbreakerHarness(cwd);
    } catch (error) {
      ui.error(`Stormbreaker Core harness unavailable: ${String((error && error.message) || error).slice(0, 400)}`);
      return { ok: false, error: "stormbreaker-core-harness-unavailable" };
    }
    const args = ["route", goal, "--project", cwd, "--runtime", "terminal"];
    if (ctx.research) args.push("--research-evidence");
    if (ctx.background) {
      ui.warn(ui.lang === "ko"
        ? "Agentlas 자체 Stormbreaker 하네스는 현재 포그라운드에서 실행합니다. 세션이 끝나도 영수증으로 재개 지점을 보존합니다."
        : "The Agentlas-owned Stormbreaker harness currently runs in the foreground and preserves resume receipts.");
    }

    let result = { code: 0, stdout: "", stderr: "" };
    if (hephaestusBin()) {
      ui.beginTurn();
      ui.startSpinner(ui.lang === "ko" ? "Stormbreaker 라우팅 근거 수집 중…" : "Stormbreaker gathering route evidence…");
      result = await new Promise((resolve) => {
        const child = spawnHephaestus(args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderrTail = [];
        child.stdout.on("data", (c) => { stdout += c.toString(); });
        child.stderr.on("data", (c) => {
          for (const ln of c.toString().split("\n")) {
            const line = ln.trim();
            if (!line) continue;
            stderrTail.push(line);
            if (stderrTail.length > 30) stderrTail.shift();
            ui.updateSpinner(line.slice(0, 100));
          }
        });
        child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err.message) }));
        child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr: stderrTail.join("\n") }));
      });
      ui.stopSpinner();
      ui.endTurn();
    }

    let json = null;
    try {
      const s = result.stdout.indexOf("{");
      const e = result.stdout.lastIndexOf("}");
      if (s >= 0 && e > s) json = JSON.parse(result.stdout.slice(s, e + 1));
    } catch { /* 비JSON 출력 */ }

    let routeContext = "";
    if (json) {
      const action = json.action || json.route_action || (json.route_decision && json.route_decision.action) || json.status || "?";
      ui.line("");
      ui.ok((ui.lang === "ko" ? "storm 결과: " : "storm result: ") + action);
      const fields = {
        receipt_id: json.receipt_id || (json.route_decision && json.route_decision.receipt_id),
        pipeline_id: json.pipeline_id,
        journal: json.journal,
        status: json.status,
        can_report_success: json.final_gate && json.final_gate.can_report_success,
      };
      if (json.auto_run) {
        fields.auto_run = String(json.auto_run.status || "") + (json.auto_run.reason ? ` — ${json.auto_run.reason}` : "");
      }
      const sel = json.selected;
      if (sel) fields.selected = typeof sel === "string" ? sel : sel.id || sel.slug || sel.name;
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null && v !== "") ui.info(`${k}: ${v}`);
      }
      if (json.clarify_question) ui.warn(String(json.clarify_question));
      if (json.reason) ui.info(String(json.reason));
      // 파이프라인 패킷 요약
      const packets = json.execution_fabric && json.execution_fabric.packets;
      if (Array.isArray(packets)) {
        routeContext = packets.slice(0, 24).map((p) => {
          const title = String(p.title || p.id || "packet").replace(/\s+/g, " ").slice(0, 160);
          const card = p.card ? ` [agent:${String(p.card).slice(0, 100)}]` : "";
          return `- ${title}${card}`;
        }).join("\n");
        for (const p of packets.slice(0, 12)) {
          ui.line("  " + ui.c.emerald("▸ ") + ui.c.text(String(p.title || p.id || "packet")) + (p.card ? ui.c.dim("  " + p.card) : ""));
        }
      }
      // 파이프라인이 아니면 추천 에이전트라도 보여준다 (hub_candidates 등)
      const exec = json.execution || {};
      const recos = []
        .concat(exec.recommended_agents || [], exec.alternatives || [])
        .map((a) => (typeof a === "string" ? a : a && (a.id || a.slug || a.name)))
        .filter(Boolean);
      if (recos.length) {
        ui.line("");
        ui.info(ui.lang === "ko" ? "추천 에이전트:" : "recommended agents:");
        for (const r of recos.slice(0, 8)) ui.line("  " + ui.c.emerald("▸ ") + ui.c.text(r));
        ui.info(ui.lang === "ko" ? '빌려 실행: agentlas cloud install <slug> 또는 "/storm"을 더 구체적 목표로.' : "borrow: agentlas cloud install <slug>, or re-run /storm with a more specific goal.");
      }
    } else {
      const raw = (result.stdout || result.stderr || "").trim();
      if (raw) ui.markdown(raw.slice(0, 4000));
    }
    if (result.code !== 0 && !json) {
      ui.warn(`Hephaestus route evidence unavailable (${result.code}); Agentlas parent planner will continue from the original goal.`);
    }

    const harnessResult = await swarmRun(db, goal, {
      ...ctx,
      ui,
      cwd,
      runtimeOverride: ctx.runtimeOverride,
      stormbreaker: true,
      executionHarness,
      routeContext,
    });
    return { ...harnessResult, routeDecision: json };
  }

  async function cmdStorm(db, args, runtimeOverride, executionContext = {}) {
    const rest = [];
    const ctx = {
      ...executionContext,
      cwd: executionContext.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd()),
      runtimeOverride,
    };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--research" || args[i] === "--research-evidence") ctx.research = true;
      else if (args[i] === "--background") ctx.background = true;
      else rest.push(args[i]);
    }
    const r = await stormRun(db, rest.join(" "), ctx);
    if (!r.ok) process.exitCode = 1;
  }

  // ── Hephaestus 네이티브 패스스루 — 엔진 전 기능을 터미널 1급으로 노출 ──
  // stdio inherit 로 돌려 색/프롬프트/스트리밍이 네이티브 그대로 나온다.
  function runHephaestusInteractive(args, opts = {}) {
    if (args[0] === "route" && opts.human !== false) return runHephaestusRoute(args, opts);
    if (args[0] === "research" && opts.human !== false) return runHephaestusResearch(args, opts);
    const isCareerGraph = args[0] === "career-graph" || args[0] === "career_graph";
    // `context` is a versioned Core capability, not a natural-language router
    // request. Older launcher scripts route unknown words through Hub search,
    // which silently turns `context verify` into a completely different action.
    // Bypass that wrapper and invoke only a Core root that actually contains
    // the canonical context-map implementation.
    const isContextMap = args[0] === "context";
    const contextRoot = isContextMap
      ? resolveCoreRuntimeRoot(
          null,
          [["agentlas_cloud", "context_map.py"]],
          { minVersion: CONTEXT_MAP_MIN_CORE_VERSION },
        )
      : null;
    const contextCapable = Boolean(
      contextRoot && fs.existsSync(path.join(contextRoot, "agentlas_cloud", "context_map.py")),
    );
    const found = isContextMap
      ? (contextCapable ? { kind: "python", root: contextRoot } : null)
      : (isCareerGraph ? careerGraphRuntime() : hephaestusBin());
    if (!found) {
      process.stderr.write(
        isContextMap
          ? "Agentlas Core context-map capability is unavailable — update Agentlas OS / Hephaestus before using `agentlas context`.\n"
          : isCareerGraph
          ? "Career Graph 런타임이 없습니다 — 최신 Agentlas OS / Hephaestus 설치 후 다시 시도하세요.\n"
          : "Hephaestus 런타임이 없습니다 — 데스크탑 앱 설치 또는 Hephaestus 인스톨러 실행 후 다시 시도하세요.\n",
      );
      if (!isContextMap) {
        process.stderr.write(
          isCareerGraph
            ? "설치 또는 지정: HEPHAESTUS_CAREER_GRAPH_BIN=<경로> 또는 HEPHAESTUS_RUNTIME_ROOT=<경로>\n"
            : "설치: https://agentlas.cloud  ·  또는 HEPHAESTUS_BIN=<경로> 지정\n",
        );
      }
      return Promise.resolve(1);
    }
    const helpOnly = args.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
    const cwd = opts.cwd || (helpOnly ? process.cwd() : D.runCwd());
    const moduleName = found.kind === "python" && isCareerGraph ? "career_graph" : "agentlas_cloud";
    const moduleArgs = moduleName === "career_graph" ? args.slice(1) : args;
    const child =
      found.kind === "bin"
        ? spawn(found.exec, isCareerGraph ? args.slice(1) : args, { cwd, stdio: "inherit" })
        : spawnCoreModule(moduleName, moduleArgs, { cwd, stdio: "inherit" }, found.root);
    if (!child) {
      process.stderr.write("Hephaestus failed: Python 3.9+ was not found.\n");
      return Promise.resolve(1);
    }
    return new Promise((resolve) => {
      child.on("error", (e) => {
        process.stderr.write(`Hephaestus failed: ${e.message}\n`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code == null ? 0 : code));
    });
  }

  const HEP_USAGE = [
    "agentlas hep <hephaestus 서브커맨드…>   — 엔진 전 기능 네이티브 패스스루",
    "",
    "  1급 별칭:",
    "    agentlas build \"<요청>\"            에이전트/팀 빌드·수리·패키징 (hep-build)",
    "    agentlas route \"<요청>\"            라우팅 미리보기 — 어떤 에이전트가 잡히는지",
    "    agentlas research <sub…>           Research Engine (status|gather|search|read|plan…)",
    "    agentlas network <sub…>            로컬 에이전트 네트워크 (init|status|reindex|add-source…)",
    "    agentlas journal <sub…>            Stormbreaker 런 저널 (status|verify|repair|gate)",
    "    agentlas call \"a,b\" \"<컨텍스트>\"    지정한 Hub/Cloud 에이전트 준비 (hep-call)",
    "",
    "  전체 서브커맨드: agentlas hep --help  (wizard·security·package·publish·cards·ao·plugins·meta-agent…)",
  ].join("\n");

  async function cmdHep(db, args) {
    if (!args.length || args[0] === "help") {
      D.out(HEP_USAGE);
      return;
    }
    const code = await runHephaestusInteractive(args);
    if (code !== 0) process.exitCode = code;
  }

  // ── swarm — 앱 swarm-run.ts 프로토콜의 CLI 포트 ──
  function swarmProtocol(goal, tasks, task, liveRuntimeInventory) {
    const doneList = tasks
      .filter((t) => t.status === "done")
      .slice(-8)
      .map((t) => `- ${t.title}`)
      .join("\n");
    const assignedList = tasks
      .filter((t) => t.id !== task.id && t.status !== "failed")
      .slice(0, 24)
      .map((t) => `- [${t.status}] ${t.title}${t.brief ? ` — ${t.brief}` : ""}`)
      .join("\n");
    return [
      "You are one worker in an EMERGENT AGENT SWARM collaborating on a shared goal.",
      `SHARED GOAL: ${goal}`,
      "",
      "YOUR TASK RIGHT NOW:",
      `- ${task.title}${task.role ? ` (role: ${task.role})` : ""}`,
      task.brief ? `- Details: ${task.brief}` : "",
      "",
      doneList ? `Already completed by peers (recent):\n${doneList}` : "No peer results yet — you may be first.",
      assignedList ? `WORK ALREADY ASSIGNED TO PEERS (never duplicate these packets):\n${assignedList}` : "",
      "",
      "RULES:",
      "1. Do your task concretely with available tools/files in the current working folder.",
      `LIVE_RUNTIME_INVENTORY=${JSON.stringify(liveRuntimeInventory || [])}`,
      "2. If the goal needs MORE work beyond your task — split into concrete next steps — end your",
      "   message with a `## Spawn` block. Every child MUST be one JSON object with a higher-level AI allocation. Choose runtimeId and exactModelId only from LIVE_RUNTIME_INVENTORY:",
      "   ## Spawn",
      '   - {"role":"webmaster","brief":"build the landing page structure","allocation":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-1","exactModelId":"model-from-inventory","tier":"balanced","effort":"high","phase":"delegate","reasonCodes":["complex-reasoning"],"rationale":"requires coordinated implementation","requiredCapabilities":["code","tools"]}}',
      '   - {"brief":"run focused tests","allocation":{"schema":"agentlas.workload-allocation.v1","runtimeId":"runtime-2","exactModelId":"model-from-inventory","tier":"economy","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"bounded verification","requiredCapabilities":["code","tools"]}}',
      "   Choose each exact runtime/model and effort from the actual child difficulty; do not copy one allocation to every child.",
      "   (role is optional. Do NOT spawn if the goal is already met or another pending/running/done packet already owns that work.)",
      "3. Do NOT restate the whole goal. Do NOT invent work that isn't needed — over-spawning wastes the user's money.",
      "4. Everything above the `## Spawn` block is your result and is shared with peers on the blackboard.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function parseSwarmOutput(text) {
    const m = String(text).match(/^[ \t]*##[ \t]*Spawn[ \t]*$/im);
    if (!m || m.index === undefined) return { result: String(text).trim(), spawn: [] };
    const result = String(text).slice(0, m.index).trim();
    const block = String(text).slice(m.index + m[0].length).split("\n");
    const spawn = [];
    for (const raw of block) {
      const line = raw.trim();
      if (!line.startsWith("-")) {
        if (line.startsWith("#")) break;
        continue;
      }
      const body = line.replace(/^-\s*/, "");
      if (body.startsWith("{")) {
        const item = workloadRouting.extractJsonObject(body);
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const brief = String(item.brief || "").trim();
          const allocation = workloadRouting.normalizeAllocation(item.allocation || item, "delegate");
          if (brief) {
            spawn.push({
              title: String(item.title || brief).trim().slice(0, 80),
              brief: brief.slice(0, 8_000),
              role: item.role ? String(item.role).trim().slice(0, 80) : undefined,
              allocation,
            });
          }
        }
        if (spawn.length >= SWARM_SPAWN_PER_TURN) break;
        continue;
      }
      const parts = body.split("|");
      let role;
      let brief;
      if (parts.length >= 2) {
        role = parts[0].trim() || undefined;
        brief = parts.slice(1).join("|").trim();
      } else {
        brief = body.trim();
      }
      // Legacy text remains parseable, but it has no AI-authored allocation and
      // therefore runs on the current model with an observable fallback receipt.
      if (brief) spawn.push({ title: brief.slice(0, 80), brief, role, allocation: null });
      if (spawn.length >= SWARM_SPAWN_PER_TURN) break;
    }
    return { result, spawn };
  }

  // ctx: { ui?, cwd?, permission?, runtime?, runtimeOverride?, concurrency?, agent?, projectPath? }
  async function swarmRun(db, goal, ctx = {}) {
    const ui = ctx.ui || newUi();
    goal = String(goal || "").trim();
    if (!goal) {
      ui.warn("usage: swarm <goal>  [--parallel N]");
      return { ok: false };
    }
    const runtime = ctx.runtime || D.resolveRuntime(db, ctx.runtimeOverride);
    const stormbreaker = ctx.stormbreaker === true;
    const executionHarness = stormbreaker ? ctx.executionHarness : null;
    if (stormbreaker && (!executionHarness || typeof executionHarness.system_prompt !== "string")) {
      ui.error("Stormbreaker requires the canonical Goal + UltraCode harness from Agentlas Core.");
      return { ok: false, error: "stormbreaker-core-harness-unavailable" };
    }
    const coreHarnessPrompt = executionHarness && executionHarness.system_prompt;
    const permission = ctx.permission || "write";
    const discoveredRuntimes = ctx.runtimes && ctx.runtimes.length
      ? ctx.runtimes
      : typeof D.listAvailableRuntimes === "function"
        ? D.listAvailableRuntimes(db, runtime)
        : [runtime];
    const runtimes = discoveredRuntimes
      .map((candidate, index) => ({ ...candidate, runtimeId: candidate.runtimeId || `runtime-${index + 1}` }));
    const liveRuntimeInventory = workloadRouting.runtimeInventory(runtimes);
    const cwd = ctx.cwd || (typeof D.projectCwd === "function" ? D.projectCwd() : D.runCwd());
    const concurrency = Math.max(1, Math.min(8, Number(ctx.concurrency) || 3));
    const env = await D.buildChildEnvCli(db, {
      projectPath: ctx.projectPath || null,
      agentId: ctx.agent && ctx.agent.id,
      permission,
      cwd,
      lang: ui.lang,
    });

    async function runBaseWorker(system, prompt) {
      if (runtime.mode === "cli") {
        return await D.captureRuntime(runtime.kind, system, prompt, {
          cwd,
          env,
          permission,
          model: ctx.modelPin || runtime.model || null,
          effort: ctx.effortPin === undefined ? null : ctx.effortPin,
        });
      }
      const text = await D.runApi(runtime.backend, ctx.modelPin || runtime.model, system, prompt);
      return typeof text === "string" ? text : (text && text.text) || "";
    }

    function recordAllocation(task, stage, decision, resolution, parentTaskId = null) {
      const receipt = workloadRouting.createDecisionReceipt({
        taskId: `${stage}-${task.id || "synthesis"}`,
        parentTaskId,
        taskText: task.brief || task.title || goal,
        stage,
        decision,
        resolution,
      });
      try {
        workloadRouting.appendDecisionReceipt(
          receipt,
          ctx.receiptFile || (D.modelRoutingReceiptPath && D.modelRoutingReceiptPath()),
        );
      } catch (error) {
        ui.warn(`model routing receipt failed: ${String((error && error.message) || error).slice(0, 120)}`);
      }
      return receipt;
    }

    async function runAllocatedWorker(system, prompt, task, stage, parentTaskId = null) {
      const resolution = workloadRouting.resolveAllocationAcrossRuntimes({
        runtimes,
        fallbackRuntime: runtime,
        decision: task.allocation,
        modelPin: ctx.modelPin,
        effortPin: ctx.effortPin,
        availableModels: ctx.availableModels,
        maxTier: ctx.maxTier || process.env.AGENTLAS_MODEL_MAX_TIER,
      });
      recordAllocation(task, stage, task.allocation, resolution, parentTaskId);
      if (!resolution.ok) {
        throw new Error(`model allocation failed closed: ${resolution.fallbackReason || "no compliant live model"}`);
      }
      if (resolution.fallbackReason) {
        ui.info(`model route: ${resolution.source} · ${resolution.runtimeId || "current"} · ${resolution.model || runtime.kind || runtime.backend} · ${resolution.fallbackReason}`);
      }
      const selectedRuntime = resolution.runtime || runtime;
      task.resolvedAllocation = {
        runtimeId: resolution.runtimeId || selectedRuntime.runtimeId || null,
        runtimeKind: selectedRuntime.kind || selectedRuntime.backend || null,
        model: resolution.model || selectedRuntime.model || null,
        effort: resolution.effort ?? null,
        source: resolution.source,
        fallbackReason: resolution.fallbackReason || null,
      };
      if (selectedRuntime.mode === "cli") {
        return await D.captureRuntime(selectedRuntime.kind, system, prompt, {
          cwd,
          env,
          permission,
          model: resolution.model,
          effort: resolution.effort,
        });
      }
      const text = await D.runApi(selectedRuntime.backend, resolution.model || selectedRuntime.model, system, prompt);
      return typeof text === "string" ? text : (text && text.text) || "";
    }

    const label = runtime.mode === "cli" ? runtime.kind : runtime.backend;
    ui.line("");
    ui.line(ui.c.paw("◤ ") + ui.c.bold(ui.c.text(stormbreaker ? "stormbreaker" : "swarm")) + ui.c.dim(`  Agentlas harness · ${label} · x${concurrency} · max ${SWARM_MAX_TASKS} tasks`));
    ui.info(goal.slice(0, 120));

    ui.startSpinner(ui.lang === "ko" ? "상위 AI가 작업별 모델 비용을 배정 중…" : "Higher-level AI is allocating task models…");
    let planned = null;
    try {
      const plannerText = await runBaseWorker(
        [
          coreHarnessPrompt,
          workloadRouting.plannerSystemPrompt({
            language: ui.lang === "ko" ? "Korean" : "English",
            maxTasks: Math.min(SWARM_SPAWN_PER_TURN, SWARM_MAX_TASKS),
            mode: stormbreaker ? "stormbreaker-goal-ultracode" : "swarm",
            liveRuntimeInventory,
          }),
        ].filter(Boolean).join("\n\n"),
        ctx.routeContext
          ? `${goal}\n\nHEPHAESTUS ROUTE EVIDENCE (advisory; the Agentlas parent owns the final plan):\n${ctx.routeContext}`
          : goal,
      );
      planned = workloadRouting.normalizePlan(plannerText, { maxTasks: SWARM_SPAWN_PER_TURN });
    } catch (error) {
      ui.warn(`workload planner failed: ${String((error && error.message) || error).slice(0, 160)}`);
    }
    ui.stopSpinner();
    if (!planned) ui.warn(ui.lang === "ko" ? "모델 배정 JSON이 유효하지 않아 현재 모델로 투명하게 폴백합니다." : "Invalid allocation JSON; transparently falling back to the current model.");
    if (planned) {
      ui.line("");
      ui.info(stormbreaker
        ? (ui.lang === "ko" ? "Stormbreaker Goal/UltraCode 실행 계획:" : "Stormbreaker Goal/UltraCode execution plan:")
        : (ui.lang === "ko" ? "스웜 실행 계획:" : "Swarm execution plan:"));
      for (const task of planned.tasks) {
        const allocation = task.allocation;
        ui.line(`  ${ui.c.emerald("▸ ")}${ui.c.text(task.title)}${ui.c.dim(`  ${allocation.runtimeId || "current"} · ${allocation.exactModelId || allocation.tier} · ${allocation.effort}`)}`);
      }
      ui.line(`  ${ui.c.emerald("◆ ")}${ui.c.text("synthesis")}${ui.c.dim(`  ${planned.synthesis.runtimeId || "current"} · ${planned.synthesis.exactModelId || planned.synthesis.tier} · ${planned.synthesis.effort}`)}`);
    }

    let seq = 0;
    const initialTasks = planned
      ? planned.tasks
      : [{ title: goal.slice(0, 80), brief: goal, role: undefined, allocation: null }];
    const tasks = initialTasks.map((task) => ({ id: ++seq, ...task, status: "pending", result: "", parentTaskId: null }));
    const seen = new Set(tasks.map((task) => task.title.toLowerCase()));
    let active = 0;
    let failed = 0;

    await new Promise((resolveAll) => {
      const pump = () => {
        const pending = tasks.filter((t) => t.status === "pending");
        if (!pending.length && active === 0) return resolveAll();
        for (const task of pending) {
          if (active >= concurrency) break;
          task.status = "running";
          active++;
          ui.tool(`⚑ ${task.title}` + (task.role ? `  (${task.role})` : ""));
          runAllocatedWorker(
            [coreHarnessPrompt, swarmProtocol(goal, tasks, task, liveRuntimeInventory)].filter(Boolean).join("\n\n"),
            task.brief || task.title,
            task,
            "worker",
            task.parentTaskId,
          )
            .then((text) => {
              const parsed = parseSwarmOutput(text);
              task.status = "done";
              task.result = parsed.result;
              ui.toolResult(parsed.result.split("\n").slice(0, 3).join("\n") || "(empty result)", true);
              for (const s of parsed.spawn) {
                const key = s.title.toLowerCase();
                if (tasks.length >= SWARM_MAX_TASKS || seen.has(key)) continue;
                seen.add(key);
                tasks.push({ id: ++seq, title: s.title, brief: s.brief, role: s.role, allocation: s.allocation, status: "pending", result: "", parentTaskId: `worker-${task.id}` });
                ui.info(`+ spawn: ${s.title}`);
              }
            })
            .catch((e) => {
              task.status = "failed";
              failed++;
              ui.toolResult(String((e && e.message) || e).slice(0, 200), false);
            })
            .finally(() => {
              active--;
              setImmediate(pump);
            });
        }
      };
      pump();
    });

    const done = tasks.filter((t) => t.status === "done" && t.result);
    ui.line("");
    ui.info(`tasks: ${tasks.length}  ·  done: ${done.length}  ·  failed: ${failed}`);
    if (!done.length) {
      ui.error(ui.lang === "ko" ? "스웜이 완료한 작업이 없습니다." : "The swarm completed no work.");
      return { ok: false };
    }

    ui.startSpinner(ui.lang === "ko" ? "스웜 결과 종합 중…" : "Synthesizing swarm results…");
    const pieces = done.map((t, i) => [
      `### ${i + 1}. ${t.title}`,
      `HOST-VERIFIED ALLOCATION: ${JSON.stringify(t.resolvedAllocation || null)}`,
      t.result,
    ].join("\n")).join("\n\n");
    let finalText;
    try {
      const synthesisTask = {
        id: "final",
        title: "swarm synthesis",
        brief: goal,
        allocation: planned && planned.synthesis,
      };
      finalText = await runAllocatedWorker(
        [
          coreHarnessPrompt,
          "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
          "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
          "Do not just concatenate. Do not include a `## Spawn` block.",
          `SHARED GOAL: ${goal}`,
          `Answer in the user's language (${ui.lang === "ko" ? "Korean" : "English"}).`,
        ].join("\n"),
        pieces,
        synthesisTask,
        "synthesis",
      );
    } catch (e) {
      ui.stopSpinner();
      ui.error("Synthesis failed: " + String((e && e.message) || e).slice(0, 200));
      finalText = pieces;
    }
    ui.stopSpinner();
    ui.line("");
    ui.markdown(String(finalText).trim());
    return { ok: true, finalText, taskCount: tasks.length, doneCount: done.length };
  }

  async function cmdSwarm(db, args, runtimeOverride, executionContext = {}) {
    const rest = [];
    let concurrency;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--parallel" || args[i] === "-n") concurrency = Number(args[++i]);
      else rest.push(args[i]);
    }
    const r = await swarmRun(db, rest.join(" "), { ...executionContext, concurrency, runtimeOverride });
    if (!r.ok) process.exitCode = 1;
  }

  // ── 미니 cron (5필드: 분 시 일 월 요일) — next_run_at 계산용 ──
  // 앱 스케줄러(croner)는 next_run_at IS NULL 을 "시계 없음"으로 취급하므로 CLI가 직접 채워야 한다.
  function cronField(expr, min, max) {
    const set = new Set();
    for (const part of String(expr).split(",")) {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) return null;
      const step = m[2] ? Number(m[2]) : 1;
      let lo = min;
      let hi = max;
      if (m[1] !== "*") {
        const range = m[1].split("-").map(Number);
        lo = range[0];
        hi = range.length > 1 ? range[1] : m[2] ? max : range[0];
      }
      if (lo < min || hi > max || lo > hi || step < 1) return null;
      for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set;
  }

  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const zonedFormatterCache = new Map();

  function zonedDateParts(date, timezone) {
    if (!timezone) {
      return {
        minute: date.getMinutes(),
        hour: date.getHours(),
        day: date.getDate(),
        month: date.getMonth() + 1,
        weekday: date.getDay(),
      };
    }
    let formatter = zonedFormatterCache.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        minute: "2-digit",
        hour: "2-digit",
        day: "2-digit",
        month: "2-digit",
        weekday: "short",
      });
      zonedFormatterCache.set(timezone, formatter);
    }
    const parts = Object.fromEntries(
      formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour),
      day: Number(parts.day),
      month: Number(parts.month),
      weekday: WEEKDAY_INDEX[parts.weekday],
    };
  }

  function nextCronRun(cron, from = new Date(), timezone = null) {
    const parts = String(cron).trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minS, hourS, domS, monS, dowS] = parts;
    const mins = cronField(minS, 0, 59);
    const hours = cronField(hourS, 0, 23);
    const doms = cronField(domS, 1, 31);
    const mons = cronField(monS, 1, 12);
    const dows = cronField(dowS, 0, 7);
    if (!mins || !hours || !doms || !mons || !dows) return null;
    if (dows.has(7)) dows.add(0);
    try {
      if (timezone) zonedDateParts(from, timezone);
    } catch {
      return null;
    }
    const t = new Date(from.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const local = zonedDateParts(t, timezone);
      const domOk = doms.has(local.day);
      const dowOk = dows.has(local.weekday);
      // 표준 cron: dom/dow 둘 다 제한이면 OR, 아니면 AND
      const domRestricted = domS !== "*";
      const dowRestricted = dowS !== "*";
      const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
      if (mons.has(local.month) && dayOk && hours.has(local.hour) && mins.has(local.minute)) return t;
      t.setMinutes(t.getMinutes() + 1);
    }
    return null;
  }

  function localTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  }

  function legacyScheduleSpec(raw, timezone) {
    const value = String(raw || "").trim();
    if (!value) return null;
    if (value.startsWith("cron:")) {
      const expr = value.slice(5).trim();
      return expr ? { kind: "cron", expr, tz: timezone } : null;
    }
    if (value.split(/\s+/).length === 5) return { kind: "cron", expr: value, tz: timezone };
    if (value === "hourly") return { kind: "interval", everyMs: 60 * 60 * 1000, anchor: "lastRun" };
    const every = value.match(/^every-(\d+)(m|h)$/);
    if (every) {
      const amount = Number(every[1]);
      if (amount > 0) return { kind: "interval", everyMs: amount * (every[2] === "h" ? 3600000 : 60000), anchor: "lastRun" };
    }
    let match = value.match(/^daily-(\d{1,2}):(\d{2})$/);
    if (match) return { kind: "cron", expr: `${Number(match[2])} ${Number(match[1])} * * *`, tz: timezone };
    match = value.match(/^weekday-(\d{1,2}):(\d{2})$/);
    if (match) return { kind: "cron", expr: `${Number(match[2])} ${Number(match[1])} * * 1-5`, tz: timezone };
    match = value.match(/^weekly-(sun|mon|tue|wed|thu|fri|sat)-(\d{1,2}):(\d{2})$/i);
    if (match) {
      const dow = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[match[1].toLowerCase()];
      return { kind: "cron", expr: `${Number(match[3])} ${Number(match[2])} * * ${dow}`, tz: timezone };
    }
    match = value.match(/^monthly-(\d{1,2})-(\d{1,2}):(\d{2})$/);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 31) {
      return { kind: "cron", expr: `${Number(match[3])} ${Number(match[2])} ${Number(match[1])} * *`, tz: timezone };
    }
    return null;
  }

  /** Desktop schedule_json + legacy mirror token parity, including IANA timezone. */
  function nextAutomationRun(row, from = new Date()) {
    const timezone = row.timezone || localTimezone();
    let spec = null;
    if (row.schedule_json && String(row.schedule_json).trim()) {
      try {
        const parsed = JSON.parse(row.schedule_json);
        if (parsed && typeof parsed.kind === "string") spec = parsed;
      } catch { /* fall through to legacy schedule */ }
    }
    if (!spec) spec = legacyScheduleSpec(row.schedule, timezone);
    if (!spec) {
      // Desktop computeNextRun preserves unknown legacy schedules with a 24h
      // fallback. More importantly, never leave a due row at the same instant.
      return row.schedule ? new Date(from.getTime() + 24 * 3600 * 1000) : null;
    }
    if (spec.kind === "cron") return nextCronRun(spec.expr, from, spec.tz || timezone);
    if (spec.kind === "interval") {
      const every = Number(spec.everyMs);
      if (!Number.isFinite(every) || every <= 0) return null;
      return spec.anchor === "wallclock"
        ? new Date(Math.ceil((from.getTime() + 1) / every) * every)
        : new Date(from.getTime() + every);
    }
    if (spec.kind === "once") {
      const at = new Date(spec.atIso);
      return at.getTime() > from.getTime() ? at : null;
    }
    return null;
  }

  // ── automation — 등록/목록/토글/실행 (run·daemon은 로컬 실행기) ──
  async function cmdAutomation(db, args, runtimeOverride) {
    const sub = args[0] || "list";
    const now = new Date().toISOString();
    const ko = isKo();
    const usage = (tail) => ko
      ? `사용법: agentlas automation ${tail}`
      : `usage: agentlas automation ${tail}`;
    const missingAutomation = (id) => ko ? `자동화를 찾지 못했습니다: ${id}` : `Automation not found: ${id}`;

    if (sub === "list") {
      const rows = db.prepare(
        "SELECT id, name, schedule, target_type, target_id, enabled, next_run_at, last_run_at, run_count, trigger_type FROM automations ORDER BY created_at DESC",
      ).all();
      if (!rows.length) return D.out(isKo()
        ? "자동화가 없습니다. `agentlas automation add --help`로 추가 방법을 확인하세요."
        : "No automations. Run agentlas automation add --help.");
      for (const r of rows) {
        const target = r.target_type + ":" + String(r.target_id).slice(0, 24);
        D.out(
          `${r.enabled ? "●" : "○"} ${String(r.id).slice(0, 8)}  ${String(r.name).padEnd(28).slice(0, 28)} ` +
            `${String(r.schedule || r.trigger_type).padEnd(14)} ${target.padEnd(32)} ` +
            `${ko ? "다음" : "next"}=${r.next_run_at ? r.next_run_at.slice(0, 16) : "-"} ` +
            `${ko ? "성공" : "success"}=${r.run_count}`,
        );
      }
      D.out("");
      D.out(isKo()
        ? "지금 실행: agentlas automation run <id>  ·  데몬: agentlas automation daemon"
        : "Run now: agentlas automation run <id>  ·  daemon: agentlas automation daemon");
      D.out(isKo()
        ? "Desktop 앱이 열려 있을 때는 Desktop 스케줄러도 실행되며, 리스로 중복 실행을 막습니다."
        : "The Desktop scheduler also runs when the app is open; leases prevent duplicate runs.");
      return;
    }

    if (sub === "add") {
      // agentlas automation add --name "..." --agent <slug>|--firm <slug> --cron "0 9 * * *" --prompt "..."
      const flags = {};
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "--name") flags.name = args[++i];
        else if (a === "--agent") flags.agent = args[++i];
        else if (a === "--firm") flags.firm = args[++i];
        else if (a === "--cron") flags.cron = args[++i];
        else if (a === "--prompt") flags.prompt = args[++i];
        else if (a === "--tz") flags.tz = args[++i];
        else if (a === "--disabled") flags.disabled = true;
      }
      if (!flags.cron || !flags.prompt || (!flags.agent && !flags.firm)) {
        D.out(ko
          ? '사용법: agentlas automation add --name "이름" --agent <슬러그>|--firm <슬러그> --cron "0 9 * * *" --prompt "지시" [--tz Asia/Seoul] [--disabled]'
          : 'usage: agentlas automation add --name "name" --agent <slug>|--firm <slug> --cron "0 9 * * *" --prompt "instructions" [--tz Asia/Seoul] [--disabled]');
        process.exitCode = 1;
        return;
      }
      let targetType;
      let targetId;
      let targetLabel;
      if (flags.agent) {
        const a = D.resolveAgent(db, flags.agent);
        if (!a) return D.fail(ko ? `에이전트를 찾지 못했습니다: ${flags.agent}` : `Agent not found: ${flags.agent}`);
        targetType = "agent";
        targetId = a.id;
        targetLabel = a.name;
      } else {
        const f = D.resolveFirm(db, flags.firm);
        if (!f) return D.fail(ko ? `회사를 찾지 못했습니다: ${flags.firm}` : `Company not found: ${flags.firm}`);
        targetType = "firm";
        targetId = f.id;
        targetLabel = f.name;
      }
      const next = nextCronRun(flags.cron, new Date(), flags.tz || null);
      if (!next) return D.fail(ko
        ? `cron 표현식을 해석하지 못했습니다: "${flags.cron}" (5개 필드: 분 시 일 월 요일)`
        : `Could not parse cron expression: "${flags.cron}" (5 fields: minute hour day month weekday)`);
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO automations (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by,
           next_run_at, created_at, timezone, trigger_type, tool_mode, hub_mode, run_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      ).run(
        id,
        flags.name || `${targetLabel} automation`,
        flags.cron,
        targetType,
        targetId,
        flags.prompt,
        flags.disabled ? 0 : 1,
        "cli",
        next.toISOString(),
        now,
        flags.tz || null,
        "schedule",
        "auto",
        "hub-allowed",
      );
      D.out(`${ko ? "생성됨" : "Created"}: ${id.slice(0, 8)}  ${flags.name || targetLabel}  ${ko ? "다음" : "next"}=${next.toISOString().slice(0, 16)}`);
      D.out(ko
        ? `지금 실행: agentlas automation run ${id.slice(0, 8)}  ·  예약 실행: agentlas automation daemon (또는 Desktop)`
        : `Run now: agentlas automation run ${id.slice(0, 8)}  ·  scheduled: agentlas automation daemon (or Desktop)`);
      return;
    }

    if (sub === "on" || sub === "off") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail(usage(`${sub} <id>`));
      const row = db.prepare("SELECT id, name, schedule, schedule_json, timezone FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(missingAutomation(idPrefix));
      if (sub === "on") {
        const next = nextAutomationRun(row) || null;
        db.prepare("UPDATE automations SET enabled=1, next_run_at=? WHERE id=?").run(next ? next.toISOString() : null, row.id);
      } else {
        db.prepare("UPDATE automations SET enabled=0 WHERE id=?").run(row.id);
      }
      D.out(`${sub === "on" ? (ko ? "활성화됨" : "Enabled") : (ko ? "비활성화됨" : "Disabled")}: ${row.id.slice(0, 8)}  ${row.name}`);
      return;
    }

    if (sub === "remove" || sub === "rm") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail(usage("remove <id>"));
      const row = db.prepare("SELECT id, name FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(missingAutomation(idPrefix));
      db.prepare("DELETE FROM automations WHERE id=?").run(row.id);
      D.out(`${ko ? "삭제됨" : "Deleted"}: ${row.id.slice(0, 8)}  ${row.name}`);
      return;
    }

    if (sub === "runs") {
      const rows = db.prepare(
        `SELECT h.ran_at, h.status, h.error, a.name FROM run_history h
           LEFT JOIN automations a ON a.id = h.automation_id
           ORDER BY h.ran_at DESC LIMIT 15`,
      ).all();
      if (!rows.length) return D.out(ko ? "실행 기록이 없습니다." : "No run history.");
      for (const r of rows) {
        const status = ko
          ? (r.status === "ok" ? "성공" : r.status === "error" ? "오류" : (r.status || "?"))
          : (r.status || "?");
        D.out(
          `${(r.ran_at || "").slice(0, 16).padEnd(17)} ${status.padEnd(9)} ${(r.name || (ko ? "(삭제됨)" : "(deleted)")).slice(0, 30).padEnd(31)} ${r.error ? String(r.error).slice(0, 40) : ""}`,
        );
      }
      return;
    }

    if (sub === "run") {
      const idPrefix = args[1];
      if (!idPrefix) return D.fail(usage("run <id>"));
      const row = db.prepare("SELECT * FROM automations WHERE id LIKE ?").get(idPrefix + "%");
      if (!row) return D.fail(missingAutomation(idPrefix));
      const ui = newUi();
      // run-now는 스케줄을 건드리지 않는다 (앱의 advanceSchedule=false와 동일).
      const r = await runAutomationOnce(db, row, { ui, advanceSchedule: false, runtimeOverride });
      if (!r.ok) process.exitCode = 1;
      return;
    }

    if (sub === "daemon") {
      let interval = 30;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--interval") interval = Math.max(10, Number(args[++i]) || 30);
      }
      return automationDaemon(db, { intervalSec: interval });
    }

    D.out(usage("list|add|on <id>|off <id>|remove <id>|run <id>|runs|daemon"));
  }

  // ── automation 실행기 — 앱 스케줄러와 같은 SQLite 리스(claimed_at TTL 15분)로 중복 실행 방지 ──
  const AUTOMATION_LEASE_TTL_MS = 15 * 60 * 1000; // 앱 store/automations.ts LEASE_TTL_MS와 동일
  const AUTOMATION_LEASE_OWNER = `cli:${os.hostname()}:${process.pid}`;

  function claimAutomation(db, id, now = new Date()) {
    const cutoff = new Date(now.getTime() - AUTOMATION_LEASE_TTL_MS).toISOString();
    const result = db
      .prepare(
        "UPDATE automations SET claimed_at = ?, lease_owner = ? WHERE id = ? AND enabled = 1 AND (claimed_at IS NULL OR claimed_at < ?)",
      )
      .run(now.toISOString(), AUTOMATION_LEASE_OWNER, id, cutoff);
    return (result.changes ?? result.rowsAffected ?? 0) > 0;
  }

  function releaseAutomation(db, id) {
    try { db.prepare("UPDATE automations SET claimed_at = NULL, lease_owner = NULL WHERE id = ?").run(id); } catch { /* best-effort */ }
  }

  function recordAutomationRun(db, automationId, status, error, scheduledFor) {
    try {
      db.prepare(
        "INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error) VALUES (?,?,?,?,?,0,?)",
      ).run(crypto.randomUUID(), automationId, scheduledFor || null, new Date().toISOString(), status, error || null);
    } catch { /* best-effort */ }
  }

  // 자동화 1건 실행: 타깃(agent/firm)의 시스템 프롬프트로 prompt_template을 활성 런타임에 태운다.
  // ctx: { ui, advanceSchedule?, runtimeOverride?, scheduledFor? }
  async function runAutomationOnce(db, row, ctx = {}) {
    const ui = ctx.ui || newUi();
    const permission = permissionPolicy.normalize(
      D.resolvePermission ? D.resolvePermission(ctx.permissionOverride) : (ctx.permissionOverride || "write"),
      "read",
    );
    if (!row.enabled) {
      ui.warn(ui.lang === "ko"
        ? `이 자동화는 비활성화되어 실행하지 않았습니다: ${row.name}`
        : `This automation is disabled and was not run: ${row.name}`);
      return { ok: false, skipped: true, reason: "disabled" };
    }
    // run-now도 리스를 잡는다 — 앱 스케줄러가 같은 행을 동시에 돌리는 것을 방지.
    if (!claimAutomation(db, row.id)) {
      ui.warn(ui.lang === "ko"
        ? `다른 실행기가 이 자동화 리스를 보유 중입니다(15분 TTL): ${row.name}`
        : `Another runner holds this automation (lease TTL 15 minutes): ${row.name}`);
      return { ok: false, skipped: true, reason: "lease" };
    }
    ui.line("");
    const surface = ui.lang === "ko" ? "자동화" : "automation";
    const suffix = `  (${String(row.id).slice(0, 8)})`;
    const room = Math.max(4, (Number(ui.out?.columns) || 80) - visWidth(`◤ ${surface}  ${suffix}`));
    ui.line(ui.c.paw("◤ ") + ui.c.bold(ui.c.text(surface)) + ui.c.dim(`  ${truncateWidth(row.name, room)}${suffix}`));

    try {
      // 타깃 해석 (agent/firm) — background/비공개 포함 id 직접 조회.
      let system;
      let agentId = null;
      if (row.target_type === "firm") {
        const firm = db.prepare("SELECT * FROM firms WHERE id = ?").get(row.target_id);
        if (!firm) throw new Error(`Company not found: ${row.target_id}`);
        system = D.firmSystemPrompt(db, firm);
      } else {
        const agent = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(row.target_id);
        if (!agent) throw new Error(`Agent not found: ${row.target_id}`);
        system = agent.system_prompt || `You are ${agent.name}.`;
        agentId = agent.id;
      }

      const cwd = D.runCwd();
      const env = await D.buildChildEnvCli(db, { projectPath: null, agentId, permission, cwd, lang: ui.lang });
      const runtime = D.resolveRuntime(db, ctx.runtimeOverride);
      ui.info(`${runtime.mode === "cli" ? runtime.kind : runtime.backend} · ${permission} · ${cwd}`);
      // A top-level automation command has no persistent composer footer.
      // Keep progress as a stable line so narrow terminals do not retain raw
      // carriage-return spinner frames in scrollback or screen recordings.
      ui.info(ui.lang === "ko" ? "자동화 실행 중…" : "running automation…");

      let text;
      if (runtime.mode === "cli") {
        text = await D.captureRuntime(runtime.kind, system, row.prompt_template, { cwd, env, permission });
      } else {
        const r = await D.runApi(runtime.backend, runtime.model, system, row.prompt_template);
        text = typeof r === "string" ? r : (r && r.text) || "";
      }
      ui.stopSpinner();
      ui.markdown(String(text).trim().slice(0, 4000));

      recordAutomationRun(db, row.id, "ok", null, ctx.scheduledFor);
      const ranAt = new Date();
      const shouldAdvance = !!ctx.advanceSchedule && (row.trigger_type || "schedule") === "schedule";
      const advance = shouldAdvance ? nextAutomationRun(row, ranAt) : null;
      if (shouldAdvance) {
        db.prepare(
          "UPDATE automations SET last_run_at = ?, run_count = run_count + 1, next_run_at = ?, enabled = ? WHERE id = ?",
        ).run(ranAt.toISOString(), advance ? advance.toISOString() : null, advance ? row.enabled : 0, row.id);
      } else {
        db.prepare("UPDATE automations SET last_run_at = ?, run_count = run_count + 1 WHERE id = ?")
          .run(ranAt.toISOString(), row.id);
      }
      // max_runs 도달 시 비활성화 (앱과 동일한 종료 조건).
      if (row.max_runs && row.run_count + 1 >= row.max_runs) {
        db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(row.id);
        ui.info(ui.lang === "ko" ? "max_runs 도달 — 자동화를 비활성화했습니다." : "max_runs reached — automation disabled.");
      }
      return { ok: true };
    } catch (e) {
      ui.stopSpinner();
      const msg = String((e && e.message) || e).slice(0, 500);
      ui.error(msg);
      recordAutomationRun(db, row.id, "error", msg, ctx.scheduledFor);
      const ranAt = new Date();
      const shouldAdvance = !!ctx.advanceSchedule && (row.trigger_type || "schedule") === "schedule";
      const advance = shouldAdvance ? nextAutomationRun(row, ranAt) : null;
      if (shouldAdvance) {
        db.prepare("UPDATE automations SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?")
          .run(ranAt.toISOString(), advance ? advance.toISOString() : null, advance ? row.enabled : 0, row.id);
      } else {
        db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(ranAt.toISOString(), row.id);
      }
      return { ok: false };
    } finally {
      releaseAutomation(db, row.id);
    }
  }

  // 상주 실행기 — 앱 없이도 자동화가 돌게 하는 포그라운드 데몬 (Ctrl-C로 종료).
  async function automationDaemon(db, opts = {}) {
    const ui = newUi();
    const intervalSec = Math.max(10, opts.intervalSec || 30);
    let stopping = false;
    process.on("SIGINT", () => { stopping = true; ui.line(""); ui.info(ui.lang === "ko" ? "종료 중…" : "stopping…"); });
    process.on("SIGTERM", () => { stopping = true; });

    ui.line("");
    ui.ok(`automation daemon — polling every ${intervalSec}s · owner ${AUTOMATION_LEASE_OWNER}`);
    ui.info(ui.lang === "ko" ? "Ctrl-C로 종료. (데스크탑 앱 스케줄러와 리스를 공유해 중복 실행되지 않습니다.)" : "Ctrl-C to stop.");

    while (!stopping) {
      const nowIso = new Date().toISOString();
      let due = [];
      try {
        due = db.prepare(
          "SELECT * FROM automations WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 5",
        ).all(nowIso);
      } catch (e) {
        ui.error("Failed to query due automations: " + String((e && e.message) || e));
      }
      for (const row of due) {
        if (stopping) break;
        await runAutomationOnce(db, row, { ui, advanceSchedule: true, scheduledFor: row.next_run_at });
        // 스케줄이 없는(1회성) 행이 남으면 재발화 방지.
        if (!row.schedule || !nextAutomationRun(row)) {
          db.prepare("UPDATE automations SET enabled = 0 WHERE id = ? AND (schedule IS NULL OR schedule = '')").run(row.id);
        }
      }
      // interval 대기 (1초 단위로 stop 체크)
      for (let i = 0; i < intervalSec && !stopping; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    ui.info(ui.lang === "ko" ? "데몬 종료." : "daemon stopped.");
  }

  // ── mcp / chats — 데스크탑 데이터 열람 ──
  function cmdMcp(db) {
    let rows = [];
    try {
      rows = db.prepare("SELECT id, name, name_en, transport, enabled FROM mcp_servers ORDER BY installed_at ASC").all();
    } catch { /* 테이블 없음 */ }
    if (!rows.length) return D.out(isKo()
      ? "설치된 MCP 서버가 없습니다. Desktop 또는 에이전트 패키지에서 설정하세요."
      : "No MCP servers are installed. Configure them in Desktop or an agent package.");
    for (const r of rows) {
      D.out(`${r.enabled ? "●" : "○"} ${String(r.name || r.name_en || r.id).padEnd(28).slice(0, 28)} ${String(r.transport || "stdio").padEnd(8)} ${String(r.id).slice(0, 12)}`);
    }
    D.out("");
    D.out(isKo()
      ? "활성(●) stdio 서버는 무제한 권한 턴에서만 런타임에 연결됩니다. REPL에서는 /mcp를 사용하세요."
      : "Only full-access turns wire active (●) stdio servers into the runtime. In the REPL, use /mcp.");
  }

  function cmdChats(db, args) {
    const limit = Math.max(1, Math.min(50, Number(args[0]) || 15));
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT c.id, c.title, c.updated_at, a.name AS agent_name, a.name_en AS agent_name_en
           FROM chats c LEFT JOIN installed_agents a ON a.id = c.agent_id
          WHERE c.archived_at IS NULL AND c.kind = 'user'
          ORDER BY c.updated_at DESC LIMIT ?`,
      ).all(limit);
    } catch { /* 스키마 차이 */ }
    if (!rows.length) return D.out(isKo() ? "대화가 없습니다." : "No chats.");
    for (const r of rows) {
      D.out(`${String(r.updated_at || "").slice(0, 16).padEnd(17)} ${String(r.agent_name_en || r.agent_name || "-").slice(0, 18).padEnd(19)} ${String(r.title || "(untitled)").slice(0, 60)}`);
    }
    D.out("");
    D.out(isKo()
      ? "이 대화는 Desktop과 공유됩니다. 터미널 세션은 REPL의 /resume으로 이어가세요."
      : "These chats are shared with Desktop. Resume terminal sessions with /resume in the REPL.");
  }

  // ── usage — 로컬 집계 ──
  async function cmdUsage(db) {
    const day = new Date(Date.now() - 86400000).toISOString();
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    const q = (sql, ...p) => {
      try { return db.prepare(sql).get(...p) || {}; } catch { return {}; }
    };
    const ar = q("SELECT kind FROM active_runtime WHERE id=1");
    // Match `agentlas list` and `/agents`: private/background architecture
    // rows are runtime infrastructure, not user-installed agents.
    const visibleAgents = D.listAgents?.(db);
    const agents = { n: Array.isArray(visibleAgents) ? visibleAgents.length : "?" };
    const chats = q("SELECT COUNT(*) AS n FROM chats WHERE archived_at IS NULL");
    const msg24 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", day);
    const msg7 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", week);
    const auto = q("SELECT COUNT(*) AS n FROM automations WHERE enabled=1");
    const runs7 = q("SELECT COUNT(*) AS n, SUM(CASE WHEN status='error' OR error IS NOT NULL THEN 1 ELSE 0 END) AS err FROM run_history WHERE ran_at > ?", week);
    D.out(isKo() ? `활성 런타임      ${ar.kind || "(없음)"}` : `Active runtime    ${ar.kind || "(none)"}`);
    D.out(isKo() ? `설치 에이전트    ${agents.n ?? "?"}` : `Installed agents  ${agents.n ?? "?"}`);
    D.out(isKo() ? `활성 대화        ${chats.n ?? "?"}` : `Active chats      ${chats.n ?? "?"}`);
    D.out(isKo() ? `메시지           24시간 ${msg24.n ?? 0}  ·  7일 ${msg7.n ?? 0}` : `Messages          24h ${msg24.n ?? 0}  ·  7d ${msg7.n ?? 0}`);
    D.out(isKo() ? `자동화           ${auto.n ?? 0}` : `Automations       ${auto.n ?? 0}`);
    D.out(isKo()
      ? `실행(7일)        ${runs7.n ?? 0}${runs7.err ? `  (실패 ${runs7.err})` : ""}`
      : `Runs (7d)         ${runs7.n ?? 0}${runs7.err ? `  (${runs7.err} failed)` : ""}`);
    D.out("");
    D.out(isKo()
      ? "세션 토큰·비용은 대화에서 /cost로 확인합니다. 공급자 할당량 대시보드는 Desktop에 있습니다."
      : "Session tokens/cost: /cost in chat. Provider quota dashboards are in Desktop.");
  }

  // ── telegram — 바인딩 현황 (읽기 전용) ──
  function cmdTelegram(db, args) {
    let rows;
    try {
      rows = db.prepare("SELECT * FROM telegram_bindings ORDER BY rowid DESC").all();
    } catch {
      rows = [];
    }
    if (!rows.length) {
      D.out(isKo()
        ? "Telegram 연결이 없습니다. Desktop Connect에서 기기를 연결하세요."
        : "No Telegram bindings. Pair devices from Desktop Connect.");
      return;
    }
    for (const r of rows) {
      const bot = r.bot_username ? "@" + r.bot_username : "(bot not set)";
      const chat = r.telegram_chat_title || r.telegram_chat_id || "(chat not connected)";
      const status = r.status || (r.telegram_chat_id ? "paired" : "pending");
      D.out(`${String(r.id).slice(0, 8)}  ${r.target_kind}:${String(r.target_id).slice(0, 20).padEnd(21)} ${String(bot).padEnd(24)} ${String(chat).slice(0, 28).padEnd(29)} ${status}`);
    }
    D.out("");
    D.out(isKo()
      ? "연결과 봇 발급은 Desktop Connect에서 수행하며, 이 명령은 상태만 보여줍니다."
      : "Pairing and bot issuance happen in Desktop Connect; this command only shows status.");
  }

  // ── login / logout / whoami — Agentlas Cloud 세션 (데스크탑과 동일한 loopback 브라우저 플로우) ──
  function webBaseUrl() {
    return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  }

  function openInBrowser(url) {
    const argv =
      process.platform === "darwin" ? ["open", url]
      : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
    try {
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
      child.unref();
    } catch { /* URL은 이미 출력됨 — 수동으로 열면 된다 */ }
  }

  async function fetchSessionMeta(cookie) {
    const resp = await fetch(`${webBaseUrl()}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`Session check returned ${resp.status}`);
    return resp.json();
  }

  function loginCallbackHtml(ok) {
    const title = ok ? "Agentlas login complete" : "Agentlas login failed";
    const body = ok
      ? "Return to the terminal. You can close this window."
      : "Return to the terminal and run agentlas login again.";
    return `<!doctype html><html><head><meta charset="utf-8"><title>Agentlas</title></head><body style="font-family:-apple-system,system-ui,sans-serif;padding:40px"><h3>${title}</h3><p>${body}</p></body></html>`;
  }

  function waitForLoopbackSession(options = {}) {
    const http = options.http || require("node:http");
    const timeoutCandidate = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : LOGIN_TIMEOUT_MS;
    const state = createLoginState(options.randomBytes || crypto.randomBytes);
    const guard = createLoginCallbackGuard(state);
    const onLoginUrl = options.onLoginUrl || ((url) => {
      D.out("Sign in to Agentlas in the browser (opening automatically):");
      D.out("  " + url);
      openInBrowser(url);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let server;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (server) server.close(); } catch { /* ignore */ }
        if (error) reject(error);
        else resolve(value);
      };

      server = http.createServer((req, res) => {
        const result = guard.consume(req.url, req.method || "GET");
        const headers = {
          "content-type": result.handled ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "x-content-type-options": "nosniff",
          connection: "close",
        };
        if (result.statusCode === 405) headers.allow = "GET";
        res.writeHead(result.statusCode, headers);
        res.end(result.handled ? loginCallbackHtml(result.ok) : result.message);
        if (!result.final) return;
        if (result.ok) finish(null, result.value);
        else finish(new Error(result.message));
      });
      server.on("error", (error) => finish(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        if (!port) {
          finish(new Error("Could not open the login loopback port."));
          return;
        }
        const callback = new URL(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}`);
        callback.searchParams.set("state", state);
        let loginUrl;
        try {
          loginUrl = new URL("/account", `${options.baseUrl || webBaseUrl()}/`);
        } catch {
          finish(new Error("The Agentlas login URL is invalid."));
          return;
        }
        loginUrl.searchParams.set("desktop", "1");
        loginUrl.searchParams.set("callback", callback.toString());
        timer = setTimeout(
          () => finish(new Error(`Login timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try: agentlas login`)),
          timeoutMs,
        );
        if (timer.unref) timer.unref();
        try {
          const notified = onLoginUrl(loginUrl.toString());
          if (notified && typeof notified.then === "function") {
            void notified.catch((error) => finish(error));
          }
        } catch (error) {
          finish(error);
        }
      });
    });
  }

  async function cmdWhoami() {
    const cookie = await D.cloudSessionCookieCli();
    if (!cookie) {
      D.out(isKo()
        ? "로그아웃 상태입니다. `agentlas login`으로 로그인하세요."
        : "You are signed out. Sign in with agentlas login.");
      process.exitCode = 1;
      return;
    }
    try {
      const j = await fetchSessionMeta(cookie);
      if (j && j.authenticated) {
        const email = (j.user && j.user.email) || "?";
        const ws = j.workspace || {};
        D.out(isKo()
          ? `로그인됨: ${email}  ·  작업 공간: ${ws.name || "?"} (${ws.plan || "free"})`
          : `Signed in: ${email}  ·  workspace: ${ws.name || "?"} (${ws.plan || "free"})`);
      } else {
        D.out(isKo()
          ? "세션이 만료되었거나 유효하지 않습니다. `agentlas login`으로 다시 로그인하세요."
          : "The session is expired or invalid. Sign in again with agentlas login.");
        process.exitCode = 1;
      }
    } catch (e) {
      D.fail((isKo() ? "세션 확인 실패: " : "Session check failed: ") + String((e && e.message) || e));
    }
  }

  // 웹 /account?desktop=1&callback=<loopback+state> 이 유효 세션이면 callback의 state를
  // 보존한 채 session을 추가해 302한다. Terminal은 state를 1회 검증한 뒤에만 저장한다.
  async function cmdLogin(args = []) {
    const force = args.includes("--force");
    if (!force) {
      const existing = await D.cloudSessionCookieCli();
      if (existing) {
        try {
          const j = await fetchSessionMeta(existing);
          if (j && j.authenticated) {
            D.out(`Already signed in (${(j.user && j.user.email) || "?"}). Re-authenticate with agentlas login --force`);
            return;
          }
        } catch { /* 확인 실패 — 새로 로그인 진행 */ }
      }
    }

    let value;
    try {
      value = await waitForLoopbackSession();
    } catch (e) {
      return D.fail(String((e && e.message) || e));
    }

    const p = D.cliSessionPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ version: 1, value, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* win32 */ }
    D.out(`Session saved: ${p}`);
    await cmdWhoami();
  }

  function cmdLogout() {
    const p = D.cliSessionPath();
    if (fs.existsSync(p)) {
      try { fs.rmSync(p); D.out("Signed out (CLI session deleted)."); } catch (e) { return D.fail("Could not delete the session file: " + e.message); }
    } else {
      D.out("No saved CLI session.");
    }
    if (process.env.AGENTLAS_SESSION) D.out("Warning: AGENTLAS_SESSION is still set, so the CLI may appear signed in.");
  }

  // ── cloud search — 마켓플레이스 검색 ──
  async function cloudSearch(db, args) {
    let limit = 10;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--limit") limit = Math.max(1, Math.min(30, Number(args[++i]) || 10));
      else rest.push(args[i]);
    }
    const query = rest.join(" ").trim();
    if (!query) return D.fail('usage: agentlas cloud search "<task>" [--limit 10]');
    if (typeof fetch !== "function") return D.fail("fetch is not available in this runtime.");
    const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
    const headers = { "content-type": "application/json" };
    try {
      const cookie = await D.cloudSessionCookieCli();
      if (cookie) headers.cookie = cookie;
    } catch { /* 로그인 없어도 검색은 가능 */ }
    let resp;
    try {
      resp = await D.fetchHub(`${base.replace(/\/$/, "")}/tools/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "marketplace.search_agents",
          // Hub는 파라미터 이름이 `q` — `query`만 보내면 무시하고 기본 목록을 준다(데스크탑 mcp-source.ts와 동일하게 둘 다 전송).
          params: { name: "marketplace.search_agents", arguments: { q: query, query, limit } },
        }),
      });
    } catch (e) {
      return D.fail(`Marketplace connection failed: ${(e && e.message) || e}`);
    }
    if (!resp.ok) return D.fail(`Marketplace returned ${resp.status}`);
    let json;
    try {
      json = JSON.parse(resp.text || "null");
    } catch {
      return D.fail("Marketplace returned invalid JSON");
    }
    if (json.error) return D.fail(json.error.message || "marketplace error");
    const result = json.result || {};
    const rawItems = result.results || result.agents || result.items || (Array.isArray(result) ? result : null);
    // 엔진 내부 에이전트(researcher-<n>, research-intelligence-desk, hephaestus-*)는 제품이 아니므로 숨긴다.
    const items = Array.isArray(rawItems) ? rawItems.filter((it) => !isInternalAgentSlug(it && (it.slug || it.id))) : rawItems;
    if (!Array.isArray(items) || !items.length) {
      D.out(`No results for "${query}"`);
      return;
    }
    for (const it of items.slice(0, limit)) {
      const slug = it.slug || it.id || "?";
      const name = it.name || it.title || slug;
      const kind = it.kind || it.entity_kind || "";
      const tagline = it.tagline || it.description || "";
      D.out(`${String(slug).padEnd(34).slice(0, 34)} ${String(name).slice(0, 26).padEnd(27)} ${String(kind).padEnd(14)} ${String(tagline).slice(0, 60)}`);
    }
    D.out("");
    D.out("Install: agentlas install <slug>");
  }

  return {
    cmdStorm, stormRun, cmdSwarm, swarmRun, cmdAutomation, cmdUsage, cmdTelegram, cloudSearch,
    cmdLogin, cmdLogout, cmdWhoami, cmdHep, runHephaestusInteractive, cmdMcp, cmdChats,
    nextCronRun, nextAutomationRun, runAutomationOnce, parseSwarmOutput, waitForLoopbackSession,
  };
}

module.exports = { create, _test: { createLoginState, createLoginCallbackGuard, routePreviewModel, researchPreviewModel } };
