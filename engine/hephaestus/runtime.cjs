"use strict";
/*
 * hephaestus/runtime — Hephaestus(Agentlas OS Core) 네이티브 패스스루 클러스터.
 *
 * v1 출처: engine/agentlas-parity.cjs (git tag legacy-v1-engine-snapshot)
 *   - hephaestusBin / careerGraphRuntime / spawnHephaestus / captureHephaestus
 *   - runHephaestusRoute / runHephaestusResearch (사람용 렌더러)
 *   - runHephaestusInteractive (stdio inherit 패스스루 공용 러너)
 *   - HEP_USAGE / cmdHep
 *
 * v2 이식 규칙:
 *   - D.out → ctx.out, D.prefsLang() → ctx.lang.
 *   - D.runCwd — v1 검증 결과: AGENTLAS_RUN_CWD 같은 env는 v1에 존재하지 않았다.
 *     v1 runCwd()의 실제 동작 = userDataDir()/agent-cwd 샌드박스(mkdir, 실패 시
 *     homedir 폴백). 그 동작을 그대로 보존해 여기 로컬로 이식했다. (프로젝트
 *     실행 위치가 필요한 곳은 v1과 동일하게 projectCwd()를 쓴다.)
 *   - 런타임 발견은 engine/agentlas-core-harness.cjs(복원본)를 소비만 한다.
 *   - 런타임 부재 = 정직 정지(exit 1) + v1 설치 안내 문구 그대로. 폴백 금지.
 *
 * ⚠ v1 결함 제거: careerGraphRuntime()의 root 후보에 있던
 *   path.resolve(__dirname, "..", "..", "agentlas_desktop", "Hephaestus")
 *   — 개발 머신에서만 존재하는 형제 저장소 상대경로 — 는 결함으로 판정되어
 *   v2에서 삭제했다. 설치 런처/env/앱 번들 후보만 남긴다.
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { Ui } = require("../agentlas-ui.cjs");
const { truncateWidth, visWidth, wrapWidth } = require("../agentlas-composer.cjs");
const coreHarness = require("../agentlas-core-harness.cjs");
const { userDataDir } = require("../core/paths.cjs");

const { CONTEXT_MAP_MIN_CORE_VERSION } = coreHarness;

// ── 명령 usage 문자열 (v1 TOP_LEVEL_COMMAND_USAGE에서 hephaestus 클러스터만 발췌) ──
const USAGE = Object.freeze({
  build: 'usage: agentlas build "<request>"',
  browser: "usage: agentlas browser <url-or-query|subcommand>",
  call: 'usage: agentlas call "<agent-slugs>" "<context>"',
  connect: "usage: agentlas connect [status|telegram|help]",
  hep: "usage: agentlas hep <subcommand> [args]",
  // 소스 스코프 스태핑(hep-network/hep-local/hep-cloud/hep-hub)과 legacy-network 의
  // usage 는 2026-08-05 에 삭제했다. 네이티브가 편성을 수행하지 않고 exit 3 +
  // host_llm_required 만 반환하므로, 여기에 usage 를 두면 "쓸 수 있는 명령"으로
  // 읽힌다. 차단과 안내는 commands/index.cjs 의 HOST_LLM_ONLY_SURFACES 가 한다.
  hephaestus: "usage: agentlas hephaestus <subcommand> [args]",
  journal: "usage: agentlas journal <status|verify|repair|gate> --run-id <id> | --journal <path>",
  netadmin: "usage: agentlas netadmin <init|status|reindex|bench|add-source> [args]",
  research: "usage: agentlas research <status|gather|search|read|plan> [args]",
  route: 'usage: agentlas route "<request>" [--json]',
});

// v1 localizedTopLevelUsage와 동일한 한국어 변환.
function usageFor(cmd, lang) {
  const usage = USAGE[cmd];
  if (!usage) return null;
  if (lang !== "ko") return usage;
  return usage
    .replace(/^usage:/, "사용법:")
    .replace(/\[args\]/g, "[인자]")
    .replace(/<subcommand>/g, "<하위-명령>");
}

function isHelpToken(value) {
  return value === "help" || value === "--help" || value === "-h";
}

// ── 라우팅/리서치 미리보기 모델 (v1 module-level 순수 함수, 그대로) ──
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

/*
 * create(ctx, deps?) — v2 ctx(DI)로 바인딩된 러너 묶음을 만든다.
 *   ctx: { lang, out, err } (엔진 ctx 그대로 전달해도 된다)
 *   deps: 테스트 전용 주입 이음새. 기본값은 실제 core-harness.
 *         (v1도 create(deps) 주입 팩토리였다 — 같은 구조를 유지한다.)
 */
function create(ctx, deps = {}) {
  const resolveCoreRuntimeRoot = deps.resolveCoreRuntimeRoot || coreHarness.resolveCoreRuntimeRoot;
  const spawnCoreModule = deps.spawnCoreModule || coreHarness.spawnCoreModule;
  const lang = () => (ctx && ctx.lang) || "en";

  function newUi(uiLang) {
    return new Ui({ lang: uiLang || lang() });
  }

  // v1 agentlas.cjs runCwd() 그대로: 에이전트 전용 안전 샌드박스 폴더.
  // (검증: v1에 AGENTLAS_RUN_CWD env는 없었다 — process.cwd() 매핑이 아니라
  //  이 샌드박스가 원래 동작이므로 그대로 보존한다.)
  function runCwd() {
    const dir = path.join(userDataDir(), "agent-cwd");
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return os.homedir();
    }
  }

  // v1: 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리.
  // 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 샌드박스로 폴백.
  function projectCwd() {
    try {
      const cwd = process.cwd();
      if (!cwd || cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return runCwd();
      return cwd;
    } catch {
      return runCwd();
    }
  }

  // ── Hephaestus 런타임 해석 (설치 런처 우선, 앱 번들 폴백) ──
  // v1 후보 순서 그대로: HEPHAESTUS_BIN → ~/.agentlas/runtime/current/bin/hephaestus
  // → Core python 모듈(resolveCoreRuntimeRoot). win32는 bin 후보를 건너뛴다(v1 동일).
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
    // v1에는 여기 형제 저장소 상대경로(../../agentlas_desktop/Hephaestus)가 있었다.
    // 개발 머신에서만 성립하는 결함으로 확정되어 v2에서 제거했다 (파일 상단 참조).
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

  function captureHephaestus(args, opts = {}) {
    const cwd = opts.cwd || runCwd();
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

  async function runHephaestusRoute(args, opts = {}) {
    const raw = args.includes("--json");
    const cleanArgs = args.filter((arg) => arg !== "--json");
    if (raw) return runHephaestusInteractive(cleanArgs, { ...opts, human: false });
    if (!hephaestusBin()) return runHephaestusInteractive(cleanArgs, { ...opts, human: false });
    const ui = opts.ui || newUi();
    // route는 Hub 왕복이라 실측 ~13s 걸린다 — research처럼 진행 표시를 준다.
    // (clig.dev: 몇 초 넘는 작업엔 진행 인디케이터. 예전엔 그 시간 내내 침묵했다.)
    if (typeof ui.startSpinner === "function") ui.startSpinner(ui.lang === "ko" ? "라우팅 미리보기 계산 중…" : "Previewing routing…");
    let result;
    try {
      result = await captureHephaestus(cleanArgs, opts);
    } finally {
      if (typeof ui.stopSpinner === "function") ui.stopSpinner();
    }
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

  // ── Hephaestus 네이티브 패스스루 — 엔진 전 기능을 터미널 1급으로 노출 ──
  // stdio inherit 로 돌려 색/프롬프트/스트리밍이 네이티브 그대로 나온다.
  //
  // 주의: `context` 분기는 공용 러너에 남겨 두지만(다른 소유자의 `agentlas
  // context` 명령이 이 러너를 호출할 수 있다), 이 클러스터의 COMMANDS에는
  // context 명령을 노출하지 않는다 — context.cjs는 다른 에이전트 소유다.
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
      // 런타임 부재 = 정직 정지 (v1 문구 그대로). 폴백 실행 금지.
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
    const cwd = opts.cwd || (helpOnly ? process.cwd() : runCwd());
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
    // Core writes nothing until its final payload. `hep search` measured 29.7s
    // of complete silence on every stream — indistinguishable from a hang, and
    // the command that takes longest is the one a newcomer tries first.
    // stdout carries machine-readable JSON, so the heartbeat goes to stderr
    // only, and only when stderr is a terminal: piping or redirecting must stay
    // byte-identical for anything parsing this.
    const stopHeartbeat = helpOnly ? null : startQuietChildHeartbeat(args);
    return new Promise((resolve) => {
      child.on("error", (e) => {
        if (stopHeartbeat) stopHeartbeat();
        process.stderr.write(`Hephaestus failed: ${e.message}\n`);
        resolve(1);
      });
      child.on("close", (code) => {
        if (stopHeartbeat) stopHeartbeat();
        resolve(code == null ? 0 : code);
      });
    });
  }

  /**
   * Report elapsed time on stderr while a passthrough child stays quiet.
   * Returns a stop function; returns null when there is nothing safe to write to.
   */
  function startQuietChildHeartbeat(args) {
    if (!process.stderr.isTTY) return null;
    const label = args.filter((a) => !String(a).startsWith("-")).slice(0, 2).join(" ") || "hephaestus";
    const started = Date.now();
    let painted = false;
    const paint = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      process.stderr.write(`\r[2K${label} … ${secs}s`);
      painted = true;
    };
    // Stay silent through the common fast case; only speak once it is slow
    // enough that a user would start wondering.
    const first = setTimeout(() => { paint(); }, 1500);
    const timer = setInterval(paint, 1000);
    if (typeof timer.unref === "function") timer.unref();
    if (typeof first.unref === "function") first.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      if (painted) process.stderr.write("\r[2K");
    };
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

  // v1 cmdHep는 process.exitCode를 세팅했다. v2 명령 계약은 exit code 반환이다.
  async function cmdHep(args) {
    if (!args.length || args[0] === "help") {
      ctx.out(HEP_USAGE);
      return 0;
    }
    return runHephaestusInteractive(args);
  }

  return {
    hephaestusBin,
    careerGraphRuntime,
    spawnHephaestus,
    captureHephaestus,
    runCwd,
    projectCwd,
    renderRoutePreview,
    renderResearchPreview,
    runHephaestusRoute,
    runHephaestusResearch,
    runHephaestusInteractive,
    HEP_USAGE,
    cmdHep,
  };
}

module.exports = {
  create,
  routePreviewModel,
  researchPreviewModel,
  USAGE,
  usageFor,
  isHelpToken,
  CONTEXT_MAP_MIN_CORE_VERSION,
};
