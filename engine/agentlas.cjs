#!/usr/bin/env node
/*
 * Agentlas terminal CLI (Phase 1).
 *
 * 앱(GUI)과 같은 데이터를 공유한다 — 같은 userData의 SQLite, 같은 keychain(env).
 * Electron-as-Node로 실행되도록 설계: 앱이 번들한 네이티브 모듈(better-sqlite3 / keytar)을
 * 그대로 require 한다. (래퍼: ELECTRON_RUN_AS_NODE=1 <Agentlas execPath> <이 파일> ...)
 *
 * 명령:
 *   agentlas list                  설치된 에이전트/회사 + 활성 런타임
 *   agentlas cd <agent>            에이전트 폴더 경로 출력 (CLAUDE.md/AGENTS.md/GEMINI.md 생성)
 *                                  → cd "$(agentlas cd seo)" && claude
 *   agentlas run <agent> [prompt]  활성(또는 --runtime) CLI로 1회 실행. prompt 없으면 stdin.
 *   agentlas chat <agent>          대화형 REPL
 *   agentlas env [list]            공유 env 키 목록 (이름만)
 *   agentlas multimodal            이미지/영상/음성 전역 fallback provider
 *   agentlas ontology              현재 프로젝트 온톨로지 inbox/source 상태
 *   agentlas update                최신 Desktop 공개 릴리즈 확인/설치
 *   agentlas doctor                런타임/데이터 점검
 *   agentlas help
 *
 * 옵션: --runtime claude-code|codex|gemini
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { compareSemVer, normalizeSemVer, parseSemVer } = require("./semver.cjs");
const terminalAssets = require("./agentlas-experience-mcp.cjs");
const terminalExperienceExchange = require("./agentlas-experience-exchange.cjs");
const desktopOntologyLoadout = require("./agentlas-desktop-loadout.cjs");
const workloadRouting = require("./agentlas-workload-routing.cjs");
const terminalExperienceIntake = require("./agentlas-experience-intake.cjs");
const { captureCoreJsonSync, resolveCoreRuntimeRoot } = require("./agentlas-core-harness.cjs");

// ── 앱과 동일한 userData 경로 (electron app.getPath('userData')와 일치) ──
function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

function readPackageVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVICE = "com.agentlas.desktop";
const ENV_PREFIX = "env:";
const MULTIMODAL_META_KEY = "multimodal_settings";
// 도구 사용 권한 (read|write|full). 빌드/파일 생성이 기본 동작이므로 기본값 write.
// `--permission full` 로 셸 명령 포함 전체 자동(npm/mkdir 등) 허용. main()에서 설정.
let PERMISSION = "write";
let PERMISSION_EXPLICIT = false; // true once --permission is passed (overrides saved prefs)

function dbPath() {
  return path.join(userDataDir(), "agentlas.sqlite");
}

function openDb() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    fail(`Agentlas data was not found: ${p}\nRun this through the 'agentlas' launcher (it bootstraps the data on first run), or reinstall: npm i -g agentlas`);
  }
  try {
    const Database = require("better-sqlite3");
    return new Database(p, { readonly: false, fileMustExist: true });
  } catch (e) {
    try {
      return openNodeSqliteDb(p);
    } catch (fallbackError) {
      fail(
        "SQLite 런타임을 불러올 수 없습니다. Node 22.5+ 로 올리거나 'npm i -g agentlas'로 재설치(better-sqlite3 빌드)하세요.\n" +
          String((fallbackError && fallbackError.message) || (e && e.message) || fallbackError),
      );
    }
  }
}

function openNodeSqliteDb(p) {
  installNodeSqliteWarningFilter();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(p);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      };
    },
    // better-sqlite3 API 패리티 — 폴백 경로에서도 db.exec/db.pragma가 있어야 한다.
    // 누락 시 ensureMemoryContextColumn 등 ALTER TABLE(exec)이 TypeError로 조용히 죽어
    // (try/catch 삼킴) context_json 컬럼 마이그레이션이 되지 않고 memory 조회가 깨진다.
    exec: (sql) => db.exec(sql),
    pragma: (source) => {
      const rows = db.prepare(`PRAGMA ${source}`).all();
      // better-sqlite3 pragma()의 단일값 반환 관례를 근사(단일 컬럼·단일 행 → 스칼라).
      if (rows.length === 1) {
        const keys = Object.keys(rows[0]);
        if (keys.length === 1) return rows[0][keys[0]];
      }
      return rows;
    },
    transaction(fn) {
      return (...args) => {
        db.exec("BEGIN");
        try {
          const result = fn(...args);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* ignore rollback failure */
          }
          throw err;
        }
      };
    },
    close: () => db.close(),
  };
}

function installNodeSqliteWarningFilter() {
  if (process.__agentlasSqliteWarningFilter) return;
  Object.defineProperty(process, "__agentlasSqliteWarningFilter", { value: true });
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const message = typeof warning === "string" ? warning : String((warning && warning.message) || warning || "");
    if (/SQLite is an experimental feature/i.test(message)) return;
    return originalEmitWarning(warning, ...args);
  };
}

function readKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

function loadMultimodalCatalog() {
  try {
    return require("../dist/shared/multimodal.js");
  } catch {
    const providers = [
      { id: "codex-cli-image", modality: "image", label: "Codex CLI image", labelKo: "Codex CLI 이미지", envKeys: [], billing: "subscription", defaultModel: "runtime-default" },
      { id: "grok-cli-image", modality: "image", label: "Grok CLI image (Imagine)", labelKo: "Grok CLI 이미지 (Imagine)", envKeys: [], billing: "subscription", defaultModel: "runtime-default" },
      { id: "grok-cli-video", modality: "video", label: "Grok CLI video (Imagine)", labelKo: "Grok CLI 영상 (Imagine)", envKeys: [], billing: "subscription", defaultModel: "runtime-default" },
      { id: "openai-image", modality: "image", label: "OpenAI Images API", labelKo: "OpenAI 이미지 API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "gpt-image-2" },
      { id: "google-image", modality: "image", label: "Google Gemini Image", labelKo: "Google Gemini 이미지", envKeys: ["GOOGLE_API_KEY"], billing: "paid-api", defaultModel: "gemini-image" },
      { id: "runway-video", modality: "video", label: "Runway API", labelKo: "Runway API", envKeys: ["RUNWAY_API_KEY"], billing: "paid-api", defaultModel: "gen4.5" },
      { id: "google-veo", modality: "video", label: "Google Veo", labelKo: "Google Veo", envKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"], billing: "provider-billing", defaultModel: "veo" },
      { id: "openai-sora", modality: "video", label: "OpenAI Sora API", labelKo: "OpenAI Sora API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "sora" },
      { id: "openai-audio", modality: "audio", label: "OpenAI Audio", labelKo: "OpenAI 오디오", envKeys: ["OPENAI_API_KEY"], billing: "paid-api", defaultModel: "gpt-4o-mini-tts" },
      { id: "elevenlabs-audio", modality: "audio", label: "ElevenLabs", labelKo: "ElevenLabs", envKeys: ["ELEVENLABS_API_KEY"], billing: "paid-api", defaultModel: "eleven_multilingual_v2" },
      { id: "deepgram-audio", modality: "audio", label: "Deepgram", labelKo: "Deepgram", envKeys: ["DEEPGRAM_API_KEY"], billing: "paid-api", defaultModel: "nova-3" },
      { id: "replicate-video", modality: "video", label: "Replicate", labelKo: "Replicate", envKeys: ["REPLICATE_API_TOKEN"], billing: "paid-api", defaultModel: "provider-model" },
    ];
    const defaults = { imageProvider: "codex-cli-image", videoProvider: "runway-video", audioProvider: "openai-audio" };
    return {
      MULTIMODAL_PROVIDERS: providers,
      DEFAULT_MULTIMODAL_SETTINGS: defaults,
      normalizeMultimodalSettings: (input) => ({ ...defaults, ...(input || {}) }),
      selectedMultimodalEnvKeys: (settings) => {
        const ids = new Set([settings.imageProvider, settings.videoProvider, settings.audioProvider]);
        return [...new Set(providers.filter((p) => ids.has(p.id)).flatMap((p) => p.envKeys || []))].sort();
      },
    };
  }
}

// ── 데이터 접근 ────────────────────────────────────────────
const PRIVATE_WEB_AGENT_FINGERPRINTS = new Set([
  "880db20e11cd945e5777b5aaf73c10f24de3e2e190d13631b5f3ed0e4796821c",
  "a0dba10416f15dac84202902284780ee23f31eda9dc068ccf6a28276b585ea36",
  "479d879189166bf9bde1b0cd939db746bf8c1b94f2aad553d08cf7b4a2204f9e",
  "79c16e0347312aceb57c0ec7ee6bb6ebd0118984cc716f9cd56db63d18679183",
  "56ff55fcc909461b5fc449fdb3d685c6cceeb10d59836d9a91faf3ceb41896a4",
  "978dd8a262d86397bbdaca13bbec5be313a68fb2d5c609330888818641af8079",
]);
const BACKGROUND_AGENT_FINGERPRINTS = new Set([
  "9011fb75e638676e23a36f86ea689b6e4de17cb5b5954b36810b5239ab077f0b",
  "0331d654916d648797d31598e3e18eb7fd49166e91783ab9d731648b6e855b90",
]);
const BACKGROUND_ROLES = new Set(["orchestrator", "pm", "curator", "governance"]);
function policyNormalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function policyFingerprint(value) {
  const normalized = policyNormalize(value);
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex") : null;
}
function agentFingerprints(agent) {
  return [agent.slug, agent.name, agent.name_en, agent.tagline, agent.tagline_en]
    .map(policyFingerprint)
    .filter(Boolean);
}
function isPrivateWebOnlyAgentCli(agent) {
  if (policyNormalize(agent.visibility) === "private") return true;
  if (policyNormalize(agent.role) === "meta") return true;
  return agentFingerprints(agent).some((value) => PRIVATE_WEB_AGENT_FINGERPRINTS.has(value));
}
function isBackgroundAgentCli(agent) {
  if (isPrivateWebOnlyAgentCli(agent)) return false;
  if (policyNormalize(agent.visibility) === "background") return true;
  if (agent.builtin && BACKGROUND_ROLES.has(policyNormalize(agent.role))) return true;
  return agentFingerprints(agent).some((value) => BACKGROUND_AGENT_FINGERPRINTS.has(value));
}
function listPublicAgents(db) {
  return db.prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC").all()
    .filter((agent) => !isPrivateWebOnlyAgentCli(agent))
    .map((agent) => ({ ...agent, visibility: isBackgroundAgentCli(agent) ? "background" : "visible" }));
}
function listAgents(db) {
  return listPublicAgents(db).filter((agent) => agent.visibility !== "background");
}
function listRoutableAgents(db) {
  return listPublicAgents(db);
}
function activeRuntime(db) {
  try {
    return db.prepare("SELECT * FROM active_runtime WHERE id = 1").get() || null;
  } catch {
    return null;
  }
}
function getMultimodalSettingsCli(db) {
  const mm = loadMultimodalCatalog();
  let raw = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(MULTIMODAL_META_KEY);
    raw = row && row.value;
  } catch {
    raw = null;
  }
  try {
    return mm.normalizeMultimodalSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return mm.normalizeMultimodalSettings(null);
  }
}
function saveMultimodalSettingsCli(db, patch) {
  const mm = loadMultimodalCatalog();
  const next = mm.normalizeMultimodalSettings({ ...getMultimodalSettingsCli(db), ...patch, updatedAt: new Date().toISOString() });
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(MULTIMODAL_META_KEY, JSON.stringify(next));
  } catch (e) {
    fail("multimodal settings 저장 실패: " + e.message);
  }
  return next;
}
function routesMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir(), "agent-routes.json"), "utf8"));
  } catch {
    return {};
  }
}
function resolveAgent(db, query) {
  if (!String(query || "").trim()) return null;
  const agents = listAgents(db);
  const q = (query || "").toLowerCase();
  return (
    agents.find((a) => a.slug === query || a.id === query) ||
    agents.find((a) => (a.name || "").toLowerCase() === q || (a.name_en || "").toLowerCase() === q) ||
    agents.find((a) => (a.slug || "").toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.name_en || "").toLowerCase().includes(q)) ||
    null
  );
}
const GLOBAL_ORCHESTRATOR_SLUG = "agentlas-orchestrator";
// 메타-빌더(에이전트/팀/회사 생성) — 약한 키워드 점수 경쟁에서 빼고, 명시적 build 의도일 때만 직행 라우팅.
const META_BUILDER_SLUGS = ["agentlas-core-engine-meta-agent-builtin", "agentlas-meta-agent"];
const NON_GENERIC_ROUTE_SLUGS = new Set([GLOBAL_ORCHESTRATOR_SLUG, ...META_BUILDER_SLUGS]);
const AGENT_BUILD_TERMS = [
  "build an agent", "build a team", "build me an agent", "build me a team", "make an agent",
  "make a team", "create an agent", "create a team", "agent team", "agent for me",
  "scaffold a team", "scaffold an agent", "build a company", "create a company",
  "new agent team", "set up an agent", "set up a team", "spin up an agent",
  "에이전트팀", "에이전트 팀", "에이전트 만들", "에이전트를 만들", "에이전트 좀 만들",
  "에이전트 생성", "에이전트 구축", "팀 만들", "팀을 만들", "팀 생성", "회사 만들",
  "회사를 만들", "에이전트 하나 만들",
];
// 한국어 조사("하나만","좀","를")가 끼면 고정 구문 매칭이 깨지므로, 엔티티+동사 근접 규칙을 보강한다.
const BUILD_ENTITY_RE = /(에이전트|agent|팀|team|회사|company)/i;
const BUILD_VERB_RE = /(만들|만든|생성|구축|구성해|꾸려|세팅|패키징|scaffold|build|create|\bmake\b|set\s?up|spin\s?up)/i;
function isAgentBuildIntent(prompt) {
  // 경로/파일 참조는 빌드 의도의 증거가 아니다 — "/Users/x/agent-tools/notes.md 요약본
  // 만들어줘"의 디렉터리명이나 "agent-notes.md" 같은 파일명이 BUILD_ENTITY_RE를 때려
  // 메타빌더(score 1000)로 직행하던 우회로 차단. 빌드 의도는 산문에서만 읽는다.
  // ⚠️ 남은 슬래시는 통째로 지우지 않고 공백으로만 벌린다 — "에이전트/팀 만들어줘"의
  // 슬래시-엔티티("에이전트/팀")를 삭제하면 BUILD_ENTITY_RE가 못 맞아 빌드 의도를 놓친다.
  // 진짜 경로는 이미 routeStripPaths(마지막 세그먼트만)+확장자 제거가 처리했다.
  const p = routeNormalize(
    routeStripPaths(prompt)
      .replace(/\S+\.[A-Za-z0-9]{1,6}(?=\s|$)/g, " ")
      .replace(/[\\/]+/g, " "),
  );
  if (!p.trim() || isTrivialRoutePrompt(p)) return false;
  if (AGENT_BUILD_TERMS.some((term) => p.includes(routeNormalize(term)))) return true;
  // 예: "단일 에이전트 하나만 만들어줘", "팀 좀 꾸려줘", "make me an agent"
  return BUILD_ENTITY_RE.test(p) && BUILD_VERB_RE.test(p);
}
function resolveMetaBuilder(db) {
  try {
    const rows = db
      .prepare("SELECT * FROM installed_agents WHERE slug IN ('agentlas-core-engine-meta-agent-builtin','agentlas-meta-agent')")
      .all();
    for (const slug of META_BUILDER_SLUGS) {
      const a = rows.find((r) => r.slug === slug);
      if (a) return a;
    }
  } catch {
    /* ignore */
  }
  return null;
}
// "ai"/"llm" 같은 초범용 토큰은 모든 에이전트 프롬프트에 나오므로 판별력이 0이다 —
// 이런 단어 하나로 전문 에이전트가 선택되던 오라우팅(예: 일반 맥 질문 → Pitch Deck Architect)을 막는다.
// "local"/"imported"/"team"은 임포터 보일러플레이트("Imported local team")와 slug 접두/접미에
// 편재해 판별력이 없다 — 'team' 한 단어가 아무 임포트 팀의 slug 부분문자열(+6 strong)을 때리던 구멍.
const ROUTE_STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "make", "build", "create", "agent", "agents", "team", "please", "ai", "llm", "local", "imported", "인공지능", "에이아이", "좀", "해주세요", "해줘", "만들어", "붙여", "연결", "작업", "요청"]);
const ROUTE_HINTS = [
  {
    slug: "agentlas-app-builder",
    terms: [
      "apps generate",
      "app builder",
      "make an app",
      "build an app",
      "create an app",
      "generated app",
      "generate app",
      "internal app",
      "dedicated app",
      "workflow app",
      "dashboard app",
      "studio app",
      "service-app",
      "creative-studio",
      "scaffold-app",
      "operate-app",
      "앱빌더",
      "앱 빌더",
      "앱 만들어",
      "앱 만들",
      "전용 앱",
      "내장 앱",
      "내부 앱",
      "생성 앱",
      "워크플로우 앱",
      "대시보드 앱",
      "스튜디오 앱",
    ],
    reasonKo: "Agentlas 안에서 열리는 내부 App 생성/설계 요청입니다",
    reasonEn: "the request is to create or design an internal Agentlas App",
  },
  {
    slug: "agentlas-memory-curator",
    terms: ["memory", "remember", "recall", "request_context", "context_json", "메모리", "기억", "회상", "저장"],
    reasonKo: "기억 저장/검색/스코프 품질을 다루는 요청입니다",
    reasonEn: "the request concerns memory storage, recall, or scope quality",
  },
  {
    slug: "agentlas-task-bias",
    terms: ["bias", "sitemap", "evidence", "completion", "coverage", "편향", "사이트맵", "증거", "검증"],
    reasonKo: "작업 편향, 사이트맵, 검증 증거를 다루는 요청입니다",
    reasonEn: "the request concerns task bias, sitemap, or validation evidence",
  },
  {
    slug: "agentlas-pm-soul",
    terms: ["project", "plan", "decision", "handoff", "continuity", "프로젝트", "계획", "결정", "연속성", "핸드오프"],
    reasonKo: "프로젝트 연속성/결정/조율이 중심인 요청입니다",
    reasonEn: "the request is centered on project continuity, decisions, or coordination",
  },
];
function routeNormalize(value) {
  return String(value || "").toLowerCase().replace(/[_/]+/g, "-");
}
// 경로 디렉터리 성분은 라우팅 의도가 아니다 — 마지막 세그먼트(파일/폴더명)만 남긴다.
// 사고(2026-07-12): "/Users/mason/Documents/…/Appbridge_Template.이 …" 프롬프트의 경로 토큰
// ("users","mason","documents","users-mason-documents-")이 임포트 에이전트 system_prompt 속
// 절대경로와 맞아떨어져 +2씩 쌓이고 라우팅 근거에까지 노출됐다. 프롬프트/헤이스택 양쪽에
// 대칭 적용해 경로↔경로 우연 일치를 차단한다. 파일/폴더명은 실제 의도라서 보존한다.
// 규칙: 공백/인용부호/괄호 뒤(또는 문자열 시작)에서 시작하고, "세그먼트+구분자"가 2회 이상
// 이어지는 절대·홈·드라이브·UNC 경로만 경로로 본다 — "and/or", "서울/부산", 날짜(2026/07/12),
// "https://…"(콜론 뒤 //는 시작 조건 불충족)는 건드리지 않는다. 세그먼트 안의 단일 공백은
// 뒤가 대문자로 시작할 때만 허용해 "Mobile Documents"/"Application Support"는 접되,
// "/tmp/out 기획/디자인 …" 같은 한글 프로즈를 경로로 삼켜버리지 않는다. 상대경로는
// 확장자 있는 파일 참조("docs/plan/roadmap.md")만 접는다 — 디렉터리명("plan")이 힌트/이름
// strong 채널을 때리는 것을 막으면서 "서울/부산/대구" 같은 나열은 보존한다.
const ROUTE_PATH_RE = /(^|[\s"'`(<\[{])((?:~|[A-Za-z]:)?[\\/]{1,2}(?:[^\s\\/]+(?: [A-Z][^\s\\/]*)?[\\/]+){2,}[^\s\\/]*|(?:[^\s\\/]+[\\/]+){2,}[^\s\\/]+\.[A-Za-z0-9]{1,6})/g;
function routeStripPaths(value) {
  return String(value || "").replace(ROUTE_PATH_RE, (whole, pre, p) => {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    return pre + (segs.length ? segs[segs.length - 1] : "");
  });
}
function routeTokenize(value) {
  // 매치가 영숫자로 끝나도록 강제해 "users-mason-documents-" 같은 후행 하이픈 토큰을 원천 차단.
  const matches = routeNormalize(routeStripPaths(value)).match(/[a-z0-9][a-z0-9-]*[a-z0-9]|[가-힣]{2,}/g) || [];
  const expanded = matches.flatMap((term) => term.split("-").filter(Boolean).concat(term));
  return [...new Set(expanded.filter((term) => term.length >= 2 && !ROUTE_STOP_WORDS.has(term)))];
}
// 정체성 존(slug/이름/태그라인) — 여기 적중은 강한 라우팅 신호. system_prompt 본문 적중은 약한 신호.
// 임포터 보일러플레이트 태그라인("Imported local team/agent")의 세 단어는 전부 스톱워드라
// 프롬프트 토큰이 될 수 없다 — 별도 필터 불필요.
function routeIdentityHaystack(agent) {
  return routeNormalize(routeStripPaths([agent.slug, agent.name, agent.name_en, agent.tagline, agent.tagline_en].join("\n")));
}
function routeHaystack(agent) {
  return routeNormalize(routeStripPaths([
    agent.slug,
    agent.name,
    agent.name_en,
    agent.tagline,
    agent.tagline_en,
    String(agent.system_prompt || "").slice(0, 3500),
  ].join("\n")));
}
const APP_BUILDER_EXPLICIT_TERMS = [
  "apps generate", "app builder", "make an app", "build an app", "create an app",
  "generate app", "generated app", "internal app", "dedicated app", "workflow app",
  "dashboard app", "studio app", "service-app", "creative-studio", "scaffold-app",
  "operate-app", "앱빌더", "앱 빌더", "앱 만들어", "앱 만들", "전용 앱", "내장 앱",
  "내부 앱", "생성 앱", "워크플로우 앱", "대시보드 앱", "스튜디오 앱",
];
const APP_BUILDER_REPEAT_TERMS = [
  "automation", "automate", "automatic", "recurring", "repeat", "scheduled",
  "scheduler", "every day", "every week", "workflow", "pipeline", "cron",
  "자동화", "자동", "반복", "정기", "매일", "매주", "스케줄", "예약",
  "워크플로우", "파이프라인",
];
const APP_BUILDER_SURFACE_TERMS = [
  "dashboard", "studio", "editor", "settings", "state", "save", "saved",
  "export", "import", "approve", "approval", "review", "queue", "table",
  "filter", "template", "memory", "profile", "대시보드", "스튜디오", "편집",
  "수정", "설정", "상태", "저장", "내보내기", "불러오기", "승인", "검토",
  "큐", "목록", "테이블", "필터", "템플릿", "학습", "메모리", "프로필",
];
const APP_BUILDER_ACTION_TERMS = [
  "build", "create", "generate", "compose", "manage", "track", "research",
  "analyze", "monitor", "render", "convert", "만들", "생성", "작성", "관리",
  "추적", "리서치", "조사", "분석", "모니터", "렌더", "변환",
];
const TRIVIAL_ROUTE_PROMPTS = new Set(["hi", "hello", "hey", "thanks", "thankyou", "안녕", "안녕하세요", "고마워", "감사", "뭐해"]);
function routeIncludesTerm(haystack, term) {
  return haystack.includes(routeNormalize(term));
}
function routeMatchedTerms(promptText, terms) {
  return [...new Set(terms.filter((term) => routeIncludesTerm(promptText, term)))];
}
function isTrivialRoutePrompt(promptText) {
  const compact = String(promptText || "").replace(/\s+/g, " ").trim();
  const stripped = compact.replace(/[.!?~。！？,，ㅋㅎ\s]/g, "");
  if (!stripped) return true;
  if (stripped.length <= 18 && TRIVIAL_ROUTE_PROMPTS.has(stripped)) return true;
  const words = compact.split(/\s+/).filter(Boolean);
  return words.length <= 3 && TRIVIAL_ROUTE_PROMPTS.has(stripped);
}
function isAppBuilderWorthyRoutePrompt(prompt) {
  const promptText = routeNormalize(routeStripPaths(prompt));
  if (!promptText.trim() || isTrivialRoutePrompt(promptText)) return false;
  const explicit = routeMatchedTerms(promptText, APP_BUILDER_EXPLICIT_TERMS);
  if (explicit.length) return true;
  const repeat = routeMatchedTerms(promptText, APP_BUILDER_REPEAT_TERMS);
  const surface = routeMatchedTerms(promptText, APP_BUILDER_SURFACE_TERMS);
  const action = routeMatchedTerms(promptText, APP_BUILDER_ACTION_TERMS);
  const signalCount = new Set([...repeat, ...surface, ...action]).size;
  if (repeat.length && (surface.length || action.length)) return true;
  if (surface.length >= 2 && action.length) return true;
  return signalCount >= 4;
}
function routeHint(promptText, agent, lang) {
  const hint = ROUTE_HINTS.find((item) => item.slug === agent.slug);
  if (!hint) return { score: 0, terms: [], reason: "" };
  if (hint.slug === "agentlas-app-builder" && !isAppBuilderWorthyRoutePrompt(promptText)) {
    return { score: 0, terms: [], reason: "" };
  }
  const terms = hint.terms.filter((term) => promptText.includes(routeNormalize(term)));
  if (!terms.length) return { score: 0, terms: [], reason: "" };
  return { score: 12 + terms.length * 3, terms, reason: lang === "ko" ? hint.reasonKo : hint.reasonEn };
}
function scoreRouteAgent(prompt, promptTerms, agent, lang, pre) {
  // 대칭 스트리핑 필수: promptText는 이름(+20)·힌트(+12↑) strong 채널의 입력이라, 여기서
  // 경로를 안 벗기면 "/Users/x/project-plan/…"의 디렉터리명이 strong 게이트를 그대로 뚫는다.
  const promptText = routeNormalize(routeStripPaths(prompt));
  if (agent.slug === "agentlas-app-builder" && !isAppBuilderWorthyRoutePrompt(promptText)) {
    return {
      agent,
      score: 0,
      reason: lang === "ko"
        ? "전용 App을 만들 만큼 반복·상태·편집·자동화가 뚜렷하지 않아 App Builder 라우트를 보류했습니다"
        : "the request does not clearly need a dedicated App with durable workflow, state, editing, or automation",
      terms: [],
      strong: false,
    };
  }
  // 헤이스택은 설치/임포트 시에만 변하므로 autoRouteAgent가 미리 계산해 넘긴다(중복 계산 제거).
  const identityHay = (pre && pre.identityHay) || routeIdentityHaystack(agent);
  const haystack = (pre && pre.haystack) || routeHaystack(agent);
  let score = 0;
  let strong = false; // 이름 언급/정체성 적중/큐레이션 힌트 — 데스크탑처럼 "이름/힌트급 증거"가 있어야 위임한다
  const terms = [];
  const seenNames = new Set();
  for (const name of [agent.slug, agent.name, agent.name_en].filter(Boolean)) {
    const n = routeNormalize(name);
    // 4자 미만 일반 단어("team","agent" 등)가 프롬프트에 우연히 들어가 +20을 독식하지 않도록 가드.
    // name === name_en 인 임포트 에이전트(appbridge 등)가 +20을 두 번 받지 않도록 정규화 기준 dedupe.
    if (!n || n.length < 4 || seenNames.has(n)) continue;
    seenNames.add(n);
    if (promptText.includes(n)) {
      score += 20;
      terms.push(name);
      strong = true;
    }
  }
  for (const term of promptTerms) {
    if (identityHay.includes(term)) {
      score += 6; // 이름/태그라인 적중 = 그 에이전트의 정체성 자체를 부른 것
      terms.push(term);
      strong = true;
    } else if (haystack.includes(term)) {
      score += term.length >= 5 ? 3 : 2;
      terms.push(term);
    }
  }
  const hint = routeHint(promptText, agent, lang);
  score += hint.score;
  if (hint.score) strong = true;
  terms.push(...hint.terms);
  const unique = [...new Set(terms)].slice(0, 6);
  const reason = hint.reason || (lang === "ko"
    ? unique.length
      ? `요청어 ${unique.map((term) => `"${term}"`).join(", ")}가 이 에이전트의 역할/트리거와 가장 가깝습니다`
      : "명확한 전문 라우트가 없어 기본 프로젝트 조율 에이전트가 가장 안전합니다"
    : unique.length
      ? `request terms ${unique.map((term) => `"${term}"`).join(", ")} best match this agent's role/triggers`
      : "no specialist matched clearly, so the default project coordinator is safest");
  return { agent, score, reason, terms: unique, strong };
}
// 라우팅 확신 임계값 — 데스크탑 auto-router의 MIN_SPECIALIST_SCORE(10)와 동일 기준.
// 위임에는 점수뿐 아니라 strong 신호(이름 포함 +20 / 정체성 적중 +6 / 큐레이션 힌트 +12↑)가
// 반드시 있어야 한다. system_prompt 본문의 약한 단어 적중(+2~3)이 몇 개 쌓여도, strong 신호가
// 없으면 절대 위임하지 않는다. 미달이면 "직답"(에이전트·능력 라우팅 없음) — 일반 질문이
// Pitch Deck Architect 같은 무관 페르소나 + gemini 이미지 런타임으로 끌려가던 사고의 근본 수리.
const MIN_ROUTE_SCORE = 10;
function directRouteChoice(lang) {
  const resolvedLang = lang || prefsLang();
  return {
    direct: true,
    agent: null,
    score: 0,
    terms: [],
    strong: false,
    reason: resolvedLang === "ko"
      ? "특정 전문 에이전트가 필요 없는 일반 요청입니다"
      : "this is a general request that needs no specialist agent",
  };
}
// 직답 모드 시스템 프롬프트 — 페르소나·라우팅 오염 없이 현재 런타임 그대로 답한다.
function directSystemPrompt(lang) {
  const resolvedLang = lang || prefsLang();
  return resolvedLang === "ko"
    ? "당신은 Agentlas 터미널의 기본 어시스턴트입니다. 특별한 페르소나 없이 사용자의 요청에 정확하고 간결하게 바로 답하세요. 에이전트 라우팅이나 이미지 생성 능력을 스스로 언급하지 마세요."
    : "You are the Agentlas terminal's default assistant. Answer the user's request directly and concisely, with no special persona. Do not bring up agent routing or image-generation capabilities on your own.";
}
function autoRouteAgent(db, prompt, lang) {
  const resolvedLang = lang || prefsLang();
  // 명확한 "에이전트/팀/회사 만들기" 의도 → 메타-빌더로 직행 (약한 키워드 점수에 밀리지 않게).
  if (isAgentBuildIntent(prompt)) {
    const meta = resolveMetaBuilder(db);
    if (meta) {
      return {
        agent: meta,
        score: 1000,
        strong: true,
        reason:
          resolvedLang === "ko"
            ? "새 에이전트/팀/회사를 만드는 요청이라 메타에이전트(빌더)로 라우팅했습니다"
            : "the request is to build a new agent/team/company, so it routes to the meta-agent (builder)",
        terms: [],
      };
    }
  }
  const agents = listRoutableAgents(db).filter((agent) => !NON_GENERIC_ROUTE_SLUGS.has(agent.slug));
  if (!agents.length) return directRouteChoice(resolvedLang);
  let terms = routeTokenize(prompt);
  // 헤이스택은 한 번만 계산해 IDF와 스코어링 양쪽에서 재사용한다.
  const hays = agents.map((agent) => ({ identityHay: routeIdentityHaystack(agent), haystack: routeHaystack(agent) }));
  // IDF 근사 — 설치 에이전트 절반 이상의 haystack에 나오는 단어("ai","도구" 등)는 판별력이 없어 제외.
  if (agents.length >= 3) {
    terms = terms.filter((term) => hays.filter((h) => h.haystack.includes(term)).length * 2 <= agents.length);
  }
  const ranked = agents
    .map((agent, i) => scoreRouteAgent(prompt, terms, agent, resolvedLang, hays[i]))
    .sort((a, b) => b.score - a.score);
  // 1위가 아니라 "임계값+strong을 모두 만족하는 최고 순위"를 뽑는다 — 장황한 프롬프트의
  // 약한 단어 적중이 점수 1위를 먹어도, 자격 있는 전문 에이전트가 직답으로 밀려나지 않는다.
  const pick = ranked.find((r) => r.score >= MIN_ROUTE_SCORE && r.strong);
  if (pick) return pick;
  return directRouteChoice(resolvedLang);
}
function autoRouteNote(choice, lang) {
  const resolvedLang = lang || prefsLang();
  if (choice.direct) {
    return resolvedLang === "ko"
      ? `사용 에이전트: 없음 — 바로 답합니다. 이유: ${choice.reason}.`
      : `Selected agent: none — answering directly. Reason: ${choice.reason}.`;
  }
  const name = resolvedLang === "ko" ? choice.agent.name : choice.agent.name_en || choice.agent.name;
  return resolvedLang === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.`
    : `Selected agent: ${name}. Reason: ${choice.reason}.`;
}
function autoRoutePreamble(choice, lang) {
  const resolvedLang = lang || prefsLang();
  if (choice.direct) {
    return [
      "## Agentlas direct answer",
      "",
      resolvedLang === "ko"
        ? "이 요청은 전문 에이전트 라우팅 없이 처리합니다. 라우팅이나 에이전트를 언급하지 말고 사용자 요청에 바로 답하세요."
        : "This request is handled without specialist routing. Answer the user directly, without mentioning routing or agents.",
    ].join("\n");
  }
  const appBuilderNeedsConsent = choice.agent && choice.agent.slug === "agentlas-app-builder";
  const instruction = appBuilderNeedsConsent
    ? resolvedLang === "ko"
      ? [
          "이 요청은 Agentlas 안에서 열리는 전용 App으로 만드는 것이 적합할 수 있지만, 사용자가 아직 전용 App 생성을 명시적으로 승인하지 않았습니다.",
          "실제 App 파일 생성, Agentlas Surface Manifest emit, scaffold-app/operate-app 액션 선언을 하지 마세요.",
          "대신 먼저 한 문장으로 확인 질문만 하세요: \"이 요청은 Agentlas 안에서 열리는 전용 App으로 만들면 더 편합니다. 전용 App으로 만들어 진행할까요?\"",
          "사용자가 동의하면 다음 메시지에서 App Builder 작업을 진행하세요.",
        ].join("\n")
      : [
          "This request may be a good fit for a dedicated Agentlas App, but the user has not explicitly approved dedicated App creation yet.",
          "Do not create App files, emit an Agentlas Surface Manifest, or declare scaffold-app/operate-app actions.",
          "Ask one confirmation question first: \"This would work better as a dedicated App inside Agentlas. Should I create that App for you?\"",
          "If the user agrees, proceed with the App Builder flow on the next message.",
        ].join("\n")
    : resolvedLang === "ko"
      ? "사용자는 에이전트를 직접 지정하지 않았습니다. 위 라우팅 결정을 첫 줄에 짧게 밝힌 뒤, 선택된 에이전트로 바로 작업하세요."
      : "The user did not explicitly choose an agent. Briefly state the route above in the first line, then work as the selected agent.";
  return [
    "## Agentlas automatic routing",
    "",
    autoRouteNote(choice, lang),
    instruction,
  ].join("\n");
}
function agentFolder(agent) {
  const routes = routesMap();
  const r = routes[agent.id];
  if (r && r.path) return r.path; // 로컬 임포트는 원본 폴더
  const cloudRoot = path.join(userDataDir(), "cloud-agent-installs", cloudSlug(agent.slug));
  if (exists(path.join(cloudRoot, CLOUD_RESTORE_MARKER_PATH))) return cloudRoot;
  return path.join(userDataDir(), "agents", agent.slug);
}
function exactAgentBaseForExecution(db, agent, runtimeExperience = null) {
  if (!agent || agent.builtin) return null;
  const portableId = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
  let binding = null;
  try {
    if (tableExists(db, "installed_agent_hub_bindings")) {
      binding = db.prepare(
        "SELECT agent_definition_id,agent_release_id FROM installed_agent_hub_bindings WHERE installed_agent_id=?",
      ).get(agent.id) || null;
    }
  } catch { binding = null; }
  const route = routesMap()[agent.id] || {};
  const markerResult = terminalExperienceExchange.readExactLocalBaseMarker(agentFolder(agent), agent.slug);
  const marker = markerResult.marker;
  const rawHash = String(marker?.packageHash || route.packageHash || route.definitionHash || "").replace(/^sha256:/i, "").toLowerCase();
  const packageHash = /^[a-f0-9]{64}$/.test(rawHash) ? `sha256:${rawHash}` : null;
  const explicitDefinition = String(runtimeExperience?.agentDefinitionId || "");
  const explicitRelease = String(runtimeExperience?.baseAgentReleaseId || "");
  if (portableId.test(explicitDefinition) && portableId.test(explicitRelease)) {
    return { agentDefinitionId: explicitDefinition, agentReleaseId: explicitRelease, packageHash, authority: "explicit-runtime-binding" };
  }
  if (binding && portableId.test(String(binding.agent_definition_id)) && portableId.test(String(binding.agent_release_id))) {
    return { agentDefinitionId: binding.agent_definition_id, agentReleaseId: binding.agent_release_id, packageHash, authority: "installed-hub-binding" };
  }
  if (!packageHash) return null;
  const definitionDigest = sha(`terminal-local-definition\0${agent.id}\0${agent.slug}`);
  const releaseDigest = sha(`terminal-local-release\0${definitionDigest}\0${packageHash}`);
  return {
    agentDefinitionId: `local-agent-definition:${definitionDigest.slice(0, 32)}`,
    agentReleaseId: `local-agent-release:${releaseDigest.slice(0, 32)}`,
    packageHash,
    authority: "exact-local-package-hash",
  };
}
function agentSystemPromptCli(agent) {
  return agent && agent.system_prompt ? agent.system_prompt : `You are ${agent?.name || "an Agentlas agent"}.`;
}

// ── 로컬 폴더 임포트 (앱의 electron/agents/import-local.ts 와 동일 규칙) ──
// 터미널에서 "폴더 드래그" = `agentlas import <path>`. 앱과 같은 DB/라우트를 공유한다.
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
    let brain = ceoBrain || rootAgents || rootClaude || nestedClaude;
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
function importLocalFolderCli(db, absPath) {
  const dir = path.resolve(absPath);
  if (!isDir(dir)) fail(`폴더가 아닙니다: ${absPath}`);
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
    id = require("node:crypto").randomUUID();
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
  writeJsonPrivateAtomicCli(path.join(userDataDir(), "agent-routes.json"), routes);

  // 팀이면 회사(firm)로도 등록 → 앱 FIRMS 목록 + `agentlas firm <slug>` 사용 가능. slug 기준 멱등.
  let firm = null;
  if (kind === "team") {
    try { firm = upsertLocalTeamFirmCli(db, dir, id, slug, name, tagline); } catch { /* best-effort */ }
  }
  return { id, slug, name, tagline, runtime, labels, kind, path: dir, updated: !!existingId, firmSlug: firm ? firm.slug : null };
}
// 팀 폴더 → 회사(firm) upsert (앱의 upsertLocalTeamFirm 과 동일). slug 기준 멱등.
function readTeamDepartmentsCli(dir) {
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
function deptLabelCli(name) {
  return name.replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function upsertLocalTeamFirmCli(db, dir, ceoAgentId, agentSlug, name, tagline) {
  if (!tableExists(db, "firms")) return null;
  const depts = readTeamDepartmentsCli(dir);
  const orgChart = [
    { agentSlug, agentId: ceoAgentId, role: "CEO", reportsTo: null },
    ...depts.map((d) => ({ agentSlug: `${agentSlug}-${d}`, agentId: "", role: deptLabelCli(d), reportsTo: agentSlug })),
  ];
  const firmSlug = `firm-${agentSlug}`;
  const chartJson = JSON.stringify(orgChart);
  const existing = db.prepare("SELECT id FROM firms WHERE slug=?").get(firmSlug);
  if (existing) {
    db.prepare("UPDATE firms SET name=?, name_en=?, tagline=?, tagline_en=?, persona=?, ceo_agent_id=?, org_chart_json=? WHERE id=?")
      .run(name, name, tagline, tagline, "", ceoAgentId, chartJson, existing.id);
    return { id: existing.id, slug: firmSlug };
  }
  const id = require("node:crypto").randomUUID();
  db.prepare(
    "INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, firmSlug, name, name, tagline, tagline, "", ceoAgentId, chartJson, new Date().toISOString());
  return { id, slug: firmSlug };
}
function cmdImport(db, absPath) {
  if (!absPath) fail("사용법: agentlas import <폴더경로>");
  const r = importLocalFolderCli(db, absPath);
  out(`${r.updated ? "갱신" : "임포트"} 완료: ${r.name}  (${r.kind})`);
  out(`  slug:    ${r.slug}`);
  out(`  runtime: ${r.runtime}  [${r.labels.join(", ")}]`);
  out(`  path:    ${r.path}`);
  if (r.firmSlug) out(`  firm:    ${r.firmSlug}  (FIRMS 등록됨 — 앱 사이드바 + 'agentlas firm ${r.firmSlug}')`);
  out("");
  out(`실행: agentlas ${r.slug} "..."   ·   agentlas run ${r.slug} "..."   (대상 프로젝트 폴더에서 실행)`);
}

// ── Agentlas Cloud packaging / marketplace ────────────────────────────────
// Packaging/security review runs locally. Agentlas Cloud gets only package data,
// hashes, and local-review evidence; no platform-owned LLM call is used.
const CLOUD_MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const CLOUD_MAX_FILE_BYTES = 512 * 1024;
const CLOUD_MAX_FILES = 400;
const CLOUD_PACKAGE_HASH_V1 = "path-sha256-v1";
const CLOUD_PACKAGE_HASH_V2 = "path-sha256-executable-v2";
const CLOUD_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";
const CLOUD_ASSET_STATE_FILE = "cloud-asset-state.v1.json";
const CLOUD_ASSET_SCOPES = new Set(["owner-private", "hub-public"]);
const CLOUD_TEXT_EXTS = new Set([".cfg", ".cjs", ".conf", ".config", ".css", ".csv", ".env", ".html", ".ini", ".js", ".json", ".jsonl", ".md", ".mjs", ".properties", ".ps1", ".psd1", ".psm1", ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const CLOUD_AGENT_FILES = new Set(["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md", "agent.md", "manifest.md", "system-prompt.md"]);
const CLOUD_SKIP_DIRS = new Set([".git", ".next", ".studio-runtime", ".turbo", "build", "coverage", "dist", "node_modules", "out", "release"]);
const CLOUD_BLOCKED_FILE_RE = [/^\.env(?:\..*)?$/i, /^id_rsa(?:\.pub)?$/i, /^credentials(?:\..*)?$/i, /^secrets?(?:\..*)?$/i, /^cloud-asset-state\.v1\.json$/i, /(?:^|[._-])service-account(?:[._-]|$)/i, /\.(?:key|pem|p12|pfx|mobileprovision)$/i];
const CLOUD_ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const CLOUD_LOCAL_EXPERIENCE_LINEAGE_PATH = ".agentlas/experience-relations.jsonl";
const CLOUD_ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const CLOUD_ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);
const CLOUD_SECRET_RE = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, "private key material"],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/, "OpenAI-style API key"],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/, "GitLab token"],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/, "npm access token"],
  ["stripe-secret", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, "Stripe secret key"],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  ["generic-secret", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, "hard-coded credential"],
];

const HUB_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const HUB_TIMEOUT_DEFAULTS = Object.freeze({ connectMs: 15_000, idleMs: 30_000, totalMs: 180_000 });

function finiteTimeoutMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function hubTimeoutConfig(env = process.env) {
  const totalMs = finiteTimeoutMs(env.AGENTLAS_HUB_TOTAL_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.totalMs, 5_000, 900_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(env.AGENTLAS_HUB_CONNECT_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.connectMs, 1_000, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(env.AGENTLAS_HUB_IDLE_TIMEOUT_MS, HUB_TIMEOUT_DEFAULTS.idleMs, 1_000, 300_000)),
    totalMs,
  };
}

function directHubTimeoutConfig(value = {}) {
  const totalMs = finiteTimeoutMs(value.totalMs, HUB_TIMEOUT_DEFAULTS.totalMs, 10, 900_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(value.connectMs, HUB_TIMEOUT_DEFAULTS.connectMs, 10, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(value.idleMs, HUB_TIMEOUT_DEFAULTS.idleMs, 10, 300_000)),
    totalMs,
  };
}

function hubTimeoutError(kind, ms) {
  const message = kind === "connect"
    ? `Hub 연결 제한 시간(${ms}ms)을 초과했습니다.`
    : kind === "idle"
      ? `Hub 응답이 ${ms}ms 동안 멈췄습니다.`
      : `Hub 요청 전체 제한 시간(${ms}ms)을 초과했습니다.`;
  const error = new Error(message);
  error.code = `AGENTLAS_HUB_${kind.toUpperCase()}_TIMEOUT`;
  return error;
}

/** Hub/Cloud fetch + body reader. Headers 전 connect, chunk 사이 idle, 전 구간 total timeout. */
async function fetchHubCli(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("이 런타임에 fetch가 없습니다.");
  const timeout = options.timeoutConfig ? directHubTimeoutConfig(options.timeoutConfig) : hubTimeoutConfig(options.env || process.env);
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let connectTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let reader = null;
  let terminalError = null;
  let rejectTerminal;
  const terminal = new Promise((_, reject) => { rejectTerminal = reject; });
  const stop = (error) => {
    if (terminalError) return;
    terminalError = error;
    try { controller.abort(error); } catch { controller.abort(); }
    rejectTerminal(error);
  };
  const onUpstreamAbort = () => {
    const reason = upstreamSignal && upstreamSignal.reason;
    const error = reason instanceof Error ? reason : new Error("Hub 요청이 취소되었습니다.");
    if (!error.code) error.code = "ABORT_ERR";
    stop(error);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(hubTimeoutError("idle", timeout.idleMs)), timeout.idleMs);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  connectTimer = setTimeout(() => stop(hubTimeoutError("connect", timeout.connectMs)), timeout.connectMs);
  totalTimer = setTimeout(() => stop(hubTimeoutError("total", timeout.totalMs)), timeout.totalMs);

  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal })),
      terminal,
    ]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    const chunks = [];
    let bytes = 0;
    armIdle();
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      while (true) {
        const part = await Promise.race([reader.read(), terminal]);
        if (part.done) break;
        armIdle();
        const chunk = Buffer.from(part.value || []);
        bytes += chunk.length;
        if (bytes > HUB_RESPONSE_MAX_BYTES) {
          const error = new Error(`Hub 응답이 허용 크기(${HUB_RESPONSE_MAX_BYTES} bytes)를 초과했습니다.`);
          error.code = "AGENTLAS_HUB_RESPONSE_TOO_LARGE";
          stop(error);
          throw error;
        }
        chunks.push(chunk);
      }
    } else {
      const raw = Buffer.from(await Promise.race([response.arrayBuffer(), terminal]));
      bytes = raw.length;
      if (bytes > HUB_RESPONSE_MAX_BYTES) throw new Error(`Hub 응답이 허용 크기(${HUB_RESPONSE_MAX_BYTES} bytes)를 초과했습니다.`);
      chunks.push(raw);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const text = Buffer.concat(chunks, bytes).toString("utf8");
    return { ok: response.ok, status: response.status, headers: response.headers, text };
  } catch (error) {
    if (terminalError) throw terminalError;
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (upstreamSignal) upstreamSignal.removeEventListener?.("abort", onUpstreamAbort);
    if (reader && terminalError) {
      try { await reader.cancel(terminalError); } catch { /* ignore */ }
    }
  }
}

function parseHubJsonCli(response, label) {
  try {
    return JSON.parse(response.text || "null");
  } catch {
    throw new Error(`${label} 응답 JSON 형식이 올바르지 않습니다.`);
  }
}

function parseCloudFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function cloudVisibilityFlag(value) {
  if (value == null) return null;
  if (value === "private-link" || value === "marketplace") return value;
  throw new Error("--visibility must be private-link or marketplace");
}

function cloudVisibilityForAction(sub, flags) {
  const explicit = cloudVisibilityFlag(flags.visibility);
  if (sub === "save") {
    if (explicit === "marketplace") {
      throw new Error("`agentlas cloud save` is owner-private. Use `agentlas cloud publish` for the public Hub.");
    }
    return "private-link";
  }
  if (sub === "publish") {
    if (explicit === "private-link") {
      throw new Error("`agentlas cloud publish` is public Hub publication. Use `agentlas cloud save` for owner-private Agent Cloud storage.");
    }
    return "marketplace";
  }
  if (explicit) return explicit;
  return "private-link";
}

function cloudActionForTopLevelUpload(args) {
  const flags = parseCloudFlags(args);
  return cloudVisibilityFlag(flags.visibility) === "marketplace" ? "publish" : "save";
}

async function cmdCloud(db, args, runtimeOverride) {
  const sub = args[0] || "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    out([
      "agentlas cloud",
      "",
      "  wizard <path> [--name name] [--json] generate/repair agentlas.json",
      "  security scan <path> [--strict]     scan risky instructions and secret paths",
      "  runtime bundle <path> [--json]      compile runtime bundle from agentlas.json",
      "  runtime read-agent-file <path> <file>",
      "                                      lazy read with allow/deny gates",
      "  field-test [--json]                 run local Cloud contract field test",
      "  save <path> [--dry-run] [--slug name]",
      "                                      save owner-private in Agent Cloud (default upload)",
      "  publish <path> [--dry-run] [--llm-review] [--slug name]",
      "                                      explicitly publish to the public Agentlas Hub",
      "  package <path> [--json] [--visibility private-link|marketplace]",
      "                                      package only; defaults to private-save checks",
      "  list [--json]                       list packages in your private Agent Cloud",
      "  restore <slug> [--json]             restore an owned Cloud package on this machine",
      "  install <slug>                      compatibility alias: install from the public Hub",
      "  delete <slug> [--scope owner-private|hub-public] [--json]",
      "                                      conditionally delete one exact observed Cloud revision",
      "  search \"<what you need>\" [--limit 10]",
      "                                      search the public Hub (no sign-in needed)",
      "",
      "Private save rule: no public review or routing card; local secret/path/hash checks remain.",
      "--llm-review applies only to public Hub publishing and uses this machine's runtime.",
    ].join("\n"));
    return;
  }
  if (sub === "search") {
    return parity().cloudSearch(db, args.slice(1));
  }
  if (sub === "list") {
    const flags = parseCloudFlags(args.slice(1));
    const result = await listOwnedCloudAgentsCli(Number(flags.limit || 100));
    if (flags.json) return out(JSON.stringify(result, null, 2));
    const agents = Array.isArray(result.results) ? result.results : [];
    if (!agents.length) return out("Private Agent Cloud에 저장된 에이전트가 없습니다.");
    for (const agent of agents) out(`${agent.slug}\t${agent.name || agent.nameEn || agent.slug}\t${agent.entityKind || "agent"}`);
    return;
  }
  if (sub === "restore") {
    const flags = parseCloudFlags(args.slice(1));
    const slug = flags._[0];
    if (!slug) fail("usage: agentlas cloud restore <slug> [--json]");
    const result = await restoreOwnedCloudAgentCli(db, slug);
    if (flags.json) return out(JSON.stringify(result, null, 2));
    out(`✓ restored ${result.slug} from private Agent Cloud`);
    out(`  hash: ${result.packageHash}`);
    if (result.localPath) out(`  files: ${result.localPath}`);
    if (result.localStateWarning) out(`  warning: ${result.localStateWarning}`);
    return;
  }
  if (sub === "delete" || sub === "unpublish") {
    const flags = parseCloudFlags(args.slice(1));
    const slug = flags._[0];
    if (!slug) fail(`usage: agentlas cloud ${sub} <slug> [--json]`);
    const result = await deleteCloudAgentCli(slug, { scope: flags.scope });
    out(flags.json ? JSON.stringify(result, null, 2) : `✓ deleted ${result.slug || slug}`);
    if (!flags.json && Array.isArray(result.localStateWarnings)) {
      for (const warning of result.localStateWarnings) out(`  warning: ${warning}`);
    }
    return;
  }
  const cloudRuntime = require("./agentlas-cloud-runtime.cjs");
  if (sub === "wizard") {
    const flags = parseCloudFlags(args.slice(1));
    const root = flags._[0];
    if (!root) fail("usage: agentlas cloud wizard <path> [--name name]");
    const result = cloudRuntime.runWizard(root, { name: typeof flags.name === "string" ? flags.name : undefined });
    out(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.manifest.name} (${result.manifest.entry})`);
    return;
  }
  if (sub === "security") {
    const action = args[1];
    if (action !== "scan") fail("usage: agentlas cloud security scan <path> [--strict]");
    const flags = parseCloudFlags(args.slice(2));
    const root = flags._[0];
    if (!root) fail("usage: agentlas cloud security scan <path> [--strict]");
    const report = cloudRuntime.scanFolder(root);
    out(JSON.stringify(report, null, 2));
    if (flags.strict && report.verdict === "BLOCK") process.exit(1);
    return;
  }
  if (sub === "runtime") {
    const action = args[1];
    if (action === "bundle") {
      const root = args[2];
      if (!root) fail("usage: agentlas cloud runtime bundle <path>");
      out(JSON.stringify(cloudRuntime.compileBundle(root), null, 2));
      return;
    }
    if (action === "read-agent-file") {
      const root = args[2];
      const targetPath = args[3];
      if (!root || !targetPath) fail("usage: agentlas cloud runtime read-agent-file <path> <file>");
      out(JSON.stringify(cloudRuntime.readAgentFile(root, targetPath), null, 2));
      return;
    }
    fail("usage: agentlas cloud runtime <bundle|read-agent-file> ...");
  }
  if (sub === "field-test") {
    const flags = parseCloudFlags(args.slice(1));
    const result = cloudRuntime.runFieldTest();
    out(flags.json ? JSON.stringify(result, null, 2) : `${result.suite}: ${result.status}`);
    if (result.status !== "PASS") process.exit(1);
    return;
  }
  if (sub === "install") return cmdCloudInstall(db, args[1]);
  if (sub !== "package" && sub !== "save" && sub !== "publish") fail("usage: agentlas cloud <save|publish|package|list|restore|install|delete> ...");
  const flags = parseCloudFlags(args.slice(1));
  const root = flags._[0];
  if (!root) fail(`usage: agentlas cloud ${sub} <path>`);
  const visibility = cloudVisibilityForAction(sub, flags);
  const dryRun = sub === "package" || Boolean(flags["dry-run"]);
  const result = await packageCloudAgentCli(db, root, {
    slug: typeof flags.slug === "string" ? flags.slug : undefined,
    visibility,
    llmReview: Boolean(flags["llm-review"]),
    dryRun,
    runtimeOverride,
  });
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  printCloudPackageResult(result);
  if ((sub === "save" || sub === "publish") && result.status === "blocked") process.exit(1);
}

async function packageCloudAgentCli(db, root, opts) {
  const requestedRoot = path.resolve(root);
  let st;
  try { st = fs.lstatSync(requestedRoot); } catch { throw new Error(`폴더를 찾을 수 없습니다: ${root}`); }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`실제 폴더가 아닙니다: ${root}`);
  const rootPath = fs.realpathSync.native(requestedRoot);
  const visibility = opts.visibility || "private-link";
  const isPublicHubPublish = visibility === "marketplace";
  const scan = scanCloudFolderCli(rootPath);
  let snapshot = cloudPackageSnapshot(scan.included);
  let careerGraph;
  if (isPublicHubPublish) {
    careerGraph = cloudReadPublicCareerCard(snapshot, scan.findings);
    cloudReplacePublicCareerCard(scan, careerGraph);
    snapshot = cloudPackageSnapshot(scan.included);
  }
  const routingCard = isPublicHubPublish ? readCloudRoutingCardCli(snapshot) : {};
  if (routingCard.finding) scan.findings.push(routingCard.finding);
  const packageFindings = isPublicHubPublish ? scan.findings : privateCloudSafetyFindingsCli(scan.findings);
  const name = cloudReadName(snapshot, path.basename(rootPath));
  const slug = cloudSlug(opts.slug || cloudReadStableSlug(snapshot) || name || path.basename(rootPath));
  const scope = cloudScopeForVisibility(visibility);
  const baseDescriptor = cloudBaseDescriptorForSourceCli(scan.localPackageMarker, rootPath, slug, scope);
  const packageHashVersion = CLOUD_PACKAGE_HASH_V2;
  const packageHash = cloudHashPackage(scan.included, packageHashVersion);
  const manifest = {
    version: "0.1",
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline: cloudReadTagline(snapshot),
    agentKind: cloudInferKind(snapshot),
    runtimeLabels: cloudDetectRuntimeLabels(snapshot),
    visibility,
    // Content-derived and host-independent. Never persist an absolute local
    // path fingerprint into a portable Cloud package.
    rootFingerprint: sha(`agentlas-package-root:${packageHash}`),
    packageHash,
    packageHashVersion,
    fileCount: scan.files.length,
    includedFileCount: scan.included.length,
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    createdAt: new Date().toISOString(),
    billingMode: isPublicHubPublish && opts.llmReview ? "submitter-local-runtime" : "static-only",
    costOwner: isPublicHubPublish && opts.llmReview ? "submitter" : "none",
    security: cloudSecuritySummary(packageFindings),
    ...(careerGraph ? { careerGraph } : {}),
  };
  if (routingCard.card) manifest.routingCard = routingCard.card;
  const packageDir = cloudPackageDir(slug);
  fs.mkdirSync(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.manifest.json");
  const bundlePath = path.join(packageDir, "package.bundle.json");
  const bundle = {
    manifest,
    files: scan.included,
    source: { packagedBy: "agentlas-cli", packagedAt: manifest.createdAt, costOwner: manifest.costOwner },
    ...(careerGraph ? { careerGraph } : {}),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  const review = isPublicHubPublish && opts.llmReview
    ? await runCloudLocalReviewCli(db, rootPath, manifest, packageFindings, opts.runtimeOverride)
    : cloudStaticReview(packageFindings, isPublicHubPublish ? "hub-public" : "owner-private");
  const allFindings = [...packageFindings, ...review.findings.filter((f) => !packageFindings.some((s) => s.id === f.id))];
  manifest.security = cloudSecuritySummary(allFindings);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify({ ...bundle, manifest }, null, 2) + "\n", "utf8");
  const blocked = review.verdict === "fail" || allFindings.some((f) => f.severity === "blocker");
  let registration = null;
  let status = blocked ? "blocked" : opts.dryRun ? "dry-run" : "ready";
  if (!blocked && !opts.dryRun) {
    registration = await registerCloudAgentCli(manifest, bundlePath, review, visibility, { baseDescriptor });
    let descriptor;
    try {
      descriptor = rememberCloudAssetDescriptorCli(registration, { sourceRoot: rootPath });
    } catch (error) {
      const stateError = new Error(
        `Cloud save committed on the server, but this machine could not persist revision ${registration.revision}. ` +
        "Do not retry blindly; run `agentlas cloud list` and restore the asset before the next update. " +
        `Local state error: ${error.message || error}`,
      );
      stateError.code = "AGENTLAS_CLOUD_LOCAL_STATE_COMMIT_FAILED";
      stateError.receipt = registration;
      throw stateError;
    }
    try {
      writeCloudSourceMarkerCli(rootPath, scan, descriptor, {
        previousMarker: scan.localPackageMarker,
        packageHash,
        packageHashVersion,
        fileCount: scan.included.length,
        totalBytes: manifest.totalBytes,
        executablePaths: packageHashVersion === CLOUD_PACKAGE_HASH_V2
          ? scan.included.filter((file) => file.executable).map((file) => file.path).sort()
          : undefined,
      });
    } catch (error) {
      registration.localStateWarning = `Cloud save succeeded, but the source marker could not be updated: ${error.message || error}`;
    }
    status = "registered";
  }
  return {
    status,
    rootPath,
    packageDir,
    manifestPath,
    bundlePath,
    manifest,
    files: scan.files,
    review,
    registration,
    summary: status === "registered"
      ? isPublicHubPublish
        ? `Published ${slug} publicly to Agentlas Hub.`
        : `Saved ${slug} privately in Agent Cloud.`
      : status === "blocked"
        ? isPublicHubPublish
          ? `Hub publish blocked: ${review.summary}`
          : `Private Agent Cloud save blocked: ${review.summary}`
        : isPublicHubPublish
          ? `Hub package ready: ${slug}.`
          : `Private Agent Cloud package ready: ${slug}.`,
  };
}

function cloudScopeForVisibility(visibility) {
  return visibility === "marketplace" ? "hub-public" : "owner-private";
}

function normalizeCloudScopeFlagCli(value) {
  if (value === "owner-private" || value === "private" || value === "private-link") return "owner-private";
  if (value === "hub-public" || value === "marketplace" || value === "public") return "hub-public";
  return null;
}

function cloudRevisionEtag(revision) {
  return `"${revision}"`;
}

function normalizeCloudAssetDescriptorCli(value, label = "cloud asset descriptor") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  const cloudId = typeof value.cloudId === "string" ? value.cloudId.trim() : "";
  const slug = typeof value.slug === "string" ? value.slug.trim() : "";
  const scope = value.scope;
  const packageHash = String(value.packageHash || "").replace(/^sha256:/i, "").toLowerCase();
  const packageHashVersion = cloudPackageHashVersion(value.packageHashVersion);
  const revision = typeof value.revision === "string" ? value.revision : "";
  const etag = typeof value.etag === "string" ? value.etag : cloudRevisionEtag(revision);
  const updatedAt = typeof value.updatedAt === "string"
    ? value.updatedAt
    : typeof value.savedAt === "string"
      ? value.savedAt
      : typeof value.registeredAt === "string"
        ? value.registeredAt
        : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(cloudId)) {
    throw new Error(`${label} cloudId is invalid`);
  }
  if (!slug || cloudSlug(slug) !== slug) throw new Error(`${label} slug is invalid`);
  if (!CLOUD_ASSET_SCOPES.has(scope)) throw new Error(`${label} scope is invalid`);
  if (!/^[a-f0-9]{64}$/.test(packageHash) || !packageHashVersion) {
    throw new Error(`${label} package identity is invalid`);
  }
  if (!revision || revision.length > 512 || /["\\\u0000-\u001f\u007f]/.test(revision)) {
    throw new Error(`${label} revision is invalid`);
  }
  if (etag !== cloudRevisionEtag(revision)) throw new Error(`${label} ETag does not authenticate revision`);
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error(`${label} updatedAt is invalid`);
  return { cloudId, slug, scope, packageHash, packageHashVersion, revision, etag, updatedAt };
}

function cloudDescriptorKey(descriptor) {
  return `${descriptor.scope}:${descriptor.slug}`;
}

function cloudAssetStatePathCli() {
  return path.join(userDataDir(), CLOUD_ASSET_STATE_FILE);
}

function readCloudAssetStateCli() {
  const statePath = cloudAssetStatePathCli();
  if (!fs.existsSync(statePath)) return { schemaVersion: 1, assets: {}, deletedBases: [] };
  let fd;
  try {
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("state file is not a bounded regular file");
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets)) {
      throw new Error("state schema is invalid");
    }
    const assets = {};
    for (const [key, raw] of Object.entries(parsed.assets)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`state entry ${key} is invalid`);
      const descriptor = normalizeCloudAssetDescriptorCli(raw.descriptor, `state entry ${key}`);
      if (key !== cloudDescriptorKey(descriptor)) throw new Error(`state entry ${key} key is invalid`);
      const sourceRoots = Array.isArray(raw.sourceRoots)
        ? [...new Set(raw.sourceRoots.filter((item) => typeof item === "string" && path.isAbsolute(item)).map((item) => path.resolve(item)))].slice(0, 32)
        : [];
      assets[key] = { descriptor, sourceRoots };
    }
    const deletedBases = Array.isArray(parsed.deletedBases)
      ? parsed.deletedBases.filter((item) =>
          item && typeof item === "object" && !Array.isArray(item) &&
          typeof item.rootPath === "string" && path.isAbsolute(item.rootPath) &&
          typeof item.slug === "string" && cloudSlug(item.slug) === item.slug &&
          CLOUD_ASSET_SCOPES.has(item.scope) && typeof item.cloudId === "string" &&
          typeof item.revision === "string"
        ).map((item) => ({
          rootPath: path.resolve(item.rootPath),
          slug: item.slug,
          scope: item.scope,
          cloudId: item.cloudId,
          revision: item.revision,
        })).slice(-256)
      : [];
    return { schemaVersion: 1, assets, deletedBases };
  } catch (error) {
    throw new Error(`Agent Cloud local revision state is unreadable: ${error.message || error}`);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

function writeCloudAssetStateCli(state) {
  const statePath = cloudAssetStatePathCli();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, statePath);
  cloudApplyPortableFileMode(statePath, 0o600);
  cloudFsyncDirectoryCli(path.dirname(statePath));
}

function rememberCloudAssetDescriptorCli(value, options = {}) {
  const descriptor = normalizeCloudAssetDescriptorCli(value);
  const state = readCloudAssetStateCli();
  const key = cloudDescriptorKey(descriptor);
  const previous = state.assets[key];
  const sameRevision = previous && previous.descriptor.cloudId === descriptor.cloudId && previous.descriptor.revision === descriptor.revision;
  const roots = sameRevision ? [...previous.sourceRoots] : [];
  if (options.sourceRoot) {
    const sourceRoot = path.resolve(options.sourceRoot);
    roots.push(sourceRoot);
    state.deletedBases = state.deletedBases.filter(
      (item) => !(item.rootPath === sourceRoot && item.slug === descriptor.slug && item.scope === descriptor.scope),
    );
  }
  state.assets[key] = { descriptor, sourceRoots: [...new Set(roots)].slice(0, 32) };
  writeCloudAssetStateCli(state);
  return descriptor;
}

function findCloudAssetDescriptorCli(slug, scope) {
  const safeSlug = cloudSlug(slug);
  const state = readCloudAssetStateCli();
  const matches = Object.values(state.assets).filter(
    (entry) => entry.descriptor.slug === safeSlug && (!scope || entry.descriptor.scope === scope),
  );
  if (!scope && matches.length > 1) {
    throw new Error(`Cloud asset ${safeSlug} exists in multiple scopes. Retry with --scope owner-private or --scope hub-public.`);
  }
  return matches.length === 1 ? matches[0] : null;
}

function cloudMarkerDescriptorsCli(marker) {
  const descriptors = {};
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return descriptors;
  if (marker.cloudAssets && typeof marker.cloudAssets === "object" && !Array.isArray(marker.cloudAssets)) {
    for (const scope of CLOUD_ASSET_SCOPES) {
      if (!marker.cloudAssets[scope]) continue;
      try {
        const descriptor = normalizeCloudAssetDescriptorCli(marker.cloudAssets[scope], `local marker ${scope}`);
        if (descriptor.scope === scope) descriptors[scope] = descriptor;
      } catch { /* legacy or corrupt CAS entry is not adopted as a base revision */ }
    }
  }
  if (marker.revision && marker.cloudId && marker.scope) {
    try {
      const descriptor = normalizeCloudAssetDescriptorCli(marker, "local marker");
      if (!descriptors[descriptor.scope]) descriptors[descriptor.scope] = descriptor;
    } catch { /* legacy marker */ }
  }
  return descriptors;
}

function cloudBaseDescriptorFromMarkerCli(marker, slug, scope) {
  const descriptor = cloudMarkerDescriptorsCli(marker)[scope];
  return descriptor && descriptor.slug === slug ? descriptor : null;
}

function cloudBaseDescriptorForSourceCli(marker, rootPath, slug, scope) {
  const state = readCloudAssetStateCli();
  const normalizedRoot = path.resolve(rootPath);
  let markerDescriptor = cloudBaseDescriptorFromMarkerCli(marker, slug, scope);
  if (markerDescriptor && state.deletedBases.some((item) =>
    item.rootPath === normalizedRoot && item.slug === slug && item.scope === scope &&
    item.cloudId === markerDescriptor.cloudId && item.revision === markerDescriptor.revision
  )) {
    markerDescriptor = null;
  }
  const entry = state.assets[`${scope}:${slug}`];
  const stateDescriptor = entry && entry.sourceRoots.includes(normalizedRoot) ? entry.descriptor : null;
  if (!markerDescriptor) return stateDescriptor;
  if (!stateDescriptor) return markerDescriptor;
  return stateDescriptor.cloudId === markerDescriptor.cloudId && stateDescriptor.updatedAt >= markerDescriptor.updatedAt
    ? stateDescriptor
    : markerDescriptor;
}

function writeCloudSourceMarkerCli(rootPath, scan, descriptor, options = {}) {
  const markerPath = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  if (fs.existsSync(markerPath)) {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent Cloud revision marker is not a regular file");
  }
  const descriptors = cloudMarkerDescriptorsCli(options.previousMarker);
  if (descriptor) descriptors[descriptor.scope] = descriptor;
  if (options.removeDescriptor) {
    const current = descriptors[options.removeDescriptor.scope];
    if (current && current.cloudId === options.removeDescriptor.cloudId && current.revision === options.removeDescriptor.revision) {
      delete descriptors[options.removeDescriptor.scope];
    }
  }
  const latest = descriptor || Object.values(descriptors)[0] || null;
  const marker = {
    schemaVersion: 1,
    source: "agentlas-cloud",
    slug: latest?.slug || options.removeDescriptor?.slug || cloudSlug(path.basename(rootPath)),
    packageHash: descriptor?.packageHash || options.packageHash || options.previousMarker?.packageHash || "",
    packageHashVersion: descriptor?.packageHashVersion || options.packageHashVersion || options.previousMarker?.packageHashVersion || CLOUD_PACKAGE_HASH_V1,
    fileCount: Number.isSafeInteger(options.fileCount) ? options.fileCount : (options.previousMarker?.fileCount || 0),
    totalBytes: Number.isSafeInteger(options.totalBytes) ? options.totalBytes : (options.previousMarker?.totalBytes || 0),
    executablePaths: Array.isArray(options.executablePaths) ? options.executablePaths : options.previousMarker?.executablePaths,
    cloudAssets: descriptors,
    ...(latest ? latest : {}),
    restoredAt: options.previousMarker?.restoredAt,
    savedAt: new Date().toISOString(),
  };
  for (const key of Object.keys(marker)) if (marker[key] === undefined) delete marker[key];
  const temp = path.join(rootPath, `.${CLOUD_RESTORE_MARKER_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, markerPath);
  cloudApplyPortableFileMode(markerPath, 0o600);
  cloudFsyncDirectoryCli(rootPath);
  return marker;
}

function readCloudSourceMarkerCli(rootPath) {
  const markerPath = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  if (!fs.existsSync(markerPath)) return null;
  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("marker is not a bounded regular file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function scanCloudFolderCli(rootPath) {
  const files = [];
  const included = [];
  const findings = [];
  const restoredExecutablePaths = cloudReadRestoreExecutablePaths(rootPath);
  let localPackageMarker = null;
  let totalBytes = 0;
  let count = 0;
  let hasDefinition = false;
  function addFinding(kind, severity, category, message, file, remediation) {
    findings.push({ id: `${kind}-${sha(file || message).slice(0, 10)}`, severity, category, message, ...(file ? { file } : {}), ...(remediation ? { remediation } : {}) });
  }
  function insideRoot(candidate) {
    const relative = path.relative(rootPath, candidate);
    return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  function readStableFile(file, rel) {
    const beforeReal = fs.realpathSync.native(file);
    if (!insideRoot(beforeReal)) throw new Error("file resolves outside the approved package root");
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const nonBlock = fs.constants.O_NONBLOCK || 0;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("package entry is not a regular file");
      if (before.size > CLOUD_MAX_FILE_BYTES) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
      const chunks = [];
      let actualBytes = 0;
      for (;;) {
        const capacity = Math.min(64 * 1024, CLOUD_MAX_FILE_BYTES + 1 - actualBytes);
        if (capacity <= 0) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
        const chunk = Buffer.allocUnsafe(capacity);
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        actualBytes += read;
        if (actualBytes > CLOUD_MAX_FILE_BYTES) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
        chunks.push(chunk.subarray(0, read));
      }
      const after = fs.fstatSync(fd);
      const afterReal = fs.realpathSync.native(file);
      const pathStat = fs.statSync(file);
      if (
        !insideRoot(afterReal) || beforeReal !== afterReal ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        after.dev !== pathStat.dev || after.ino !== pathStat.ino || after.mode !== pathStat.mode ||
        actualBytes !== after.size
      ) {
        throw new Error("package entry changed while it was being read");
      }
      return {
        bytes: Buffer.concat(chunks, actualBytes),
        executable: cloudPortableExecutableForFile(rel, after.mode, restoredExecutablePaths),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  function walk(dir) {
    let directoryBefore;
    let directoryRealBefore;
    try {
      directoryBefore = fs.lstatSync(dir);
      directoryRealBefore = fs.realpathSync.native(dir);
      if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !insideRoot(directoryRealBefore)) {
        throw new Error("directory is not stable inside the approved root");
      }
    } catch (error) {
      addFinding("unsafe-directory", "blocker", "policy", `Package directory could not be read safely: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Remove linked or changing directories and retry.");
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      addFinding("unsafe-directory", "blocker", "policy", `Package directory could not be read safely: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Remove linked or changing directories and retry.");
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootPath, abs).split(path.sep).join("/");
      if (cloudIsLocalExperienceLineagePath(rel)) {
        let bytes = 0;
        try { bytes = Number(fs.lstatSync(abs).size) || 0; } catch { /* excluded local state */ }
        files.push({ path: rel, bytes, sha256: "", kind: "text", included: false, reason: "experience-lineage-separate-asset" });
        continue;
      }
      if (cloudPortablePathKey(rel) === cloudPortablePathKey(CLOUD_RESTORE_MARKER_PATH)) {
        // Local restore/CAS metadata is runtime state, never portable asset
        // data, but it must be captured with the same no-follow stability gate.
        if (entry.isSymbolicLink() || !entry.isFile()) {
          addFinding("unsafe-local-state", "blocker", "policy", "Agent Cloud local revision marker must be a stable regular file.", rel, "Remove the linked or special marker and restore/list the asset again.");
          continue;
        }
        try {
          const stableMarker = readStableFile(abs, rel);
          localPackageMarker = JSON.parse(stableMarker.bytes.toString("utf8"));
        } catch (error) {
          addFinding("invalid-local-state", "blocker", "policy", `Agent Cloud local revision marker could not be read safely: ${error.message || error}`, rel, "Repair or remove the marker, then restore/list the asset again.");
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        addFinding("symlink", "blocker", "policy", "Symbolic links are not allowed in cloud agent packages.", rel, "Replace the symlink with an ordinary file or remove it.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "symlink-blocked" });
        continue;
      }
      if (entry.isDirectory()) {
        if (CLOUD_SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        addFinding("unsupported-entry", "blocker", "policy", "Only stable ordinary files and directories are allowed in Cloud packages.", rel, "Remove sockets, FIFOs, devices, and other special filesystem entries.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "unsupported-entry" });
        continue;
      }
      if (!cloudPortableRelativePath(rel)) {
        addFinding("unsafe-path", "blocker", "policy", "File path is not portable across supported hosts.", rel, "Rename the file to a Unicode NFC, relative, cross-platform-safe path.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "unsafe-path" });
        continue;
      }
      count++;
      if (count > CLOUD_MAX_FILES) {
        addFinding("file-count-limit", "blocker", "size", `Package has more than ${CLOUD_MAX_FILES} files.`, "", "Publish a focused agent/team folder.");
        continue;
      }
      if (CLOUD_AGENT_FILES.has(entry.name)) hasDefinition = true;
      let hint;
      try { hint = fs.lstatSync(abs); } catch { hint = { size: 0 }; }
      if (CLOUD_BLOCKED_FILE_RE.some((re) => re.test(entry.name))) {
        addFinding("blocked-file", "blocker", "secret", "Secret-bearing file names are not allowed in cloud packages.", rel, "Remove credentials and publish only env key names.");
        files.push({ path: rel, bytes: Number(hint.size) || 0, sha256: "", kind: "binary", included: false, reason: "secret-file-blocked" });
        continue;
      }
      if (Number(hint.size) > CLOUD_MAX_FILE_BYTES) {
        addFinding("large-file", "blocker", "size", `File exceeds ${CLOUD_MAX_FILE_BYTES} bytes.`, rel, "Move large assets out of the package.");
        files.push({ path: rel, bytes: Number(hint.size), sha256: "", kind: "binary", included: false, reason: "file-too-large" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isText = CLOUD_TEXT_EXTS.has(ext) || CLOUD_AGENT_FILES.has(entry.name);
      let stable;
      try {
        stable = readStableFile(abs, rel);
      } catch (error) {
        addFinding("unstable-file", "blocker", "policy", `Package file could not be read safely: ${error.message || error}`, rel, "Remove linked or concurrently changing files and retry.");
        files.push({ path: rel, bytes: Number(hint.size) || 0, sha256: "", kind: isText ? "text" : "binary", included: false, reason: "unstable-file" });
        continue;
      }
      const content = stable.bytes;
      const executable = stable.executable;
      totalBytes += content.length;
      const digest = sha(content);
      cloudAddSecretFindingsFromBytes(content, rel, addFinding);
      if (isText) {
        const decoded = cloudDecodeTextAsset(content);
        if (!decoded.ok) {
          addFinding("invalid-text-encoding", "blocker", "policy", "A text agent asset is not valid UTF-8 or BOM-marked UTF-16.", rel, "Save the file as UTF-8 or BOM-marked UTF-16 before packaging.");
          files.push({ path: rel, bytes: content.length, sha256: digest, kind: "text", executable, included: false, reason: "invalid-text-encoding" });
          continue;
        }
        const text = decoded.text;
        if (/(?:curl|wget)[^\n|&;]+[|]\s*(?:sh|bash)/i.test(text)) {
          addFinding("curl-pipe-shell", "high", "network", "Remote shell install pattern detected.", rel, "Use explicit, reviewable install steps.");
        }
      }
      files.push({ path: rel, bytes: content.length, sha256: digest, kind: isText ? "text" : "binary", executable, included: true });
      included.push({ path: rel, bytes: content.length, sha256: digest, executable, contentBase64: content.toString("base64") });
    }
    try {
      const directoryAfter = fs.lstatSync(dir);
      const directoryRealAfter = fs.realpathSync.native(dir);
      if (
        !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() || !insideRoot(directoryRealAfter) ||
        directoryRealBefore !== directoryRealAfter || directoryBefore.dev !== directoryAfter.dev ||
        directoryBefore.ino !== directoryAfter.ino || directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
        directoryBefore.ctimeMs !== directoryAfter.ctimeMs
      ) {
        throw new Error("directory changed while it was scanned");
      }
    } catch (error) {
      addFinding("unstable-directory", "blocker", "policy", `Package directory changed while it was scanned: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Stop concurrent edits and retry.");
    }
  }
  walk(rootPath);
  const pathConflict = cloudPortablePathConflict(included.map((file) => file.path));
  if (pathConflict) {
    addFinding(pathConflict.code, "blocker", "policy", pathConflict.message, "", "Rename aliased paths so every file and ancestor directory has one portable identity.");
  }
  if (!hasDefinition) addFinding("missing-agent-definition", "blocker", "structure", "No agent definition file was found.", "", "Add AGENTS.md, CLAUDE.md, GEMINI.md, AGENT.md, or README.md at the package root.");
  if (totalBytes > CLOUD_MAX_TOTAL_BYTES) addFinding("package-size-limit", "blocker", "size", `Package exceeds ${CLOUD_MAX_TOTAL_BYTES} bytes.`, "", "Publish a smaller agent folder.");
  files.sort(cloudCodePointPathOrder);
  included.sort(cloudCodePointPathOrder);
  return { files, included, findings, totalBytes, localPackageMarker };
}

function readCloudRoutingCardCli(snapshot) {
  const file = snapshot.get(CLOUD_ROUTING_CARD_PATH);
  if (!file) {
    return {
      finding: {
        id: "routing-card-required",
        severity: "blocker",
        category: "structure",
        file: CLOUD_ROUTING_CARD_PATH,
        message: "Cloud registration requires a Hephaestus Network routing card.",
        remediation: "Add .agentlas/routing-card.json before publishing. In Hephaestus packages, run the routing-card migration or package verifier.",
      },
    };
  }
  try {
    const parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cloudRoutingCardFinding("routing-card-invalid", "Routing card must be a JSON object.", "Replace .agentlas/routing-card.json with a routing-card/2.0 object.");
    }
    const problem = cloudRoutingCardProblem(parsed);
    if (problem) {
      return cloudRoutingCardFinding("routing-card-invalid", `Routing card is invalid: ${problem}`, "Fix .agentlas/routing-card.json before publishing.");
    }
    return { card: parsed };
  } catch {
    return cloudRoutingCardFinding("routing-card-invalid-json", "Routing card is not valid JSON.", "Fix .agentlas/routing-card.json before publishing.");
  }
}

function cloudRoutingCardFinding(id, message, remediation) {
  return {
    finding: {
      id,
      severity: "blocker",
      category: "structure",
      file: CLOUD_ROUTING_CARD_PATH,
      message,
      remediation,
    },
  };
}

function cloudRoutingCardProblem(card) {
  if (card.schemaVersion !== "routing-card/2.0") return "schemaVersion must be routing-card/2.0";
  if (typeof card.id !== "string" || !card.id.trim()) return "id must be a non-empty string";
  if (card.type !== "agent" && card.type !== "team" && card.type !== "plugin") return "type must be agent, team, or plugin";
  if (typeof card.name !== "string" || !card.name.trim()) return "name must be a non-empty string";
  if (typeof card.summary !== "string" || !card.summary.trim()) return "summary must be a non-empty string";
  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) return "capabilities must be a non-empty array";
  for (const capability of card.capabilities) {
    if (typeof capability !== "string" || !CLOUD_ROUTING_CARD_CAPABILITY_RE.test(capability)) {
      return `capability ${JSON.stringify(capability)} must be snake_case with at least two words`;
    }
  }
  if (typeof card.routing_status !== "string" || !CLOUD_ROUTING_CARD_STATUSES.has(card.routing_status)) {
    return "routing_status must be draft, searchable, candidate, routing_ready, or trusted";
  }
  return null;
}

function privateCloudSafetyFindingsCli(findings) {
  return findings.filter((finding) =>
    (finding.severity === "blocker" && !finding.id.startsWith("missing-agent-definition"))
    || finding.category === "secret"
    || finding.category === "size");
}

function cloudStaticReview(findings, scope = "hub-public") {
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const high = findings.filter((f) => f.severity === "high").length;
  return {
    mode: "static-only",
    verdict: blockers ? "fail" : high ? "needs-review" : "pass",
    costOwner: "none",
    summary: blockers || high
      ? `${blockers} blocker(s), ${high} high-risk finding(s).`
      : scope === "owner-private"
        ? "Private Agent Cloud safety checks passed."
        : "Static public package review passed.",
    findings,
    reviewedAt: new Date().toISOString(),
  };
}

async function runCloudLocalReviewCli(db, rootPath, manifest, staticFindings, runtimeOverride) {
  let text = "";
  const system = [
    "You are the Agentlas Cloud package security reviewer.",
    "This review runs locally on the submitter machine using the submitter's own CLI/BYOK/local runtime.",
    "Agentlas Cloud and the platform owner must not pay for this model call.",
    "Return strict JSON only: {\"verdict\":\"pass|fail|needs-review\",\"summary\":\"...\",\"findings\":[{\"severity\":\"blocker|high|medium|low|info\",\"category\":\"secret|policy|size|structure|runtime|network|review\",\"message\":\"...\",\"file\":\"optional\",\"remediation\":\"optional\"}]}",
  ].join("\n");
  const prompt = `Review this package manifest and static scan.\n\n${JSON.stringify({ manifest, staticFindings }, null, 2)}`;
  const rt = resolveRuntime(db, runtimeOverride);
  if (rt.mode === "api") {
    text = await runApi(rt.backend, rt.model, system, prompt);
  } else {
    const env = await buildChildEnvCli(db, { cwd: rootPath });
    text = await captureRuntime(rt.kind, system, prompt, { cwd: rootPath, permission: "read", env });
  }
  const parsed = parseCloudReviewJson(text);
  const llmFindings = parsed.findings.map((f, i) => ({
    id: f.id || `local-runtime-review-${i + 1}`,
    severity: normalizeCloudSeverity(f.severity),
    category: normalizeCloudCategory(f.category),
    message: String(f.message || "Reviewer finding"),
    ...(typeof f.file === "string" ? { file: f.file } : {}),
    ...(typeof f.remediation === "string" ? { remediation: f.remediation } : {}),
  }));
  const findings = [...staticFindings, ...llmFindings];
  return {
    mode: "local-runtime",
    verdict: parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "needs-review"
      ? parsed.verdict
      : findings.some((f) => f.severity === "blocker") ? "fail" : "needs-review",
    costOwner: "submitter",
    runtimeLabel: rt.mode === "api" ? `${rt.backend}${rt.model ? " · " + rt.model : ""}` : rt.kind,
    summary: parsed.summary || "Local runtime review completed.",
    findings,
    reviewedAt: new Date().toISOString(),
    rawText: String(text || "").slice(0, 4000),
  };
}

function cloudCasResponseErrorCli(response, label) {
  let body = null;
  try { body = JSON.parse(response.text || "null"); } catch { /* generic below */ }
  const code = body && typeof body.code === "string" ? body.code : "cloud_request_failed";
  let message = `${label} 실패 ${response.status}`;
  if (response.status === 412 && code === "cloud_agent_revision_conflict") {
    const current = body && body.current ? body.current : body && body.conflict && body.conflict.current;
    message = current
      ? `다른 PC에서 이 Agent Cloud 자산이 변경되었습니다. 자동 덮어쓰기는 중단했습니다. \`agentlas cloud list\`로 최신 revision을 확인하고 \`agentlas cloud restore ${current.slug || "<slug>"}\`로 복원한 뒤 변경 사항을 병합하세요.`
      : "이 Agent Cloud 자산은 다른 PC에서 삭제되었거나 다른 식별자로 다시 생성되었습니다. 자동 재생성은 중단했습니다. `agentlas cloud list`로 현재 상태를 확인하세요.";
  } else if (response.status === 428 && code === "client_upgrade_required") {
    message = "기존 Cloud 자산을 안전하게 갱신할 base revision이 없습니다. 서버 revision을 자동 복사하지 않습니다. `agentlas cloud list`로 확인하고 `agentlas cloud restore <slug>`로 복원한 뒤 다시 저장하세요.";
  } else if (response.status === 503 && code === "cloud_mutations_maintenance") {
    const retryAfter = response.headers && typeof response.headers.get === "function" ? response.headers.get("retry-after") : null;
    message = `Agent Cloud 저장/삭제가 잠시 점검 중입니다${retryAfter ? ` (약 ${retryAfter}초 후 재시도)` : ""}. 읽기·목록·복원은 계속 사용할 수 있습니다.`;
  } else if (body && typeof body.error === "string") {
    message = `${label} 실패 ${response.status}: ${body.error.slice(0, 300)}`;
  }
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  if (body && body.current) error.current = body.current;
  if (body && body.conflict) error.conflict = body.conflict;
  return error;
}

async function registerCloudAgentCli(manifest, bundlePath, review, visibility, options = {}) {
  const cookie = await cloudSessionCookieCli();
  if (!cookie) fail("agentlas.cloud 로그인이 필요합니다. 데스크톱 앱에서 로그인하거나 AGENTLAS_SESSION을 설정하세요.");
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const expectedScope = cloudScopeForVisibility(visibility);
  const baseDescriptor = options.baseDescriptor
    ? normalizeCloudAssetDescriptorCli(options.baseDescriptor, "base revision")
    : null;
  if (baseDescriptor && (baseDescriptor.slug !== manifest.slug || baseDescriptor.scope !== expectedScope)) {
    throw new Error("Agent Cloud base revision does not match the requested slug/scope.");
  }
  const headers = { "content-type": "application/json", cookie, origin: base };
  if (baseDescriptor) {
    headers["if-match"] = baseDescriptor.etag;
    headers["x-agentlas-cloud-id"] = baseDescriptor.cloudId;
  } else {
    headers["if-none-match"] = "*";
  }
  const resp = await fetchHubCli(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ manifest, bundle, review, visibility, billing: { modelCallsPaidBy: review.costOwner, localRuntime: review.runtimeLabel || null } }),
  });
  if (!resp.ok) throw cloudCasResponseErrorCli(resp, "Agentlas Cloud 등록");
  const json = parseHubJsonCli(resp, "Agentlas Cloud 등록");
  const expectedSource = visibility === "marketplace" ? "hub" : "agent-cloud";
  const expectedVisibility = visibility === "marketplace" ? "marketplace" : "owner-private";
  const etag = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("etag") : null;
  const cacheControl = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("cache-control") : null;
  const expectedOperations = baseDescriptor ? new Set(["updated", "unchanged"]) : new Set(["created"]);
  if (
    json.schema !== "agentlas.agent_cloud.registration.v1" ||
    !expectedOperations.has(json.operation) ||
    json.source !== expectedSource ||
    json.visibility !== expectedVisibility ||
    json.scope !== expectedScope ||
    json.owner !== true ||
    json.publicHubPublished !== (visibility === "marketplace") ||
    json.dryRun !== false ||
    typeof json.cloudId !== "string" || !json.cloudId.trim() ||
    json.slug !== manifest.slug ||
    json.packageHash !== manifest.packageHash ||
    json.packageHashVersion !== manifest.packageHashVersion ||
    typeof json.revision !== "string" || etag !== cloudRevisionEtag(json.revision) ||
    typeof json.registeredAt !== "string" || !Number.isFinite(Date.parse(json.registeredAt)) ||
    !String(cacheControl || "").toLowerCase().includes("no-store") ||
    (baseDescriptor && json.cloudId !== baseDescriptor.cloudId)
  ) {
    throw new Error("Agentlas Cloud register returned an invalid or mismatched registration receipt.");
  }
  const descriptor = normalizeCloudAssetDescriptorCli({
    cloudId: json.cloudId,
    slug: json.slug,
    scope: json.scope,
    packageHash: json.packageHash,
    packageHashVersion: json.packageHashVersion,
    revision: json.revision,
    etag,
    updatedAt: json.savedAt || json.registeredAt,
  }, "registration receipt");
  return {
    ...descriptor,
    operation: json.operation,
    ...(typeof json.url === "string" ? { url: json.url } : {}),
    ...(typeof json.marketplaceUrl === "string" ? { marketplaceUrl: json.marketplaceUrl } : {}),
    registeredAt: json.registeredAt,
    dryRun: false,
  };
}

async function deleteCloudAgentCli(slug, options = {}) {
  const safeSlug = String(slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!safeSlug) fail("usage: agentlas cloud delete <slug> [--json]");
  const cookie = await cloudSessionCookieCli();
  if (!cookie) fail("agentlas.cloud 로그인이 필요합니다. 데스크톱 앱에서 로그인하거나 AGENTLAS_SESSION을 설정하세요.");
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  const scope = options.scope == null ? null : normalizeCloudScopeFlagCli(options.scope);
  if (options.scope != null && !scope) throw new Error("--scope must be owner-private or hub-public");
  const localEntry = findCloudAssetDescriptorCli(safeSlug, scope);
  if (!localEntry) {
    throw new Error(`No observed base revision for ${safeSlug}${scope ? ` (${scope})` : ""}. Run \`agentlas cloud list\` first, then retry the exact asset deletion.`);
  }
  const descriptor = localEntry.descriptor;
  const base = (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
  const query = new URLSearchParams({ slug: safeSlug, scope: descriptor.scope, cloudId: descriptor.cloudId });
  const resp = await fetchHubCli(`${base}/api/cloud-agents/v1/register?${query.toString()}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: base,
      "if-match": descriptor.etag,
      "x-agentlas-cloud-id": descriptor.cloudId,
    },
  });
  if (!resp.ok) throw cloudCasResponseErrorCli(resp, "Agentlas Cloud 삭제");
  const json = parseHubJsonCli(resp, "Agentlas Cloud 삭제");
  const responseEtag = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("etag") : null;
  const cacheControl = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("cache-control") : null;
  const expectedSource = descriptor.scope === "hub-public" ? "hub" : "agent-cloud";
  const expectedVisibility = descriptor.scope === "hub-public" ? "marketplace" : "owner-private";
  const deletionTimestamp = descriptor.scope === "hub-public" ? json.unpublishedAt : json.deletedAt;
  if (
    json.schema !== "agentlas.agent_cloud.delete.v1" || json.ok !== true ||
    json.source !== expectedSource || json.visibility !== expectedVisibility ||
    json.scope !== descriptor.scope || json.cloudId !== descriptor.cloudId || json.slug !== descriptor.slug ||
    json.packageHash !== descriptor.packageHash || json.packageHashVersion !== descriptor.packageHashVersion ||
    json.revision !== descriptor.revision ||
    responseEtag !== descriptor.etag || !String(cacheControl || "").toLowerCase().includes("no-store") ||
    (descriptor.scope === "hub-public" && json.operation !== "unpublished") ||
    typeof deletionTimestamp !== "string" || !Number.isFinite(Date.parse(deletionTimestamp))
  ) {
    throw new Error("Agentlas Cloud delete returned an invalid or mismatched deletion receipt.");
  }
  const state = readCloudAssetStateCli();
  const key = cloudDescriptorKey(descriptor);
  const roots = state.assets[key]?.sourceRoots || [];
  const warnings = [];
  for (const rootPath of roots) {
    state.deletedBases.push({ rootPath, slug: descriptor.slug, scope: descriptor.scope, cloudId: descriptor.cloudId, revision: descriptor.revision });
  }
  delete state.assets[key];
  state.deletedBases = state.deletedBases.slice(-256);
  try {
    writeCloudAssetStateCli(state);
  } catch (error) {
    const stateError = new Error(
      `Cloud delete committed on the server, but this machine could not persist the deletion tombstone. ` +
      "Run `agentlas cloud list` before saving this slug again. " +
      `Local state error: ${error.message || error}`,
    );
    stateError.code = "AGENTLAS_CLOUD_LOCAL_STATE_COMMIT_FAILED";
    stateError.receipt = json;
    throw stateError;
  }
  for (const rootPath of roots) {
    try {
      const marker = readCloudSourceMarkerCli(rootPath);
      if (marker) writeCloudSourceMarkerCli(rootPath, null, null, { previousMarker: marker, removeDescriptor: descriptor });
    } catch (error) {
      warnings.push(`Could not clear ${rootPath}: ${error.message || error}`);
    }
  }
  return { ...json, ...(warnings.length ? { localStateWarnings: warnings } : {}) };
}

// `agentlas login`이 저장하는 CLI 세션 파일 (평문·0600 — 데스크탑의 safeStorage 파일과 별개).
function cliSessionPath() {
  return path.join(userDataDir(), "auth", "cli-session.v1.json");
}
function readCliSessionValue() {
  try {
    const j = JSON.parse(fs.readFileSync(cliSessionPath(), "utf8"));
    return (j && typeof j.value === "string" && j.value) || null;
  } catch {
    return null;
  }
}

async function cloudSessionCookieCli() {
  if (process.env.AGENTLAS_SESSION) return `agentlas_session=${process.env.AGENTLAS_SESSION}`;
  // 1) CLI 자체 로그인 세션 (agentlas login)
  const fileValue = readCliSessionValue();
  if (fileValue) return `agentlas_session=${fileValue}`;
  // 2) (레거시) keytar 항목 — 데스크탑 앱은 세션을 keytar에 두지 않으므로 보통 비어 있다.
  const keytar = readKeytar();
  if (!keytar) return null;
  try {
    const value = await keytar.getPassword("Agentlas Session", "default");
    return value ? `agentlas_session=${value}` : null;
  } catch {
    return null;
  }
}

async function cmdCloudInstall(db, slug) {
  if (!slug) fail("usage: agentlas cloud install <slug>");
  const listing = await fetchCloudManifestCli(slug);
  if (!listing) fail(`Hub agent를 찾을 수 없습니다: ${slug}`);
  if (listing.delivery && listing.delivery.mode === "call_only") {
    fail(`이 Hub 에이전트는 소스 설치가 허용되지 않은 call-only 자산입니다. 실행: agentlas call ${slug}`);
  }
  const agent = persistCloudListingCli(db, listing);
  out(`✓ Hub installed ${agent.slug} — ${agent.name}`);
  if (agent.localPath) out(`  files: ${agent.localPath}`);
}

async function callAgentlasMcpToolCli(name, args, { requireSession = false } = {}) {
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
  const headers = { "content-type": "application/json" };
  const cookie = await cloudSessionCookieCli();
  if (requireSession && !cookie) fail("Agent Cloud에는 로그인이 필요합니다. 먼저 `agentlas login`을 실행하세요.");
  if (cookie) headers.cookie = cookie;
  const resp = await fetchHubCli(`${base.replace(/\/$/, "")}/tools/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: name, params: { name, arguments: args || {} } }),
  });
  if (!resp.ok) fail(`${name} 실패 ${resp.status}`);
  const json = parseHubJsonCli(resp, name);
  if (json.error) fail(`${name}: ${json.error.message || "unknown error"}`);
  return json.result || null;
}

async function fetchCloudManifestCli(slug) {
  return callAgentlasMcpToolCli("marketplace.get_manifest", { kind: "agent", slug });
}

async function listOwnedCloudAgentsCli(limit = 100) {
  const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 100));
  const result = (await callAgentlasMcpToolCli("cargo.search_agents", { q: "", limit: safeLimit }, { requireSession: true })) || {
    schema: "agentlas.agent_cloud.search.v1",
    source: "cloud",
    status: "ok",
    count: 0,
    total: 0,
    results: [],
  };
  if (!Array.isArray(result.results)) throw new Error("Agent Cloud list returned an invalid results contract.");
  if (result.results.length) {
    const state = readCloudAssetStateCli();
    for (const raw of result.results) {
      const descriptor = normalizeCloudAssetDescriptorCli(raw, "Agent Cloud list result");
      const key = cloudDescriptorKey(descriptor);
      const previous = state.assets[key];
      const preserveRoots = previous && previous.descriptor.cloudId === descriptor.cloudId && previous.descriptor.revision === descriptor.revision;
      state.assets[key] = { descriptor, sourceRoots: preserveRoots ? previous.sourceRoots : [] };
    }
    writeCloudAssetStateCli(state);
  }
  return result;
}

async function restoreOwnedCloudAgentCli(db, slug) {
  const raw = await callAgentlasMcpToolCli("cargo.restore_package", { slug }, { requireSession: true });
  if (!raw || raw.error) {
    const code = raw && raw.error ? raw.error : "agent_not_found";
    const message = raw && raw.message ? raw.message : `Agent Cloud package not found: ${slug}`;
    throw new Error(`${code}: ${message}`);
  }
  const restored = normalizeOwnerRestorePayloadCli(raw, slug);
  const cloudPackage = restored.cloudPackage;
  const listing = {
    slug: restored.slug || slug,
    name: restored.name || restored.nameEn || restored.slug || slug,
    nameEn: restored.nameEn || restored.name || restored.slug || slug,
    tagline: restored.tagline || restored.taglineEn || "",
    taglineEn: restored.taglineEn || restored.tagline || "",
    trustGrade: "A",
    visibility: "visible",
    source: "cloud",
    assetDescriptor: restored.descriptor,
    cloudPackage,
  };
  const agent = persistCloudListingCli(db, listing);
  let descriptor = restored.descriptor;
  let localStateWarning;
  try {
    descriptor = rememberCloudAssetDescriptorCli(restored.descriptor, { sourceRoot: agent.localPath || undefined });
  } catch (error) {
    localStateWarning = `Restore completed, but observed revision state could not be indexed: ${error.message || error}`;
  }
  return {
    schema: restored.schema || "agentlas.agent_cloud.restore.v1",
    source: "cloud",
    slug: agent.slug,
    name: agent.name,
    packageHash: cloudPackage.packageHash,
    packageHashVersion: cloudPackage.packageHashVersion || CLOUD_PACKAGE_HASH_V1,
    cloudId: descriptor.cloudId,
    scope: descriptor.scope,
    revision: descriptor.revision,
    etag: descriptor.etag,
    updatedAt: descriptor.updatedAt,
    localPath: agent.localPath || null,
    ...(localStateWarning ? { localStateWarning } : {}),
  };
}

function normalizeOwnerRestorePayloadCli(raw, expectedSlug) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_restore_contract");
  if (raw.schema !== "agentlas.agent_cloud.restore.v1" || raw.source !== "cloud" || raw.owner !== true) {
    throw new Error("invalid_restore_contract");
  }
  if (typeof raw.slug !== "string" || !raw.slug || raw.slug !== expectedSlug) {
    throw new Error(`restore_slug_mismatch: requested ${expectedSlug}; received ${String(raw.slug || "")}`);
  }
  const pkg = raw.cloudPackage;
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || !Array.isArray(pkg.files)) {
    throw new Error("invalid_restore_contract");
  }
  const version = cloudPackageHashVersion(pkg.packageHashVersion);
  if (!version || !/^[a-f0-9]{64}$/i.test(String(pkg.packageHash || "").replace(/^sha256:/i, ""))) {
    throw new Error("invalid_restore_contract");
  }
  let descriptor;
  let nestedDescriptor;
  try {
    descriptor = normalizeCloudAssetDescriptorCli(raw, "owner restore receipt");
    nestedDescriptor = normalizeCloudAssetDescriptorCli({
      ...pkg,
      slug: raw.slug,
      etag: raw.etag,
    }, "owner restore package receipt");
  } catch (error) {
    throw new Error(`invalid_restore_contract: ${error.message || error}`);
  }
  if (JSON.stringify(descriptor) !== JSON.stringify(nestedDescriptor)) {
    throw new Error("invalid_restore_contract: restore revision envelope and cloudPackage disagree");
  }
  if (!["agent", "team", "repo"].includes(pkg.agentKind) || !Number.isSafeInteger(pkg.fileCount) || !Number.isSafeInteger(pkg.totalBytes)) {
    throw new Error("invalid_restore_contract");
  }
  for (const file of pkg.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || typeof file.sha256 !== "string" || typeof file.contentBase64 !== "string") {
      throw new Error("invalid_restore_contract");
    }
  }
  const outerVersion = raw.packageHashVersion == null ? version : cloudPackageHashVersion(raw.packageHashVersion);
  if (
    (raw.packageHash != null && String(raw.packageHash) !== String(pkg.packageHash)) ||
    !outerVersion || outerVersion !== version ||
    (raw.fileCount != null && raw.fileCount !== pkg.fileCount) ||
    (raw.totalBytes != null && raw.totalBytes !== pkg.totalBytes) ||
    (raw.agentKind != null && raw.agentKind !== pkg.agentKind)
  ) {
    throw new Error("invalid_restore_contract: restore envelope and cloudPackage disagree");
  }
  return {
    schema: raw.schema,
    source: raw.source,
    owner: true,
    slug: raw.slug,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.slug,
    nameEn: typeof raw.nameEn === "string" && raw.nameEn ? raw.nameEn : (raw.name || raw.slug),
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    taglineEn: typeof raw.taglineEn === "string" ? raw.taglineEn : (raw.tagline || ""),
    descriptor,
    cloudPackage: {
      cloudId: descriptor.cloudId,
      scope: descriptor.scope,
      revision: descriptor.revision,
      updatedAt: descriptor.updatedAt,
      packageHash: String(pkg.packageHash).replace(/^sha256:/i, "").toLowerCase(),
      packageHashVersion: version,
      fileCount: pkg.fileCount,
      totalBytes: pkg.totalBytes,
      agentKind: pkg.agentKind,
      runtimeLabels: Array.isArray(pkg.runtimeLabels) ? pkg.runtimeLabels.filter((item) => typeof item === "string" && item.trim()) : [],
      files: pkg.files,
    },
  };
}

function cloudSystemPromptFromPackageCli(listing, slug) {
  const pkg = listing && listing.cloudPackage;
  if (!pkg || !Array.isArray(pkg.files) || !pkg.files.length) return "";
  const byPath = new Map();
  for (const file of pkg.files) {
    if (!file || typeof file.path !== "string" || typeof file.contentBase64 !== "string") continue;
    byPath.set(cloudPortablePathKey(file.path), file);
  }
  const readText = (candidate) => {
    const safe = cloudPortableRelativePath(candidate);
    if (!safe) return "";
    const file = byPath.get(cloudPortablePathKey(safe));
    if (!file) return "";
    let bytes;
    try { bytes = Buffer.from(file.contentBase64, "base64"); } catch { return ""; }
    if (!bytes.length || bytes.includes(0)) return "";
    const text = bytes.toString("utf8");
    if (!text.trim() || text.includes("\ufffd")) return "";
    return text.slice(0, 64 * 1024);
  };
  let manifest = null;
  const manifestFile = byPath.get(cloudPortablePathKey("agentlas.json"));
  if (manifestFile) {
    try { manifest = JSON.parse(Buffer.from(manifestFile.contentBase64, "base64").toString("utf8")); }
    catch { manifest = null; }
  }
  const declaredEntry = manifest && typeof manifest === "object" && typeof manifest.entry === "string"
    ? cloudPortableRelativePath(manifest.entry)
    : null;
  const candidates = [
    declaredEntry,
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "AGENT.md",
    "agent.md",
    "system-prompt.md",
    "README.md",
  ].filter(Boolean);
  let entryPath = "";
  let entryText = "";
  for (const candidate of candidates) {
    const text = readText(candidate);
    if (!text) continue;
    entryPath = candidate;
    entryText = text;
    break;
  }
  if (!entryText) return "";
  const installRoot = path.join(userDataDir(), "cloud-agent-installs", slug);
  return [
    `You are the Agentlas Cloud agent "${listing.name || slug}".`,
    `IMMUTABLE CLOUD AGENT ROOT: ${installRoot}`,
    `CANONICAL ENTRY: ${entryPath}`,
    `PACKAGE HASH: ${String(pkg.packageHash || "").replace(/^sha256:/i, "")}`,
    "Resolve package-relative references under IMMUTABLE CLOUD AGENT ROOT. Treat that root as read-only and do work in the user's active project.",
    "",
    "--- CLOUD AGENT ENTRY ---",
    entryText,
  ].join("\n");
}

function persistCloudListingCli(db, listing) {
  if (listing?.delivery?.mode === "call_only") {
    throw new Error(`call-only Hub asset cannot be source-installed; invoke it with agentlas call ${listing.slug || "<slug>"}`);
  }
  const slug = cloudSlug(listing.slug || listing.name || "cloud-agent");
  recoverCloudInstallJournalCli(db, slug);
  const existing = db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(slug);
  const now = new Date().toISOString();
  const envReqs = JSON.stringify(listing.envRequirements || []);
  const mcpServers = JSON.stringify(listing.mcpServers || []);
  const id = existing?.id || crypto.randomUUID();
  const hasVisibility = columnExists(db, "installed_agents", "visibility");
  let installedAt = now;
  if (existing && String(existing.installed_at || "") === installedAt) {
    installedAt = new Date(Date.now() + 1).toISOString();
  }
  const tone = listing.tone || "blue";
  const packageSystemPrompt = cloudSystemPromptFromPackageCli(listing, slug);
  const dbExpected = {
    id,
    slug,
    name: listing.name || slug,
    name_en: listing.nameEn || listing.name || slug,
    tagline: listing.tagline || "",
    tagline_en: listing.taglineEn || listing.tagline || "",
    system_prompt: packageSystemPrompt || listing.systemPrompt || "",
    mcp_servers_json: mcpServers,
    env_requirements_json: envReqs,
    trust_grade: listing.trustGrade || "unknown",
    installed_at: installedAt,
    tone,
    ...(!existing ? { preferred_backend: null } : {}),
    ...(hasVisibility ? { visibility: listing.visibility || "visible" } : {}),
  };
  const restore = materializeCloudListingCli(id, slug, listing, { deferCommit: true, dbExpected });
  const mutate = () => {
    if (existing) {
      if (hasVisibility) {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, mcp_servers_json=?, env_requirements_json=?, trust_grade=?, installed_at=?, tone=?, visibility=? WHERE slug=?")
          .run(dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, dbExpected.visibility, slug);
      } else {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, mcp_servers_json=?, env_requirements_json=?, trust_grade=?, installed_at=?, tone=? WHERE slug=?")
          .run(dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, slug);
      }
      return;
    }
    if (hasVisibility) {
      db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)")
        .run(id, slug, dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, dbExpected.visibility);
    } else {
      db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)")
        .run(id, slug, dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone);
    }
  };
  let dbCommitted = false;
  try {
    if (typeof db.transaction === "function") db.transaction(mutate)();
    else mutate();
    dbCommitted = true;
    restore?.commit();
  } catch (error) {
    if (!dbCommitted) restore?.rollback();
    throw error;
  }
  const localPath = restore?.path || null;
  // entity_kind 기록 — needsImage의 팀 body-veto가 로컬 폴더 임포트(detectKind)뿐 아니라
  // 클라우드/Hub 소스 설치 팀에도 걸리게 한다. 안 하면 팀 CEO 두뇌의 부서 키워드
  // ("Design HQ" 등)로 needsImage가 참이 되어 세션 런타임이 통째로 gemini로 하이재킹된다.
  // Hub가 준 entityKind를 우선하고, 없으면 materialize된 팩 폴더 구조로 판정한다.
  if (columnExists(db, "installed_agents", "entity_kind")) {
    let kind = String(listing.entityKind || "").toLowerCase();
    if (kind !== "team" && kind !== "agent") {
      kind = localPath && fs.existsSync(localPath) ? detectKind(localPath) : "agent";
    }
    db.prepare("UPDATE installed_agents SET entity_kind=? WHERE id=?").run(kind, id);
  }
  return existing
    ? { ...existing, slug, name: dbExpected.name, ...(localPath ? { localPath } : {}) }
    : { id, slug, name: dbExpected.name, ...(localPath ? { localPath } : {}) };
}

function materializeCloudListingCli(agentId, slug, listing, options = {}) {
  const pkg = listing.cloudPackage;
  if (!pkg || !Array.isArray(pkg.files) || pkg.files.length === 0) return null;
  if (pkg.files.length > CLOUD_MAX_FILES) throw new Error(`cloud package exceeds ${CLOUD_MAX_FILES} files`);
  if (!Number.isSafeInteger(pkg.fileCount) || pkg.fileCount !== pkg.files.length) {
    throw new Error("cloud package file count does not match its manifest");
  }
  if (!Number.isSafeInteger(pkg.totalBytes) || pkg.totalBytes < 0 || pkg.totalBytes > CLOUD_MAX_TOTAL_BYTES) {
    throw new Error("cloud package total byte count is invalid");
  }
  const packageHashVersion = cloudPackageHashVersion(pkg.packageHashVersion);
  if (!packageHashVersion) throw new Error(`unsupported cloud package hash version: ${pkg.packageHashVersion}`);
  const assetDescriptor = listing.assetDescriptor
    ? normalizeCloudAssetDescriptorCli(listing.assetDescriptor, "restore asset descriptor")
    : null;
  if (assetDescriptor && assetDescriptor.slug !== slug) throw new Error("restore asset descriptor slug mismatch");
  const pathConflict = cloudPortablePathConflict(pkg.files.map((file) => file && file.path));
  if (pathConflict) throw new Error(pathConflict.message);
  const dir = path.join(userDataDir(), "cloud-agent-installs", slug);
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const staging = path.join(parent, `.${path.basename(dir)}.installing-${nonce}`);
  const backup = path.join(parent, `.${path.basename(dir)}.backup-${nonce}`);
  const journal = path.join(parent, `.${path.basename(dir)}.install-journal.json`);
  const seen = new Set();
  const verifiedFiles = [];
  let verifiedTotalBytes = 0;
  let movedExisting = false;
  let installed = false;
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    cloudApplyPrivateDirectoryMode(staging);
    for (const file of pkg.files) {
      const target = resolveCloudInstallPathCli(staging, file.path);
      const normalizedPath = path.relative(staging, target).split(path.sep).join("/");
      if (seen.has(normalizedPath)) throw new Error(`duplicate cloud package path: ${file.path}`);
      seen.add(normalizedPath);
      if (packageHashVersion === CLOUD_PACKAGE_HASH_V2 && typeof file.executable !== "boolean") {
        throw new Error(`cloud package hash v2 requires executable boolean: ${file.path}`);
      }
      if (packageHashVersion === CLOUD_PACKAGE_HASH_V1 && file.executable !== undefined) {
        throw new Error(`legacy cloud package hash v1 cannot authenticate executable flag: ${file.path}`);
      }
      if (!cloudCanonicalBase64(file.contentBase64)) {
        throw new Error(`cloud package file base64 is not canonical: ${file.path}`);
      }
      const bytes = Buffer.from(String(file.contentBase64 || ""), "base64");
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > CLOUD_MAX_FILE_BYTES) {
        throw new Error(`cloud package file byte count is invalid: ${file.path}`);
      }
      if (bytes.length !== Number(file.bytes) || sha(bytes) !== String(file.sha256 || "").toLowerCase()) {
        throw new Error(`cloud package file integrity failed: ${file.path}`);
      }
      verifiedFiles.push({
        path: normalizedPath,
        bytes: bytes.length,
        sha256: String(file.sha256 || "").toLowerCase(),
        ...(packageHashVersion === CLOUD_PACKAGE_HASH_V2 ? { executable: file.executable } : {}),
      });
      verifiedTotalBytes += bytes.length;
      if (verifiedTotalBytes > CLOUD_MAX_TOTAL_BYTES) throw new Error("cloud package exceeds total byte limit");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      cloudApplyPrivateDirectoryMode(path.dirname(target));
      const mode = packageHashVersion === CLOUD_PACKAGE_HASH_V2 && file.executable ? 0o700 : 0o600;
      fs.writeFileSync(target, bytes, { mode });
      cloudApplyPortableFileMode(target, mode);
    }
    const expectedPackageHash = String(pkg.packageHash || "").toLowerCase().replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(expectedPackageHash)) {
      throw new Error("cloud package aggregate hash is missing or invalid");
    }
    const actualPackageHash = cloudHashPackage(verifiedFiles, packageHashVersion);
    if (actualPackageHash !== expectedPackageHash) {
      throw new Error("cloud package aggregate integrity failed");
    }
    if (assetDescriptor && (
      assetDescriptor.packageHash !== expectedPackageHash ||
      assetDescriptor.packageHashVersion !== packageHashVersion
    )) {
      throw new Error("restore asset descriptor package identity mismatch");
    }
    if (verifiedTotalBytes !== pkg.totalBytes) throw new Error("cloud package total byte count does not match its files");
    const restoredAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(staging, ".agentlas-cloud-package.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "agentlas-cloud",
        slug,
        packageHash: expectedPackageHash,
        packageHashVersion,
        fileCount: verifiedFiles.length,
        totalBytes: verifiedTotalBytes,
        executablePaths: packageHashVersion === CLOUD_PACKAGE_HASH_V2
          ? verifiedFiles.filter((file) => file.executable).map((file) => file.path).sort()
          : undefined,
        ...(assetDescriptor ? {
          cloudId: assetDescriptor.cloudId,
          scope: assetDescriptor.scope,
          revision: assetDescriptor.revision,
          etag: assetDescriptor.etag,
          updatedAt: assetDescriptor.updatedAt,
          cloudAssets: { [assetDescriptor.scope]: assetDescriptor },
        } : {}),
        restoredAt,
      }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    cloudApplyPortableFileMode(path.join(staging, CLOUD_RESTORE_MARKER_PATH), 0o600);
    cloudVerifyRestoredSnapshot(staging, verifiedFiles, {
      slug,
      packageHash: expectedPackageHash,
      packageHashVersion,
      totalBytes: verifiedTotalBytes,
      assetDescriptor,
    });

    if (options.deferCommit) {
      writeCloudInstallJournalCli(journal, {
        schemaVersion: 1,
        slug,
        phase: "prepared",
        destination: dir,
        staging,
        backup,
        hadExisting: fs.existsSync(dir),
        dbExpected: options.dbExpected || {},
      });
    }

    // A Cloud agent is an immutable asset snapshot. Replace the managed install
    // as a whole so removed files and local mutations cannot leak across versions.
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, backup);
      movedExisting = true;
    }
    fs.renameSync(staging, dir);
    cloudFsyncDirectoryCli(parent);
    installed = true;
    if (options.deferCommit) {
      writeCloudInstallJournalCli(journal, {
        schemaVersion: 1,
        slug,
        phase: "disk-swapped-db-pending",
        destination: dir,
        staging,
        backup,
        hadExisting: movedExisting,
        dbExpected: options.dbExpected || {},
      });
    }
  } catch (error) {
    rollbackCloudInstallSwapCli({ destination: dir, staging, backup, movedExisting, installed });
    try { if (fs.existsSync(journal)) fs.unlinkSync(journal); } catch { /* best-effort */ }
    throw error;
  } finally {
    try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { if (!options.deferCommit && installed && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (!options.deferCommit) return dir;
  let settled = false;
  return {
    path: dir,
    commit() {
      if (settled) return;
      writeCloudInstallJournalCli(journal, {
        schemaVersion: 1,
        slug,
        phase: "db-committed",
        destination: dir,
        staging,
        backup,
        hadExisting: movedExisting,
        dbExpected: options.dbExpected || {},
      });
      if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
      if (fs.existsSync(journal)) fs.unlinkSync(journal);
      cloudFsyncDirectoryCli(parent);
      settled = true;
    },
    rollback() {
      if (settled) return;
      rollbackCloudInstallSwapCli({ destination: dir, staging, backup, movedExisting, installed });
      if (fs.existsSync(journal)) fs.unlinkSync(journal);
      cloudFsyncDirectoryCli(parent);
      settled = true;
    },
  };
}

function writeCloudInstallJournalCli(journalPath, value) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const temp = `${journalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, journalPath);
  cloudApplyPortableFileMode(journalPath, 0o600);
  cloudFsyncDirectoryCli(path.dirname(journalPath));
}

function cloudFsyncDirectoryCli(directory) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch { /* some filesystems do not support directory fsync */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ } }
}

function rollbackCloudInstallSwapCli({ destination, staging, backup, movedExisting, installed }) {
  if (installed && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  if (movedExisting && fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  cloudFsyncDirectoryCli(path.dirname(destination));
}

function recoverCloudInstallJournalCli(db, slug) {
  const destination = path.join(userDataDir(), "cloud-agent-installs", slug);
  const parent = path.dirname(destination);
  const journalPath = path.join(parent, `.${path.basename(destination)}.install-journal.json`);
  if (!fs.existsSync(journalPath)) return;
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { throw new Error(`cloud install recovery journal is unreadable for ${slug}`); }
  const safeSibling = (candidate, prefix) =>
    typeof candidate === "string" && path.dirname(candidate) === parent && path.basename(candidate).startsWith(prefix);
  if (
    journal.schemaVersion !== 1 || journal.slug !== slug || journal.destination !== destination ||
    !["prepared", "disk-swapped-db-pending", "db-committed"].includes(journal.phase) ||
    typeof journal.hadExisting !== "boolean" ||
    !safeSibling(journal.staging, `.${path.basename(destination)}.installing-`) ||
    !safeSibling(journal.backup, `.${path.basename(destination)}.backup-`)
  ) {
    throw new Error(`cloud install recovery journal is invalid for ${slug}`);
  }
  const row = db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(slug);
  const expected = journal.dbExpected && typeof journal.dbExpected === "object" ? journal.dbExpected : {};
  const expectedEntries = Object.entries(expected);
  const dbMatches = Boolean(row) && expectedEntries.length > 0 && expectedEntries.every(
    ([key, value]) => String(row[key] ?? "") === String(value ?? ""),
  );
  if (journal.phase === "prepared") {
    // The DB mutation starts only after materializeCloudListingCli returns, so a
    // prepared journal always represents the pre-DB state. Cover both rename
    // crash windows: old→backup and staging→destination.
    if (journal.hadExisting) {
      if (fs.existsSync(journal.backup)) {
        if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
        fs.renameSync(journal.backup, destination);
      } else if (!fs.existsSync(destination)) {
        throw new Error(`prepared cloud install lost both destination and backup for ${slug}`);
      }
    } else {
      if (fs.existsSync(journal.backup)) {
        throw new Error(`prepared first cloud install has an unexpected backup for ${slug}`);
      }
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    }
    if (fs.existsSync(journal.staging)) fs.rmSync(journal.staging, { recursive: true, force: true });
  } else if (journal.phase === "db-committed" || dbMatches) {
    if (!fs.existsSync(destination) && fs.existsSync(journal.staging)) fs.renameSync(journal.staging, destination);
    if (!fs.existsSync(destination)) throw new Error(`committed cloud install is missing for ${slug}`);
    if (fs.existsSync(journal.backup)) fs.rmSync(journal.backup, { recursive: true, force: true });
    if (fs.existsSync(journal.staging)) fs.rmSync(journal.staging, { recursive: true, force: true });
  } else if (journal.phase === "disk-swapped-db-pending") {
    if (!fs.existsSync(destination)) throw new Error(`pending cloud install destination is missing for ${slug}`);
    if (journal.hadExisting !== fs.existsSync(journal.backup)) {
      throw new Error(`pending cloud install backup state is invalid for ${slug}`);
    }
    rollbackCloudInstallSwapCli({
      destination,
      staging: journal.staging,
      backup: journal.backup,
      movedExisting: Boolean(journal.hadExisting),
      installed: true,
    });
  }
  fs.unlinkSync(journalPath);
  cloudFsyncDirectoryCli(parent);
}

function recoverCloudInstallJournalsCli(db) {
  const parent = path.join(userDataDir(), "cloud-agent-installs");
  if (!fs.existsSync(parent)) return 0;
  let recovered = 0;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.endsWith(".install-journal.json")) continue;
    const match = entry.name.match(/^\.([a-z0-9][a-z0-9-]{0,63})\.install-journal\.json$/);
    if (!match || cloudSlug(match[1]) !== match[1] || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`invalid cloud install recovery journal entry: ${entry.name}`);
    }
    recoverCloudInstallJournalCli(db, match[1]);
    recovered += 1;
  }
  return recovered;
}

function resolveCloudInstallPathCli(root, relPath) {
  const normalized = cloudPortableRelativePath(relPath);
  if (!normalized || cloudPortablePathKey(normalized) === cloudPortablePathKey(CLOUD_RESTORE_MARKER_PATH)) {
    throw new Error(`unsafe cloud package path: ${relPath}`);
  }
  const parts = normalized.split("/");
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`cloud package path escapes install folder: ${relPath}`);
  }
  return target;
}

function printCloudPackageResult(result) {
  out(`${result.status === "blocked" ? "✖" : "✓"} ${result.summary}`);
  out(`  target:  ${result.manifest.visibility === "marketplace" ? "Agentlas Hub (public)" : "Agent Cloud (owner-private)"}`);
  out(`  slug:    ${result.manifest.slug}`);
  out(`  files:   ${result.manifest.includedFileCount}/${result.manifest.fileCount}`);
  out(`  hash:    ${result.manifest.packageHash}`);
  out(`  bundle:  ${result.bundlePath}`);
  out(`  review:  ${result.review.mode} · cost=${result.review.costOwner}${result.review.runtimeLabel ? " · " + result.review.runtimeLabel : ""}`);
  const findings = result.review.findings || [];
  if (findings.length) {
    out("  findings:");
    for (const f of findings.slice(0, 20)) out(`    - ${f.severity} ${f.file ? f.file + ": " : ""}${f.message}`);
  }
  if (result.registration) {
    const label = result.manifest.visibility === "marketplace" ? "hub" : "cloud";
    out(`  ${label}:     ${result.registration.marketplaceUrl || result.registration.url || result.registration.cloudId}`);
    if (result.registration.localStateWarning) out(`  warning: ${result.registration.localStateWarning}`);
  }
}

function cloudPackageSnapshot(files) {
  return new Map(files.map((file) => [file.path, file]));
}
function cloudIsLocalExperienceLineagePath(value) {
  const normalized = cloudPortablePathKey(String(value || "").replace(/\\/g, "/"));
  const canonical = cloudPortablePathKey(CLOUD_LOCAL_EXPERIENCE_LINEAGE_PATH);
  return normalized === canonical
    || normalized.startsWith(`${canonical}.`)
    || normalized.startsWith(cloudPortablePathKey(".agentlas/.experience-relations.jsonl."));
}
function cloudReadPublicCareerCard(snapshot, findings) {
  const relativePath = ".agentlas/public-career-card.json";
  const file = snapshot.get(relativePath);
  if (!file) return undefined;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")); }
  catch {
    findings.push(cloudCareerFinding("career-card-invalid-json", "structure", "Career Graph public card is not valid JSON."));
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.kind !== "agentlas-public-career-card") {
    findings.push(cloudCareerFinding("career-card-invalid-kind", "structure", "Career Graph public card has an invalid kind."));
    return undefined;
  }
  const privacy = parsed.privacy && typeof parsed.privacy === "object" && !Array.isArray(parsed.privacy) ? parsed.privacy : {};
  for (const key of ["rawLocalPathsIncluded", "rawPromptsIncluded", "rawTranscriptsIncluded", "sourceTextIncluded"]) {
    if (privacy[key] !== false) findings.push(cloudCareerFinding(`career-card-privacy-${key}`, "policy", `Career Graph public card must set privacy.${key}=false.`));
  }
  if (cloudContainsAbsoluteLocalPath(JSON.stringify(parsed))) {
    findings.push(cloudCareerFinding("career-card-local-path", "policy", "Career Graph public card contains a local absolute path."));
  }
  if (findings.some((finding) => finding.severity === "blocker" && finding.id.startsWith("career-card-"))) return undefined;
  return cloudSanitizePublicCareerCard(parsed);
}
function cloudCareerFinding(id, category, message) {
  return {
    id,
    severity: "blocker",
    category,
    file: ".agentlas/public-career-card.json",
    message,
    remediation: "Regenerate a redacted aggregate-only public Career Graph card before publishing.",
  };
}
function cloudContainsAbsoluteLocalPath(value) {
  return (
    (os.homedir() && value.includes(os.homedir())) ||
    /(?:^|["'\s:(])\/(?:Users|home|var|tmp|private|Volumes|opt|etc)\//i.test(value) ||
    /(?:^|["'\s:(])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|["'\s:(])\\\\[^\\\s]+\\/.test(value)
  );
}
function cloudSanitizePublicCareerCard(parsed) {
  const card = { kind: "agentlas-public-career-card" };
  for (const [key, max] of [["schemaVersion", 80], ["generatedAt", 80], ["projectName", 200], ["indexStatus", 80], ["policy", 160]]) {
    if (typeof parsed[key] === "string" && parsed[key].length <= max) card[key] = parsed[key];
  }
  card.privacy = {
    rawLocalPathsIncluded: false,
    rawPromptsIncluded: false,
    rawTranscriptsIncluded: false,
    sourceTextIncluded: false,
  };
  for (const key of ["counts", "sourceKinds", "nodeTypes", "edgeTypes"]) {
    const safe = cloudSanitizeCountRecord(parsed[key]);
    if (safe) card[key] = safe;
  }
  for (const key of ["canonicalSources", "staleSourceCount"]) {
    if (Number.isSafeInteger(parsed[key]) && parsed[key] >= 0) card[key] = parsed[key];
  }
  return card;
}
function cloudSanitizeCountRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, count] of Object.entries(value).slice(0, 200)) {
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(key) && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return Object.keys(result).length ? result : undefined;
}
function cloudReplacePublicCareerCard(scan, card) {
  const relativePath = ".agentlas/public-career-card.json";
  const includedIndex = scan.included.findIndex((file) => file.path === relativePath);
  const existing = includedIndex >= 0 ? scan.included[includedIndex] : null;
  if (includedIndex >= 0) scan.included.splice(includedIndex, 1);
  const fileRecord = scan.files.find((file) => file.path === relativePath);
  if (!card) {
    if (fileRecord) { fileRecord.included = false; fileRecord.reason = "public-career-card-blocked"; }
    return;
  }
  const bytes = Buffer.from(JSON.stringify(card, null, 2) + "\n", "utf8");
  const replacement = { path: relativePath, bytes: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64"), executable: false };
  scan.included.push(replacement);
  scan.included.sort(cloudCodePointPathOrder);
  scan.totalBytes += bytes.length - (existing?.bytes || 0);
  if (fileRecord) Object.assign(fileRecord, { bytes: bytes.length, sha256: replacement.sha256, kind: "text", executable: false, included: true, reason: undefined });
  else scan.files.push({ path: relativePath, bytes: bytes.length, sha256: replacement.sha256, kind: "text", executable: false, included: true });
}
function cloudReadName(snapshot, fallbackName) {
  const manifest = cloudReadPackageJson(snapshot);
  const explicit = stringFirstCli(
    manifest.agentlas?.displayName,
    manifest.agentlas?.name,
    manifest.manifest?.name,
    manifest.agentCard?.name,
    manifest.routingCard?.name,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").trim().slice(0, 80);
  const text = cloudReadFirst(snapshot, ["agent.md", "AGENT.md", "README.md", "CLAUDE.md", "AGENTS.md"], 2000);
  const heading = text.match(/^#\s+(.+)$/m);
  return (heading ? heading[1] : fallbackName).replace(/\s+/g, " ").trim().slice(0, 80);
}
function cloudReadTagline(snapshot) {
  const manifest = cloudReadPackageJson(snapshot);
  const explicit = stringFirstCli(
    manifest.agentlas?.summary,
    manifest.agentlas?.description,
    manifest.manifest?.description,
    manifest.agentCard?.summary,
    manifest.routingCard?.summary,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").trim().slice(0, 160);
  const text = cloudReadFirst(snapshot, ["README.md", "agent.md", "AGENT.md"], 3000);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 160);
  }
  return "Portable Agentlas cloud agent package.";
}
function cloudReadStableSlug(snapshot) {
  const manifest = cloudReadPackageJson(snapshot);
  return stringFirstCli(
    manifest.agentlas?.slug,
    manifest.agentlas?.id,
    manifest.manifest?.package,
    manifest.manifest?.slug,
    manifest.agentCard?.slug,
    manifest.agentCard?.id,
    manifest.routingCard?.agent_card_ref?.slug,
  );
}
function cloudReadPackageJson(snapshot) {
  return {
    agentlas: cloudReadSnapshotJson(snapshot, "agentlas.json"),
    manifest: cloudReadSnapshotJson(snapshot, "manifest.json"),
    agentCard: cloudReadSnapshotJson(snapshot, ".agentlas/agent-card.json"),
    routingCard: cloudReadSnapshotJson(snapshot, ".agentlas/routing-card.json"),
  };
}
function cloudReadSnapshotJson(snapshot, relativePath) {
  try {
    const parsed = JSON.parse(cloudReadSnapshotText(snapshot, relativePath));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function stringFirstCli(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
function cloudReadFirst(snapshot, names, maxChars) {
  for (const name of names) {
    const text = cloudReadSnapshotText(snapshot, name);
    if (text) return text.slice(0, maxChars);
  }
  return "";
}
function cloudReadSnapshotText(snapshot, relativePath) {
  const file = snapshot.get(relativePath);
  return file ? Buffer.from(file.contentBase64, "base64").toString("utf8") : "";
}
function cloudInferKind(snapshot) {
  const paths = [...snapshot.keys()];
  if (paths.some((file) => file === "TEAM.md" || file === "team.json" || /^(?:agents|team|departments|hr-departments)\//.test(file))) return "team";
  return "agent";
}
function cloudDetectRuntimeLabels(snapshot) {
  const paths = new Set(snapshot.keys());
  const labels = [];
  if (paths.has("CLAUDE.md") || [...paths].some((file) => file.startsWith(".claude/"))) labels.push("claude-code");
  if (paths.has("AGENTS.md")) labels.push("codex");
  if (paths.has("GEMINI.md")) labels.push("gemini");
  if (paths.has(".cursorrules") || [...paths].some((file) => file.startsWith(".cursor/"))) labels.push("cursor");
  return labels.length ? labels : ["generic"];
}
function cloudPackageDir(slug) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(userDataDir(), "cloud-agent-packages", `${slug}-${stamp}`);
}
function cloudPackageHashVersion(value) {
  if (value === undefined || value === null || value === "") return CLOUD_PACKAGE_HASH_V1;
  if (value === CLOUD_PACKAGE_HASH_V1 || value === CLOUD_PACKAGE_HASH_V2) return value;
  return null;
}
function cloudHashPackage(files, version = CLOUD_PACKAGE_HASH_V1) {
  const hashVersion = cloudPackageHashVersion(version);
  if (!hashVersion) throw new Error(`unsupported cloud package hash version: ${version}`);
  const h = crypto.createHash("sha256");
  // 서버 package-contract.ts와 바이트 동일해야 한다: 경로 코드포인트 순 정렬.
  // 정렬 없이 스캔 순서로 해시하면 대소문자 혼합 경로 패키지(AGENTS.md + agents/…)가
  // 전부 package_hash_mismatch로 거절된다(2026-07-02 근본 수정).
  for (const file of [...files].filter((file) => !cloudIsLocalExperienceLineagePath(file.path)).sort(cloudCodePointPathOrder)) {
    h.update(file.path);
    h.update("\0");
    h.update(file.sha256);
    h.update("\0");
    if (hashVersion === CLOUD_PACKAGE_HASH_V2) {
      h.update(file.executable ? "x" : "-");
      h.update("\0");
    }
  }
  return h.digest("hex");
}
function cloudCodePointPathOrder(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function cloudPortablePathKey(value) {
  return String(value).normalize("NFC").toLowerCase();
}
function cloudPortableRelativePath(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")) return null;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.endsWith("/")) return null;
  if (value.includes("//") || value.length > 260) return null;
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.length > 255 || Buffer.byteLength(part, "utf8") > 255 || cloudHasUnpairedSurrogate(part)) return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)) return null;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
  }
  return value;
}
function cloudHasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
function cloudPortablePathConflict(paths) {
  const files = new Map();
  const directories = new Map();
  for (const value of paths) {
    if (typeof value !== "string" || !value) continue;
    const fileKey = cloudPortablePathKey(value);
    const existingFile = files.get(fileKey);
    if (existingFile) {
      if (existingFile.path === value) {
        return { code: "duplicate-path", message: `Cloud package repeats file path ${JSON.stringify(value)}.` };
      }
      return { code: "path-alias-collision", message: `Cloud package paths ${JSON.stringify(existingFile.path)} and ${JSON.stringify(value)} alias after Unicode NFC normalization and case-folding.` };
    }
    files.set(fileKey, { path: value });
    const parts = value.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      const directoryKey = cloudPortablePathKey(directory);
      const existingDirectory = directories.get(directoryKey);
      if (existingDirectory && existingDirectory.directory !== directory) {
        return {
          code: "path-alias-collision",
          message: `Ancestor directories ${JSON.stringify(existingDirectory.directory)} (from ${JSON.stringify(existingDirectory.sourcePath)}) and ${JSON.stringify(directory)} (from ${JSON.stringify(value)}) alias after Unicode NFC normalization and case-folding.`,
        };
      }
      if (!existingDirectory) directories.set(directoryKey, { directory, sourcePath: value });
    }
  }
  for (const [key, file] of files) {
    const directory = directories.get(key);
    if (!directory) continue;
    if (file.path === directory.directory) {
      return { code: "path-type-collision", message: `Cloud package path ${JSON.stringify(file.path)} is both a file and an ancestor directory.` };
    }
    return {
      code: "path-alias-collision",
      message: `File path ${JSON.stringify(file.path)} aliases ancestor directory ${JSON.stringify(directory.directory)} from ${JSON.stringify(directory.sourcePath)} after Unicode NFC normalization and case-folding.`,
    };
  }
  return null;
}
function cloudReadRestoreExecutablePaths(rootPath) {
  if (process.platform !== "win32") return new Set();
  const marker = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (cloudPackageHashVersion(parsed.packageHashVersion) !== CLOUD_PACKAGE_HASH_V2) return new Set();
    if (!Array.isArray(parsed.executablePaths)) return new Set();
    return new Set(parsed.executablePaths
      .filter((value) => cloudPortableRelativePath(value))
      .map((value) => cloudPortablePathKey(value)));
  } catch {
    return new Set();
  }
}
function cloudPortableExecutableForFile(relativePath, statMode, restoredExecutablePaths, platform = process.platform) {
  if (platform === "win32") return restoredExecutablePaths.has(cloudPortablePathKey(relativePath));
  return Boolean(statMode & 0o111);
}
function cloudApplyPrivateDirectoryMode(directoryPath, platform = process.platform) {
  if (platform === "win32") return;
  fs.chmodSync(directoryPath, 0o700);
  const actual = fs.statSync(directoryPath).mode & 0o777;
  if (actual !== 0o700) throw new Error(`cloud restore directory mode verification failed: ${directoryPath}`);
}
function cloudApplyPortableFileMode(filePath, mode, platform = process.platform) {
  if (platform === "win32") return;
  fs.chmodSync(filePath, mode);
  const actual = fs.statSync(filePath).mode & 0o777;
  if (actual !== mode) throw new Error(`cloud restore file mode verification failed: ${filePath}`);
}
function cloudVerifyRestoredSnapshot(root, files, expected) {
  const expectedByPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set();
  function walk(dir) {
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("cloud restore staging contains an unsafe directory");
    if (process.platform !== "win32" && (dirStat.mode & 0o777) !== 0o700) throw new Error("cloud restore staging directory mode mismatch");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === CLOUD_RESTORE_MARKER_PATH) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("cloud restore staging contains a symbolic link");
      if (stat.isDirectory()) { walk(absolute); continue; }
      if (!stat.isFile()) throw new Error("cloud restore staging contains a special filesystem entry");
      const expectedFile = expectedByPath.get(relative);
      if (!expectedFile || seen.has(relative)) throw new Error(`cloud restore staging has an unexpected file: ${relative}`);
      const bytes = fs.readFileSync(absolute);
      if (bytes.length !== expectedFile.bytes || sha(bytes) !== expectedFile.sha256) {
        throw new Error(`cloud restore staging file integrity mismatch: ${relative}`);
      }
      if (process.platform !== "win32") {
        const mode = expected.packageHashVersion === CLOUD_PACKAGE_HASH_V2 && expectedFile.executable ? 0o700 : 0o600;
        if ((stat.mode & 0o777) !== mode) throw new Error(`cloud restore staging file mode mismatch: ${relative}`);
      }
      seen.add(relative);
    }
  }
  walk(root);
  if (seen.size !== expectedByPath.size) throw new Error("cloud restore staging is missing package files");
  const markerPath = path.join(root, CLOUD_RESTORE_MARKER_PATH);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("cloud restore marker is unsafe");
  if (process.platform !== "win32" && (markerStat.mode & 0o777) !== 0o600) throw new Error("cloud restore marker mode mismatch");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const expectedExecutablePaths = expected.packageHashVersion === CLOUD_PACKAGE_HASH_V2
    ? files.filter((file) => file.executable).map((file) => file.path).sort()
    : undefined;
  if (
    marker.schemaVersion !== 1 || marker.source !== "agentlas-cloud" || marker.slug !== expected.slug ||
    String(marker.packageHash).replace(/^sha256:/i, "").toLowerCase() !== expected.packageHash ||
    marker.packageHashVersion !== expected.packageHashVersion || marker.fileCount !== files.length ||
    marker.totalBytes !== expected.totalBytes || typeof marker.restoredAt !== "string" ||
    !Number.isFinite(Date.parse(marker.restoredAt)) ||
    JSON.stringify(marker.executablePaths) !== JSON.stringify(expectedExecutablePaths)
  ) {
    throw new Error("cloud restore marker contract mismatch");
  }
  if (expected.assetDescriptor) {
    const descriptor = normalizeCloudAssetDescriptorCli(marker, "cloud restore marker");
    const nested = normalizeCloudAssetDescriptorCli(marker.cloudAssets?.[descriptor.scope], "cloud restore marker scope");
    if (
      JSON.stringify(descriptor) !== JSON.stringify(expected.assetDescriptor) ||
      JSON.stringify(nested) !== JSON.stringify(expected.assetDescriptor)
    ) {
      throw new Error("cloud restore marker revision contract mismatch");
    }
  }
}
function cloudDecodeUtf16CredentialText(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)).toString("utf16le");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    body.swap16();
    return body.toString("utf16le");
  }
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (sampleLength < 8) return null;
  let oddNuls = 0;
  let evenNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNuls++;
    if (bytes[index + 1] === 0) oddNuls++;
  }
  const pairs = sampleLength / 2;
  const fullLength = bytes.length - (bytes.length % 2);
  if (oddNuls / pairs > 0.3) return bytes.subarray(0, fullLength).toString("utf16le");
  if (evenNuls / pairs > 0.3) {
    const body = Buffer.from(bytes.subarray(0, fullLength));
    body.swap16();
    return body.toString("utf16le");
  }
  return null;
}
function cloudDecodeTextAsset(bytes) {
  const utf16 = cloudDecodeUtf16CredentialText(bytes);
  if (utf16 !== null) return { ok: true, text: utf16 };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}
function cloudCredentialValueLooksReal(rawValue) {
  let value = String(rawValue || "").trim().replace(/^['"]|['"]$/g, "").trim();
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  if (value.length < 8) return false;
  if (/^(?:\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]+\}\}|<[^>]+>)$/i.test(value)) return false;
  if (/^(?:process\.env\.|os\.environ|env\(|secret\(|vault:)/i.test(value)) return false;
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (/^(?:your|example|sample|dummy|placeholder|configure|configureonthismachine|changeme|replaceme|replacewith|redacted|masked|notareal|none|null|undefined|x+|star+)(?:api)?(?:key|secret|token|password)?(?:here)?$/.test(compact)) return false;
  if (/^(?:\*+|x+|_+|-+)$/.test(value)) return false;
  return true;
}
function cloudTextContainsStructuredCredential(text) {
  const assignment = /(?:^|\n)\s*["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)["']?\s*[:=]\s*([^\r\n#;]+)/gi;
  for (const match of text.matchAll(assignment)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  const urlCredential = /\bhttps?:\/\/[^/\s:@]+:([^@\s/]{8,})@/gi;
  for (const match of text.matchAll(urlCredential)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  const queryCredential = /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password)=([^&#\s]+)/gi;
  for (const match of text.matchAll(queryCredential)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  return false;
}
function cloudAddSecretFindingsFromBytes(bytes, relativePath, addFinding) {
  const candidates = new Set([bytes.toString("utf8")]);
  const utf16 = cloudDecodeUtf16CredentialText(bytes);
  if (utf16) candidates.add(utf16);
  for (const text of candidates) {
    for (const [id, re, label] of CLOUD_SECRET_RE) {
      if (re.test(text)) addFinding(id, "blocker", "secret", `Possible ${label} found in package content.`, relativePath, "Remove the value and require users to configure their own key.");
    }
    if (cloudTextContainsStructuredCredential(text)) {
      addFinding("generic-unquoted-secret", "blocker", "secret", "Possible unquoted or URL-embedded credential found in package content.", relativePath, "Replace the value with an environment/BYOK placeholder.");
    }
  }
}
function cloudCanonicalBase64(value) {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
function cloudSecuritySummary(findings) {
  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  return { verdict: blockerCount ? "fail" : highCount ? "needs-review" : "pass", blockerCount, highCount, findingCount: findings.length };
}
function parseCloudReviewJson(text) {
  const candidate = String(text || "").match(/\{[\s\S]*\}/);
  if (!candidate) return { verdict: "needs-review", summary: "Local runtime returned non-JSON review output.", findings: [{ severity: "medium", category: "review", message: "Review output could not be parsed as strict JSON." }] };
  try {
    const parsed = JSON.parse(candidate[0]);
    return { verdict: parsed.verdict, summary: parsed.summary, findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
  } catch {
    return { verdict: "needs-review", summary: "Local runtime returned invalid JSON.", findings: [{ severity: "medium", category: "review", message: "Review output could not be parsed as strict JSON." }] };
  }
}
function normalizeCloudSeverity(value) {
  return ["blocker", "high", "medium", "low", "info"].includes(value) ? value : "medium";
}
function normalizeCloudCategory(value) {
  return ["secret", "policy", "size", "structure", "runtime", "network", "review"].includes(value) ? value : "review";
}
function cloudSlug(value) {
  return (String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agentlas-cloud-agent");
}
function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ── Agentlas 아키텍처 (앱과 동일한 빌트인 에이전트 + 메모리) ────────────
// cli/architecture.data.json은 컴파일된 manifest에서 생성됨(scripts/gen-cli-architecture.mjs).
let _arch = null;
function loadArch() {
  if (_arch) return _arch;
  try {
    _arch = require("./architecture.data.json");
  } catch {
    _arch = { version: "0", agents: [], emitterBlock: "", eventsHeading: "## Memory Events", memoryDir: ".agentlas", soulFile: "project-soul-memory.md", sitemapFile: "sitemap.json", logFile: "memory-log.jsonl", careerGraphConfigFile: "career-graph.json", careerGraphSourceManifestFile: "career-graph-sources.json", careerGraphInboxDir: "career-graph-inbox", careerGraphDbFile: "career-graph.sqlite", kinds: [], scopes: [] };
  }
  return _arch;
}
function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}
function columnExists(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
}
function ensureMemoryContextColumn(db) {
  try {
    if (tableExists(db, "memory_entries") && !columnExists(db, "memory_entries", "context_json")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  } catch { /* ignore */ }
}
// 앱의 seedBuiltinAgents와 동일한 멱등·버전 게이팅 로직(CJS 버전). 스키마가 아직 v12가 아니면
// (= 앱이 마이그레이션 전) 건너뜀 — 앱을 한 번 켜면 마이그레이션+시드가 수행된다.
function seedBuiltins(db) {
  const arch = loadArch();
  if (!arch.agents || !arch.agents.length) return;
  if (!tableExists(db, "meta") || !columnExists(db, "installed_agents", "builtin")) return;
  let installedVersion = null;
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key='architecture_version'").get();
    installedVersion = r ? r.value : null;
  } catch { return; }
  if (installedVersion === arch.version) {
    try {
      const have = db.prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE builtin=1").get();
      if (have.n >= arch.agents.length) return;
    } catch { /* fallthrough */ }
  }
  const now = new Date().toISOString();
  try {
    const tx = db.transaction(() => {
      const hasVisibility = columnExists(db, "installed_agents", "visibility");
      for (const def of arch.agents) {
        const visibility = def.visibility || "background";
        const existing = db.prepare("SELECT id FROM installed_agents WHERE id=? OR slug=?").get(def.id, def.slug);
        if (existing) {
          if (hasVisibility) {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A', visibility=? WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, visibility, existing.id);
          } else {
            db.prepare(
              "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A' WHERE id=?",
            ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, existing.id);
          }
        } else {
          if (hasVisibility) {
            db.prepare(
              "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?,?)",
            ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role, visibility);
          } else {
            db.prepare(
              "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?)",
            ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role);
          }
        }
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('architecture_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(arch.version);
    });
    tx();
  } catch { /* best-effort */ }
}

const SECRET_RE = [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i];

function localCredentialConfigCli(arch) {
  return {
    mapFile: arch.localCredentialsMapFile || "local-credentials.map.json",
    envExampleFile: arch.projectEnvExampleFile || ".env.example",
    signingDir: arch.projectSigningDir || "signing",
    credentialsDir: arch.projectCredentialsDir || "credentials",
    readmeFile: arch.projectCredentialsReadmeFile || "README.md",
  };
}
function projectEnvIdCli(projectPath) {
  const raw = path.basename(projectPath || runCwd() || "project") || "project";
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROJECT";
}
function projectScopedGlobalEnvKeyCli(projectPath, key) {
  return `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_${key}`;
}
function projectScopedEnvValuesCli(values, projectPath) {
  const prefix = `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_`;
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(prefix)) continue;
    const actualKey = key.slice(prefix.length);
    if (/^[A-Z][A-Z0-9_]*$/.test(actualKey)) result[actualKey] = value;
  }
  return result;
}
function localCredentialsMapSkeletonCli(projectPath, projectName, cfg) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    kind: "agentlas-local-credential-store",
    projectName,
    projectRoot: projectPath,
    createdAt: now,
    updatedAt: now,
    envFiles: [".env", ".env.local"],
    secretDirs: [cfg.signingDir, cfg.credentialsDir],
    entries: [],
  };
}
const CREDENTIAL_INDEX_SECTION_CLI = "## Local Credential Index (read first)";
function credentialIndexSectionContentCli(arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const mapFile = (arch && arch.localCredentialsMapFile) || "local-credentials.map.json";
  return `${CREDENTIAL_INDEX_SECTION_CLI}

- For deploy, release, store, billing, auth, API, or cloud work, read
  .agentlas/${mapFile} before saying a credential is missing.
- Real values may live in .env, .env.local, ${cfg.signingDir}/,
  ${cfg.credentialsDir}/, local keychain/vault, or project-scoped global env
  keys like AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME>.
- Keep this memory value-free: record env names, local relative paths, owner,
  stale-check notes, and validation commands only.

| Need | Look here first | Memory record |
|------|-----------------|---------------|
| Scalar env key | .env or .env.local | env name only |
| Store/signing file | ${cfg.signingDir}/ | relative path only |
| App/provider config | ${cfg.credentialsDir}/ | relative path only |
| Shared local env | AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME> | project-scoped env name |
`;
}
function projectSoulTemplateCli(projectName, arch) {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by Agentlas.

${credentialIndexSectionContentCli(arch)}

## Project Purpose

## Current State

## Decisions

## Risks

## Auto-curated memory
`;
}
function ensureSoulCredentialIndexCli(projectPath, projectName, arch) {
  const memoryDir = (arch && arch.memoryDir) || ".agentlas";
  const soulFile = (arch && arch.soulFile) || "project-soul-memory.md";
  const dir = path.join(projectPath, memoryDir);
  const soul = path.join(dir, soulFile);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(soul)) {
    fs.writeFileSync(soul, projectSoulTemplateCli(projectName, arch), "utf8");
    return soul;
  }
  let content = "";
  try { content = fs.readFileSync(soul, "utf8"); } catch { content = ""; }
  if (!content.includes(CREDENTIAL_INDEX_SECTION_CLI)) {
    const section = credentialIndexSectionContentCli(arch);
    const marker = "\n## Project Purpose";
    const next = content.includes(marker)
      ? content.replace(marker, `\n${section}\n## Project Purpose`)
      : `${content.trimEnd()}\n\n${section}\n`;
    fs.writeFileSync(soul, next.endsWith("\n") ? next : next + "\n", "utf8");
  }
  return soul;
}
function envExampleContentCli(cfg) {
  return `# Agentlas local project environment.
# Copy this file to .env and fill real values only on this machine.

# File-path style for tools that expect a local JSON credential file.
SUPPLY_JSON_KEY=${cfg.signingDir}/google-play.json

# Inline JSON style for tools that support reading a credential directly from env.
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
`;
}
function signingReadmeContentCli(cfg) {
  return `# ${cfg.signingDir}/

Put release signing material here when this project needs local deploy or store
automation. This folder is ignored by git except for this README.

Examples:

- Google Play release JSON used by SUPPLY_JSON_KEY
- Apple signing certificates or provisioning profiles
- Notarization or release upload keys

Do not commit files from this folder.
`;
}
function credentialsReadmeContentCli(cfg) {
  return `# ${cfg.credentialsDir}/

Put app or service configuration files here when this project needs local runtime
access. This folder is ignored by git except for this README.

Examples:

- Android google-services.json
- iOS GoogleService-Info.plist
- provider config files used only by this local project

Do not commit files from this folder.
`;
}
function ensureAgentlasCredentialIgnoreCli(projectPath, cfg) {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const marker = "# Agentlas local credentials";
  const block = `${marker}
.env
.env.local
.env.*.local
._*
${cfg.signingDir}/*
!${cfg.signingDir}/
!${cfg.signingDir}/${cfg.readmeFile}
${cfg.credentialsDir}/*
!${cfg.credentialsDir}/
!${cfg.credentialsDir}/${cfg.readmeFile}
`;
  let existing = "";
  try { existing = fs.readFileSync(gitignorePath, "utf8"); } catch { existing = ""; }
  if (existing.includes(marker)) {
    if (!/^\._\*$/m.test(existing)) fs.writeFileSync(gitignorePath, `${existing.trimEnd()}\n._*\n`, "utf8");
    return;
  }
  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  fs.writeFileSync(gitignorePath, next.endsWith("\n") ? next : next + "\n", "utf8");
}
function ensureLocalCredentialStoreCli(projectPath, projectName, arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const dir = path.join(projectPath, (arch && arch.memoryDir) || ".agentlas");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.signingDir), { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.credentialsDir), { recursive: true });
  const envExample = path.join(projectPath, cfg.envExampleFile);
  if (!fs.existsSync(envExample)) fs.writeFileSync(envExample, envExampleContentCli(cfg), "utf8");
  const signingReadme = path.join(projectPath, cfg.signingDir, cfg.readmeFile);
  if (!fs.existsSync(signingReadme)) fs.writeFileSync(signingReadme, signingReadmeContentCli(cfg), "utf8");
  const credentialsReadme = path.join(projectPath, cfg.credentialsDir, cfg.readmeFile);
  if (!fs.existsSync(credentialsReadme)) fs.writeFileSync(credentialsReadme, credentialsReadmeContentCli(cfg), "utf8");
  const mapPath = path.join(dir, cfg.mapFile);
  if (!fs.existsSync(mapPath)) {
    fs.writeFileSync(mapPath, JSON.stringify(localCredentialsMapSkeletonCli(projectPath, projectName, cfg), null, 2) + "\n", "utf8");
  }
  ensureAgentlasCredentialIgnoreCli(projectPath, cfg);
  return { cfg, mapPath };
}
function readJsonObjectCli(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function upsertLocalCredentialMapCli(projectPath, projectName, arch, entry) {
  const { cfg, mapPath } = ensureLocalCredentialStoreCli(projectPath, projectName, arch || loadArch());
  const data = readJsonObjectCli(mapPath, localCredentialsMapSkeletonCli(projectPath, projectName, cfg));
  const now = new Date().toISOString();
  data.updatedAt = now;
  if (!Array.isArray(data.entries)) data.entries = [];
  const id = entry.id || `${entry.provider || "credential"}:${(entry.env || []).join(",") || (entry.localFiles || []).join(",")}`;
  const clean = {
    id,
    provider: entry.provider || "unknown",
    env: Array.isArray(entry.env) ? [...new Set(entry.env.filter(Boolean))] : [],
    localFiles: Array.isArray(entry.localFiles) ? [...new Set(entry.localFiles.filter(Boolean))] : [],
    owner: entry.owner || "project",
    valueMaterialized: Boolean(entry.valueMaterialized),
    storage: Array.isArray(entry.storage) ? [...new Set(entry.storage.filter(Boolean))] : [],
    requiredFor: Array.isArray(entry.requiredFor) ? [...new Set(entry.requiredFor.filter(Boolean))] : [],
    lastVerified: entry.lastVerified || null,
    staleCheck: entry.staleCheck || null,
    updatedAt: now,
  };
  const idx = data.entries.findIndex((row) => row && row.id === id);
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...clean };
  else data.entries.push(clean);
  fs.writeFileSync(mapPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function safeCredentialDestRelCli(destRel) {
  const rel = path.normalize(String(destRel || "")).replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || rel === "." || rel.startsWith("../") || rel.includes("\0")) {
    fail("credential destination must be a relative path inside the project");
  }
  return rel;
}

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    ensureLocalCredentialStoreCli(projectPath, name, arch);
    ensureSoulCredentialIndexCli(projectPath, name, arch);
    const sitemap = path.join(dir, arch.sitemapFile);
    if (!fs.existsSync(sitemap)) {
      const now = new Date().toISOString();
      fs.writeFileSync(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2), "utf8");
    }
    const skillRegistryFile = arch.skillRegistryFile || "skill-registry.json";
    const skillTrialsFile = arch.skillTrialsFile || "skill-trials.jsonl";
    const curatorDecisionsFile = arch.curatorDecisionsFile || "curator-decisions.jsonl";
    const ontologyRuntimeFile = arch.ontologyRuntimeFile || "ontology-runtime.json";
    const ontologySourceManifestFile = arch.ontologySourceManifestFile || "ontology-sources.json";
    const ontologyInboxDir = arch.ontologyInboxDir || "ontology-inbox";
    const ontologyDbFile = arch.ontologyDbFile || "ontology-runtime.sqlite";
    const careerGraphConfigFile = arch.careerGraphConfigFile || "career-graph.json";
    const careerGraphSourceManifestFile = arch.careerGraphSourceManifestFile || "career-graph-sources.json";
    const careerGraphInboxDir = arch.careerGraphInboxDir || "career-graph-inbox";
    const careerGraphDbFile = arch.careerGraphDbFile || "career-graph.sqlite";
    const superOntologyContractFile = arch.superOntologyContractFile || "super-ontology-contract.json";
    const superOntologyOpenWorldCoverageFile =
      arch.superOntologyOpenWorldCoverageFile || "super-ontology-open-world-coverage.json";
    const superOntologyConsensusCoordinationFile =
      arch.superOntologyConsensusCoordinationFile || "super-ontology-consensus-coordination.json";
    const superOntologyTaskCoverageFile = arch.superOntologyTaskCoverageFile || "super-ontology-task-coverage.json";
    const superOntologyAssuranceCaseFile = arch.superOntologyAssuranceCaseFile || "super-ontology-assurance-case.json";
    const superOntologyContextualFlowFile = arch.superOntologyContextualFlowFile || "super-ontology-contextual-flow.json";
    const superOntologyCausalImpactFile = arch.superOntologyCausalImpactFile || "super-ontology-causal-impact.json";
    const superOntologyKnowledgeHomeostasisFile =
      arch.superOntologyKnowledgeHomeostasisFile || "super-ontology-knowledge-homeostasis.json";
    const superOntologyAdversarialProvenanceFile =
      arch.superOntologyAdversarialProvenanceFile || "super-ontology-adversarial-provenance.json";
    const superOntologyEpistemicCalibrationFile =
      arch.superOntologyEpistemicCalibrationFile || "super-ontology-epistemic-calibration.json";
    const superOntologySemanticAlignmentFile =
      arch.superOntologySemanticAlignmentFile || "super-ontology-semantic-alignment.json";
    const superOntologyResilienceControlFile =
      arch.superOntologyResilienceControlFile || "super-ontology-resilience-control.json";
    const superOntologyInvariantVerificationFile =
      arch.superOntologyInvariantVerificationFile || "super-ontology-invariant-verification.json";
    const superOntologyObservabilityTelemetryFile =
      arch.superOntologyObservabilityTelemetryFile || "super-ontology-observability-telemetry.json";
    const superOntologyObjectiveProxyValidityFile =
      arch.superOntologyObjectiveProxyValidityFile || "super-ontology-objective-proxy-validity.json";
    const superOntologyStakeholderPreferenceGovernanceFile =
      arch.superOntologyStakeholderPreferenceGovernanceFile ||
      "super-ontology-stakeholder-preference-governance.json";
    const superOntologyNormativeAuthorityDriftFile =
      arch.superOntologyNormativeAuthorityDriftFile ||
      "super-ontology-normative-authority-drift.json";
    const superOntologySideEffectContainmentFile =
      arch.superOntologySideEffectContainmentFile ||
      "super-ontology-side-effect-containment.json";
    const superOntologySourceLineageVersionFile =
      arch.superOntologySourceLineageVersionFile ||
      "super-ontology-source-lineage-version.json";
    const superOntologyEntityIdentityResolutionFile =
      arch.superOntologyEntityIdentityResolutionFile ||
      "super-ontology-entity-identity-resolution.json";
    const superOntologyTemporalStateTransitionFile =
      arch.superOntologyTemporalStateTransitionFile ||
      "super-ontology-temporal-state-transition.json";
    const superOntologyCapabilityDelegationAuthorityFile =
      arch.superOntologyCapabilityDelegationAuthorityFile ||
      "super-ontology-capability-delegation-authority.json";
    const superOntologyPrivacyConfidentialityBoundaryFile =
      arch.superOntologyPrivacyConfidentialityBoundaryFile ||
      "super-ontology-privacy-confidentiality-boundary.json";
    const superOntologyStrategicIncentiveCompatibilityFile =
      arch.superOntologyStrategicIncentiveCompatibilityFile ||
      "super-ontology-strategic-incentive-compatibility.json";
    const superOntologyReflexiveFeedbackStabilityFile =
      arch.superOntologyReflexiveFeedbackStabilityFile ||
      "super-ontology-reflexive-feedback-stability.json";
    const superOntologyReplaysFile = arch.superOntologyReplaysFile || "super-ontology-replays.jsonl";
    const superOntologyEvidenceFile = arch.superOntologyEvidenceFile || "super-ontology-evidence.jsonl";
    const superOntologyMemoryBridgeFile = arch.superOntologyMemoryBridgeFile || "super-ontology-memory-bridge.jsonl";
    const skillRegistry = path.join(dir, skillRegistryFile);
    if (!fs.existsSync(skillRegistry)) {
      fs.writeFileSync(skillRegistry, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-skill-lifecycle-registry",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        defaultTier: "candidate",
        runtimeFirstClassRecallEnabled: false,
        predicatesRequired: true,
        curatorQuarantineRequired: true,
        evidenceLedgers: {
          trials: `.agentlas/${skillTrialsFile}`,
          curatorDecisions: `.agentlas/${curatorDecisionsFile}`,
          memoryEvents: `.agentlas/${arch.logFile}`,
        },
        hardStops: [
          "permission_change",
          "credential_change",
          "payment_or_billing_effect",
          "regulated_or_irreversible_side_effect",
          "same_authority_patch_and_validator",
          "holdout_contamination",
          "missing_rollback_snapshot",
        ],
        effectiveErrorBudgetTerms: [
          "first_class_error_mass",
          "quarantine_false_accept_estimate",
          "blind_spot_estimate",
          "drift_estimate",
        ],
        niches: [],
        skills: [],
        rolloutPolicy: {
          staticOnlyCanApprove: false,
          sandboxRequired: true,
          holdoutRequired: true,
          shadowRequiredForFastPathChanges: true,
          lowRiskCanaryOnly: true,
          severeFailureTolerance: 0,
        },
      }, null, 2), "utf8");
    }
    const ontologyInbox = path.join(dir, ontologyInboxDir);
    if (!fs.existsSync(ontologyInbox)) fs.mkdirSync(ontologyInbox, { recursive: true });
    const ontologyRuntime = path.join(dir, ontologyRuntimeFile);
    if (!fs.existsSync(ontologyRuntime)) {
      fs.writeFileSync(ontologyRuntime, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-runtime",
        state: "active",
        activation: "automatic",
        projectRoot: projectPath,
        projectName: name,
        dbPath: path.join(dir, ontologyDbFile),
        inboxPath: ontologyInbox,
        sourceManifest: path.join(dir, ontologySourceManifestFile),
        defaultScope: "internal",
        autoIngestPolicy: {
          mode: "inbox_and_registered_sources_only",
          neverScanHomeDirectory: true,
          neverScanSiblingProjects: true,
          crossProjectSearchDefault: "disabled",
          privateScopeDefaultSearch: "excluded",
        },
        promotionMode: {
          operatorManagedLocal: true,
          securityGateMode: "context_folder_routing_only",
          blockingSecurityGate: false,
          notes: "Local promotion is blocked by missing project/folder/owner/evidence/rollback structure, not by a generic security gate.",
        },
        memoryPolicy: {
          durableWrites: "candidate-ticket-only",
          workingMemory: "runtime-cache-only",
        },
      }, null, 2), "utf8");
    }
    const ontologySources = path.join(dir, ontologySourceManifestFile);
    if (!fs.existsSync(ontologySources)) {
      fs.writeFileSync(ontologySources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-source-manifest",
        projectRoot: projectPath,
        sources: [],
      }, null, 2), "utf8");
    }
    const careerGraphInbox = path.join(dir, careerGraphInboxDir);
    if (!fs.existsSync(careerGraphInbox)) fs.mkdirSync(careerGraphInbox, { recursive: true });
    const careerGraphConfig = path.join(dir, careerGraphConfigFile);
    if (!fs.existsSync(careerGraphConfig)) {
      fs.writeFileSync(careerGraphConfig, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph",
        state: "active",
        model: "ledger_first_derived_index",
        projectRoot: projectPath,
        projectName: name,
        dbPath: path.join(dir, careerGraphDbFile),
        inboxPath: careerGraphInbox,
        sourceManifest: path.join(dir, careerGraphSourceManifestFile),
        canonicalSourcePolicy: {
          sourceOfTruth: "markdown_jsonl_json",
          graphIsRebuildable: true,
          fallbackWhenStale: "read_canonical_files",
          neverScanHomeDirectory: true,
          neverScanSiblingProjects: true,
        },
      }, null, 2), "utf8");
    }
    const careerGraphSources = path.join(dir, careerGraphSourceManifestFile);
    if (!fs.existsSync(careerGraphSources)) {
      fs.writeFileSync(careerGraphSources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph-source-manifest",
        projectRoot: projectPath,
        sources: [],
      }, null, 2), "utf8");
    }
    for (const fileName of [skillTrialsFile, curatorDecisionsFile]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    const superOntologyContract = path.join(dir, superOntologyContractFile);
    if (!fs.existsSync(superOntologyContract)) {
      fs.writeFileSync(superOntologyContract, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-contract",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimeGraphWriteEnabled: false,
        zeroErrorClaim: false,
        operatorManagedPromotion: {
          enabled: true,
          runtimePromotionModel: "operator_managed_local",
          securityGateMode: "context_folder_routing_only",
          blockingSecurityGate: false,
          requiredBeforePromotion: [
            "project_root",
            "source_folder",
            "owner",
            "evidence_refs",
            "rollback_or_replay_path",
          ],
          publicExportRemainsValueFree: true,
          notes: "Local operators may promote when structure and ownership are explicit. Security labels are routing metadata, not a generic runtime stop sign.",
        },
        layers: [
          "source_intake",
          "evidence_packet",
          "belief_ledger",
          "knowledge_capsule",
          "affordance_action_binding",
          "agentlas_integration_contract",
          "memory_curator_bridge",
          "open_world_coverage_contract",
          "consensus_coordination_contract",
          "task_coverage_contract",
          "contextual_flow_contract",
          "causal_impact_contract",
          "assurance_case_contract",
          "knowledge_homeostasis_contract",
          "adversarial_provenance_contract",
          "epistemic_calibration_contract",
          "semantic_alignment_contract",
          "resilience_control_contract",
          "invariant_verification_contract",
          "observability_telemetry_contract",
          "objective_proxy_validity_contract",
          "stakeholder_preference_governance_contract",
          "normative_authority_drift_contract",
          "side_effect_containment_contract",
          "source_lineage_version_contract",
          "entity_identity_resolution_contract",
          "temporal_state_transition_contract",
          "capability_delegation_authority_contract",
          "privacy_confidentiality_boundary_contract",
          "strategic_incentive_compatibility_contract",
          "reflexive_feedback_stability_contract",
          "promotion_readiness",
          "promotion_replay_drill",
          "architecture_sync_review",
        ],
        evidenceLedgers: {
          replays: `.agentlas/${superOntologyReplaysFile}`,
          promotionEvidence: `.agentlas/${superOntologyEvidenceFile}`,
          memoryTickets: `.agentlas/${arch.logFile}`,
          memoryCuratorBridge: `.agentlas/${superOntologyMemoryBridgeFile}`,
          openWorldCoverage: `.agentlas/${superOntologyOpenWorldCoverageFile}`,
          consensusCoordination: `.agentlas/${superOntologyConsensusCoordinationFile}`,
          taskCoverage: `.agentlas/${superOntologyTaskCoverageFile}`,
          contextualFlow: `.agentlas/${superOntologyContextualFlowFile}`,
          causalImpact: `.agentlas/${superOntologyCausalImpactFile}`,
          assuranceCase: `.agentlas/${superOntologyAssuranceCaseFile}`,
          knowledgeHomeostasis: `.agentlas/${superOntologyKnowledgeHomeostasisFile}`,
          adversarialProvenance: `.agentlas/${superOntologyAdversarialProvenanceFile}`,
          epistemicCalibration: `.agentlas/${superOntologyEpistemicCalibrationFile}`,
          semanticAlignment: `.agentlas/${superOntologySemanticAlignmentFile}`,
          resilienceControl: `.agentlas/${superOntologyResilienceControlFile}`,
          invariantVerification: `.agentlas/${superOntologyInvariantVerificationFile}`,
          observabilityTelemetry: `.agentlas/${superOntologyObservabilityTelemetryFile}`,
          objectiveProxyValidity: `.agentlas/${superOntologyObjectiveProxyValidityFile}`,
          stakeholderPreferenceGovernance: `.agentlas/${superOntologyStakeholderPreferenceGovernanceFile}`,
          normativeAuthorityDrift: `.agentlas/${superOntologyNormativeAuthorityDriftFile}`,
          sideEffectContainment: `.agentlas/${superOntologySideEffectContainmentFile}`,
          sourceLineageVersion: `.agentlas/${superOntologySourceLineageVersionFile}`,
          entityIdentityResolution: `.agentlas/${superOntologyEntityIdentityResolutionFile}`,
          temporalStateTransition: `.agentlas/${superOntologyTemporalStateTransitionFile}`,
          capabilityDelegationAuthority: `.agentlas/${superOntologyCapabilityDelegationAuthorityFile}`,
          privacyConfidentialityBoundary: `.agentlas/${superOntologyPrivacyConfidentialityBoundaryFile}`,
          strategicIncentiveCompatibility: `.agentlas/${superOntologyStrategicIncentiveCompatibilityFile}`,
          reflexiveFeedbackStability: `.agentlas/${superOntologyReflexiveFeedbackStabilityFile}`,
        },
        hardStops: [
          "zero_error_claim",
          "raw_source_to_graph_write",
          "forbidden_context_join",
          "whole_graph_exposure",
          "tool_authority_without_provenance",
          "missing_open_world_coverage_contract",
          "proposal_example_equals_all_tasks",
          "unknown_combination_to_runtime_write",
          "untested_modality_to_memory_write",
          "implicit_degradation_as_complete_data",
          "adversarial_source_as_authority",
          "forbidden_authority_to_action",
          "missing_consensus_coordination_contract",
          "agent_agreement_as_truth",
          "majority_vote_as_write_authority",
          "debate_stability_as_proof",
          "model_judge_as_final_evidence",
          "distributed_replica_merge_without_review",
          "route_sync_without_quorum",
          "last_writer_wins_architecture_update",
          "peer_pressure_to_memory_write",
          "validator_disagreement_to_release",
          "appbridge_source_of_truth_write",
          "missing_rollback",
          "missing_shadow_or_canary_evidence",
          "missing_memory_curator_bridge",
          "missing_task_coverage_contract",
          "missing_contextual_flow_contract",
          "forbidden_context_flow",
          "missing_causal_impact_contract",
          "missing_assurance_case_contract",
          "missing_knowledge_homeostasis_contract",
          "error_budget_overrun_continues",
          "critical_homeostasis_runtime_write",
          "privacy_incident_public_export",
          "missing_adversarial_provenance_contract",
          "prompt_injection_as_instruction",
          "forged_provenance_as_trusted_source",
          "poisoned_source_to_memory",
          "tool_output_tampering_to_action",
          "stale_trusted_source_replay_as_current_truth",
          "missing_epistemic_calibration_contract",
          "uncalibrated_confidence_to_answer",
          "unknown_state_to_runtime_write",
          "conflicting_sources_as_current_truth",
          "low_retrieval_relevance_as_confident_answer",
          "wide_judge_interval_to_regulated_answer",
          "missing_semantic_alignment_contract",
          "same_label_as_same_meaning",
          "embedding_similarity_as_exact_match",
          "close_match_as_transitive_truth",
          "generated_label_as_ontology_class",
          "appbridge_route_as_source_ontology_edit",
          "same_individual_without_stable_identifier",
          "unit_label_without_unit_compatibility",
          "source_conflict_to_memory_merge",
          "no_match_promoted_to_weak_match",
          "missing_resilience_control_contract",
          "validator_disagreement_to_graph_write",
          "retrieval_drift_to_current_answer",
          "semantic_regression_to_memory_merge",
          "curator_backlog_to_direct_memory_write",
          "tool_error_spike_to_unbounded_retry",
          "sync_drift_to_release_surface",
          "degraded_parser_to_ontology_class",
          "emergency_stop_bypass_by_route",
          "missing_invariant_verification_contract",
          "memory_write_without_ticket_invariant",
          "graph_write_without_evidence_invariant",
          "tool_action_without_authority_invariant",
          "public_export_without_flow_invariant",
          "route_sync_without_source_contract_invariant",
          "rollback_not_observed_after_violation",
          "emergency_stop_transition_bypassed",
          "unordered_multi_agent_write",
          "non_idempotent_replay_mutation",
          "missing_observability_telemetry_contract",
          "write_without_trace_id",
          "memory_ticket_without_span_lineage",
          "tool_action_without_audit_receipt",
          "public_export_with_stale_metric",
          "route_sync_without_correlation_id",
          "release_seed_when_audit_sink_down",
          "redaction_missing_in_telemetry",
          "metric_green_without_sample_size",
          "alert_suppressed_during_degraded_mode",
          "shadow_replay_not_recorded",
          "repair_without_before_after_snapshot",
          "rollback_without_observed_event",
          "unobservable_runtime_write",
          "missing_objective_proxy_validity_contract",
          "metric_improvement_as_goal_completion",
          "approval_rate_as_trust",
          "benchmark_score_as_reliability",
          "test_pass_rate_as_maintainability",
          "open_rate_as_customer_value",
          "self_judge_score_as_truth",
          "edge_count_as_knowledge_quality",
          "short_term_profit_as_compliance",
          "cost_per_execution_as_sustainability",
          "reward_score_as_quality",
          "label_leakage_as_accuracy",
          "green_dashboard_as_health",
          "proxy_optimization_without_countermetric",
          "optimization_without_stakeholder_map",
          "metric_gaming_without_probe",
          "reward_tampering_to_promotion",
          "construct_underdefined_to_runtime_write",
          "unvalidated_proxy_to_public_release",
          "missing_stakeholder_preference_governance_contract",
          "single_stakeholder_preference_as_global_goal",
          "owner_preference_as_all_stakeholders",
          "majority_preference_as_rights_clearance",
          "average_utility_over_protected_constraint",
          "hidden_affected_party",
          "missing_appeal_path",
          "missing_dissent_capture",
          "strategic_preference_report_as_truth",
          "preference_aggregation_without_rule",
          "preference_conflict_to_runtime_write",
          "consent_absent_to_personalization",
          "minority_harm_hidden_by_aggregate",
          "irreversible_action_without_stakeholder_review",
          "private_preference_to_public_release",
          "cross_context_preference_reuse_without_scope",
          "role_power_as_legitimacy",
          "arrow_impossibility_ignored",
          "manipulable_vote_as_stable_preference",
          "stakeholder_map_missing_for_release",
          "missing_normative_authority_drift_contract",
          "stale_policy_as_current_rule",
          "wrong_jurisdiction_as_valid_policy",
          "draft_policy_as_enforced_rule",
          "superseded_contract_as_current_authority",
          "terms_of_service_without_effective_date",
          "local_custom_as_global_policy",
          "internal_preference_as_legal_requirement",
          "policy_exception_without_owner",
          "conflicting_authorities_without_precedence",
          "regulation_summary_as_primary_law",
          "compliance_claim_without_citation",
          "policy_translation_as_authoritative_text",
          "expired_consent_as_current_permission",
          "missing_retention_or_deletion_rule",
          "cross_border_transfer_without_jurisdiction",
          "licensing_constraint_ignored",
          "audit_requirement_missing_before_release",
          "emergency_exception_without_expiry",
          "legal_advice_without_review",
          "missing_side_effect_containment_contract",
          "read_permission_as_write_permission",
          "preview_as_send",
          "dry_run_result_as_committed",
          "non_idempotent_retry_to_external_action",
          "irreversible_action_without_human_approval",
          "deletion_without_recovery_plan",
          "payment_without_idempotency_key",
          "customer_message_without_review",
          "release_without_rollback",
          "connector_write_without_scope",
          "cross_tool_chain_without_transaction",
          "compensation_plan_missing",
          "blast_radius_unknown",
          "idempotency_key_missing",
          "external_commit_without_receipt",
          "partial_failure_without_saga_state",
          "physical_action_without_safety_interlock",
          "scheduled_action_without_cancellation",
          "side_effect_logging_missing",
          "hosted_tool_without_local_side_effect_wrapper",
          "missing_source_lineage_version_contract",
          "filename_as_version",
          "latest_folder_as_current_source",
          "pdf_export_as_primary_source",
          "summary_as_primary_source",
          "ocr_text_without_source_span",
          "spreadsheet_sheet_without_workbook_revision",
          "email_attachment_without_message_context",
          "duplicate_title_as_same_artifact",
          "checksum_missing_for_authoritative_source",
          "stale_cache_as_current_record",
          "connector_snapshot_without_capture_time",
          "transitive_derivation_as_primary_source",
          "merged_record_without_parent_refs",
          "redacted_copy_as_complete_source",
          "translation_as_authoritative_source",
          "chunk_without_source_span",
          "embedding_hit_without_artifact_version",
          "memory_fact_without_lineage",
          "public_export_without_lineage_evidence",
          "training_example_without_dataset_version",
          "graph_edge_without_derivation_chain",
          "superseded_source_to_runtime_write",
          "lineage_cycle_unresolved",
          "missing_entity_identity_resolution_contract",
          "name_as_identity",
          "email_domain_as_company",
          "fuzzy_match_as_merge",
          "embedding_cluster_as_identity",
          "llm_canonical_name_as_id",
          "crm_id_cross_tenant_merge",
          "recycled_employee_id_as_same_person",
          "redacted_name_as_public_identity",
          "stale_alias_as_current_entity",
          "relationship_edge_without_identity_evidence",
          "memory_note_as_identity_authority",
          "missing_temporal_state_transition_contract",
          "current_snapshot_as_truth",
          "missing_valid_time",
          "missing_transaction_time",
          "local_timestamp_as_global_order",
          "spreadsheet_order_as_event_order",
          "llm_summary_as_event_log",
          "late_event_ignored",
          "retroactive_correction_without_tx_history",
          "future_effective_as_current",
          "expired_state_as_active",
          "deleted_state_without_tombstone",
          "non_idempotent_replay",
          "materialized_view_as_source_of_truth",
          "projection_without_version",
          "recurring_event_without_rule",
          "timezone_free_deadline",
          "state_transition_without_precondition",
          "partial_failure_as_success",
          "clock_skew_as_fact",
          "scheduled_job_without_receipt",
          "memory_fact_without_validity_interval",
          "graph_edge_without_temporal_bounds",
          "missing_capability_delegation_authority_contract",
          "role_as_capability",
          "oauth_scope_as_task_permission",
          "api_key_as_actor",
          "read_access_as_write_authority",
          "parent_agent_unbounded_delegation",
          "delegation_chain_missing",
          "purpose_mismatch_authority",
          "capability_without_caveats",
          "stale_capability_token_as_current",
          "cross_context_capability_reuse",
          "capability_escalation_by_tool_choice",
          "subagent_exceeds_parent_authority",
          "human_consent_reused_for_new_purpose",
          "permission_prompt_as_policy",
          "tool_schema_as_authorization",
          "cached_auth_decision_without_fresh_context",
          "break_glass_without_expiry",
          "admin_role_as_all_actions",
          "shared_service_account_as_identity",
          "task_goal_as_permission",
          "hidden_tool_call_without_policy_decision",
          "missing_privacy_confidentiality_boundary_contract",
          "pii_as_normal_fact",
          "secret_as_graph_label",
          "confidential_deck_as_public_context",
          "consent_missing_for_personal_data",
          "legal_basis_missing_for_processing",
          "purpose_reuse_without_privacy_review",
          "training_on_private_material",
          "public_export_without_redaction",
          "retention_expired_memory",
          "data_subject_delete_ignored",
          "cross_tenant_context_bleed",
          "customer_data_as_public_demo",
          "personal_life_as_company_context",
          "employee_note_as_hr_decision",
          "inferred_sensitive_attribute_to_output",
          "redacted_text_reidentified",
          "connector_cache_as_allowed_use",
          "screenshot_ocr_without_classification",
          "embedding_of_secret_without_policy",
          "vector_search_private_neighbor_leak",
          "shared_memory_without_audience_boundary",
          "confidential_source_to_untrusted_model",
          "legal_privilege_lost_by_disclosure",
          "missing_strategic_incentive_compatibility_contract",
          "self_report_as_truth",
          "kpi_as_objective",
          "commission_report_as_fact",
          "manager_approval_as_no_conflict",
          "vendor_claim_as_source_quality",
          "customer_rating_as_value",
          "agent_vote_as_independent_signal",
          "benchmark_score_as_general_capability",
          "cheap_provider_as_best_provider",
          "data_provider_label_as_quality",
          "compliance_attestation_as_compliance",
          "peer_pressure_as_consensus",
          "hidden_affiliation_as_neutral_review",
          "survey_response_as_stable_preference",
          "retention_metric_as_satisfaction",
          "access_request_as_need_to_know",
          "family_pressure_as_user_preference",
          "approval_chain_as_truthfulness",
          "cost_saving_as_system_health",
          "strategic_silence_as_no_risk",
          "collusive_agents_as_quorum",
          "mechanism_missing_to_runtime_write",
          "incentive_conflict_to_memory_write",
          "reward_model_as_human_goal",
          "missing_reflexive_feedback_stability_contract",
          "observation_after_intervention_as_neutral_truth",
          "recommendation_effect_as_preference",
          "self_generated_content_as_training_data",
          "model_output_as_source_corpus",
          "dashboard_change_as_system_improvement",
          "metric_response_as_real_world_gain",
          "repeated_retrieval_as_relevance",
          "agent_self_score_as_external_feedback",
          "closed_loop_without_counterfactual",
          "runaway_feedback_to_runtime_write",
          "oscillation_as_adaptation",
          "delayed_harm_ignored",
          "synthetic_data_loop_as_real_distribution",
          "intervention_without_stop_condition",
          "user_adaptation_as_stable_preference",
          "market_response_as_causal_truth",
          "personal_nudge_as_identity_change",
          "training_on_ai_outputs_without_real_anchor",
          "feedback_loop_to_memory_write",
          "feedback_loop_to_policy_write",
          "externality_free_assumption",
          "correlation_as_causation",
          "unsupported_claim",
          "direct_durable_memory_write",
          "raw_prompt_or_secret_memory_capture",
        ],
        promotionPolicy: {
          shadowRequired: true,
          canaryRequiredForMixedContext: true,
          rollbackRequired: true,
          syncReviewRequired: true,
          appbridgeSourceWritesBlocked: true,
          memoryCuratorBridgeRequired: true,
          openWorldCoverageRequired: true,
          unknownCombinationRuntimeWritesBlocked: true,
          uncoveredModalityRuntimeWritesBlocked: true,
          consensusCoordinationRequired: true,
          agentAgreementRuntimeWritesBlocked: true,
          majorityVoteRuntimeWritesBlocked: true,
          splitBrainRuntimeWritesBlocked: true,
          taskCoverageRequired: true,
          contextualFlowRequired: true,
          causalImpactRequired: true,
          assuranceCaseRequired: true,
          knowledgeHomeostasisRequired: true,
          adversarialProvenanceRequired: true,
          untrustedSourceRuntimeWritesBlocked: true,
          epistemicCalibrationRequired: true,
          uncalibratedRuntimeWritesBlocked: true,
          semanticAlignmentRequired: true,
          highAuthorityAlignmentReviewRequired: true,
          unreviewedSemanticRuntimeWritesBlocked: true,
          resilienceControlRequired: true,
          degradedRuntimeWritesBlocked: true,
          emergencyStopBypassBlocked: true,
          invariantVerificationRequired: true,
          runtimeInvariantWritesBlocked: true,
          forbiddenTransitionBlocked: true,
          observabilityTelemetryRequired: true,
          unobservableRuntimeWritesBlocked: true,
          auditSinkRequired: true,
          crossSurfaceCorrelationRequired: true,
          objectiveProxyValidityRequired: true,
          proxyOptimizationRuntimeWritesBlocked: true,
          countermetricRequired: true,
          metricGamingProbeRequired: true,
          stakeholderPreferenceGovernanceRequired: true,
          singleStakeholderRuntimeWritesBlocked: true,
          aggregationRuleRequired: true,
          appealPathRequired: true,
          normativeAuthorityDriftRequired: true,
          stalePolicyRuntimeWritesBlocked: true,
          jurisdictionScopeRequired: true,
          authorityHierarchyRequired: true,
          sideEffectContainmentRequired: true,
          irreversibleRuntimeActionsBlocked: true,
          idempotencyKeyRequired: true,
          compensationPlanRequired: true,
          sourceLineageVersionRequired: true,
          unversionedSourceRuntimeWritesBlocked: true,
          derivedArtifactPromotionBlocked: true,
          lineageRepairRequired: true,
          entityIdentityResolutionRequired: true,
          ambiguousIdentityRuntimeWritesBlocked: true,
          identityMergeReviewRequired: true,
          identityRollbackRequired: true,
          temporalStateTransitionRequired: true,
          timelessStateRuntimeWritesBlocked: true,
          eventReplayRequired: true,
          projectionVersionRequired: true,
          capabilityDelegationAuthorityRequired: true,
          unscopedCapabilityRuntimeWritesBlocked: true,
          delegationChainRequired: true,
          capabilityAttenuationRequired: true,
          purposeBoundCapabilityRequired: true,
          directDurableMemoryWritesBlocked: true,
          privacyConfidentialityBoundaryRequired: true,
          unclassifiedPrivateRuntimeWritesBlocked: true,
          privacyBoundaryReviewRequired: true,
          publicTrainingDisclosureFlagRequired: true,
          deletionAndRetentionStateRequired: true,
          crossTenantPrivacyBleedBlocked: true,
          strategicIncentiveCompatibilityRequired: true,
          incentiveConflictRuntimeWritesBlocked: true,
          mechanismReviewRequired: true,
          independentVerificationRequired: true,
          collusionCheckRequired: true,
          mechanismRedesignRequired: true,
          reflexiveFeedbackStabilityRequired: true,
          postInterventionRuntimeWritesBlocked: true,
          feedbackHoldoutRequired: true,
          realWorldAnchorRequired: true,
          dampingAndStopConditionRequired: true,
          modelCollapseLoopBlocked: true,
        },
        surfacePolicy: {
          desktopTerminal: {
            defaultDecision: "shadow_required",
            notes: "Local graph-write behavior needs permission audit and replay.",
          },
          appbridge: {
            defaultDecision: "blocked",
            notes: "AppBridge remains a route adapter, never the source of truth.",
          },
        },
      }, null, 2), "utf8");
    }
    const superOntologyOpenWorldCoverage = path.join(dir, superOntologyOpenWorldCoverageFile);
    if (!fs.existsSync(superOntologyOpenWorldCoverage)) {
      fs.writeFileSync(superOntologyOpenWorldCoverage, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-open-world-coverage",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "lower_authority_before_unknown_combination_write",
        worldFamilies: [
          "personal_life",
          "company_operations",
          "public_research",
          "scientific_observation",
          "social_institutional",
          "creative_media",
          "regulated_health",
          "legal_compliance",
          "industrial_physical",
          "environmental_geospatial",
          "software_enterprise",
          "education",
          "finance_compliance",
          "multimodal_brand",
          "unknown_mixed",
        ],
        modalities: [
          "text",
          "table",
          "slide",
          "pdf",
          "hwp",
          "image",
          "video",
          "audio",
          "sensor",
          "code",
          "database",
          "email",
          "calendar",
          "web",
          "geospatial",
        ],
        faultModels: [
          "none",
          "explicit_error",
          "implicit_degradation",
          "mixed_fault",
          "missing_field",
          "stale_source",
          "adversarial_source",
          "permission_gap",
          "semantic_ambiguity",
          "causal_gap",
        ],
        authorityStates: [
          "public_allowed",
          "owner_authority_present",
          "authority_unknown",
          "regulated_requires_review",
          "forbidden",
        ],
        coverageGaps: [
          "covered",
          "new_combination",
          "underrepresented_world",
          "missing_fault_fixture",
          "missing_modality_fixture",
          "missing_authority_fixture",
        ],
        requiredGates: [
          "task_coverage",
          "contextual_flow",
          "epistemic_calibration",
          "semantic_alignment",
          "adversarial_provenance",
          "causal_impact",
          "knowledge_homeostasis",
          "resilience_control",
          "invariant_verification",
          "memory_curator_bridge",
          "assurance_case",
          "shadow_canary_replay",
          "owner_review",
        ],
        samplingActions: [
          "allow_as_research_fixture",
          "add_fixture",
          "ask_clarify",
          "shadow_replay",
          "quarantine",
          "block",
          "require_owner_review",
        ],
        promotionDecisions: [
          "candidate_only",
          "shadow_required",
          "sync_review_required",
          "blocked",
        ],
        researchBasis: [
          "open_world_evaluation",
          "professional_agent_benchmarks",
          "real_computer_environment_benchmarks",
          "ontology_oriented_kg_construction",
          "enterprise_ontology_scope_limits",
          "no_free_lunch",
          "zero_trust_architecture",
        ],
        hardStops: [
          "missing_open_world_coverage_contract",
          "proposal_example_equals_all_tasks",
          "unknown_combination_to_runtime_write",
          "untested_modality_to_memory_write",
          "implicit_degradation_as_complete_data",
          "adversarial_source_as_authority",
          "forbidden_authority_to_action",
          "open_world_case_without_shadow_replay",
          "open_world_case_without_owner_or_sync_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyConsensusCoordination = path.join(dir, superOntologyConsensusCoordinationFile);
    if (!fs.existsSync(superOntologyConsensusCoordination)) {
      fs.writeFileSync(superOntologyConsensusCoordination, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-consensus-coordination",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "treat_agent_agreement_as_candidate_signal_not_write_authority",
        coordinationTopologies: [
          "independent_parallel",
          "star_orchestrator",
          "round_robin",
          "majority_vote",
          "weighted_vote",
          "debate",
          "owner_review_board",
          "distributed_replicas",
          "cross_runtime_sync",
        ],
        failureModes: [
          "majority_corruption",
          "peer_pressure",
          "sycophancy",
          "split_brain",
          "stale_replica",
          "double_write",
          "authority_escalation",
          "validator_disagreement",
          "collusion",
          "unreliable_judge",
          "network_partition",
          "race_condition",
        ],
        requiredGates: [
          "adversarial_provenance",
          "epistemic_calibration",
          "semantic_alignment",
          "knowledge_homeostasis",
          "resilience_control",
          "invariant_verification",
          "memory_curator_bridge",
          "assurance_case",
          "shadow_canary_replay",
          "owner_review",
          "sync_gate",
        ],
        consensusPolicies: [
          "independent_verification",
          "stability_detection",
          "evidence_weighted",
          "unanimity_for_high_risk",
          "owner_tiebreak",
          "quorum_plus_veto",
          "read_only_shadow",
          "two_phase_commit",
          "crdt_merge_with_review",
          "block",
        ],
        conflictResolutions: [
          "ask_clarify",
          "quarantine",
          "shadow_replay",
          "owner_review",
          "sync_review",
          "rollback",
          "emergency_stop",
          "merge_as_contested",
          "reject",
          "read_only_mode",
        ],
        researchBasis: [
          "multi_agent_consensus_risk",
          "peer_pressure_research",
          "distributed_systems_consensus",
          "ontology_conflict_resolution",
          "assurance_case",
          "zero_trust_architecture",
        ],
        hardStops: [
          "missing_consensus_coordination_contract",
          "agent_agreement_as_truth",
          "majority_vote_as_write_authority",
          "debate_stability_as_proof",
          "model_judge_as_final_evidence",
          "distributed_replica_merge_without_review",
          "route_sync_without_quorum",
          "last_writer_wins_architecture_update",
          "peer_pressure_to_memory_write",
          "validator_disagreement_to_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyContextualFlow = path.join(dir, superOntologyContextualFlowFile);
    if (!fs.existsSync(superOntologyContextualFlow)) {
      fs.writeFileSync(superOntologyContextualFlow, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-contextual-flow",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "contextual_flow_required_before_boundary_crossing",
        flowStages: [
          "user_to_agent",
          "agent_to_tool",
          "tool_to_agent",
          "agent_to_agent",
          "agent_to_memory",
          "agent_to_output",
          "agent_to_public_surface",
        ],
        contexts: ["personal", "company", "customer", "public", "regulated", "agent_internal"],
        requiredParameters: [
          "source_context",
          "target_context",
          "sender_role",
          "recipient_role",
          "subject_role",
          "attribute_type",
          "transmission_principle",
          "purpose",
          "authority_basis",
          "sensitivity",
          "retention_policy",
          "audit_refs",
        ],
        decisions: ["allow", "redact", "aggregate_only", "review_required", "block"],
        researchBasis: [
          "contextual_integrity",
          "privacy_flow_graph",
          "multi_agent_contextual_privacy",
          "compositional_privacy",
          "information_flow_control",
          "nist_ai_rmf_gai_profile",
          "w3c_prov",
          "stpa_mode_confusion",
        ],
        hardStops: [
          "same_user_means_all_contexts_joinable",
          "tool_response_as_need_to_know",
          "public_output_after_private_handoff",
          "raw_prompt_or_transcript_to_memory",
          "customer_data_to_public_surface_without_consent",
          "regulated_data_to_training_without_consent_delete_path",
          "agent_internal_trace_to_user_output",
          "cross_project_join_without_scope_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyCausalImpact = path.join(dir, superOntologyCausalImpactFile);
    if (!fs.existsSync(superOntologyCausalImpact)) {
      fs.writeFileSync(superOntologyCausalImpact, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-causal-impact",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "counterfactual_required_before_state_change",
        causalClaimTypes: [
          "correlation_only",
          "causal_hypothesis",
          "intervention",
          "counterfactual",
          "temporal_causal",
          "memory_intervention",
          "multi_agent_plan",
          "external_side_effect",
          "physical_or_train",
        ],
        requiredChecks: [
          "intervention_target",
          "expected_outcomes",
          "adverse_outcomes",
          "counterfactual_checks",
          "observability",
          "reversibility",
          "blast_radius",
          "blocked_write_surfaces",
          "rollback_plan",
        ],
        decisions: [
          "allow_read",
          "draft_only",
          "review_required",
          "shadow_required",
          "block",
        ],
        researchBasis: [
          "causal_rag",
          "causal_counterfactual_rag",
          "counterfactual_benchmark",
          "causal_planning",
          "causal_memory_intervention",
          "structural_causal_model",
          "resilience_engineering",
          "systems_theory",
        ],
        hardStops: [
          "correlation_as_causation",
          "retrieved_relation_as_action_permission",
          "missing_counterfactual_check",
          "missing_adverse_outcome",
          "missing_blast_radius",
          "missing_observability",
          "state_change_without_rollback",
          "physical_action_without_human_protocol",
          "training_without_consent_or_delete_path",
          "multi_agent_write_without_ordered_handoff",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyAssuranceCase = path.join(dir, superOntologyAssuranceCaseFile);
    if (!fs.existsSync(superOntologyAssuranceCase)) {
      fs.writeFileSync(superOntologyAssuranceCase, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-assurance-case",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "evidence_linked_claim_required",
        claimTypes: [
          "scope_boundary",
          "source_provenance",
          "knowledge_integrity",
          "memory_safety",
          "action_safety",
          "task_coverage",
          "world_coverage",
          "promotion_safety",
          "sync_integrity",
          "red_team_reporting",
          "rejected_overclaim",
        ],
        evidenceKinds: [
          "schema_check",
          "fixture_check",
          "public_safety_check",
          "typecheck",
          "build",
          "sync_check",
          "shadow_replay",
          "canary_replay",
          "rollback_drill",
          "constraint_validation",
          "provenance_standard",
          "official_standard",
          "red_team_report",
          "human_review",
          "rejected_claim",
        ],
        validators: [
          "json_schema",
          "jsonl_fixture_checker",
          "public_safety_scan",
          "typecheck",
          "sync_gate",
          "shadow_canary_replay",
          "rollback_drill",
          "provenance_ledger",
          "constraint_shape",
          "red_team_question_bank",
          "human_review_queue",
        ],
        researchBasis: [
          "assurance_case",
          "argument_graph",
          "compliance_by_construction",
          "w3c_prov",
          "w3c_shacl",
          "nist_ai_rmf_gai_profile",
          "genai_red_team_reporting",
          "llm_kg_construction",
          "ontology_validation",
          "no_free_lunch",
        ],
        hardStops: [
          "unsupported_claim",
          "missing_required_evidence",
          "hidden_missing_evidence",
          "missing_validator",
          "missing_residual_risk",
          "missing_rollback_plan",
          "perfect_or_zero_error_claim",
          "red_team_without_followup",
          "runtime_claim_without_shadow_or_canary",
          "appbridge_source_of_truth_claim",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyKnowledgeHomeostasis = path.join(dir, superOntologyKnowledgeHomeostasisFile);
    if (!fs.existsSync(superOntologyKnowledgeHomeostasis)) {
      fs.writeFileSync(superOntologyKnowledgeHomeostasis, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-knowledge-homeostasis",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "homeostasis_required_before_runtime_or_memory_write",
        signals: [
          "contradiction_rate",
          "stale_claim_age",
          "schema_violation_rate",
          "parser_error_rate",
          "unsupported_claim_rate",
          "repair_backlog",
          "replay_failure_rate",
          "drift_rate",
          "source_freshness",
          "authority_expiry",
          "privacy_incident",
          "promotion_evidence_gap",
          "user_correction_rate",
          "runtime_desync_rate",
        ],
        decisions: [
          "continue",
          "quarantine",
          "degrade_to_read_only",
          "require_review",
          "replay",
          "repair",
          "rollback",
          "block_promotion",
          "retire",
        ],
        requiredParameters: [
          "monitored_artifact",
          "scope_id",
          "surface",
          "signal_type",
          "measurement",
          "severity",
          "affected_contexts",
          "affected_lenses",
          "affected_claims",
          "affected_surfaces",
          "error_budget",
          "control_decision",
          "automation_level",
          "escalation",
          "evidence_refs",
          "rollback_plan",
          "memory_curator_policy",
          "public_export_policy",
        ],
        researchBasis: [
          "shacl_validation",
          "kg_repair_evaluation",
          "ontology_change_propagation",
          "truth_maintenance",
          "data_observability",
          "resilience_engineering",
          "homeostatic_control",
          "w3c_prov",
          "nist_ai_rmf",
          "ai_agent_index",
        ],
        hardStops: [
          "error_budget_overrun_continues",
          "critical_homeostasis_runtime_write",
          "privacy_incident_public_export",
          "appbridge_route_as_source_authority",
          "stale_claim_as_current_truth",
          "parser_error_as_complete_source",
          "missing_homeostasis_evidence",
          "memory_write_without_ticket_or_quarantine",
          "runtime_desync_ignored",
          "literal_perfection_claim",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyAdversarialProvenance = path.join(dir, superOntologyAdversarialProvenanceFile);
    if (!fs.existsSync(superOntologyAdversarialProvenance)) {
      fs.writeFileSync(superOntologyAdversarialProvenance, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-adversarial-provenance",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "zero_trust_provenance_required_before_retrieval_memory_tool_or_public_seed",
        sourceChannels: [
          "upload",
          "web",
          "email",
          "chat",
          "tool_response",
          "connector",
          "memory_recall",
          "public_repo",
          "media_asset",
          "appbridge_route",
          "generated_artifact",
          "dataset",
        ],
        attackVectors: [
          "prompt_injection",
          "instruction_smuggling",
          "data_poisoning",
          "provenance_forgery",
          "citation_spoofing",
          "tool_output_tampering",
          "ocr_hidden_text",
          "cross_context_exfiltration",
          "supply_chain_tampering",
          "memory_poisoning",
          "social_engineering",
          "model_policy_bypass",
          "media_provenance_conflict",
          "stale_trusted_source_replay",
        ],
        trustBoundaries: [
          "untrusted_external",
          "user_private",
          "company_internal",
          "customer_confidential",
          "public_web",
          "runtime_tool",
          "agent_internal",
          "memory_store",
          "release_artifact",
        ],
        instructionPolicies: [
          "treat_as_data_only",
          "strip_instructions",
          "quote_only",
          "sandbox_tool_output",
          "require_signature",
          "require_human_review",
          "block",
        ],
        retrievalPolicies: [
          "exclude_from_retrieval",
          "metadata_only",
          "citation_only",
          "quarantined_candidate",
          "low_trust_retrieval",
          "allow_after_verification",
        ],
        memoryPolicies: [
          "no_memory",
          "quarantine_ticket",
          "redact_then_ticket",
          "supersede_after_review",
          "discard",
        ],
        toolPolicies: [
          "no_tool_use",
          "dry_run_only",
          "allowlisted_read_only",
          "require_human_approval",
          "block_external_effect",
        ],
        promotionDecisions: [
          "allow_read",
          "quarantine",
          "review_required",
          "shadow_required",
          "block",
          "retire_source",
        ],
        requiredParameters: [
          "source_channel",
          "attack_vector",
          "trust_boundary",
          "claimed_authority",
          "observed_artifact",
          "provenance_evidence",
          "integrity_checks",
          "instruction_policy",
          "retrieval_policy",
          "memory_policy",
          "tool_policy",
          "promotion_decision",
          "required_controls",
          "must_not_do",
          "evidence_refs",
          "rollback_plan",
        ],
        researchBasis: [
          "owasp_llm_top10",
          "mitre_atlas",
          "nist_adversarial_ml",
          "slsa_provenance",
          "in_toto_attestation",
          "c2pa_content_credentials",
          "zero_trust_architecture",
          "information_flow_control",
          "adversarial_rag",
          "secure_rag_prompt_injection",
        ],
        hardStops: [
          "prompt_injection_as_instruction",
          "instruction_smuggling_as_policy",
          "poisoned_source_to_memory",
          "forged_provenance_as_trusted_source",
          "spoofed_citation_as_grounded_fact",
          "tool_output_tampering_to_action",
          "hidden_ocr_instruction_as_user_intent",
          "cross_context_exfiltration",
          "unsigned_release_artifact",
          "route_output_as_source_write_authority",
          "stale_trusted_source_replay_as_current_truth",
          "missing_adversarial_provenance_evidence",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyEpistemicCalibration = path.join(dir, superOntologyEpistemicCalibrationFile);
    if (!fs.existsSync(superOntologyEpistemicCalibration)) {
      fs.writeFileSync(superOntologyEpistemicCalibration, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-epistemic-calibration",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "calibrated_uncertainty_required_before_answer_memory_tool_or_public_seed",
        contextTypes: [
          "user_personal",
          "company_internal",
          "customer_confidential",
          "public_web",
          "regulated",
          "scientific",
          "software",
          "finance_compliance",
          "physical",
          "creative",
          "agent_internal",
          "mixed_context",
          "multimodal",
          "appbridge_route",
          "release_surface",
        ],
        claimTypes: [
          "factual_answer",
          "graph_edge",
          "ontology_class",
          "relation_mapping",
          "action_plan",
          "memory_write",
          "tool_action",
          "public_export",
          "legal_or_policy",
          "financial_estimate",
          "scientific_claim",
          "physical_action",
          "creative_generation",
          "route_sync",
          "generated_artifact",
        ],
        uncertaintySources: [
          "missing_evidence",
          "conflicting_sources",
          "low_retrieval_relevance",
          "distribution_shift",
          "ambiguous_intent",
          "insufficient_permissions",
          "temporal_staleness",
          "noisy_ocr",
          "model_disagreement",
          "tool_inconclusive",
          "causal_unknown",
          "private_context_gap",
          "benchmark_gap",
          "low_calibration_support",
          "adversarial_source_uncertain",
          "no_ground_truth",
        ],
        epistemicStates: [
          "known_enough_for_read",
          "partially_supported",
          "contested",
          "underspecified",
          "out_of_distribution",
          "uncalibrated",
          "unknowable_for_now",
        ],
        calibrationSignals: [
          "conformal_set_size",
          "confidence_interval",
          "prediction_set",
          "abstention_score",
          "evidence_coverage",
          "retrieval_entropy",
          "contradiction_score",
          "judge_interval",
          "self_eval_none_of_above",
          "ensemble_disagreement",
          "holdout_error_rate",
          "calibration_error",
          "ood_score",
          "human_feedback_gap",
        ],
        confidenceBands: [
          "calibrated_high",
          "calibrated_medium",
          "calibrated_low",
          "uncalibrated",
          "unknown",
        ],
        riskTiers: ["low", "moderate", "high", "critical"],
        allowedOutputs: [
          "answer_with_caveat",
          "ask_clarifying_question",
          "retrieve_more",
          "cite_only",
          "draft_only",
          "human_review",
          "abstain",
          "block",
          "shadow_replay",
        ],
        requiredParameters: [
          "context_type",
          "claim_type",
          "uncertainty_source",
          "epistemic_state",
          "calibration_signal",
          "confidence_band",
          "risk_tier",
          "allowed_output",
          "required_controls",
          "blocked_shortcuts",
          "evidence_refs",
          "research_basis",
          "memory_policy",
          "tool_policy",
          "public_export_policy",
          "rollback_plan",
        ],
        researchBasis: [
          "conformal_prediction",
          "conformal_risk_control",
          "selective_prediction",
          "abstention_policy",
          "llm_self_evaluation",
          "verbalized_confidence_calibration",
          "rag_uncertainty_benchmark",
          "nist_ai_rmf",
          "ood_detection",
          "human_in_the_loop",
          "calibration_error",
          "uncertainty_alignment",
        ],
        hardStops: [
          "missing_evidence_as_complete_answer",
          "conflicting_sources_as_current_truth",
          "low_retrieval_relevance_as_confident_answer",
          "ambiguous_intent_to_memory_write",
          "distribution_shift_to_financial_estimate",
          "stale_policy_as_current_policy",
          "model_disagreement_as_consensus",
          "noisy_ocr_as_ontology_class",
          "inconclusive_tool_output_to_action",
          "causal_unknown_to_physical_action",
          "benchmark_gap_to_public_release",
          "uncalibrated_route_sync",
          "adversarial_uncertainty_to_graph_edge",
          "wide_judge_interval_to_regulated_answer",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySemanticAlignment = path.join(dir, superOntologySemanticAlignmentFile);
    if (!fs.existsSync(superOntologySemanticAlignment)) {
      fs.writeFileSync(superOntologySemanticAlignment, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-semantic-alignment",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "scoped_candidate_alignment_required_before_graph_memory_or_public_seed",
        sourceContexts: [
          "company_internal",
          "user_personal",
          "customer_confidential",
          "public_web",
          "regulated",
          "scientific",
          "software_schema",
          "finance_compliance",
          "multimodal_ocr",
          "appbridge_route",
          "release_surface",
          "cross_team",
          "legacy_system",
          "mixed_context",
          "generated_artifact",
        ],
        artifactTypes: [
          "glossary",
          "database_schema",
          "spreadsheet",
          "presentation",
          "contract",
          "policy_doc",
          "source_code",
          "ticket",
          "email",
          "pdf",
          "image_ocr",
          "ontology",
          "knowledge_graph",
          "app_route",
          "generated_output",
        ],
        alignmentIntents: [
          "synonym_discovery",
          "schema_column_match",
          "class_alignment",
          "property_alignment",
          "entity_resolution",
          "hierarchy_mapping",
          "relation_mapping",
          "unit_mapping",
          "business_process_mapping",
          "compliance_mapping",
          "source_system_merge",
          "ontology_change",
          "release_sync",
          "memory_merge",
          "no_match_detection",
        ],
        candidateRelations: [
          "exact_match",
          "close_match",
          "broad_match",
          "narrow_match",
          "related_match",
          "equivalent_class",
          "equivalent_property",
          "same_individual",
          "synonym",
          "no_match",
          "conflict",
        ],
        alignmentScopes: [
          "local_task",
          "project",
          "team",
          "company",
          "customer",
          "regulated_domain",
          "public_export",
          "appbridge_route",
          "release_surface",
        ],
        ambiguityTypes: [
          "homonym",
          "synonym",
          "polysemy",
          "abbreviation",
          "language_variant",
          "unit_mismatch",
          "temporal_version",
          "scope_collision",
          "granularity_mismatch",
          "relation_direction_unknown",
          "entity_class_confusion",
          "ocr_noise",
          "source_conflict",
          "generated_label",
          "missing_definition",
        ],
        validationChecks: [
          "candidate_retrieval",
          "bidirectional_check",
          "contradiction_check",
          "disjointness_check",
          "transitivity_check",
          "sample_instance_check",
          "roundtrip_query_check",
          "shacl_validation",
          "owl_consistency",
          "kgcl_diff",
          "human_owner_review",
          "rollback_drill",
          "shadow_replay",
          "relation_direction_check",
          "unit_compatibility",
        ],
        researchBasis: [
          "skos_mapping",
          "owl_reasoning",
          "shacl_validation",
          "kgcl_change_language",
          "llm_schema_matching",
          "retrieval_augmented_ontology_matching",
          "human_in_loop_schema_discovery",
          "schema_rollup_drilldown",
          "entity_resolution",
          "data_contracts",
          "provenance_review",
          "ontology_change_management",
        ],
        hardStops: [
          "same_label_as_same_meaning",
          "embedding_similarity_as_exact_match",
          "close_match_as_transitive_truth",
          "abbreviation_without_owner_glossary",
          "broad_or_narrow_without_direction_check",
          "generated_label_as_ontology_class",
          "ocr_label_as_property_alignment",
          "appbridge_route_as_source_ontology_edit",
          "source_conflict_to_memory_merge",
          "customer_confidential_mapping_to_public_export",
          "release_sync_without_rollback",
          "ontology_change_without_diff",
          "same_individual_without_stable_identifier",
          "unit_label_without_unit_compatibility",
          "no_match_promoted_to_weak_match",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyResilienceControl = path.join(dir, superOntologyResilienceControlFile);
    if (!fs.existsSync(superOntologyResilienceControl)) {
      fs.writeFileSync(superOntologyResilienceControl, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-resilience-control",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "degrade_authority_before_runtime_graph_memory_tool_or_sync_write",
        controlLoopPhases: ["monitor", "analyze", "plan", "execute", "learn", "sync"],
        operatingModes: [
          "nominal",
          "watch",
          "degraded",
          "shadow_only",
          "read_only",
          "quarantine",
          "owner_review",
          "rollback",
          "emergency_stop",
        ],
        degradationSignals: [
          "contradiction_spike",
          "validator_disagreement",
          "retrieval_drift",
          "semantic_alignment_regression",
          "provenance_gap",
          "memory_curator_backlog",
          "tool_error_spike",
          "user_correction_spike",
          "unknown_task_family",
          "context_flow_violation",
          "causal_impact_uncertain",
          "sync_drift",
          "model_judge_divergence",
          "latency_budget_overrun",
          "replay_failure",
          "permission_boundary_unknown",
          "sensor_or_parser_degraded",
          "external_side_effect_detected",
        ],
        hazardTypes: [
          "unsafe_control_action",
          "missing_feedback",
          "delayed_feedback",
          "wrong_mode",
          "authority_escalation",
          "control_loop_oscillation",
          "stale_process_model",
          "degraded_sensor",
          "conflicting_controller",
          "runaway_repair",
          "unbounded_retry",
          "brittle_threshold",
          "silent_fail_open",
          "operator_overload",
        ],
        controlDecisions: [
          "continue",
          "observe",
          "ask_clarify",
          "retrieve_more",
          "shadow_only",
          "read_only",
          "quarantine",
          "require_owner_review",
          "rollback",
          "emergency_stop",
        ],
        requiredFeedback: [
          "fresh_source_retrieval",
          "validator_matrix",
          "curator_queue_depth",
          "tool_trace",
          "source_identity_check",
          "contextual_flow_replay",
          "causal_impact_review",
          "semantic_alignment_replay",
          "epistemic_calibration_replay",
          "architecture_sync_diff",
          "rollback_confirmation",
          "owner_review_ticket",
        ],
        researchBasis: [
          "mape_k",
          "self_adaptive_systems",
          "stpa",
          "unsafe_control_actions",
          "robustness_analysis",
          "degradation_state_analysis",
          "agentic_self_awareness",
          "adaptive_hierarchical_kg",
          "resilience_engineering",
          "cybernetics_feedback",
          "incident_command",
          "sociotechnical_escalation",
        ],
        hardStops: [
          "validator_disagreement_to_graph_write",
          "retrieval_drift_to_current_answer",
          "semantic_regression_to_memory_merge",
          "provenance_gap_to_tool_authority",
          "curator_backlog_to_direct_memory_write",
          "tool_error_spike_to_unbounded_retry",
          "unknown_task_to_normal_execution",
          "context_flow_violation_to_public_export",
          "sync_drift_to_release_surface",
          "judge_divergence_to_regulated_answer",
          "degraded_parser_to_ontology_class",
          "rollback_failure_to_runtime_promotion",
          "emergency_stop_bypass_by_route",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyInvariantVerification = path.join(dir, superOntologyInvariantVerificationFile);
    if (!fs.existsSync(superOntologyInvariantVerification)) {
      fs.writeFileSync(superOntologyInvariantVerification, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-invariant-verification",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "runtime_monitor_required_before_graph_memory_tool_route_release_or_public_write",
        eventStreams: [
          "source_intake",
          "evidence_packet",
          "belief_update",
          "semantic_alignment",
          "resilience_mode",
          "memory_ticket",
          "graph_write",
          "tool_call",
          "public_export",
          "route_sync",
          "release_seed",
          "rollback",
          "emergency_stop",
        ],
        invariantTypes: [
          "safety",
          "liveness",
          "ordering",
          "separation",
          "cardinality",
          "idempotency",
          "provenance",
          "authority",
          "consent",
          "rollback",
          "audit",
          "determinism",
        ],
        temporalOperators: ["always", "never", "eventually", "until", "before", "after", "within", "once"],
        monitors: [
          "json_schema",
          "event_sequence",
          "state_machine",
          "temporal_logic",
          "property_test",
          "shadow_replay",
          "model_check",
          "sync_check",
          "curator_ticket_audit",
          "human_owner_review",
        ],
        violationActions: [
          "block",
          "reject",
          "quarantine",
          "rollback",
          "emergency_stop",
          "ask_clarify",
          "review_required",
          "shadow_only",
        ],
        researchBasis: [
          "runtime_verification",
          "temporal_logic",
          "model_checking",
          "contract_based_design",
          "assume_guarantee_contracts",
          "finite_state_monitor",
          "agent_runtime_monitoring",
          "formal_methods_for_planning",
          "formal_skill_verification",
          "multi_agent_safety_invariants",
          "memory_safety_invariants",
          "audit_log_invariants",
        ],
        hardStops: [
          "memory_write_without_ticket_invariant",
          "graph_write_without_evidence_invariant",
          "tool_action_without_authority_invariant",
          "public_export_without_flow_invariant",
          "route_sync_without_source_contract_invariant",
          "rollback_not_observed_after_violation",
          "emergency_stop_transition_bypassed",
          "unordered_multi_agent_write",
          "non_idempotent_replay_mutation",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyObservabilityTelemetry = path.join(dir, superOntologyObservabilityTelemetryFile);
    if (!fs.existsSync(superOntologyObservabilityTelemetry)) {
      fs.writeFileSync(superOntologyObservabilityTelemetry, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-observability-telemetry",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "observability_required_before_runtime_graph_memory_tool_route_release_or_public_write",
        eventTypes: [
          "source_intake",
          "evidence_packet",
          "belief_update",
          "graph_write",
          "memory_ticket",
          "tool_action",
          "public_export",
          "route_sync",
          "release_seed",
          "repair_event",
          "rollback",
          "emergency_stop",
        ],
        failureModes: [
          "missing_trace_id",
          "dropped_span",
          "partial_log",
          "stale_metric",
          "redaction_gap",
          "audit_sink_down",
          "clock_skew",
          "sample_bias",
          "alert_suppression",
          "replay_not_recorded",
          "repair_without_snapshot",
          "cross_surface_correlation_missing",
        ],
        requiredTelemetry: [
          "trace_id",
          "span_id",
          "parent_span_id",
          "correlation_id",
          "source_ref",
          "evidence_ref",
          "actor_role",
          "authority_state",
          "decision_state",
          "risk_tier",
          "redaction_policy",
          "retention_policy",
          "clock_source",
          "checksum",
          "before_snapshot_ref",
          "after_snapshot_ref",
          "rollback_ref",
          "alert_ref",
          "audit_sink_ref",
          "sample_size",
        ],
        traceStates: ["complete", "partial", "missing", "corrupted", "untrusted", "redacted"],
        auditChannels: [
          "jsonl_ledger",
          "otel_trace",
          "memory_ticket",
          "sync_log",
          "release_log",
          "tool_receipt",
          "owner_review_queue",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "shadow_required",
          "sync_review_required",
          "quarantine",
          "rollback",
          "emergency_stop",
          "blocked",
        ],
        researchBasis: [
          "agent_execution_provenance",
          "agent_observability_telemetry",
          "trace_reasoning_benchmark",
          "opentelemetry",
          "w3c_trace_context",
          "sre_monitoring",
          "nist_ai_rmf_gai_profile",
          "runtime_assurance",
          "audit_log_invariants",
          "data_observability",
        ],
        hardStops: [
          "missing_observability_telemetry_contract",
          "write_without_trace_id",
          "memory_ticket_without_span_lineage",
          "tool_action_without_audit_receipt",
          "public_export_with_stale_metric",
          "route_sync_without_correlation_id",
          "release_seed_when_audit_sink_down",
          "redaction_missing_in_telemetry",
          "metric_green_without_sample_size",
          "alert_suppressed_during_degraded_mode",
          "shadow_replay_not_recorded",
          "repair_without_before_after_snapshot",
          "rollback_without_observed_event",
          "unobservable_runtime_write",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyObjectiveProxyValidity = path.join(dir, superOntologyObjectiveProxyValidityFile);
    if (!fs.existsSync(superOntologyObjectiveProxyValidity)) {
      fs.writeFileSync(superOntologyObjectiveProxyValidity, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-objective-proxy-validity",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "construct_validity_required_before_metric_driven_runtime_graph_memory_tool_route_release_or_public_write",
        constructs: [
          "user_value",
          "business_outcome",
          "safety",
          "quality",
          "truthfulness",
          "trust",
          "learning",
          "wellbeing",
          "compliance",
          "fairness",
          "reliability",
          "maintainability",
          "environmental_impact",
          "financial_return",
          "operational_efficiency",
          "reputation",
        ],
        proxyMetrics: [
          "approval_rate",
          "open_rate",
          "click_rate",
          "benchmark_score",
          "test_pass_rate",
          "self_judge_score",
          "ontology_edge_count",
          "memory_recall_count",
          "short_term_profit",
          "cost_per_execution",
          "green_dashboard_percentage",
          "reward_score_delta",
        ],
        validityGaps: [
          "construct_underdefined",
          "proxy_not_construct",
          "proxy_overoptimized",
          "benchmark_contamination",
          "reward_tampering",
          "metric_gaming",
          "stakeholder_harm_hidden",
          "short_term_metric_long_term_harm",
          "sample_not_representative",
          "measurement_noninvariance",
          "label_leakage",
          "evaluator_conflict",
          "target_shift",
        ],
        goodhartModes: [
          "regressional",
          "extremal",
          "causal",
          "adversarial",
          "campbell_law",
          "reward_hacking",
          "proxy_gaming",
          "benchmark_gaming",
        ],
        requiredValidityEvidence: [
          "construct_definition",
          "stakeholder_map",
          "countermetric",
          "negative_control",
          "holdout_distribution",
          "baseline_comparison",
          "item_level_analysis",
          "causal_path",
          "gaming_probe",
          "benchmark_provenance",
          "human_owner_review",
          "longitudinal_check",
          "measurement_invariance_check",
          "sample_size",
          "error_bar",
          "rollback_plan",
        ],
        countermetrics: [
          "harm_rate",
          "complaint_rate",
          "long_term_retention",
          "quality_review_score",
          "fairness_delta",
          "safety_incident_rate",
          "source_grounding_rate",
          "maintenance_burden",
          "cost_per_success",
          "reversal_rate",
          "learning_transfer",
          "user_trust_signal",
          "denominator",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "shadow_required",
          "human_review_required",
          "redesign_metric",
          "quarantine",
          "block_optimization",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "goodharts_law",
          "campbells_law",
          "construct_validity",
          "psychometrics",
          "measurement_theory",
          "reward_hacking",
          "specification_gaming",
          "benchmark_validity",
          "ai_risk_management",
          "sociotechnical_evaluation",
          "causal_inference",
          "program_evaluation",
        ],
        hardStops: [
          "missing_objective_proxy_validity_contract",
          "metric_improvement_as_goal_completion",
          "approval_rate_as_trust",
          "benchmark_score_as_reliability",
          "test_pass_rate_as_maintainability",
          "open_rate_as_customer_value",
          "self_judge_score_as_truth",
          "edge_count_as_knowledge_quality",
          "short_term_profit_as_compliance",
          "cost_per_execution_as_sustainability",
          "reward_score_as_quality",
          "label_leakage_as_accuracy",
          "green_dashboard_as_health",
          "proxy_optimization_without_countermetric",
          "optimization_without_stakeholder_map",
          "metric_gaming_without_probe",
          "reward_tampering_to_promotion",
          "construct_underdefined_to_runtime_write",
          "unvalidated_proxy_to_public_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyStakeholderPreferenceGovernance = path.join(
      dir,
      superOntologyStakeholderPreferenceGovernanceFile,
    );
    if (!fs.existsSync(superOntologyStakeholderPreferenceGovernance)) {
      fs.writeFileSync(superOntologyStakeholderPreferenceGovernance, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-stakeholder-preference-governance",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "stakeholder_preference_governance_required_before_multi_party_runtime_graph_memory_tool_route_release_or_public_write",
        stakeholderRoles: [
          "individual_user",
          "project_owner",
          "team_member",
          "manager",
          "executive",
          "customer",
          "customer_end_user",
          "legal_compliance",
          "security_privacy",
          "sales_marketing",
          "operations_support",
          "finance_procurement",
          "public_audience",
          "regulator",
          "minority_or_vulnerable_group",
          "future_maintainer",
          "student",
          "teacher",
          "parent_guardian",
          "patient_or_caregiver",
        ],
        preferenceSignals: [
          "explicit_instruction",
          "approval_vote",
          "ranking",
          "policy_requirement",
          "legal_obligation",
          "contractual_constraint",
          "customer_feedback",
          "complaint",
          "usage_behavior",
          "accessibility_need",
          "safety_objection",
          "privacy_preference",
          "quality_review",
          "maintenance_burden",
          "cost_constraint",
          "minority_report",
          "professional_standard",
          "recency_check",
        ],
        conflictTypes: [
          "stakeholder_conflict",
          "value_tradeoff",
          "rights_constraint",
          "consent_boundary",
          "power_asymmetry",
          "minority_harm",
          "short_term_long_term_conflict",
          "private_public_tension",
          "role_scope_collision",
          "regulatory_conflict",
          "resource_allocation_conflict",
          "strategic_misreporting",
          "preference_drift",
          "unrepresented_party",
        ],
        aggregationRules: [
          "consent_required",
          "veto_for_rights",
          "owner_review",
          "policy_precedence",
          "weighted_deliberation",
          "ranked_choice",
          "majority_with_veto",
          "pareto_screen",
          "minimax_regret",
          "rawlsian_priority",
          "human_governance_board",
          "case_by_case_review",
          "no_aggregation_allowed",
        ],
        requiredGovernanceEvidence: [
          "stakeholder_map",
          "preference_source",
          "scope_of_authority",
          "affected_party_analysis",
          "aggregation_rule",
          "rights_constraint_check",
          "minority_report",
          "dissent_capture",
          "consent_record",
          "appeal_path",
          "rollback_plan",
          "review_owner",
          "tradeoff_rationale",
          "public_private_boundary",
          "recency_check",
          "policy_or_contract_ref",
          "manipulation_probe",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "human_review_required",
          "policy_review_required",
          "consent_required",
          "redesign_tradeoff",
          "quarantine",
          "block_write",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "social_choice_theory",
          "arrow_impossibility",
          "gibbard_satterthwaite",
          "pluralistic_alignment",
          "multi_stakeholder_alignment",
          "deliberative_democracy",
          "stakeholder_theory",
          "value_sensitive_design",
          "participatory_design",
          "procedural_justice",
          "ai_risk_management",
          "human_subjects_ethics",
          "governance_risk_compliance",
        ],
        hardStops: [
          "missing_stakeholder_preference_governance_contract",
          "single_stakeholder_preference_as_global_goal",
          "owner_preference_as_all_stakeholders",
          "majority_preference_as_rights_clearance",
          "average_utility_over_protected_constraint",
          "hidden_affected_party",
          "missing_appeal_path",
          "missing_dissent_capture",
          "strategic_preference_report_as_truth",
          "preference_aggregation_without_rule",
          "preference_conflict_to_runtime_write",
          "consent_absent_to_personalization",
          "minority_harm_hidden_by_aggregate",
          "irreversible_action_without_stakeholder_review",
          "private_preference_to_public_release",
          "cross_context_preference_reuse_without_scope",
          "role_power_as_legitimacy",
          "arrow_impossibility_ignored",
          "manipulable_vote_as_stable_preference",
          "stakeholder_map_missing_for_release",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyNormativeAuthorityDrift = path.join(
      dir,
      superOntologyNormativeAuthorityDriftFile,
    );
    if (!fs.existsSync(superOntologyNormativeAuthorityDrift)) {
      fs.writeFileSync(superOntologyNormativeAuthorityDrift, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-normative-authority-drift",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "normative_authority_required_before_policy_legal_compliance_contract_license_consent_or_runtime_write",
        authorityTypes: [
          "law",
          "regulation",
          "contract",
          "terms_of_service",
          "internal_policy",
          "security_policy",
          "privacy_policy",
          "data_retention_policy",
          "license",
          "standard",
          "professional_guideline",
          "customer_commitment",
          "board_decision",
          "manager_directive",
          "emergency_exception",
        ],
        scopeDimensions: [
          "jurisdiction",
          "effective_date",
          "expiry_date",
          "organization",
          "workspace",
          "role",
          "customer_segment",
          "data_category",
          "system_surface",
          "action_type",
          "retention_period",
          "transfer_region",
          "license_scope",
          "exception_scope",
        ],
        conflictTypes: [
          "stale_authority",
          "wrong_jurisdiction",
          "draft_vs_enforced",
          "superseded_rule",
          "authority_conflict",
          "exception_misuse",
          "translation_mismatch",
          "summary_vs_primary_source",
          "role_authority_gap",
          "license_conflict",
          "retention_conflict",
          "cross_border_conflict",
          "emergency_override",
          "professional_boundary",
        ],
        effectiveTimeStates: [
          "current",
          "stale",
          "future_effective",
          "expired",
          "draft",
          "superseded",
          "unknown",
          "exception_active",
          "emergency_exception",
        ],
        jurisdictionStates: [
          "in_scope",
          "out_of_scope",
          "mixed",
          "unknown",
          "cross_border",
          "local_only",
          "global_claim_unverified",
        ],
        authorityHierarchyRules: [
          "primary_source_precedence",
          "newer_version_precedence",
          "contract_clause_precedence",
          "stricter_rule_precedence",
          "local_law_precedence",
          "internal_policy_after_law",
          "exception_requires_owner_expiry",
          "human_legal_review",
          "no_precedence_available",
        ],
        requiredAuthorityEvidence: [
          "primary_source_ref",
          "effective_date",
          "version_id",
          "jurisdiction_scope",
          "authority_owner",
          "precedence_rule",
          "exception_owner",
          "expiry_or_review_date",
          "policy_citation",
          "contract_clause",
          "license_text",
          "retention_rule",
          "transfer_rule",
          "review_owner",
          "rollback_plan",
          "audit_trail",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "human_review_required",
          "policy_review_required",
          "legal_review_required",
          "security_review_required",
          "quarantine",
          "block_write",
          "rollback",
          "emergency_stop",
        ],
        researchBasis: [
          "legal_informatics",
          "governance_risk_compliance",
          "policy_as_code",
          "compliance_automation",
          "temporal_knowledge_graphs",
          "deontic_logic",
          "defeasible_reasoning",
          "regulatory_change_management",
          "records_management",
          "data_protection",
          "software_supply_chain_governance",
          "provenance_standards",
          "rights_expression_language",
          "ai_management_systems",
        ],
        hardStops: [
          "missing_normative_authority_drift_contract",
          "stale_policy_as_current_rule",
          "wrong_jurisdiction_as_valid_policy",
          "draft_policy_as_enforced_rule",
          "superseded_contract_as_current_authority",
          "terms_of_service_without_effective_date",
          "local_custom_as_global_policy",
          "internal_preference_as_legal_requirement",
          "policy_exception_without_owner",
          "conflicting_authorities_without_precedence",
          "regulation_summary_as_primary_law",
          "compliance_claim_without_citation",
          "policy_translation_as_authoritative_text",
          "expired_consent_as_current_permission",
          "missing_retention_or_deletion_rule",
          "cross_border_transfer_without_jurisdiction",
          "licensing_constraint_ignored",
          "audit_requirement_missing_before_release",
          "emergency_exception_without_expiry",
          "legal_advice_without_review",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySideEffectContainment = path.join(
      dir,
      superOntologySideEffectContainmentFile,
    );
    if (!fs.existsSync(superOntologySideEffectContainment)) {
      fs.writeFileSync(superOntologySideEffectContainment, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-side-effect-containment",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "containment_required_before_external_file_finance_release_message_route_memory_training_or_physical_action",
        sideEffectClasses: [
          "file_mutation",
          "external_message",
          "payment_or_finance",
          "customer_record_update",
          "public_release",
          "account_permission_change",
          "data_transfer",
          "memory_write",
          "training_update",
          "code_execution",
          "physical_actuation",
          "scheduled_job",
          "multi_system_workflow",
          "legal_or_compliance_commitment",
        ],
        actionSurfaces: [
          "local_file_system",
          "email_or_chat",
          "crm_or_customer_system",
          "payment_or_procurement",
          "public_web_or_social",
          "release_pipeline",
          "cloud_admin",
          "database_write",
          "memory_curator",
          "training_pipeline",
          "physical_or_sensor",
          "appbridge_route",
          "hosted_connector",
          "shell_or_code_runner",
        ],
        reversibilityStates: [
          "read_only",
          "preview_only",
          "reversible",
          "compensable",
          "retryable_after_pivot",
          "irreversible",
          "unknown",
        ],
        transactionBoundaries: [
          "single_local_transaction",
          "saga_compensating_transaction",
          "external_api_commit",
          "human_approval_boundary",
          "two_phase_commit_required",
          "no_transaction_boundary",
          "scheduled_future_commit",
          "physical_world_boundary",
        ],
        idempotencyStates: [
          "idempotent_key_present",
          "idempotent_by_design",
          "non_idempotent",
          "duplicate_risk_unknown",
          "retry_guard_missing",
          "replay_safe_dry_run",
        ],
        blastRadii: [
          "user_local",
          "workspace",
          "customer",
          "organization",
          "public",
          "financial",
          "legal_compliance",
          "physical_safety",
          "cross_system",
          "cross_border_data",
        ],
        externalCommitStates: [
          "not_committed",
          "dry_run_only",
          "pending_human_commit",
          "committed_with_receipt",
          "partial_commit",
          "ambiguous_commit",
          "scheduled_commit",
          "irreversible_commit",
        ],
        requiredContainmentEvidence: [
          "user_intent_span",
          "tool_scope",
          "auth_scope",
          "idempotency_key",
          "dry_run_receipt",
          "preflight_diff",
          "approval_receipt",
          "transaction_log",
          "compensation_action",
          "rollback_snapshot",
          "cancellation_path",
          "rate_limit_budget",
          "blast_radius_bound",
          "external_commit_receipt",
          "audit_trace",
          "policy_gate_ref",
          "memory_ticket_ref",
          "safety_interlock",
          "operator_owner",
          "post_action_verification",
        ],
        decisions: [
          "allow_read",
          "allow_dry_run",
          "prepare_only",
          "ask_clarify",
          "human_approval_required",
          "policy_review_required",
          "security_review_required",
          "containment_required",
          "block_execute",
          "rollback",
          "compensate",
          "emergency_stop",
        ],
        researchBasis: [
          "excessive_agency",
          "least_privilege",
          "systems_security_engineering",
          "saga_pattern",
          "compensating_transaction",
          "idempotent_workflow",
          "human_in_the_loop",
          "complete_mediation",
          "rate_limiting",
          "auditability",
          "safety_engineering",
          "transaction_processing",
          "secure_agent_guardrails",
          "disaster_recovery",
        ],
        hardStops: [
          "missing_side_effect_containment_contract",
          "read_permission_as_write_permission",
          "preview_as_send",
          "dry_run_result_as_committed",
          "non_idempotent_retry_to_external_action",
          "irreversible_action_without_human_approval",
          "deletion_without_recovery_plan",
          "payment_without_idempotency_key",
          "customer_message_without_review",
          "release_without_rollback",
          "connector_write_without_scope",
          "cross_tool_chain_without_transaction",
          "compensation_plan_missing",
          "blast_radius_unknown",
          "idempotency_key_missing",
          "external_commit_without_receipt",
          "partial_failure_without_saga_state",
          "physical_action_without_safety_interlock",
          "scheduled_action_without_cancellation",
          "side_effect_logging_missing",
          "hosted_tool_without_local_side_effect_wrapper",
        ],
      }, null, 2), "utf8");
    }
    const superOntologySourceLineageVersion = path.join(
      dir,
      superOntologySourceLineageVersionFile,
    );
    if (!fs.existsSync(superOntologySourceLineageVersion)) {
      fs.writeFileSync(superOntologySourceLineageVersion, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-source-lineage-version",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "lineage_required_before_graph_memory_public_training_tool_or_route_authority",
        documentFamilies: [
          "policy",
          "contract",
          "sales_deck",
          "spreadsheet",
          "hwp_doc",
          "pdf_export",
          "email_attachment",
          "crm_record",
          "code_artifact",
          "dataset",
          "model_artifact",
          "sensor_log",
          "meeting_notes",
          "public_web_page",
        ],
        sourceArtifactTypes: [
          "primary_document",
          "derived_document",
          "exported_pdf",
          "spreadsheet_workbook",
          "sheet_tab",
          "email_message",
          "attachment",
          "connector_record",
          "database_snapshot",
          "web_snapshot",
          "chunk",
          "embedding_vector",
          "summary",
          "translation",
          "redacted_copy",
          "dataset_snapshot",
          "model_checkpoint",
          "sensor_batch",
        ],
        requiredLineageEvidence: [
          "source_uri",
          "source_checksum",
          "content_hash",
          "version_id",
          "revision_id",
          "effective_date",
          "capture_time",
          "transformation_log",
          "derivation_chain",
          "parent_artifact_ref",
          "primary_source_ref",
          "authority_owner",
          "approval_record",
          "deprecation_record",
          "supersedes_ref",
          "checksum_or_signature",
          "connector_snapshot_id",
          "parser_version",
          "chunk_span",
          "memory_ticket_ref",
          "audit_trace",
          "rollback_snapshot",
        ],
        decisions: [
          "allow_read",
          "candidate_only",
          "ask_clarify",
          "lineage_repair_required",
          "source_owner_review_required",
          "deprecate",
          "quarantine",
          "block_graph_write",
          "block_memory_write",
          "block_public_export",
          "rollback",
        ],
        hardStops: [
          "missing_source_lineage_version_contract",
          "filename_as_version",
          "latest_folder_as_current_source",
          "pdf_export_as_primary_source",
          "summary_as_primary_source",
          "ocr_text_without_source_span",
          "spreadsheet_sheet_without_workbook_revision",
          "email_attachment_without_message_context",
          "duplicate_title_as_same_artifact",
          "checksum_missing_for_authoritative_source",
          "stale_cache_as_current_record",
          "connector_snapshot_without_capture_time",
          "transitive_derivation_as_primary_source",
          "merged_record_without_parent_refs",
          "redacted_copy_as_complete_source",
          "translation_as_authoritative_source",
          "chunk_without_source_span",
          "embedding_hit_without_artifact_version",
          "memory_fact_without_lineage",
          "public_export_without_lineage_evidence",
          "training_example_without_dataset_version",
          "graph_edge_without_derivation_chain",
          "superseded_source_to_runtime_write",
          "lineage_cycle_unresolved",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyEntityIdentityResolution = path.join(
      dir,
      superOntologyEntityIdentityResolutionFile,
    );
    if (!fs.existsSync(superOntologyEntityIdentityResolution)) {
      fs.writeFileSync(superOntologyEntityIdentityResolution, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-entity-identity-resolution",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision: "identity_evidence_required_before_canonical_graph_memory_public_training_tool_or_route_authority",
        entityFamilies: [
          "person",
          "company",
          "customer_account",
          "vendor",
          "product",
          "project",
          "model",
          "location",
          "team",
          "patient_or_user",
          "device",
          "document",
        ],
        mentionArtifactTypes: [
          "name_string",
          "alias",
          "email_address",
          "phone_number",
          "domain",
          "crm_id",
          "employee_id",
          "spreadsheet_row",
          "external_uri",
          "embedding_cluster",
          "llm_generated_canonical",
          "redacted_identifier",
        ],
        requiredIdentityEvidence: [
          "canonical_entity_id",
          "source_system_id",
          "entity_type",
          "source_uri",
          "source_span",
          "negative_evidence",
          "disambiguating_attributes",
          "temporal_validity",
          "tenant_or_context_id",
          "privacy_basis",
          "owner_review",
          "merge_policy",
          "split_policy",
          "tombstone_record",
          "audit_trace",
          "rollback_snapshot",
        ],
        hardStops: [
          "missing_entity_identity_resolution_contract",
          "name_as_identity",
          "email_domain_as_company",
          "fuzzy_match_as_merge",
          "embedding_cluster_as_identity",
          "llm_canonical_name_as_id",
          "crm_id_cross_tenant_merge",
          "recycled_employee_id_as_same_person",
          "redacted_name_as_public_identity",
          "stale_alias_as_current_entity",
          "relationship_edge_without_identity_evidence",
          "memory_note_as_identity_authority",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyTemporalStateTransition = path.join(
      dir,
      superOntologyTemporalStateTransitionFile,
    );
    if (!fs.existsSync(superOntologyTemporalStateTransition)) {
      fs.writeFileSync(superOntologyTemporalStateTransition, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-temporal-state-transition",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "temporal_state_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_or_customer_authority",
        stateSubjectFamilies: [
          "person",
          "company",
          "customer_account",
          "vendor",
          "product",
          "project",
          "policy",
          "contract",
          "dataset",
          "model",
          "document",
          "workflow",
          "task",
          "asset",
          "device",
          "payment",
          "permission",
          "release",
          "memory_fact",
          "graph_edge",
        ],
        eventArtifactTypes: [
          "timestamp",
          "valid_interval",
          "transaction_record",
          "event_log_entry",
          "state_snapshot",
          "spreadsheet_row",
          "document_revision",
          "calendar_event",
          "webhook_event",
          "connector_delta",
          "message_thread",
          "scheduled_job",
          "audit_log",
          "migration_batch",
          "derived_projection",
          "llm_summary",
          "memory_note",
          "graph_edge",
        ],
        requiredTemporalEvidence: [
          "valid_time",
          "transaction_time",
          "event_id",
          "event_sequence",
          "source_uri",
          "source_span",
          "pre_state",
          "post_state",
          "transition_guard",
          "idempotency_key",
          "replay_log",
          "rollback_snapshot",
          "projection_version",
          "owner_review",
          "audit_trace",
          "tombstone_record",
          "scheduler_receipt",
          "post_action_verification",
        ],
        hardStops: [
          "missing_temporal_state_transition_contract",
          "current_snapshot_as_truth",
          "missing_valid_time",
          "missing_transaction_time",
          "local_timestamp_as_global_order",
          "spreadsheet_order_as_event_order",
          "llm_summary_as_event_log",
          "late_event_ignored",
          "retroactive_correction_without_tx_history",
          "future_effective_as_current",
          "expired_state_as_active",
          "deleted_state_without_tombstone",
          "non_idempotent_replay",
          "materialized_view_as_source_of_truth",
          "projection_without_version",
          "recurring_event_without_rule",
          "timezone_free_deadline",
          "stale_cache_as_current",
          "state_transition_without_precondition",
          "partial_failure_as_success",
          "clock_skew_as_fact",
          "scheduled_job_without_receipt",
          "memory_fact_without_validity_interval",
          "graph_edge_without_temporal_bounds",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyCapabilityDelegationAuthority = path.join(
      dir,
      superOntologyCapabilityDelegationAuthorityFile,
    );
    if (!fs.existsSync(superOntologyCapabilityDelegationAuthority)) {
      fs.writeFileSync(superOntologyCapabilityDelegationAuthority, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-capability-delegation-authority",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "capability_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_customer_or_physical_authority",
        principalTypes: [
          "human_user",
          "delegated_agent",
          "child_agent",
          "service_account",
          "oauth_client",
          "api_key_holder",
          "mcp_tool",
          "scheduler",
          "workflow_runner",
          "enterprise_connector",
          "browser_session",
          "unknown_principal",
        ],
        capabilityArtifactTypes: [
          "role",
          "group_membership",
          "oauth_scope",
          "api_key",
          "service_account_key",
          "session_cookie",
          "tool_schema",
          "policy_decision",
          "approval_record",
          "delegation_token",
          "agent_identity_token",
          "signed_attestation",
          "capability_token",
          "cached_authorization_decision",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "scheduled_authority",
          "permission_authority",
          "financial_authority",
          "release_authority",
          "customer_output_authority",
          "physical_authority",
        ],
        requiredCapabilityEvidence: [
          "actor_identity",
          "agent_identity",
          "user_intent",
          "task_id",
          "workflow_step",
          "delegation_chain",
          "parent_capability",
          "policy_decision",
          "policy_version",
          "resource_id",
          "operation",
          "scope",
          "purpose",
          "caveat_set",
          "consent_record",
          "owner_approval",
          "time_bound",
          "recipient_bound",
          "environment_context",
          "proof_of_possession",
          "revocation_check",
          "audit_trace",
          "rollback_snapshot",
          "post_action_verification",
        ],
        hardStops: [
          "role_as_capability",
          "oauth_scope_as_task_permission",
          "api_key_as_actor",
          "read_access_as_write_authority",
          "parent_agent_unbounded_delegation",
          "delegation_chain_missing",
          "purpose_mismatch_authority",
          "capability_without_caveats",
          "stale_capability_token_as_current",
          "cross_context_capability_reuse",
          "capability_escalation_by_tool_choice",
          "subagent_exceeds_parent_authority",
          "human_consent_reused_for_new_purpose",
          "permission_prompt_as_policy",
          "tool_schema_as_authorization",
          "cached_auth_decision_without_fresh_context",
          "break_glass_without_expiry",
          "admin_role_as_all_actions",
          "shared_service_account_as_identity",
          "task_goal_as_permission",
          "hidden_tool_call_without_policy_decision",
        ],
        researchBasis: [
          "least_privilege",
          "zero_trust",
          "abac",
          "rebac",
          "capability_security",
          "macaroons",
          "zanzibar",
          "oauth_oidc",
          "oidc_agents",
          "agentic_jwt",
          "privilege_control",
          "contextual_integrity",
          "policy_as_code",
          "proof_of_possession",
          "auditability",
          "delegation_logic",
          "threat_modeling",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyPrivacyConfidentialityBoundary = path.join(
      dir,
      superOntologyPrivacyConfidentialityBoundaryFile,
    );
    if (!fs.existsSync(superOntologyPrivacyConfidentialityBoundary)) {
      fs.writeFileSync(superOntologyPrivacyConfidentialityBoundary, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-privacy-confidentiality-boundary",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "privacy_boundary_evidence_required_before_graph_memory_public_training_tool_route_customer_output_personalization_retrieval_or_analytics_authority",
        dataClassifications: [
          "public",
          "internal",
          "confidential",
          "restricted",
          "regulated_pii",
          "sensitive_pii",
          "credentials_or_secret",
          "financial",
          "health",
          "legal_privileged",
          "biometric",
          "location",
          "behavioral_profile",
          "inferred_sensitive",
          "unknown",
        ],
        boundarySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "customer_output_authority",
          "personalization_authority",
          "retrieval_authority",
          "analytics_authority",
        ],
        requiredPrivacyEvidence: [
          "data_classification",
          "sensitivity_label",
          "source_span",
          "data_subject_category",
          "controller_or_owner",
          "processing_purpose",
          "legal_basis_or_owner_approval",
          "consent_or_confidentiality_basis",
          "audience",
          "minimization_reason",
          "redaction_policy",
          "retention_policy",
          "deletion_or_legal_hold_state",
          "transfer_basis",
          "model_trust_tier",
          "training_allowed_flag",
          "public_disclosure_allowed_flag",
          "access_policy_decision",
          "audit_trace",
          "rollback_snapshot",
          "breach_response_owner",
          "reidentification_risk_assessment",
          "vector_index_policy",
          "memory_write_scope",
        ],
        hardStops: [
          "pii_as_normal_fact",
          "secret_as_graph_label",
          "confidential_deck_as_public_context",
          "consent_missing",
          "legal_basis_missing",
          "purpose_reuse_without_review",
          "training_on_private_material",
          "public_export_without_redaction",
          "retention_expired_memory",
          "data_subject_delete_ignored",
          "cross_tenant_context_bleed",
          "customer_data_as_demo",
          "personal_life_as_company_context",
          "employee_note_as_hr_decision",
          "inferred_sensitive_attribute_public",
          "redacted_text_reidentified",
          "connector_cache_as_allowed_use",
          "screenshot_ocr_without_classification",
          "embedding_of_secret_without_policy",
          "vector_search_leaks_private_neighbors",
          "shared_memory_without_audience_boundary",
          "confidential_source_in_prompt_to_untrusted_model",
          "trade_secret_as_embedding_neighbor",
          "legal_privilege_lost_by_disclosure",
        ],
        researchBasis: [
          "nist_privacy_framework",
          "nist_pii_confidentiality",
          "oecd_privacy_principles",
          "gdpr_principles",
          "contextual_integrity",
          "data_minimization",
          "purpose_limitation",
          "privacy_by_design",
          "information_flow_control",
          "privacy_risk_management",
          "reidentification_risk",
          "secrets_management",
          "records_retention",
          "zero_trust",
          "auditability",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyStrategicIncentiveCompatibility = path.join(
      dir,
      superOntologyStrategicIncentiveCompatibilityFile,
    );
    if (!fs.existsSync(superOntologyStrategicIncentiveCompatibility)) {
      fs.writeFileSync(superOntologyStrategicIncentiveCompatibility, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-strategic-incentive-compatibility",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "incentive_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_or_personalization_authority",
        incentiveSignalTypes: [
          "kpi_bonus",
          "commission",
          "promotion",
          "cost_savings",
          "approval_rate",
          "benchmark_score",
          "customer_rating",
          "retention_metric",
          "compliance_attestation",
          "vote_power",
          "access_grant",
          "data_payment",
          "social_status",
          "family_pressure",
          "none_declared",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "release_authority",
          "financial_authority",
          "hiring_authority",
          "policy_authority",
          "customer_output_authority",
          "analytics_authority",
          "evaluation_authority",
          "personalization_authority",
        ],
        requiredIncentiveEvidence: [
          "principal_id",
          "agent_id",
          "role_or_delegation",
          "private_information_inventory",
          "objective_function",
          "payoff_or_reward_model",
          "conflict_of_interest_disclosure",
          "strategic_behavior_hypothesis",
          "counterfactual_truthfulness_check",
          "holdout_or_audit_sample",
          "independent_verification",
          "collusion_check",
          "peer_pressure_check",
          "mechanism_constraint",
          "counter_incentive",
          "review_owner",
          "appeal_or_challenge_path",
          "audit_trace",
          "rollback_snapshot",
          "post_decision_monitoring",
          "data_quality_contribution",
          "budget_or_transfer_rule",
          "incentive_compatibility_argument",
          "residual_incentive_risk",
        ],
        hardStops: [
          "self_report_as_truth",
          "kpi_as_objective",
          "commission_report_as_fact",
          "manager_approval_as_no_conflict",
          "vendor_claim_as_source_quality",
          "customer_rating_as_value",
          "agent_vote_as_independent_signal",
          "benchmark_score_as_general_capability",
          "cheap_provider_as_best_provider",
          "data_provider_label_as_quality",
          "compliance_attestation_as_compliance",
          "peer_pressure_as_consensus",
          "hidden_affiliation_as_neutral_review",
          "survey_response_as_stable_preference",
          "retention_metric_as_satisfaction",
          "access_request_as_need_to_know",
          "family_pressure_as_user_preference",
          "approval_chain_as_truthfulness",
          "cost_saving_as_system_health",
          "strategic_silence_as_no_risk",
          "collusive_agents_as_quorum",
          "mechanism_missing_to_runtime_write",
          "incentive_conflict_to_memory_write",
          "reward_model_as_human_goal",
        ],
        researchBasis: [
          "mechanism_design",
          "incentive_compatibility",
          "principal_agent_theory",
          "information_asymmetry",
          "moral_hazard",
          "adverse_selection",
          "strategic_classification",
          "goodhart_law",
          "campbell_law",
          "game_theory",
          "multi_agent_systems",
          "nist_ai_rmf",
          "nist_genai_profile",
          "oecd_ai_principles",
          "auditability",
          "human_factors",
        ],
      }, null, 2), "utf8");
    }
    const superOntologyTaskCoverage = path.join(dir, superOntologyTaskCoverageFile);
    const superOntologyReflexiveFeedbackStability = path.join(dir, superOntologyReflexiveFeedbackStabilityFile);
    if (!fs.existsSync(superOntologyReflexiveFeedbackStability)) {
      fs.writeFileSync(superOntologyReflexiveFeedbackStability, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-reflexive-feedback-stability",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        defaultDecision:
          "feedback_stability_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_physical_or_personalization_authority",
        interventionTypes: [
          "recommendation",
          "ranking",
          "notification",
          "automation",
          "memory_write",
          "retrieval_biasing",
          "dashboard_metric",
          "pricing_or_budget_change",
          "training_update",
          "route_update",
          "access_policy_change",
          "social_prompt",
          "customer_message",
          "physical_action",
          "none_declared",
        ],
        loopSignalTypes: [
          "post_intervention_observation",
          "behavior_change",
          "data_distribution_shift",
          "self_generated_content",
          "model_output_reuse",
          "metric_response",
          "user_adaptation",
          "agent_self_evaluation",
          "market_response",
          "social_contagion",
          "scheduler_replay",
        ],
        authoritySurfaces: [
          "graph_authority",
          "memory_authority",
          "public_export_authority",
          "training_authority",
          "tool_authority",
          "route_authority",
          "release_authority",
          "financial_authority",
          "hiring_authority",
          "policy_authority",
          "customer_output_authority",
          "analytics_authority",
          "evaluation_authority",
          "personalization_authority",
          "physical_authority",
        ],
        requiredFeedbackEvidence: [
          "intervention_id",
          "pre_intervention_baseline",
          "feedback_path_map",
          "time_lag_window",
          "post_intervention_observation",
          "counterfactual_or_holdout",
          "real_world_data_anchor",
          "synthetic_data_ratio",
          "stability_margin_or_error_budget",
          "damping_or_rate_limit",
          "saturation_bound",
          "externality_map",
          "affected_stakeholders",
          "monitoring_trace",
          "rollback_snapshot",
          "stop_condition",
          "owner_review",
          "residual_feedback_risk",
        ],
        hardStops: [
          "observation_after_intervention_as_neutral_truth",
          "recommendation_effect_as_preference",
          "self_generated_content_as_training_data",
          "model_output_as_source_corpus",
          "dashboard_change_as_system_improvement",
          "metric_response_as_real_world_gain",
          "repeated_retrieval_as_relevance",
          "agent_self_score_as_external_feedback",
          "closed_loop_without_counterfactual",
          "runaway_feedback_to_runtime_write",
          "oscillation_as_adaptation",
          "delayed_harm_ignored",
          "synthetic_data_loop_as_real_distribution",
          "intervention_without_stop_condition",
          "user_adaptation_as_stable_preference",
          "market_response_as_causal_truth",
          "personal_nudge_as_identity_change",
          "training_on_ai_outputs_without_real_anchor",
          "feedback_loop_to_memory_write",
          "feedback_loop_to_policy_write",
          "externality_free_assumption",
        ],
        researchBasis: [
          "performative_prediction",
          "control_theory",
          "cybernetics",
          "systems_dynamics",
          "model_collapse",
          "distribution_shift",
          "causal_inference",
          "reinforcement_learning_feedback",
          "human_factors",
          "fairness_feedback_loops",
          "nist_ai_rmf",
          "safety_engineering",
          "ecological_feedback",
          "social_contagion",
        ],
      }, null, 2), "utf8");
    }

    if (!fs.existsSync(superOntologyTaskCoverage)) {
      fs.writeFileSync(superOntologyTaskCoverage, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-super-ontology-task-coverage",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        runtimePromotionAllowed: false,
        taskFamilies: [
          "retrieve_answer",
          "summarize_synthesize",
          "draft_artifact",
          "transform_format",
          "analyze_decide",
          "plan_sequence",
          "coordinate_social",
          "execute_tool",
          "monitor_repair",
          "personalize_memory",
          "regulated_boundary",
          "multimodal_generate",
          "physical_or_sensor",
          "software_change",
          "financial_or_compliance",
          "education_or_coaching",
        ],
        affordanceTypes: [
          "read",
          "draft",
          "write",
          "publish",
          "execute",
          "physical",
          "train",
        ],
        evidenceModes: [
          "citation",
          "current_approved_source",
          "owner_authority",
          "policy_or_law",
          "measurement_or_dataset",
          "license_or_consent",
          "runtime_test",
          "rollback_plan",
        ],
        defaultDecision: "classify_before_action",
        hardStops: [
          "missing_task_family",
          "missing_affordance_type",
          "missing_evidence_mode",
          "write_without_rollback",
          "publish_execute_physical_or_train_without_authority",
        ],
      }, null, 2), "utf8");
    }
    for (const fileName of [
      superOntologyReplaysFile,
      superOntologyEvidenceFile,
      superOntologyMemoryBridgeFile,
    ]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    return dir;
  } catch { return null; }
}

const ONTOLOGY_SUPPORTED_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv"]);

function ontologyPathsForCli(projectPath) {
  const arch = loadArch();
  const root = path.resolve(projectPath || process.cwd());
  const memoryDir = path.join(root, arch.memoryDir || ".agentlas");
  return {
    root,
    memoryDir,
    configPath: path.join(memoryDir, arch.ontologyRuntimeFile || "ontology-runtime.json"),
    sourceManifestPath: path.join(memoryDir, arch.ontologySourceManifestFile || "ontology-sources.json"),
    inboxPath: path.join(memoryDir, arch.ontologyInboxDir || "ontology-inbox"),
    dbPath: path.join(memoryDir, arch.ontologyDbFile || "ontology-runtime.sqlite"),
  };
}

function readJsonSafeCli(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafeCli(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
// 원자적(temp+rename) + 소유자 전용(0600) JSON 쓰기. 세션 ID/경로 등 민감 상태 파일용:
// (1) 크래시 중간 쓰기로 JSON이 깨져 routesMap()이 {}를 돌려주며 임포트 매핑을 통째로 잃던 사고,
// (2) 기본 umask(0644)로 cli-sessions.json/agent-routes.json이 world-readable이던 정보 노출을 함께 막는다.
function writeJsonPrivateAtomicCli(filePath, value) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* 일부 FS는 chmod 미지원 — best-effort */ }
}

function ontologySourceManifestSkeletonCli(root) {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-ontology-source-manifest",
    projectRoot: root,
    sources: [],
  };
}

function ensureOntologyCli(projectPath) {
  const paths = ontologyPathsForCli(projectPath);
  ensureProjectMemoryCli(paths.root, path.basename(paths.root) || "Project");
  fs.mkdirSync(paths.inboxPath, { recursive: true });
  if (!fs.existsSync(paths.sourceManifestPath)) {
    writeJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  }
  return paths;
}

function listOntologyInboxCli(inboxPath) {
  try {
    if (!fs.existsSync(inboxPath)) return [];
    return fs.readdirSync(inboxPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const full = path.join(inboxPath, entry.name);
        const stat = fs.statSync(full);
        const isDir = entry.isDirectory();
        const ext = path.extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          path: full,
          kind: isDir ? "dir" : "file",
          size: isDir ? 0 : stat.size,
          supported: isDir || ONTOLOGY_SUPPORTED_EXTS.has(ext),
        };
      })
      .slice(0, 80);
  } catch {
    return [];
  }
}

function readOntologySourcesCli(sourceManifestPath) {
  const manifest = readJsonSafeCli(sourceManifestPath, { sources: [] });
  return Array.isArray(manifest.sources) ? manifest.sources : [];
}

function ontologyUsageLinesCli() {
  return [
    "Ontology commands:",
    "  /ontology                         turn on/show this project's ontology",
    "  /ontology list                    list inbox files and registered folders",
    "  /ontology open                    open the project ontology inbox",
    "  /ontology add ./docs              register a folder as private project knowledge",
    "  /ontology company ./docs          register company docs as private",
    "  /ontology personal ~/notes        register personal docs as private",
    "",
    "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
    "",
    "Safety: only the current project inbox and registered folders are used.",
    "No home folder or sibling project scan is started.",
  ];
}

function shellSplitCli(text) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of String(text || "")) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function expandUserPathCli(value) {
  const v = String(value || "").trim();
  if (v === "~") return os.homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return path.join(os.homedir(), v.slice(2));
  return v;
}

function cleanOntologyPathTokenCli(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^[`"']+|[`"',;]+$/g, "");
}

function resolveOntologyPathCli(value, cwd) {
  const clean = expandUserPathCli(cleanOntologyPathTokenCli(value));
  return path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd || process.cwd(), clean);
}

function inferOntologyKindCli(value, text) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["company", "work", "business", "corp", "team", "회사", "업무", "팀", "조직"].includes(v) || /(company|work|business|corp|team|회사|업무|조직)/i.test(hay)) return "company";
  if (["personal", "private-life", "life", "me", "개인", "내자료", "일상"].includes(v) || /(personal|private-life|\bme\b|개인|내\s*자료|일상)/i.test(hay)) return "personal";
  if (["project", "repo", "프로젝트", "레포"].includes(v) || /(project|repo|프로젝트|레포)/i.test(hay)) return "project";
  return "project";
}

function inferOntologyScopeCli(value, text, kind) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["public", "open", "공개"].includes(v) || /(public|open|공개)/i.test(hay)) return "public";
  if (["internal", "team", "내부", "팀"].includes(v) || /(internal|team-only|company-wide|내부|팀\s*공유|회사\s*공유)/i.test(hay)) return "internal";
  if (["private", "secret", "local", "비공개", "개인"].includes(v) || /(private|secret|local-only|비공개|개인만|나만)/i.test(hay)) return "private";
  return kind === "company" || kind === "personal" ? "private" : "private";
}

function isOntologyPathishCli(token, cwd, allowExistingName) {
  const clean = cleanOntologyPathTokenCli(token);
  if (!clean || clean === "." || clean === "..") return true;
  if (/^(?:~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(clean)) return true;
  if (clean.includes("/") || clean.includes("\\")) return true;
  if (allowExistingName) {
    try {
      return fs.existsSync(resolveOntologyPathCli(clean, cwd));
    } catch {
      return false;
    }
  }
  return false;
}

function findOntologyPathTokenCli(tokens, cwd, text) {
  const lower = String(text || "").toLowerCase();
  const addIntent = /(add|register|attach|source|folder|watch|sync|추가|등록|붙|연결|폴더|자료|문서)/i.test(lower);
  const skip = new Set([
    "add", "register", "attach", "source", "sources", "folder", "folders", "watch", "sync", "use",
    "company", "personal", "project", "private", "internal", "public", "work", "business",
    "추가", "등록", "붙여", "붙여줘", "연결", "켜줘", "켜", "회사", "개인", "프로젝트", "자료", "문서", "폴더", "비공개", "내부", "공개",
  ]);
  for (const token of tokens) {
    const clean = cleanOntologyPathTokenCli(token);
    if (!clean || skip.has(clean.toLowerCase())) continue;
    if (isOntologyPathishCli(clean, cwd, addIntent)) return clean;
  }
  return null;
}

function parseOntologyNaturalArgsCli(text, cwd) {
  const raw = String(text || "").trim();
  if (!raw) return ["status"];
  const lower = raw.toLowerCase();
  if (/^(?:help|\?|도움|사용법)\b/i.test(raw)) return ["help"];
  if (/(?:^|\s)(?:list|ls|sources?|status|show|상태|목록|리스트)(?:\s|$)/i.test(raw)) return ["list"];
  if (/(?:^|\s)(?:open|inbox|finder|열어|열기|인박스)(?:\s|$)/i.test(raw)) return ["open"];
  const tokens = shellSplitCli(raw);
  const kind = inferOntologyKindCli(null, raw);
  const scope = inferOntologyScopeCli(null, raw, kind);
  let source = findOntologyPathTokenCli(tokens, cwd, raw);
  if (!source && /(?:this folder|current folder|here|이\s*폴더|현재\s*폴더|지금\s*폴더|여기)/i.test(raw)) source = ".";
  const wantsAdd = Boolean(source) || /(add|register|attach|source|watch|sync|추가|등록|붙|연결)/i.test(lower);
  if (wantsAdd) {
    if (!source) return ["add"];
    return ["add", source, "--kind", kind, "--scope", scope];
  }
  if (/(enable|activate|start|turn on|켜|시작|활성)/i.test(lower)) return ["status"];
  return ["status"];
}

function formatOntologyStatusCli(paths) {
  const sources = readOntologySourcesCli(paths.sourceManifestPath);
  const inbox = listOntologyInboxCli(paths.inboxPath);
  const lines = [
    "Ontology: active",
    `  project: ${paths.root}`,
    `  inbox:  ${paths.inboxPath}`,
    `  db:     ${paths.dbPath}`,
    "  policy: inbox_and_registered_sources_only",
    "  scan:   no home folder, no sibling projects",
    "",
    `Inbox (${inbox.length}):`,
  ];
  for (const item of inbox) lines.push(`  ${item.supported ? "✓" : "!"} ${item.name}  ${item.supported ? "supported" : "adapter pending"}`);
  if (!inbox.length) lines.push("  (empty)");
  lines.push("", `Sources (${sources.length}):`);
  for (const source of sources) {
    const sourcePath = path.resolve(String(source.path || ""));
    lines.push(`  ${fs.existsSync(sourcePath) ? "✓" : "!"} ${sourcePath}  ${source.kind || "project"} / ${source.scope || "internal"}`);
  }
  if (!sources.length) lines.push("  (none)");
  lines.push(
    "",
    "Add sources:",
    "  /ontology add ./docs",
    "  /ontology company ./docs",
    "  /ontology personal ~/notes",
    "",
    "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
  );
  return lines;
}

function registerOntologySourceCli(paths, source, kind, scope, cwd) {
  if (!source) throw new Error("usage: /ontology add <path>  or  /ontology company ./docs");
  const sourcePath = resolveOntologyPathCli(source, cwd || paths.root);
  if (!fs.existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);
  const manifest = readJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  const nextSources = (Array.isArray(manifest.sources) ? manifest.sources : [])
    .filter((item) => path.resolve(String(item.path || "")) !== sourcePath);
  nextSources.push({ path: sourcePath, kind, scope, registeredAt: new Date().toISOString() });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-ontology-source-manifest";
  manifest.projectRoot = paths.root;
  manifest.sources = nextSources;
  writeJsonSafeCli(paths.sourceManifestPath, manifest);
  return [
    `Registered ontology source: ${sourcePath}`,
    `  kind:  ${kind}`,
    `  scope: ${scope}`,
    "  copy:  no",
    "  scan:  only this registered folder, not home/sibling projects",
  ];
}

function runOntologyCli(args, opts) {
  opts = opts || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  const projectPath = path.resolve(opts.projectPath || cwd);
  const normalizedArgs = Array.isArray(args) ? args : [];
  const sub = normalizedArgs[0] || "status";
  const paths = ensureOntologyCli(projectPath);
  if (sub === "status" || sub === "list") {
    return formatOntologyStatusCli(paths);
  }
  if (sub === "open") {
    if (!opts.noOpen) openLocalPathCli(paths.inboxPath);
    return [`Opened ontology inbox: ${paths.inboxPath}`];
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return ontologyUsageLinesCli();
  }
  if (sub === "add") {
    const flags = parseCloudFlags(normalizedArgs.slice(1));
    const source = flags._[0];
    const kind = inferOntologyKindCli(flags.kind || flags._[1], normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[2], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, source, kind, scope, cwd);
  }
  if (["company", "personal", "project"].includes(String(sub).toLowerCase())) {
    const flags = parseCloudFlags(normalizedArgs.slice(1));
    const kind = inferOntologyKindCli(sub, normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[1], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, flags._[0], kind, scope, cwd);
  }
  if (isOntologyPathishCli(sub, cwd, true)) {
    return registerOntologySourceCli(paths, sub, inferOntologyKindCli(null, normalizedArgs.join(" ")), inferOntologyScopeCli(null, normalizedArgs.join(" "), "project"), cwd);
  }
  return runOntologyCli(parseOntologyNaturalArgsCli(normalizedArgs.join(" "), cwd), opts);
}

function runOntologyNaturalCli(text, opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  return runOntologyCli(parseOntologyNaturalArgsCli(text, cwd), { ...(opts || {}), cwd });
}

function careerGraphPathsForCli(projectPath) {
  const arch = loadArch();
  const root = path.resolve(projectPath || process.cwd());
  const memoryDir = path.join(root, arch.memoryDir || ".agentlas");
  return {
    root,
    memoryDir,
    configPath: path.join(memoryDir, arch.careerGraphConfigFile || "career-graph.json"),
    sourceManifestPath: path.join(memoryDir, arch.careerGraphSourceManifestFile || "career-graph-sources.json"),
    inboxPath: path.join(memoryDir, arch.careerGraphInboxDir || "career-graph-inbox"),
    dbPath: path.join(memoryDir, arch.careerGraphDbFile || "career-graph.sqlite"),
  };
}

function careerGraphSourceManifestSkeletonCli(root) {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-career-graph-source-manifest",
    projectRoot: root,
    sources: [],
  };
}

function ensureCareerGraphCli(projectPath) {
  const paths = careerGraphPathsForCli(projectPath);
  ensureProjectMemoryCli(paths.root, path.basename(paths.root) || "Project");
  fs.mkdirSync(paths.inboxPath, { recursive: true });
  if (!fs.existsSync(paths.sourceManifestPath)) {
    writeJsonSafeCli(paths.sourceManifestPath, careerGraphSourceManifestSkeletonCli(paths.root));
  }
  return paths;
}

function readCareerGraphSourcesCli(sourceManifestPath) {
  const manifest = readJsonSafeCli(sourceManifestPath, { sources: [] });
  return Array.isArray(manifest.sources) ? manifest.sources : [];
}

function careerGraphUsageLinesCli() {
  return [
    "Career Graph commands:",
    "  career-graph status               show source-routing files and index state",
    "  career-graph list                 list inbox files and registered source refs",
    "  career-graph open                 open the project career graph inbox",
    "  career-graph add ./docs           register a folder as private source material",
    "",
    "Full graph index commands live in Agentlas OS / Hephaestus:",
    "  hephaestus career-graph ingest --project .",
    "  hephaestus career-graph query \"release failures\" --project .",
    "  hephaestus career-graph verify --project .",
    "",
    "Safety: the graph is rebuildable. Markdown, JSONL ledgers, sitemap, and code map stay source of truth.",
  ];
}

function existingCareerGraphCanonicalRefsCli(root) {
  return [
    ".agentlas/project-soul-memory.md",
    ".agentlas/memory-log.jsonl",
    ".agentlas/curator-decisions.jsonl",
    ".agentlas/sitemap.json",
    ".agentlas/code-map/project-map.json",
    ".agentlas/ledgers/routing-decisions.jsonl",
    ".agentlas/ledgers/executions.jsonl",
    ".agentlas/ledgers/agent-evolution-proposals.jsonl",
  ].filter((rel) => fs.existsSync(path.join(root, rel)));
}

function formatCareerGraphStatusCli(paths) {
  const sources = readCareerGraphSourcesCli(paths.sourceManifestPath);
  const inbox = listOntologyInboxCli(paths.inboxPath);
  const canonical = existingCareerGraphCanonicalRefsCli(paths.root);
  const lines = [
    "Career Graph: active",
    `  project: ${paths.root}`,
    `  inbox:  ${paths.inboxPath}`,
    `  db:     ${paths.dbPath}`,
    `  index:  ${fs.existsSync(paths.dbPath) ? "present" : "pending"}`,
    "  policy: ledger_first_derived_index",
    "  source of truth: Markdown / JSONL / JSON files",
    "",
    `Canonical source refs (${canonical.length}):`,
  ];
  for (const rel of canonical) lines.push(`  ${rel}`);
  if (!canonical.length) lines.push("  (none yet)");
  lines.push("", `Inbox (${inbox.length}):`);
  for (const item of inbox) lines.push(`  ${item.supported ? "ok" : "!"} ${item.name}  ${item.supported ? "supported" : "adapter pending"}`);
  if (!inbox.length) lines.push("  (empty)");
  lines.push("", `Registered source refs (${sources.length}):`);
  for (const source of sources) {
    const sourcePath = path.resolve(String(source.path || ""));
    lines.push(`  ${fs.existsSync(sourcePath) ? "ok" : "!"} ${sourcePath}  ${source.kind || "project"} / ${source.scope || "private"}`);
  }
  if (!sources.length) lines.push("  (none)");
  lines.push(
    "",
    "Build the derived index with Agentlas OS:",
    `  hephaestus career-graph ingest --project ${JSON.stringify(paths.root)}`,
  );
  return lines;
}

function registerCareerGraphSourceCli(paths, source, kind, scope, cwd) {
  if (!source) throw new Error("usage: career-graph add <path>");
  const sourcePath = resolveOntologyPathCli(source, cwd || paths.root);
  if (!fs.existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);
  const manifest = readJsonSafeCli(paths.sourceManifestPath, careerGraphSourceManifestSkeletonCli(paths.root));
  const nextSources = (Array.isArray(manifest.sources) ? manifest.sources : [])
    .filter((item) => path.resolve(String(item.path || "")) !== sourcePath);
  nextSources.push({ path: sourcePath, kind, scope, registeredAt: new Date().toISOString() });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-career-graph-source-manifest";
  manifest.projectRoot = paths.root;
  manifest.sources = nextSources;
  writeJsonSafeCli(paths.sourceManifestPath, manifest);
  return [
    `Registered Career Graph source: ${sourcePath}`,
    `  kind:  ${kind}`,
    `  scope: ${scope}`,
    "  copy:  no",
    "  scan:  only this registered folder, not home/sibling projects",
  ];
}

function runCareerGraphCli(args, opts) {
  opts = opts || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  const projectPath = path.resolve(opts.projectPath || cwd);
  const normalizedArgs = Array.isArray(args) ? args : [];
  const sub = normalizedArgs[0] || "status";
  const paths = ensureCareerGraphCli(projectPath);
  if (sub === "status" || sub === "list") {
    return formatCareerGraphStatusCli(paths);
  }
  if (sub === "open") {
    if (!opts.noOpen) openLocalPathCli(paths.inboxPath);
    return [`Opened Career Graph inbox: ${paths.inboxPath}`];
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return careerGraphUsageLinesCli();
  }
  if (sub === "add") {
    const flags = parseCloudFlags(normalizedArgs.slice(1));
    const source = flags._[0];
    const kind = inferOntologyKindCli(flags.kind || flags._[1], normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[2], normalizedArgs.join(" "), kind);
    return registerCareerGraphSourceCli(paths, source, kind, scope, cwd);
  }
  if (["ingest", "query", "verify", "trace"].includes(String(sub))) {
    return [
      "Career Graph index execution is provided by Agentlas OS / Hephaestus.",
      `Run: hephaestus career-graph ${normalizedArgs.join(" ")} --project ${JSON.stringify(paths.root)}`,
    ];
  }
  return runCareerGraphCli(parseOntologyNaturalArgsCli(normalizedArgs.join(" "), cwd), opts);
}

function runCareerGraphNaturalCli(text, opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  return runCareerGraphCli(parseOntologyNaturalArgsCli(text, cwd), { ...(opts || {}), cwd });
}

async function cmdCareerGraph(args) {
  const sub = String((args && args[0]) || "status");
  if (["ingest", "query", "verify", "trace", "public-card"].includes(sub)) {
    const code = await parity().runHephaestusInteractive(["career-graph", ...args], { cwd: process.cwd() });
    if (code !== 0) process.exitCode = code;
    return;
  }
  try {
    for (const line of runCareerGraphCli(args, { cwd: process.cwd(), projectPath: process.cwd() })) out(line);
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

function cmdOntology(args) {
  try {
    for (const line of runOntologyCli(args, { cwd: process.cwd(), projectPath: process.cwd() })) out(line);
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

function openLocalPathCli(targetPath) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    spawn(command, [targetPath], { detached: true, stdio: "ignore" }).unref();
  } catch {
    out(`Open manually: ${targetPath}`);
  }
}

function logCli(projectPath, rec) {
  if (!projectPath) return;
  try {
    const dir = ensureProjectMemoryCli(projectPath);
    if (!dir) return;
    fs.appendFileSync(path.join(dir, loadArch().logFile), JSON.stringify(rec) + "\n", "utf8");
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
const AGENTLAS_PROJECT_STATE_IGNORE_START = "# >>> agentlas local project state >>>";
const AGENTLAS_PROJECT_STATE_IGNORE_END = "# <<< agentlas local project state <<<";
const AGENTLAS_GITIGNORE_MAX_BYTES = 1024 * 1024;
const projectBootstrapStates = new Map();

function terminalProjectCandidateCli(projectPath) {
  try {
    const root = path.resolve(projectPath || process.cwd());
    const unsafe = new Set([
      path.resolve(os.homedir()),
      path.parse(root).root,
      path.resolve(userDataDir()),
      path.resolve(runCwd()),
    ]);
    if (unsafe.has(root)) return null;
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return null;
    return root;
  } catch {
    return null;
  }
}

function assertNoSymlinkInAgentlasStateCli(stateDir) {
  const pending = [stateDir];
  let visited = 0;
  while (pending.length && visited < 4096) {
    const current = pending.pop();
    visited += 1;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(".agentlas local state must not contain symbolic links");
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    }
  }
  if (pending.length) throw new Error(".agentlas local state exceeds the safe bootstrap inspection limit");
}

function readRegularUtf8FileNoFollowCli(filePath, maxBytes = AGENTLAS_GITIGNORE_MAX_BYTES) {
  let before;
  try { before = fs.lstatSync(filePath); } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, content: "", mode: 0o644, stat: null };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(".gitignore must be a regular non-symbolic-link file");
  if (before.size > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(error && error.code)) throw error;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(".gitignore changed type during bootstrap");
    if (opened.size > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);
    if (
      Number.isFinite(before.dev) && Number.isFinite(before.ino) &&
      (before.dev !== opened.dev || before.ino !== opened.ino)
    ) {
      throw new Error(".gitignore changed during bootstrap");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error(`.gitignore exceeds the ${maxBytes}-byte safe bootstrap limit`);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(".gitignore changed while it was being read");
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); } catch {
      throw new Error(".gitignore must contain valid UTF-8 text");
    }
    return { exists: true, content, mode: before.mode & 0o777, stat: before };
  } finally {
    fs.closeSync(fd);
  }
}

function assertFileSnapshotUnchangedCli(filePath, snapshot) {
  if (!snapshot.exists) {
    try {
      fs.lstatSync(filePath);
      throw new Error(".gitignore appeared during bootstrap");
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
  }
  const current = fs.lstatSync(filePath);
  if (current.isSymbolicLink() || !current.isFile()) throw new Error(".gitignore changed type during bootstrap");
  const original = snapshot.stat;
  if (
    !original || current.dev !== original.dev || current.ino !== original.ino ||
    current.size !== original.size || current.mtimeMs !== original.mtimeMs
  ) {
    throw new Error(".gitignore changed during bootstrap");
  }
}

function replaceRegularFileCli(tempPath, destinationPath, snapshot) {
  try {
    fs.renameSync(tempPath, destinationPath);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !snapshot.exists || !["EEXIST", "EPERM", "EACCES"].includes(error && error.code)) {
      throw error;
    }
  }

  // Windows can reject replacement of an existing file. Keep a same-directory
  // rollback copy so an interrupted replacement never silently loses user rules.
  assertFileSnapshotUnchangedCli(destinationPath, snapshot);
  const backup = `${destinationPath}.agentlas-${process.pid}-${crypto.randomUUID()}.bak`;
  fs.renameSync(destinationPath, backup);
  try {
    fs.renameSync(tempPath, destinationPath);
  } catch (error) {
    try {
      if (!fs.existsSync(destinationPath)) fs.renameSync(backup, destinationPath);
    } catch { /* preserve the original error and leave the backup recoverable */ }
    throw error;
  }
  try { fs.unlinkSync(backup); } catch { /* a harmless rollback copy may remain on locked Windows hosts */ }
}

function ensureAgentlasProjectStateIgnoreCli(projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) throw new Error("refusing to initialize an unsafe Agentlas project root");
  const stateDir = path.join(root, ".agentlas");
  let stateExists = false;
  try {
    const state = fs.lstatSync(stateDir);
    stateExists = true;
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(".agentlas must be a real directory");
    assertNoSymlinkInAgentlasStateCli(stateDir);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  const gitignorePath = path.join(root, ".gitignore");
  const snapshot = readRegularUtf8FileNoFollowCli(gitignorePath);
  const existing = snapshot.content;
  const mode = snapshot.mode || 0o644;

  let next = existing;
  const start = existing.indexOf(AGENTLAS_PROJECT_STATE_IGNORE_START);
  const end = start >= 0 ? existing.indexOf(AGENTLAS_PROJECT_STATE_IGNORE_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const blockEnd = end + AGENTLAS_PROJECT_STATE_IGNORE_END.length;
    const block = existing.slice(start, blockEnd);
    if (!/^\.agentlas\/$/m.test(block)) {
      next = `${existing.slice(0, start)}${block.replace(AGENTLAS_PROJECT_STATE_IGNORE_START, `${AGENTLAS_PROJECT_STATE_IGNORE_START}\n.agentlas/`)}${existing.slice(blockEnd)}`;
    }
  } else {
    const block = `${AGENTLAS_PROJECT_STATE_IGNORE_START}\n.agentlas/\n${AGENTLAS_PROJECT_STATE_IGNORE_END}\n`;
    next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  }
  if (next !== existing) {
    const temp = path.join(root, `.gitignore.agentlas-${process.pid}-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, next.endsWith("\n") ? next : `${next}\n`, { encoding: "utf8", mode, flag: "wx" });
    try {
      assertFileSnapshotUnchangedCli(gitignorePath, snapshot);
      replaceRegularFileCli(temp, gitignorePath, snapshot);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      throw error;
    }
  }
  if (!stateExists) fs.mkdirSync(stateDir, { recursive: false, mode: 0o700 });
  assertNoSymlinkInAgentlasStateCli(stateDir);
  try { fs.chmodSync(stateDir, 0o700); } catch { /* Windows/best effort */ }
}

function hardenAgentlasProjectStateCli(projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return;
  const stateDir = path.join(root, ".agentlas");
  const pending = [stateDir];
  let visited = 0;
  while (pending.length && visited < 4096) {
    const current = pending.pop();
    visited += 1;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        try { fs.chmodSync(current, 0o700); } catch { /* Windows/best effort */ }
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile()) {
        try { fs.chmodSync(current, 0o600); } catch { /* Windows/best effort */ }
      }
    } catch { /* disappearing files and ACL-only hosts are best effort */ }
  }
}

function ensureCoreProjectCli(projectPath, options = {}) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) throw new Error("Agentlas project bootstrap requires a real project directory");
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  ensureAgentlasProjectStateIgnoreCli(root);
  const cached = projectBootstrapStates.get(root);
  if (cached && fs.existsSync(path.join(root, ".agentlas", "project-soul-memory.md"))) {
    return cached === "core";
  }
  projectBootstrapStates.delete(root);
  const coreRoot = resolveCoreRuntimeRoot(options.coreRoot);
  const hasCanonicalBootstrap = Boolean(
    coreRoot && fs.existsSync(path.join(coreRoot, "agentlas_cloud", "project_bootstrap.py")),
  );
  if (hasCanonicalBootstrap) {
    const result = captureCoreJsonSync(
      "agentlas_cloud",
      ["project", "ensure", "--project", root, "--reason", options.reason || "terminal-first-contact"],
      { cwd: root },
      coreRoot,
    );
    const canonical = Boolean(
      result
      && result.schemaVersion === "agentlas.project-bootstrap.v1"
      && ["active", "privacy_warning"].includes(result.status)
      && result.mergeOnly === true
      && result.privacyBlockInstalled === true
      && result.privateModeCompliant === true
      && Array.isArray(result.missing)
      && result.missing.length === 0
      && Array.isArray(result.overwritten)
      && result.overwritten.length === 0
      && Array.isArray(result.permissionIssues)
      && result.permissionIssues.length === 0
    );
    if (canonical) {
      // Core owns the canonical seed. Terminal adds one intentionally broader
      // guard so future local memory files are private without a release update.
      ensureAgentlasProjectStateIgnoreCli(root);
      hardenAgentlasProjectStateCli(root);
      projectBootstrapStates.set(root, "core");
      return true;
    }
    throw new Error("Agentlas Core returned an incomplete project bootstrap contract");
  }
  // A just-updated Terminal can briefly see the previous Core. The legacy
  // merge-only seed remains local-only and Core is retried next process.
  ensureProjectMemoryCli(root);
  if (!fs.existsSync(path.join(root, ".agentlas"))) {
    throw new Error("Agentlas project bootstrap could not create private local state");
  }
  ensureAgentlasProjectStateIgnoreCli(root);
  hardenAgentlasProjectStateCli(root);
  projectBootstrapStates.set(root, "fallback");
  return false;
}

// Passive checks never increment visits or touch the project. Activation is
// reserved for an actual write/full Terminal execution or an explicit ensure.
function recordCliFolderVisit(db, projectPath, options = {}) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return { activated: false };
  const activate = options.activate === true;
  try {
    if (!activate) {
      const row = tableExists(db, "folder_activity")
        ? db.prepare("SELECT activated_at FROM folder_activity WHERE path=?").get(root)
        : null;
      return { activated: Boolean(row && row.activated_at) || fs.existsSync(path.join(root, ".agentlas")) };
    }

    ensureCoreProjectCli(root, { reason: options.reason || "terminal-first-contact", coreRoot: options.coreRoot });
    if (!tableExists(db, "folder_activity")) return { activated: true };
    const now = new Date().toISOString();
    const row = db.prepare("SELECT visits FROM folder_activity WHERE path=?").get(root);
    if (row) {
      db.prepare("UPDATE folder_activity SET visits=?, activated_at=COALESCE(activated_at,?), last_seen=? WHERE path=?")
        .run(Number(row.visits || 0) + 1, now, now, root);
    } else {
      db.prepare("INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?,?,?,?,?)")
        .run(root, 1, now, now, now);
    }
    return { activated: true };
  } catch (error) {
    // An activation failure can mean that the project-local privacy boundary
    // could not be established (for example, a symlinked or oversized
    // .gitignore). Never continue a write/full execution in that state.
    if (activate) throw error;
    return { activated: false };
  }
}

function activeProjectPath(db, options = {}) {
  const root = terminalProjectCandidateCli(options.projectPath || process.cwd());
  if (!root) return null;
  const result = recordCliFolderVisit(db, root, options);
  return result.activated ? root : null;
}

function ensureTerminalProjectForExecutionCli(db, projectPath, permission = PERMISSION, reason = "terminal-first-contact") {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) return null;
  if (permission === "read") return activeProjectPath(db, { projectPath: root });
  return activeProjectPath(db, { projectPath: root, activate: true, reason });
}
function cliMemoryContext(db, projectPath) {
  const sections = [];
  const arch = loadArch();
  ensureMemoryContextColumn(db);
  if (projectPath) {
    try {
      const soulPath = path.join(projectPath, arch.memoryDir, arch.soulFile);
      if (fs.existsSync(soulPath)) {
        let s = fs.readFileSync(soulPath, "utf8");
        if (s.length > 1800) s = s.slice(0, 1800) + "\n…(truncated)";
        if (s.trim()) sections.push(`### Project memory (${projectPath})\n${s.trim()}`);
      }
    } catch { /* ignore */ }
  }
  if (tableExists(db, "memory_entries")) {
    try {
      const rows = projectPath
        ? db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE superseded_at IS NULL AND scope!='session' AND (project_path=? OR (project_path IS NULL AND scope IN ('user_identity','team_memory','agent_team'))) ORDER BY created_at DESC LIMIT 12").all(projectPath)
        : db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE project_path IS NULL AND scope!='session' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 12").all();
      if (rows.length) sections.push((projectPath ? "### Recent curated memory\n" : "### Curated memory (global)\n") + rows.map((r) => `- [${r.kind}] ${r.content}${contextLine(r.context_json)}`).join("\n"));
    } catch { /* ignore */ }
  }
  if (!sections.length) return "";
  return "## Agentlas memory (read before answering; five-scope + request_context recall)\n\n" + sections.join("\n\n");
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
  else cut = idx;
  return { events, cleaned: (text.slice(0, idx) + text.slice(cut)).trim() };
}
function curateCliReply(db, text, ctx) {
  const { events, cleaned } = parseMemoryEventsCli(text);
  const style = require("./agentlas-style.cjs");
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

function langDirective(lang) {
  return require("./agentlas-style.cjs").responseDirective(lang);
}

function prefsLang() {
  try {
    return require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en";
  } catch {
    return "en";
  }
}

const TERMINAL_MEMORY_CORE_MAX_TOKENS = 150;
const TERMINAL_MEMORY_CORE = [
  "## Memory",
  "Only for a durable decision, fact, preference, risk, or reusable procedure, end with `## Memory Events` plus a fenced JSON array; otherwise emit nothing.",
  "Each item: memory_kind, content, suggested_scope. Never include secrets, credentials, prompts, transcripts, or raw logs; the curator validates scope.",
].join("\n");
const MEMORY_DETAIL_RE = /\b(?:remember|memory|save this|record this|memory event)\b|기억|메모리|저장해|기록해|남겨/i;
const CREDENTIAL_INDEX_RE = /\b(?:deploy|release|billing|auth|oauth|credential|api key|secret key|cloud)\b|배포|릴리스|출시|결제|인증|자격 증명|API\s*키|시크릿|클라우드/i;

function approximatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ""), "utf8") / 3);
}
if (approximatePromptTokens(TERMINAL_MEMORY_CORE) > TERMINAL_MEMORY_CORE_MAX_TOKENS) {
  throw new Error("Terminal always-on memory core exceeds 150 tokens");
}

function memoryEmitterPromptFor(request, arch = loadArch()) {
  if (!MEMORY_DETAIL_RE.test(String(request || ""))) return TERMINAL_MEMORY_CORE;
  const full = String(arch?.emitterBlock || "");
  if (!full) return TERMINAL_MEMORY_CORE;
  // Credential lookup is a separate triggered concern. Remove the legacy
  // always-on paragraph from the full memory schema too.
  return full.replace(
    /\n- Real credential values may live only[\s\S]*?before saying a credential is missing\.\n/,
    "\n",
  ).trim();
}

function credentialIndexReminderFor(request) {
  if (!CREDENTIAL_INDEX_RE.test(String(request || ""))) return "";
  return [
    "## Local credential lookup (triggered)",
    "Before saying a deploy, release, billing, auth, API, or cloud credential is missing, read `.agentlas/local-credentials.map.json` and the Local Credential Index in `.agentlas/project-soul-memory.md`.",
    "Use only env names and local relative references; never copy credential values into memory or output.",
  ].join("\n");
}

function augmentSystem(db, baseSystem, ctx, withEmitter, request = "") {
  const arch = loadArch();
  let sys = baseSystem || "";
  // 언어/말투 지시를 맨 앞에 둔다. imported/cloud/company agents도 같은 전역 계약을 따른다.
  const lang = (ctx && ctx.lang) || prefsLang();
  sys = langDirective(lang) + (sys ? "\n\n" + sys : "");
  const connectionSkill = loadGlobalConnectionSkill();
  if (connectionSkill) sys += "\n\n" + connectionSkill;
  const mem = cliMemoryContext(db, ctx && ctx.projectPath);
  if (mem) sys += "\n\n" + mem;
  if (withEmitter && (!ctx || ctx.permission !== "read")) {
    sys += "\n\n" + memoryEmitterPromptFor(request, arch);
    const credentialReminder = credentialIndexReminderFor(request);
    if (credentialReminder) sys += "\n\n" + credentialReminder;
  }
  return sys;
}

function loadGlobalConnectionSkill() {
  try {
    return require("../dist/electron/runtime/global-skill.js").GLOBAL_CONNECTION_SKILL || "";
  } catch {
    return [
      "## Connecting accounts for the user (always-on background skill)",
      "When the task needs Slack, Gmail, Google Cloud, Firebase, a database, store release access, or another third-party service, open the provider website with the browser tool when available, guide the user one tiny step at a time, and save the issued credential with `agentlas creds save --provider <name> --key <ENV_NAME> --value \"<value>\" --project \"<cwd>\"` or `agentlas creds file --source <path> --provider <name> --env <ENV_NAME> --project \"<cwd>\"`.",
      "Do not lecture the user about security in this local single-user setup; make the connection effortless.",
    ].join("\n\n");
  }
}

// ── 런타임 CLI 스폰 ────────────────────────────────────────
const RUNTIME_BIN = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

// 활성 런타임 → 실행 방식 결정. CLI(claude/codex/gemini) 또는 API(BYOK/Ollama).
function resolveRuntime(db, override) {
  const ar = activeRuntime(db);
  const activeCli = ar && RUNTIME_BIN[ar.kind]
    ? {
        mode: "cli",
        kind: ar.kind,
        model: ar.model || null,
        capabilities: ["code", "tools", ...(ar.long_context ? ["long-context"] : [])],
        efforts: [],
      }
    : null;
  if (override) {
    if (!RUNTIME_BIN[override]) fail(`알 수 없는 런타임: ${override} (claude-code|codex|gemini)`);
    return activeCli && activeCli.kind === override ? activeCli : { mode: "cli", kind: override };
  }
  if (activeCli) return activeCli;
  if (ar && ar.kind === "byok" && ar.backend) return { mode: "api", backend: ar.backend, model: ar.model };
  if (ar && ar.kind === "ollama") return { mode: "api", backend: "ollama", model: ar.model };
  // 폴백: 설치된 CLI 탐지
  for (const kind of Object.keys(RUNTIME_BIN)) {
    if (which(RUNTIME_BIN[kind])) return { mode: "cli", kind };
  }
  fail("사용할 런타임이 없습니다. CLI(claude/codex/gemini)를 설치하거나 앱에서 API 키/Ollama를 설정하세요.");
}

// Build the executable runtime inventory for the parent allocator.  It is
// intentionally local to this host: a Terminal/Codex/Claude plugin never
// pretends it can schedule a runtime that is not installed and connected here.
function listAvailableRuntimes(db, fallbackRuntime = null) {
  const routing = require("./agentlas-workload-routing.cjs");
  const active = fallbackRuntime || resolveRuntime(db);
  const candidates = [];
  const add = (runtime) => {
    if (!runtime) return;
    const key = runtime.mode === "cli" ? `cli:${runtime.kind}` : `api:${runtime.backend}:${runtime.model || ""}`;
    if (candidates.some((item) => item.key === key)) return;
    const discovered = routing.defaultAvailableModels(runtime);
    const availableModels = [...discovered];
    if (runtime.model && !availableModels.some((model) => model.id === runtime.model)) {
      availableModels.push({
        id: runtime.model,
        tier: runtime.modelTier || runtime.tier || null,
        capabilities: runtime.capabilities || [],
        contextWindow: runtime.contextWindow || null,
        efforts: runtime.efforts || [],
        description: runtime.modelDescription || "host-selected current model",
      });
    }
    candidates.push({ ...runtime, key, availableModels });
  };
  add(active);
  for (const kind of Object.keys(RUNTIME_BIN)) {
    if (!which(RUNTIME_BIN[kind])) continue;
    add({ mode: "cli", kind });
  }
  return candidates
    .filter((runtime) => runtime.availableModels.length)
    .map(({ key, ...runtime }, index) => ({ ...runtime, runtimeId: `runtime-${index + 1}` }));
}

function currentRuntimeInventoryCli(db, runtime) {
  const candidates = listAvailableRuntimes(db, runtime);
  const current = candidates.find((candidate) =>
    candidate.mode === runtime.mode &&
    (runtime.mode === "cli"
      ? candidate.kind === runtime.kind
      : candidate.backend === runtime.backend && candidate.model === runtime.model));
  if (current) return current;
  return {
    ...runtime,
    runtimeId: "runtime-current",
    availableModels: workloadRouting.defaultAvailableModels(runtime),
  };
}

// ── API 러너 (BYOK / Ollama) — 비스트리밍, 최종 텍스트 반환 ──
const DEFAULT_API_MODEL = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.1",
  upstage: "solar-pro2",
  custom: "deepseek-chat",
  glm: "glm-4.6",
  kimi: "kimi-k2-0711-preview",
  deepseek: "deepseek-chat",
};
const ANTHROPIC_COMPAT_API = {
  glm: { label: "GLM", baseUrl: "https://api.z.ai/api/anthropic" },
  kimi: { label: "Kimi", baseUrl: "https://api.moonshot.ai/anthropic" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic" },
};
const DEFAULT_CUSTOM_API_BASE_URL = "https://api.openai.com/v1";

async function apiKey(backend) {
  const keytar = readKeytar();
  if (!keytar) return null;
  // 키체인 접근 거부(서명 안 된 standalone Node)는 "키 없음"으로 조용히 처리.
  return keytar.getPassword(SERVICE, "byok:" + backend).catch(() => null);
}

/**
 * Custom BYOK 키가 전송될 origin을 Terminal에서도 다시 검증한다.
 * Desktop IPC와 동일하게 공개 주소는 HTTPS만, HTTP는 localhost/LAN만 허용한다.
 */
function normalizeCustomApiBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_CUSTOM_API_BASE_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Custom API base URL이 올바르지 않습니다.");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const isPrivateLan =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (isLoopback || isPrivateLan))) {
    throw new Error("Custom API base URL은 HTTPS 또는 localhost/LAN의 HTTP여야 합니다.");
  }
  return value.replace(/\/+$/, "");
}

/** Desktop과 공유하는 SQLite meta에서 Custom OpenAI base URL을 읽는다. */
function readCustomApiBaseUrl() {
  const p = dbPath();
  if (!fs.existsSync(p)) return DEFAULT_CUSTOM_API_BASE_URL;
  let db = null;
  let raw = "";
  try {
    try {
      const Database = require("better-sqlite3");
      db = new Database(p, { readonly: true, fileMustExist: true });
    } catch {
      db = openNodeSqliteDb(p);
    }
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get();
      raw = row && row.value ? row.value : "";
    } catch {
      // 구버전 DB에 meta 테이블/키가 없으면 Desktop과 동일하게 OpenAI 기본 URL.
      raw = "";
    }
  } catch (e) {
    throw new Error(`Custom API base URL을 공유 DB에서 읽지 못했습니다: ${(e && e.message) || e}`);
  } finally {
    try { if (db && typeof db.close === "function") db.close(); } catch { /* ignore close failure */ }
  }
  return normalizeCustomApiBaseUrl(raw);
}

/**
 * BYOK/Ollama 한 턴. 재사용 경로(swarm/automation)이므로 절대 process.exit하지 않고
 * 오류를 throw해 호출자의 catch/finally가 리스 해제·부분 실패를 처리하게 한다.
 * options는 회귀 테스트의 fetch/키 주입용이며 상용 호출자는 사용하지 않는다.
 */
async function runApi(backend, model, system, prompt, options) {
  options = options || {};
  model = model || DEFAULT_API_MODEL[backend];
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  if (backend === "ollama") {
    const resp = await fetchImpl("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status} — 'ollama serve' 실행/모델 확인`);
    const j = await resp.json();
    return (j.message && j.message.content) || "";
  }
  const supported = backend === "anthropic" || backend === "openai" || backend === "google" ||
    backend === "upstage" || backend === "custom" || !!ANTHROPIC_COMPAT_API[backend];
  if (!supported) throw new Error("지원하지 않는 backend: " + backend);
  const key = Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : await apiKey(backend);
  if (!key) throw new Error(`${backend} API 키가 없습니다. 앱 설정 → BYOK에서 키를 등록하세요.`);

  const anthropicCompat = ANTHROPIC_COMPAT_API[backend];
  if (backend === "anthropic" || anthropicCompat) {
    const label = anthropicCompat ? anthropicCompat.label : "Anthropic";
    const base = anthropicCompat ? anthropicCompat.baseUrl : "https://api.anthropic.com";
    const authHeaders = anthropicCompat
      ? { "x-api-key": key, authorization: "Bearer " + key }
      : { "x-api-key": key };
    const resp = await fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`${label} ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.content && j.content[0] && j.content[0].text) || "";
  }
  if (backend === "openai" || backend === "upstage" || backend === "custom") {
    const base = backend === "upstage"
      ? "https://api.upstage.ai/v1"
      : backend === "custom"
        ? normalizeCustomApiBaseUrl(Object.prototype.hasOwnProperty.call(options, "customBaseUrl")
          ? options.customBaseUrl
          : readCustomApiBaseUrl())
        : "https://api.openai.com/v1";
    const label = backend === "custom" ? "Custom API" : backend === "upstage" ? "Upstage" : "OpenAI";
    const resp = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`${label} ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  if (backend === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) throw new Error(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    const c = j.candidates && j.candidates[0];
    return (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || "";
  }
  throw new Error("지원하지 않는 backend: " + backend);
}

// 1회 실행 — CLI면 spawn(스트리밍 stdout), API면 호출 후 텍스트 출력. 종료코드 반환.
// ctx = { projectPath, agentId } — 메모리 주입/큐레이션에 사용.
function finalizeExperienceExecutionCli(db, input) {
  if (input.permission === "read") return null;
  if (!input.agentId) return null;
  let agent;
  try { agent = db.prepare("SELECT * FROM installed_agents WHERE id=?").get(input.agentId); }
  catch { return null; }
  if (!agent) return null;
  const exactBase = exactAgentBaseForExecution(db, agent, input.runtimeExperience);
  if (!exactBase) return null;
  const runtime = input.runtime || {};
  const provider = runtime.mode === "cli" ? runtime.kind : runtime.backend;
  const modelId = input.model || runtime.model || provider;
  const usage = input.usage || {};
  try {
    return terminalExperienceIntake.finalizeAgentExecution({
      db,
      userDataDir: userDataDir(),
      cwd: input.cwd || input.projectPath || projectCwd(),
      agent,
      exactBase,
      environment: { runtime: provider || "terminal", os: process.platform, arch: process.arch },
      model: { provider: provider || "terminal-runtime", modelId: modelId || "terminal-runtime" },
      mcp: (input.mcpServers || []).flatMap((server) => {
        const catalogId = server.catalog_id || server.catalogId;
        // A reviewed runtime allowlist proves approval, not that this turn's
        // child completed an MCP initialize/tool call. Do not inflate it into
        // connected evidence without an exact runtime signal.
        return catalogId ? [{ catalogId, status: "approved" }] : [];
      }),
      outcome: input.outcome,
      metrics: {
        promptTokens: usage.input_tokens || usage.prompt_tokens || 0,
        completionTokens: usage.output_tokens || usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        durationMs: input.durationMs || usage.duration_ms || 0,
        retryCount: 0,
      },
      curatedMemories: input.curatedMemories || [],
      taskHint: input.taskHint,
      taskSignatures: input.runtimeExperience?.taskSignatures || [],
      experiencePackReleaseId: input.runtimeExperience?.experiencePackReleaseIds?.[0] || null,
      locale: input.lang || prefsLang(),
      runId: input.runId,
      createdAt: input.createdAt,
    });
  } catch (error) {
    process.stderr.write(`▸ local Experience intake skipped · ${String((error && error.message) || error).slice(0, 180)}\n`);
    return null;
  }
}

async function executeOnce(db, system, prompt, override, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  const runStartedAt = Date.now();
  const experienceRunId = `terminal-run:${crypto.randomUUID()}`;
  const curatedMemories = [];
  ctx.curatedMemories = curatedMemories;
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = projectCwd();
  let runtimeSystem = system;
  let localExperienceContext = null;
  if (ctx.runtimeExperience?.disabled === true && ctx.runtimeExperience.observableReason) {
    process.stderr.write(`▸ local Experience skipped · ${ctx.runtimeExperience.observableReason}\n`);
  } else if (ctx.runtimeExperience && ctx.runtimeExperience.disabled !== true) {
    const runtimeExperience = ctx.runtimeExperience;
    const augmented = terminalExperienceExchange.augmentRuntimeSystemWithLocalExperience(system, {
      userDataDir: userDataDir(),
      cwd: ctx.projectPath || ctx.cwdAtRequest,
      baseAgentReleaseId: runtimeExperience.baseAgentReleaseId,
      agentDefinitionId: runtimeExperience.agentDefinitionId,
      experiencePackReleaseIds: runtimeExperience.experiencePackReleaseIds || [],
      taskSignatures: runtimeExperience.taskSignatures || [],
      environmentTags: Array.isArray(runtimeExperience.environmentTags) && runtimeExperience.environmentTags.length
        ? runtimeExperience.environmentTags
        : terminalExperienceExchange.defaultEnvironmentTags(),
      reservedTokens: ctx.runtimeExperience?.tasteRuntimeOverlay?.estimatedTokens ?? 0,
    });
    runtimeSystem = augmented.systemPrompt;
    localExperienceContext = augmented.experienceContext;
    if (localExperienceContext.itemIds.length) {
      const source = runtimeExperience.loadoutAuthority === "desktop-terminal-exact-loadout"
        ? "Desktop-approved exact Experience"
        : "local Experience advisory";
      process.stderr.write(`▸ ${source} · ${localExperienceContext.itemIds.length} item(s) · ~${localExperienceContext.estimatedTokens} tokens · no server rental receipt\n`);
    }
  }
  const tasteTaskResolution = terminalExperienceExchange.deriveCanonicalTaskClasses(prompt);
  if (
    ctx.runtimeExperience?.tasteRuntimeOverlay &&
    desktopOntologyLoadout.tasteRuntimeOverlayMatchesTask(
      ctx.runtimeExperience.tasteRuntimeOverlay,
      tasteTaskResolution.taskIds,
      prompt,
    )
  ) {
    const tasteDirective = desktopOntologyLoadout.renderTasteRuntimeDirective(
      ctx.runtimeExperience.tasteRuntimeOverlay,
    );
    runtimeSystem = `${runtimeSystem}\n\n${tasteDirective}`;
    process.stderr.write(
      `▸ Desktop-approved exact Taste · ${ctx.runtimeExperience.tasteRuntimeOverlay.releaseId} · ~${ctx.runtimeExperience.tasteRuntimeOverlay.estimatedTokens} tokens · session snapshot\n`,
    );
  }
  const rt = resolveRuntime(db, override);
  if (rt.mode === "cli") {
    // 네이티브 CLI에도 같은 Memory emitter를 주입하되 guard가 화면의 JSON 블록을 숨긴다.
    // 큐레이터가 만든 구조화 Memory만 성공 RunReceipt 이후 Experience intake로 전달된다.
    const sys = augmentSystem(db, runtimeSystem, ctx, true, prompt);
    const cwd = ctx.projectPath || projectCwd();
    const permission = ctx.permission || "write";
    const env = await buildChildEnvCli(db, { ...ctx, cwd });
    process.stderr.write(`▸ ${rt.kind} · ${permission} · ${cwd}\n`);
    // one-shot(`agentlas "작업"`)도 REPL과 동일한 리치 렌더(⏺ 툴 / └ 결과 / 토큰)로 출력한다.
    const { runNativeTurn } = require("./agentlas-native-host.cjs");
    const { Ui } = require("./agentlas-ui.cjs");
    const { makeMemoryGuard } = require("./agentlas-repl.cjs");
    const ui = new Ui({ lang: prefsLang() });
    let mcpServers = [];
    if (permission === "full") {
      if (Array.isArray(ctx.mcpServers)) {
        // Build's reviewed host allowlist is authoritative, including the valid
        // empty list. Never fall back to every enabled registry row.
        mcpServers = ctx.mcpServers;
      } else {
        try {
          mcpServers = terminalAssets.readConsentedSystemMcpServers(db, { userDataDir: userDataDir() });
        } catch { /* ignore */ }
      }
    }
    ui.beginTurn();
    const memoryGuard = makeMemoryGuard(ui, loadArch().eventsHeading);
    const res = await runNativeTurn({
      kind: rt.kind,
      bin: which(RUNTIME_BIN[rt.kind]) || RUNTIME_BIN[rt.kind],
      prompt,
      systemPrompt: sys,
      cwd,
      permission,
      session: {},
      model: ctx.model || null,
      effort: ctx.effort || null,
      mcpServers,
      mcpAllowlistMode: ctx.mcpAllowlistMode,
      env,
      ui: memoryGuard,
    });
    ui.endTurn();
    curateCliReply(db, res.text || "", ctx);
    finalizeExperienceExecutionCli(db, {
      agentId: ctx.agentId,
      projectPath: ctx.projectPath,
      cwd,
      runtime: rt,
      permission: ctx.permission,
      model: ctx.model || rt.model,
      runtimeExperience: ctx.runtimeExperience,
      mcpServers,
      curatedMemories,
      taskHint: prompt,
      outcome: { status: res.error ? "failed" : "succeeded", failureCode: res.error ? "runtime-error" : null },
      usage: res.usage,
      durationMs: Date.now() - runStartedAt,
      runId: experienceRunId,
      lang: ctx.lang,
    });
    return res.error ? 1 : 0;
  }
  // API 경로 — emitter 동봉 → 답변에서 메모리 이벤트를 파싱·큐레이션하고 블록은 제거.
  const sys = augmentSystem(db, runtimeSystem, ctx, true, prompt);
  const env = await buildChildEnvCli(db, { ...ctx, cwd: ctx.cwd || projectCwd() });
  Object.assign(process.env, env);
  const selectedModel = ctx.model || rt.model;
  process.stderr.write(`▸ ${rt.backend}${selectedModel ? " · " + selectedModel : ""}\n`);
  let text;
  try {
    text = await runApi(rt.backend, selectedModel, sys, prompt);
  } catch (error) {
    finalizeExperienceExecutionCli(db, {
      agentId: ctx.agentId,
      projectPath: ctx.projectPath,
      cwd: ctx.cwd || projectCwd(),
      runtime: rt,
      permission: ctx.permission,
      model: selectedModel,
      runtimeExperience: ctx.runtimeExperience,
      curatedMemories,
      taskHint: prompt,
      outcome: { status: "failed", failureCode: "runtime-error" },
      durationMs: Date.now() - runStartedAt,
      runId: experienceRunId,
      lang: ctx.lang,
    });
    throw error;
  }
  const cleaned = curateCliReply(db, text || "", ctx);
  finalizeExperienceExecutionCli(db, {
    agentId: ctx.agentId,
    projectPath: ctx.projectPath,
    cwd: ctx.cwd || projectCwd(),
    runtime: rt,
    permission: ctx.permission,
    model: selectedModel,
    runtimeExperience: ctx.runtimeExperience,
    curatedMemories,
    taskHint: prompt,
    outcome: { status: "succeeded", failureCode: null },
    durationMs: Date.now() - runStartedAt,
    runId: experienceRunId,
    lang: ctx.lang,
  });
  process.stdout.write((cleaned || "").trim() + "\n");
  return 0;
}

async function runTerminalBuilder(db, request, metadata = {}, runtimeOverride = null, cwd = projectCwd()) {
  const builder = resolveMetaBuilder(db);
  if (!builder) throw new Error("Agentlas Core Engine Meta-Agent is unavailable; Build did not start.");
  const runtime = resolveRuntime(db, runtimeOverride);
  const routingOptions = metadata.workloadRouting && typeof metadata.workloadRouting === "object"
    ? metadata.workloadRouting
    : {};
  let allocation = null;
  try {
    const currentInventory = currentRuntimeInventoryCli(db, runtime);
    const plannerSystem = workloadRouting.plannerSystemPrompt({
      language: prefsLang() === "ko" ? "Korean" : "English",
      maxTasks: 1,
      mode: "builder",
      liveRuntimeInventory: workloadRouting.runtimeInventory([currentInventory]),
    });
    let plannerText;
    if (runtime.mode === "cli") {
      const env = await buildChildEnvCli(db, { projectPath: cwd, agentId: builder.id, permission: "read", cwd });
      plannerText = await captureRuntime(runtime.kind, plannerSystem, request, {
        cwd,
        env,
        permission: "read",
        model: routingOptions.modelPin || runtime.model || null,
        effort: routingOptions.effortPin === undefined ? null : routingOptions.effortPin,
      });
    } else {
      plannerText = await runApi(runtime.backend, routingOptions.modelPin || runtime.model, plannerSystem, request);
    }
    const plan = workloadRouting.normalizePlan(plannerText, { maxTasks: 1 });
    allocation = plan && plan.tasks[0] && plan.tasks[0].allocation;
  } catch (error) {
    process.stderr.write(`▸ builder model planner fallback · ${String((error && error.message) || error).slice(0, 160)}\n`);
  }
  const currentInventory = currentRuntimeInventoryCli(db, runtime);
  const resolution = workloadRouting.resolveAllocation({
    runtime: currentInventory,
    decision: allocation,
    modelPin: routingOptions.modelPin,
    effortPin: routingOptions.effortPin,
    availableModels: currentInventory.availableModels,
    maxTier: routingOptions.maxTier || process.env.AGENTLAS_MODEL_MAX_TIER,
  });
  const receipt = workloadRouting.createDecisionReceipt({
    taskId: "builder-execution",
    stage: "builder",
    decision: allocation,
    resolution,
  });
  try {
    workloadRouting.appendDecisionReceipt(receipt, path.join(userDataDir(), "model-routing-receipts.jsonl"));
  } catch (error) {
    process.stderr.write(`▸ builder model routing receipt failed · ${String((error && error.message) || error).slice(0, 120)}\n`);
  }
  if (!resolution.ok) {
    throw new Error(`Agentlas builder model allocation failed closed: ${resolution.fallbackReason || "no compliant live model"}`);
  }
  process.stderr.write(
    `▸ builder model route · ${resolution.source} · ${resolution.model || runtime.kind || runtime.backend}` +
      `${resolution.effort ? ` · ${resolution.effort}` : ""}` +
      `${resolution.fallbackReason ? ` · ${resolution.fallbackReason}` : ""}\n`,
  );
  const code = await executeOnce(db, agentSystemPromptCli(builder), request, runtimeOverride, {
    projectPath: cwd,
    agentId: builder.id,
    permission: "full",
    // This is an exact private host object created after consent. An empty array
    // deliberately overrides all global/project/default MCP configuration.
    mcpServers: Array.isArray(metadata.mcpServers) ? metadata.mcpServers : [],
    mcpAllowlistMode: "exact",
    model: resolution.model,
    effort: resolution.effort,
  });
  if (code !== 0) throw new Error(`Agentlas builder runtime exited ${code}`);
  return code;
}

async function allocateSingleWorkloadCli(db, request, options = {}) {
  const runtime = options.runtime || resolveRuntime(db, options.runtimeOverride);
  const cwd = options.cwd || projectCwd();
  let allocation = null;
  try {
    const currentInventory = currentRuntimeInventoryCli(db, runtime);
    const plannerSystem = workloadRouting.plannerSystemPrompt({
      language: options.lang === "ko" ? "Korean" : "English",
      maxTasks: 1,
      mode: options.mode || "team",
      liveRuntimeInventory: workloadRouting.runtimeInventory([currentInventory]),
    });
    let plannerText;
    if (runtime.mode === "cli") {
      const env = await buildChildEnvCli(db, {
        projectPath: options.projectPath || null,
        agentId: options.agentId || null,
        permission: "read",
        cwd,
      });
      plannerText = await captureRuntime(runtime.kind, plannerSystem, request, {
        cwd,
        env,
        permission: "read",
        model: options.modelPin || runtime.model || null,
        effort: options.effortPin === undefined ? null : options.effortPin,
      });
    } else {
      plannerText = await runApi(runtime.backend, options.modelPin || runtime.model, plannerSystem, request);
    }
    const plan = workloadRouting.normalizePlan(plannerText, { maxTasks: 1 });
    allocation = plan && plan.tasks[0] && plan.tasks[0].allocation;
  } catch (error) {
    if (options.onWarning) options.onWarning(`model planner fallback: ${String((error && error.message) || error).slice(0, 160)}`);
  }
  const currentInventory = currentRuntimeInventoryCli(db, runtime);
  const resolution = workloadRouting.resolveAllocation({
    runtime: currentInventory,
    decision: allocation,
    modelPin: options.modelPin,
    effortPin: options.effortPin,
    availableModels: options.availableModels || currentInventory.availableModels,
    maxTier: options.maxTier || process.env.AGENTLAS_MODEL_MAX_TIER,
  });
  const receipt = workloadRouting.createDecisionReceipt({
    taskId: options.taskId || `${options.mode || "team"}-execution`,
    stage: options.mode || "team",
    decision: allocation,
    resolution,
  });
  try {
    workloadRouting.appendDecisionReceipt(receipt, options.receiptFile || path.join(userDataDir(), "model-routing-receipts.jsonl"));
  } catch (error) {
    if (options.onWarning) options.onWarning(`model routing receipt failed: ${String((error && error.message) || error).slice(0, 120)}`);
  }
  if (!resolution.ok) {
    throw new Error(`Agentlas model allocation failed closed: ${resolution.fallbackReason || "no compliant live model"}`);
  }
  return { allocation, resolution, receipt };
}

async function probeApprovedTerminalMcp(db, server, runtimeOverride, cwd, probeOptions = {}) {
  const runtime = resolveRuntime(db, runtimeOverride);
  if (runtime.mode !== "cli") return { connected: false, reason: "runtime_incompatible" };
  const env = await buildChildEnvCli(db, { cwd, permission: "full" });
  if (runtime.kind === "gemini") {
    const readiness = require("./agentlas-native-host.cjs").geminiMcpIsolationReadiness(env);
    if (!readiness.ready) return { connected: false, reason: "runtime_isolation_unavailable" };
  }
  return terminalAssets.probeSystemMcpServerConnection(server, {
    cwd,
    env,
    userDataDir: userDataDir(),
    timeoutMs: probeOptions.timeoutMs,
    signal: probeOptions.signal,
  });
}

// API 백엔드용 간이 대화형 REPL (네이티브 인터랙티브가 없는 BYOK/Ollama).
// 매 턴 메모리 컨텍스트 + emitter를 주입하고 답변에서 메모리를 큐레이션한다.
function apiRepl(db, backend, model, system, label, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = ctx.cwd || projectCwd();
  const readline = require("node:readline");
  process.stderr.write(`▸ ${label} (${backend}${model ? " · " + model : ""}) — 종료: /exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = () =>
    rl.question("\nyou › ", async (line) => {
      const tt = (line || "").trim();
      if (tt === "/exit" || tt === "/quit") return rl.close();
      if (!tt) return ask();
      try {
        const sys = augmentSystem(db, system, ctx, true, tt);
        const text = await runApi(backend, model, sys, tt);
        const cleaned = curateCliReply(db, text || "", ctx);
        process.stdout.write("\n" + (cleaned || "").trim() + "\n");
      } catch (e) {
        process.stderr.write("✖ " + (e && e.message) + "\n");
      }
      ask();
    });
  ask();
}

function which(cmd) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const extra = [
    path.join(os.homedir(), ".claude/local"),
    path.join(os.homedir(), ".codex/bin"),
    path.join(os.homedir(), ".gemini/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of [...paths, ...extra]) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function runCwd() {
  const dir = path.join(userDataDir(), "agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

// 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리(= 대상 프로젝트).
// 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 안전한 전용 폴더로 폴백한다.
function projectCwd() {
  try {
    const cwd = process.cwd();
    if (!cwd || cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return runCwd();
    return cwd;
  } catch {
    return runCwd();
  }
}

function parseDotEnvCli(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function readDotEnvFileCli(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return {};
    return parseDotEnvCli(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function readDotEnvDirCli(dir) {
  return { ...readDotEnvFileCli(path.join(dir, ".env")), ...readDotEnvFileCli(path.join(dir, ".env.local")) };
}
function agentEnvRequirementsCli(db, agentId) {
  if (!agentId) return [];
  try {
    const row = db.prepare("SELECT env_requirements_json FROM installed_agents WHERE id=?").get(agentId);
    const parsed = JSON.parse((row && row.env_requirements_json) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function agentEnvDirCli(agentId) {
  if (!agentId) return null;
  const route = routesMap()[agentId];
  if (route && route.path) return route.path;
  return null;
}
function readVaultEnvValuesCli(keys, projectPath) {
  // standalone에서는 키체인을 건너뛰고 credentials.env 파일 값만 쓴다(buildChildEnvCli가 합침).
  const keytar = isElectronRuntime() ? readKeytar() : null;
  const result = {};
  if (!keytar || !keys.length) return Promise.resolve(result);
  return Promise.all(
    keys.map((key) =>
      Promise.resolve()
        .then(async () => {
          if (projectPath) {
            const scoped = await keytar.getPassword(SERVICE, ENV_PREFIX + projectScopedGlobalEnvKeyCli(projectPath, key)).catch(() => null);
            if (scoped) {
              result[key] = scoped;
              return;
            }
          }
          const value = await keytar.getPassword(SERVICE, ENV_PREFIX + key).catch(() => null);
          if (value) result[key] = value;
        })
        .catch(() => {}),
    ),
  ).then(() => result);
}

// 프로젝트/에이전트 dotenv는 일반 API 키 우선순위를 유지하되, 호스트 CLI의 신원·설치·
// 플러그인 탐색 루트는 바꾸지 못한다. Windows 환경변수도 안전하게 대소문자 무관 비교한다.
const PROTECTED_CHILD_ENV_KEYS_CLI = new Set([
  "HOME", "PATH", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SAFE_MODE",
  "AGENTLAS_CODEX_HOME", "AGENTLAS_USER_DATA_DIR",
  "CLAUDE_CODE_SIMPLE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR",
  "GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_USER_SETTINGS",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH", "GEMINI_CLI_TRUST_WORKSPACE", "GEMINI_CLI_EXTENSION_REGISTRY_URI",
  "HEPHAESTUS_RUNTIME_ROOT", "HEPHAESTUS_RUNTIME_BASE", "HEPHAESTUS_PYTHON", "HEPHAESTUS_AUTO_UPDATE",
  "HEPHAESTUS_UPDATE_CHECK", "NPM_CONFIG_PREFIX", "NODE_OPTIONS", "NODE_PATH",
  "PYTHONHOME", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "AGENTLAS_HUB_CONNECT_TIMEOUT_MS", "AGENTLAS_HUB_IDLE_TIMEOUT_MS", "AGENTLAS_HUB_TOTAL_TIMEOUT_MS",
  "AGENTLAS_NATIVE_IDLE_TIMEOUT_MS", "AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS", "AGENTLAS_NATIVE_KILL_GRACE_MS",
  "AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES",
]);
// 네트워크 무결성 키 — TLS 검증·프록시·CA·엔드포인트·세션. 프로젝트/에이전트 dotenv(신뢰 불가:
// 클론한 레포에 딸려올 수 있음)로 주입되면 MITM/SSRF/세션 하이재킹이 된다. 단, 사용자 본인의
// 전역 credentials.env와 호스트 셸 env는 신뢰하므로 그대로 허용한다. 사고 방지: 원샷 API 경로는
// buildChildEnvCli 결과를 process.env에 병합(Object.assign)하므로, 프로젝트 .env가 부모 프로세스의
// 클라우드 호출(세션 쿠키 동반)까지 오염시킬 수 있었다.
const UNTRUSTED_PROTECTED_ENV_KEYS_CLI = new Set([
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "OPENSSL_CONF", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GRPC_PROXY", "NPM_CONFIG_PROXY",
  "AGENTLAS_SESSION", "AGENTLAS_MCP_BASE_URL", "AGENTLAS_WEB_BASE_URL", "AGENTLAS_API_BASE_URL",
  "AGENTLAS_HUB_BASE_URL", "AGENTLAS_CLOUD_BASE_URL", "OLLAMA_HOST",
]);
function isProtectedChildEnvKeyCli(key, trusted) {
  const k = String(key || "").trim().toUpperCase();
  if (PROTECTED_CHILD_ENV_KEYS_CLI.has(k)) return true; // 호스트 신원/플러그인 루트 — 모든 출처 차단
  if (!trusted && UNTRUSTED_PROTECTED_ENV_KEYS_CLI.has(k)) return true; // 네트워크 무결성 — 비신뢰 출처만 차단
  return false;
}
function mergeChildEnvValuesCli(target, values, overwrite, trusted) {
  const injected = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (!value || isProtectedChildEnvKeyCli(key, trusted)) continue;
    if (!overwrite && target[key]) continue;
    target[key] = value;
    injected.push(key);
  }
  return injected;
}
async function buildChildEnvCli(db, ctx) {
  const env = { ...process.env };
  // trusted=true: 사용자 본인의 전역 자격/볼트. trusted=false: 프로젝트·에이전트 폴더 dotenv.
  const apply = (values, overwrite, trusted) => {
    mergeChildEnvValuesCli(env, values, overwrite, trusted);
  };
  const globalCredentials = {
    ...readDotEnvFileCli(path.join(userDataDir(), "credentials.env")),
    ...readDotEnvFileCli(path.join(os.homedir(), ".agentlas", "credentials.env")),
  };
  apply(globalCredentials, false, true);
  if (ctx && ctx.projectPath) apply(projectScopedEnvValuesCli(globalCredentials, ctx.projectPath), true, true);
  if (ctx && ctx.cwd) apply(readDotEnvDirCli(ctx.cwd), true, false);
  if (ctx && ctx.projectPath) apply(readDotEnvDirCli(ctx.projectPath), true, false);
  const agentDir = agentEnvDirCli(ctx && ctx.agentId);
  if (agentDir) apply(readDotEnvDirCli(agentDir), true, false);

  const mm = loadMultimodalCatalog();
  const settings = getMultimodalSettingsCli(db);
  const keys = new Set(mm.selectedMultimodalEnvKeys(settings));
  for (const req of agentEnvRequirementsCli(db, ctx && ctx.agentId)) {
    if (req && req.key) keys.add(req.key);
  }
  const vaultValues = await readVaultEnvValuesCli([...keys].filter((key) => !env[key]), ctx && ctx.projectPath);
  apply(vaultValues, false, true); // 볼트는 사용자 본인 저장소 — 신뢰
  env.AGENTLAS_MULTIMODAL_IMAGE_PROVIDER = settings.imageProvider;
  env.AGENTLAS_MULTIMODAL_VIDEO_PROVIDER = settings.videoProvider;
  env.AGENTLAS_MULTIMODAL_AUDIO_PROVIDER = settings.audioProvider;
  return env;
}

// One-shot/background capture uses the same permission truth as the interactive host.
// Keep its plain-output argument shape, but never duplicate the security mapping here.
function buildArgs(kind, systemPrompt, prompt, permission, runtimeOptions = {}) {
  const native = require("./agentlas-native-host.cjs");
  const level = require("./agentlas-permissions.cjs").normalize(permission);
  const model = runtimeOptions.model ? String(runtimeOptions.model) : null;
  const effort = runtimeOptions.effort ? String(runtimeOptions.effort) : null;
  if (kind === "claude-code") {
    const perm = native.claudePermissionArgs(level);
    // Background/capture has no one-pass reviewed server list. Full permission
    // changes tool authority, not MCP consent, so this path remains exact-empty.
    const mcp = native.claudeMcpIsolationArgs();
    const thinking = effort === "max" || effort === "xhigh" ? "Ultrathink. " : effort === "high" ? "Think hard. " : effort === "medium" ? "Think. " : "";
    const claudeEffort = effort === "minimal" ? "low" : effort === "xhigh" ? "max" : effort;
    const effortArgs = claudeEffort && claudeEffort !== "none" ? ["--effort", claudeEffort] : [];
    return ["-p", thinking + prompt, "--append-system-prompt", systemPrompt, ...(model ? ["--model", model] : []), ...effortArgs, ...perm, ...mcp];
  }
  if (kind === "codex") {
    const perm = native.codexPermissionArgs(level);
    const mcp = [];
    const modelArgs = model ? ["-m", model] : [];
    const effortArgs = effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
    return ["exec", "--skip-git-repo-check", ...modelArgs, ...effortArgs, ...perm, ...mcp, `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  }
  if (kind === "gemini") {
    const perm = native.geminiPermissionArgs(level);
    // Legacy/background capture has no structured reviewed server list. Even
    // at full permission it must stay exact-empty instead of inheriting the
    // user's global Gemini MCP definitions with the provider credential env.
    const mcp = native.geminiMcpIsolationArgs();
    return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`, ...(model ? ["-m", model] : []), ...perm, ...mcp];
  }
  return [prompt];
}

// `claude` 치면 바로 대화형 세션 뜨듯이 — 에이전트 폴더(CLAUDE.md/AGENTS.md/GEMINI.md 보유)에서
// 네이티브 CLI를 인자 없이(대화형) 실행. 에이전트 페르소나는 그 폴더의 프로젝트 지시로 자동 로드. (A+B 결합)
// 보스턴테리어 터미널(대화형 TUI)로 진입. agentlas 가 항상 "호스트"다 —
// 활성 런타임이 claude/codex/gemini면 native-host로 headless 구동해 이 TUI 안에서 렌더하고,
// BYOK/Ollama면 자체 에이전트 루프(api-agent)를 돌린다. (apiRepl/네이티브 인계는 대체됨)
function launchInteractive(db, agent, runtimeOverride) {
  const subject = {
    kind: "agent",
    id: agent.id,
    slug: agent.slug,
    label: agent.name,
    system: agentSystemPromptCli(agent),
    capAgent: agent,
  };
  return launchTui(db, subject, runtimeOverride);
}

// REPL이 필요로 하는 DB 헬퍼들을 한 객체로 노출 (중복 구현 방지).
function buildHelpers(db) {
  return {
    which,
    RUNTIME_BIN,
    augmentSystem: (db_, base, ctx, emit, request) => augmentSystem(db_, base, ctx, emit, request),
    curateCliReply: (db_, text, ctx) => curateCliReply(db_, text, ctx),
    detectResponseLanguage: (prompt, fallback) => require("./agentlas-style.cjs").detectResponseLanguage(prompt, fallback),
    sanitizeAssistantText: (text) => require("./agentlas-style.cjs").sanitizeAssistantText(text),
    apiKey: (backend) => apiKey(backend),
    eventsHeading: () => loadArch().eventsHeading,
    defaultApiModel: (backend) => DEFAULT_API_MODEL[backend],
    buildChildEnv: (db_, ctx) => buildChildEnvCli(db_, ctx),
    allocateWorkload: (db_, request, ctx) => allocateSingleWorkloadCli(db_, request, ctx),
    finalizeExperienceRun: (db_, input) => finalizeExperienceExecutionCli(db_, input),
    multimodalStatus: (db_) => multimodalStatusCli(db_),
    setMultimodal: (db_, modality, providerId) => setMultimodalCli(db_, modality, providerId),
    resolveAgent,
    resolveFirm,
    listAgents,
    listFirms,
    firmSystemPrompt,
    autoRouteAgent: (db_, prompt, lang) => autoRouteAgent(db_, prompt, lang),
    autoRouteNote: (choice, lang) => autoRouteNote(choice, lang),
    autoRoutePreamble: (choice, lang) => autoRoutePreamble(choice, lang),
    directSystemPrompt: (lang) => directSystemPrompt(lang),
    cliMemoryContext: (db_, pp) => cliMemoryContext(db_, pp),
    importLocal: (db_, p) => importLocalFolderCli(db_, p),
    // REPL-safe public Hub install: fail()(process.exit) 대신 Error를 throw 해 REPL이 직접 렌더하게 한다.
    cloudInstall: async (db_, slug) => {
      if (typeof fetch !== "function") throw new Error("이 런타임에 fetch가 없습니다(앱 런타임 필요).");
      const base = process.env.AGENTLAS_MCP_BASE_URL || "https://agentlas.cloud/api/mcp/v1";
      const headers = { "content-type": "application/json" };
      const cookie = await cloudSessionCookieCli();
      if (cookie) headers.cookie = cookie;
      let resp;
      try {
        resp = await fetchHubCli(`${base.replace(/\/$/, "")}/tools/call`, {
          method: "POST",
          headers,
          body: JSON.stringify({ method: "marketplace.get_manifest", params: { name: "marketplace.get_manifest", arguments: { kind: "agent", slug } } }),
        });
      } catch (e) {
        throw new Error(`Hub 연결 실패: ${(e && e.message) || e}`);
      }
      if (!resp.ok) {
        const authHint = resp.status === 401 || resp.status === 403 ? " — 로그인이 필요합니다 (앱에서 로그인 또는 AGENTLAS_SESSION 설정)" : "";
        throw new Error(`Hub 응답 ${resp.status}${authHint}`);
      }
      const json = parseHubJsonCli(resp, "marketplace.get_manifest");
      if (json.error) throw new Error(json.error.message || "Hub error");
      const listing = json.result;
      if (!listing) throw new Error(`Hub에서 찾을 수 없음: ${slug}`);
      if (listing.delivery && listing.delivery.mode === "call_only") {
        throw new Error(`이 Hub 에이전트는 call-only 자산입니다. 실행: agentlas call ${slug}`);
      }
      return persistCloudListingCli(db_, listing);
    },
    hasCloudSession: async () => {
      try { return !!(await cloudSessionCookieCli()); } catch { return false; }
    },
    mcpServers: (db_) => {
      try {
        const consentedIds = new Set(
          terminalAssets.readConsentedSystemMcpServers(db_, { userDataDir: userDataDir(), createRuntimeHome: false })
            .map((server) => server.id),
        );
        return db_.prepare("SELECT id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled FROM mcp_servers ORDER BY installed_at ASC")
          .all()
          .map((row) => {
            const runtime = terminalAssets.materializeTrustedSystemMcpServer(row, { userDataDir: userDataDir(), createRuntimeHome: false });
            Object.defineProperty(row, "runtimeEligible", { value: Boolean(runtime), enumerable: false });
            Object.defineProperty(row, "runtimeConsented", { value: Boolean(runtime && consentedIds.has(String(row.id))), enumerable: false });
            if (runtime) {
              Object.defineProperty(row, "credentialKeyNames", { value: runtime.credentialKeyNames, enumerable: false });
              if (runtime.mcpRuntimeHome) Object.defineProperty(row, "mcpRuntimeHome", { value: runtime.mcpRuntimeHome, enumerable: false });
            }
            return row;
          });
      } catch {
        return [];
      }
    },
    // CLI 세션 영속화(이어하기 /resume): 네이티브 런타임 세션ID를 cli-sessions.json에 저장.
    sessionsLoad: () => {
      try { return JSON.parse(fs.readFileSync(path.join(userDataDir(), "cli-sessions.json"), "utf8")) || []; } catch { return []; }
    },
    sessionsSave: (list) => {
      try { writeJsonPrivateAtomicCli(path.join(userDataDir(), "cli-sessions.json"), (list || []).slice(0, 30)); } catch { /* ignore */ }
    },
    // 패리티: REPL의 /storm·/swarm·/build·/route·/research 가 그대로 호출한다.
    stormRun: (db_, goal, ctx) => parity().stormRun(db_, goal, ctx),
    swarmRun: (db_, goal, ctx) => parity().swarmRun(db_, goal, ctx),
    terminalBuild: (db_, args, ctx = {}) => terminalAssets.cmdBuild({
      db: db_,
      args: Array.isArray(args) ? args : terminalAssets.tokenizeBuildCommandLine(String(args || "")),
      userDataDir: userDataDir(),
      cwd: ctx.cwd || projectCwd(),
      input: ctx.input || process.stdin,
      promptOutput: ctx.promptOutput || process.stderr,
      out: ctx.out || out,
      probeMcpServer: (server, probeOptions) => probeApprovedTerminalMcp(db_, server, null, ctx.cwd || projectCwd(), probeOptions),
      invokeBuild: (request, metadata) => runTerminalBuilder(db_, request, {
        ...metadata,
        workloadRouting: {
          modelPin: ctx.modelPin || null,
          effortPin: ctx.effortPin,
          maxTier: ctx.maxTier,
        },
      }, null, ctx.cwd || projectCwd()),
    }),
    hepRun: (args, opts) => parity().runHephaestusInteractive(args, opts),
    cloudSearch: (db_, args) => parity().cloudSearch(db_, args),
    careerGraphCommand: (text, ctx) => runCareerGraphNaturalCli(text, {
      cwd: (ctx && ctx.cwd) || projectCwd(),
      projectPath: (ctx && ctx.cwd) || projectCwd(),
    }),
    ontologyCommand: (text, ctx) => runOntologyNaturalCli(text, {
      cwd: (ctx && ctx.cwd) || projectCwd(),
      projectPath: (ctx && ctx.cwd) || projectCwd(),
    }),
    // /cwd 로 작업 폴더를 바꿀 때 그 폴더의 활성 프로젝트 경로(또는 null)를 재계산 — activeProjectPath의 명시-dir 버전.
    projectPathFor: (db_, dir) => {
      try {
        if (!dir || dir === os.homedir() || dir === userDataDir() || dir === runCwd()) return null;
        const v = recordCliFolderVisit(db_, dir);
        return v.activated ? dir : null;
      } catch {
        return null;
      }
    },
    ensureProjectForExecution: (db_, dir, permission, reason) =>
      ensureTerminalProjectForExecutionCli(db_, dir, permission, reason || "terminal-interactive-turn"),
    doctor: async (db_, ui) => {
      ui.line("");
      ui.info("userData: " + userDataDir());
      ui.info("db: " + (fs.existsSync(dbPath()) ? "OK" : "없음"));
      const ar = activeRuntime(db_);
      ui.info("활성 런타임: " + (ar ? ar.kind : "(없음)"));
      // CLI 런타임: 설치 + 로그인(인증 파일) 휴리스틱
      const home = os.homedir();
      const authFiles = {
        "claude-code": [path.join(home, ".claude.json"), path.join(home, ".claude", ".credentials.json")],
        codex: [path.join(home, ".codex", "auth.json")],
        gemini: [path.join(home, ".gemini", "oauth_creds.json"), path.join(home, ".gemini", "google_accounts.json")],
      };
      const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
      for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
        const installed = !!which(bin);
        const authed = (authFiles[kind] || []).some(has);
        ui.info(`  ${kind.padEnd(12)} ${!installed ? "미설치" : authed ? "설치됨 · 로그인" : "설치됨 · 로그인 미확인"}`);
      }
      // BYOK 키 (keytar) + 클라우드 세션
      const byok = [];
      for (const b of ["anthropic", "openai", "google", "upstage"]) {
        try { if (await apiKey(b)) byok.push(b); } catch { /* keytar 미사용 */ }
      }
      ui.info("BYOK 키: " + (byok.length ? byok.join(", ") : "(없음 — 앱 설정 → BYOK)"));
      let cloud = false;
      try { cloud = !!(await cloudSessionCookieCli()); } catch { /* ignore */ }
      ui.info("클라우드 세션: " + (cloud ? "로그인됨" : "로그아웃"));
    },
  };
}

function launchTui(db, subject, runtimeOverride) {
  let startRepl, config;
  try {
    ({ startRepl } = require("./agentlas-repl.cjs"));
    config = require("./agentlas-config.cjs");
  } catch (e) {
    fail("Failed to load the terminal UI module: " + (e && e.message));
  }
  const dir = userDataDir();
  const prefs = config.loadPrefs(dir);
  // Runtime: explicit --runtime wins; else a saved default (cli kind, installed); else app's active runtime.
  let override = runtimeOverride;
  if (!override && prefs.runtime && prefs.runtime !== "auto" && RUNTIME_BIN[prefs.runtime] && which(RUNTIME_BIN[prefs.runtime])) {
    override = prefs.runtime;
  }
  const runtime = resolveRuntime(db, override);
  // Permission: explicit --permission wins; else the saved default; else "write".
  const permission = PERMISSION_EXPLICIT ? PERMISSION : prefs.permission || PERMISSION;
  startRepl({
    db,
    subject,
    runtime,
    permission,
    cwd: projectCwd(),
    projectPath: activeProjectPath(db),
    helpers: buildHelpers(db),
    prefs,
    savePrefs: (p) => config.savePrefs(dir, p),
  });
}

function spawnRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  return new Promise((resolve) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    const env = require("./agentlas-native-host.cjs").runtimeEnvForKind(kind, opts.env || process.env, {
      permission: opts.permission,
      mcpServers: [],
      mcpAllowlistMode: kind === "gemini" ? "exact" : undefined,
    });
    const child = spawn(bin, buildArgs(kind, systemPrompt, prompt, opts.permission), {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env,
    });
    child.on("error", (err) => {
      process.stderr.write(`\n실행 실패(${kind}): ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

const CAPTURE_OUTPUT_DEFAULT_BYTES = 4 * 1024 * 1024;
function captureOutputLimit(env = process.env) {
  return finiteTimeoutMs(env.AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES, CAPTURE_OUTPUT_DEFAULT_BYTES, 64 * 1024, 32 * 1024 * 1024);
}
function directCaptureOutputLimit(value) {
  return finiteTimeoutMs(value, CAPTURE_OUTPUT_DEFAULT_BYTES, 128, 32 * 1024 * 1024);
}

function captureRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  const { nativeTimeoutConfig, directNativeTimeoutConfig } = require("./agentlas-native-host.cjs");
  const timeout = opts.timeoutConfig
    ? directNativeTimeoutConfig(opts.timeoutConfig)
    : nativeTimeoutConfig(opts.env || process.env);
  const outputLimit = opts.outputLimitBytes == null
    ? captureOutputLimit(opts.env || process.env)
    : directCaptureOutputLimit(opts.outputLimitBytes);
  return new Promise((resolve, reject) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    let child;
    try {
      const spawnImpl = opts.spawn || spawn;
      const env = require("./agentlas-native-host.cjs").runtimeEnvForKind(kind, opts.env || process.env, {
        permission: opts.permission,
        mcpServers: [],
        mcpAllowlistMode: kind === "gemini" ? "exact" : undefined,
      });
      child = spawnImpl(bin, buildArgs(kind, systemPrompt, prompt, opts.permission, { model: opts.model, effort: opts.effort }), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let terminationError = null;
    let idleTimer = null;
    let totalTimer = null;
    let killTimer = null;
    let forceTimer = null;
    let onStdout = () => {};
    let onStderr = () => {};
    let onError = () => {};
    let onClose = () => {};
    let onAbort = () => {};

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      idleTimer = totalTimer = killTimer = forceTimer = null;
    };
    const cleanup = () => {
      clearTimers();
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (opts.signal) opts.signal.removeEventListener?.("abort", onAbort);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const requestStop = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = totalTimer = null;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        if (settled) return;
        forceTimer = setTimeout(() => finishReject(terminationError), Math.max(250, Math.min(1_000, timeout.killGraceMs)));
      }, timeout.killGraceMs);
    };
    const timeoutError = (phase, ms) => {
      const error = new Error(
        phase === "idle"
          ? `${kind} capture idle timeout: ${ms}ms 동안 출력이 없습니다.`
          : `${kind} capture total timeout: 전체 실행 시간이 ${ms}ms를 초과했습니다.`,
      );
      error.code = `AGENTLAS_CAPTURE_${phase.toUpperCase()}_TIMEOUT`;
      return error;
    };
    const armIdle = () => {
      if (settled || terminationError) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => requestStop(timeoutError("idle", timeout.idleMs)), timeout.idleMs);
    };
    const append = (target, chunk) => {
      armIdle();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimit - capturedBytes);
      if (remaining > 0) {
        const kept = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
        target.push(kept);
        capturedBytes += kept.length;
      }
      if (bytes.length > remaining) {
        const error = new Error(`${kind} capture output limit: ${outputLimit} bytes를 초과했습니다.`);
        error.code = "AGENTLAS_CAPTURE_OUTPUT_LIMIT";
        requestStop(error);
      }
    };

    onStdout = (chunk) => append(stdoutChunks, chunk);
    onStderr = (chunk) => append(stderrChunks, chunk);
    onError = (error) => finishReject(terminationError || error);
    onClose = (code) => {
      if (terminationError) {
        finishReject(terminationError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code && code !== 0) {
        finishReject(new Error(`${kind} exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      finishResolve(stdout.trim() || stderr.trim());
    };
    onAbort = () => {
      const reason = opts.signal && opts.signal.reason;
      const error = reason instanceof Error ? reason : new Error(`${kind} capture aborted`);
      if (!error.code) error.code = "ABORT_ERR";
      requestStop(error);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    armIdle();
    totalTimer = setTimeout(() => requestStop(timeoutError("total", timeout.totalMs)), timeout.totalMs);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── 패리티 모듈 (storm/swarm/automation/usage/telegram/cloud search) ──
// 데스크탑 앱 전용이던 기능의 터미널 구현 — 헬퍼를 주입해 지연 생성한다.
function parity() {
  if (!parity._i) {
    parity._i = require("./agentlas-parity.cjs").create({
      captureRuntime,
      runApi,
      resolveRuntime,
      listAvailableRuntimes,
      buildChildEnvCli,
      projectCwd,
      runCwd,
      userDataDir,
      modelRoutingReceiptPath: () => path.join(userDataDir(), "model-routing-receipts.jsonl"),
      resolveAgent,
      resolveFirm,
      listAgents,
      autoRouteAgent,
      prefsLang,
      cloudSessionCookieCli,
      cliSessionPath,
      firmSystemPrompt,
      out,
      fail,
      RUNTIME_BIN,
      which,
      apiKey,
    });
  }
  return parity._i;
}

// ── 명령 구현 ──────────────────────────────────────────────
function cmdList(db) {
  const agents = listAgents(db);
  const ar = activeRuntime(db);
  let lang = "en";
  try { lang = require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en"; } catch { /* default en */ }
  const nm = (a) => (lang === "en" && a.name_en && a.name_en !== a.name ? a.name_en : a.name);
  out(`Active runtime: ${ar ? `${ar.kind}${ar.backend ? " · " + ar.backend : ""}${ar.model ? " · " + ar.model : ""}` : "(none)"}`);
  out(`${agents.length} agent(s) installed:`);
  const routes = routesMap();
  for (const a of agents) {
    const local = routes[a.id] ? "  [local]" : "";
    const arch = a.builtin ? "  [architecture]" : "";
    out(`  ${a.slug.padEnd(28)} ${nm(a)}${arch}${local}`);
  }
  const firms = listFirms(db);
  if (firms.length) {
    out(`\n${firms.length} company(ies):`);
    for (const f of firms) out(`  ${f.slug.padEnd(28)} ${nm(f)}  (CEO)`);
  }
  if (!agents.length) {
    // 신선 설치: 빌트인 오케스트레이션 에이전트는 background 라 목록에 안 뜬다 — 빈 설치로 오해 방지.
    out(
      lang === "ko"
        ? "\n(빌트인 오케스트레이션 에이전트는 백그라운드로 동작합니다. `agentlas cloud search \"할 일\"` 로 에이전트를 찾아 설치하거나, 그냥 `agentlas` 를 열고 할 일을 입력하세요.)"
        : "\n(Built-in orchestration agents run in the background. Find agents with `agentlas cloud search \"what you need\"`, or just open `agentlas` and type a task.)",
    );
  }
  out("\nRun: agentlas <agent>  ·  agentlas firm <firm>  ·  agentlas run <agent> \"...\"");
}

function ensureNativeFiles(agent, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const sys = agentSystemPromptCli(agent);
  writeIfMissing(path.join(folder, "system-prompt.md"), sys);
  const header = `# ${agent.name}\n\n${agent.tagline || ""}\n\n${sys}\n`;
  // 네이티브 CLI가 프로젝트 지시로 자동 인식하는 파일들
  writeIfMissing(path.join(folder, "CLAUDE.md"), header);
  writeIfMissing(path.join(folder, "AGENTS.md"), header);
  writeIfMissing(path.join(folder, "GEMINI.md"), header);
}
function writeIfMissing(file, content) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function cmdCd(db, query) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  const folder = agentFolder(agent);
  ensureNativeFiles(agent, folder);
  // 경로만 stdout으로 (cd "$(agentlas cd seo)") — 안내는 stderr로.
  process.stderr.write(`# ${agent.name} — 네이티브 CLI 컨텍스트(CLAUDE.md/AGENTS.md/GEMINI.md) 준비됨\n`);
  process.stdout.write(folder + "\n");
}

function parseRunExperienceArgs(args) {
  const prompt = [];
  const experience = { taskSignatures: [], declaredTaskClasses: [], environmentTags: [], experiencePackReleaseIds: [] };
  let passthrough = false;
  const addList = (target, value) => {
    for (const item of String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
      if (!target.includes(item)) target.push(item);
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (passthrough) { prompt.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    const take = () => index + 1 < args.length ? String(args[++index]) : "";
    if (token === "--experience-base-release") experience.baseAgentReleaseId = take();
    else if (token.startsWith("--experience-base-release=")) experience.baseAgentReleaseId = token.slice(26);
    else if (token === "--experience-pack-release") addList(experience.experiencePackReleaseIds, take());
    else if (token.startsWith("--experience-pack-release=")) addList(experience.experiencePackReleaseIds, token.slice(26));
    else if (token === "--experience-agent-definition") experience.agentDefinitionId = take();
    else if (token.startsWith("--experience-agent-definition=")) experience.agentDefinitionId = token.slice(30);
    else if (token === "--experience-task-signature") addList(experience.taskSignatures, take());
    else if (token.startsWith("--experience-task-signature=")) addList(experience.taskSignatures, token.slice(28));
    else if (token === "--experience-task-class") addList(experience.declaredTaskClasses, take());
    else if (token.startsWith("--experience-task-class=")) addList(experience.declaredTaskClasses, token.slice(24));
    else if (token === "--experience-environment") addList(experience.environmentTags, take());
    else if (token.startsWith("--experience-environment=")) addList(experience.environmentTags, token.slice(25));
    else if (token === "--experience-desktop-loadout") experience.desktopLoadout = true;
    else if (
      token === "--experience-loadout" || token === "--experience-loadout-file" ||
      token.startsWith("--experience-loadout=") || token.startsWith("--experience-loadout-file=")
    ) {
      throw new Error("Custom Experience loadout paths are no longer supported; use --experience-desktop-loadout.");
    }
    else if (token === "--no-experience") experience.disabled = true;
    else prompt.push(token);
  }
  return { prompt: prompt.join(" "), experience };
}

function resolveRuntimeExperienceCli(agent, prompt, requested, cwd, overrides = {}) {
  const prepared = desktopOntologyLoadout.prepareDesktopLoadoutRequest({
    db: overrides.db,
    agent,
    userDataDir: overrides.userDataDir || userDataDir(),
    requested: requested || {},
    now: overrides.now,
  });
  if (prepared.mode === "skip") {
    return { disabled: true, observableReason: prepared.reason, resolution: "skipped" };
  }
  const resolved = terminalExperienceExchange.resolveRuntimeExperienceForAgent({
    userDataDir: overrides.userDataDir || userDataDir(),
    cwd,
    prompt,
    requested: prepared.requested || requested || {},
    agent,
    agentRoot: agent ? (overrides.agentRoot || agentFolder(agent)) : null,
    ...(overrides.platform ? { platform: overrides.platform } : {}),
    ...(overrides.arch ? { arch: overrides.arch } : {}),
    ...(overrides.runtime ? { runtime: overrides.runtime } : {}),
  });
  if (prepared.mode !== "resolved") return resolved;
  const authority = prepared.authority;
  const tasteRuntime = {
    tasteRuntimeOverlay: authority.tasteRuntimeOverlay || null,
    loadoutAuthority: "desktop-terminal-exact-loadout",
    projectionRevision: authority.projectionRevision,
    loadoutRevision: authority.loadoutRevision,
  };
  if (!authority.experiencePackReleaseId) {
    return {
      disabled: true,
      resolution: "desktop-loadout-taste-only",
      ...tasteRuntime,
    };
  }
  if (resolved.disabled === true) return { ...resolved, ...tasteRuntime };
  if (
    resolved.agentDefinitionId !== authority.agentDefinitionId ||
    resolved.baseAgentReleaseId !== authority.baseAgentReleaseId ||
    !Array.isArray(resolved.experiencePackReleaseIds) ||
    resolved.experiencePackReleaseIds.length !== 1 ||
    resolved.experiencePackReleaseIds[0] !== authority.experiencePackReleaseId
  ) {
    return {
      disabled: true,
      observableReason: "desktop-loadout-runtime-resolution-mismatch",
      resolution: "skipped",
      ...tasteRuntime,
    };
  }
  return {
    ...resolved,
    ...tasteRuntime,
  };
}

async function cmdRun(db, query, prompt, runtimeOverride, runtimeExperience = null) {
  const agent = resolveAgent(db, query);
  if (!agent) {
    const routedPrompt = [query, prompt].filter(Boolean).join(" ").trim() || (await readStdin());
    if (!routedPrompt || !routedPrompt.trim()) fail("프롬프트가 비어 있습니다. agentlas run <agent> \"...\" 또는 agentlas run \"...\" 형식으로 입력하세요.");
    return cmdAutoRun(db, routedPrompt.trim(), runtimeOverride, runtimeExperience);
  }
  let userPrompt = prompt;
  if (!userPrompt) userPrompt = await readStdin();
  if (!userPrompt || !userPrompt.trim()) fail("프롬프트가 비어 있습니다. agentlas run <agent> \"...\" 또는 stdin으로 전달하세요.");
  process.stderr.write(`▸ ${agent.name}\n`);
  const projectPath = ensureTerminalProjectForExecutionCli(db, projectCwd(), PERMISSION, "terminal-run");
  const cwd = projectPath || projectCwd();
  const resolvedExperience = resolveRuntimeExperienceCli(agent, userPrompt.trim(), runtimeExperience, cwd, { db });
  const code = await executeOnce(db, agentSystemPromptCli(agent), userPrompt.trim(), runtimeOverride, {
    projectPath, agentId: agent.id, permission: PERMISSION, runtimeExperience: resolvedExperience,
  });
  process.exit(code);
}

async function cmdAutoRun(db, prompt, runtimeOverride, runtimeExperience = null) {
  const lang = prefsLang();
  const choice = autoRouteAgent(db, prompt, lang);
  if (!choice) fail("자동 라우팅할 에이전트가 없습니다. agentlas list로 설치 상태를 확인하세요.");
  if (choice.direct) {
    // 전문 에이전트 확신 없음 → 페르소나/능력 라우팅 없이 현재 런타임으로 직답.
    process.stderr.write(`▸ direct (no agent)\n`);
    process.stderr.write(`  ${autoRouteNote(choice, lang)}\n`);
    const sys = `${autoRoutePreamble(choice, lang)}\n\n${directSystemPrompt(lang)}`;
    const projectPath = ensureTerminalProjectForExecutionCli(db, projectCwd(), PERMISSION, "terminal-auto-run");
    const cwd = projectPath || projectCwd();
    const resolvedExperience = resolveRuntimeExperienceCli(null, prompt.trim(), runtimeExperience, cwd, { db });
    const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, {
      projectPath,
      agentId: null,
      permission: PERMISSION,
      runtimeExperience: resolvedExperience,
    });
    process.exit(code);
  }
  process.stderr.write(`▸ ${choice.agent.name} (auto)\n`);
  process.stderr.write(`  ${autoRouteNote(choice, lang)}\n`);
  const sys = `${autoRoutePreamble(choice, lang)}\n\n${agentSystemPromptCli(choice.agent)}`;
  const projectPath = ensureTerminalProjectForExecutionCli(db, projectCwd(), PERMISSION, "terminal-auto-run");
  const cwd = projectPath || projectCwd();
  const resolvedExperience = resolveRuntimeExperienceCli(choice.agent, prompt.trim(), runtimeExperience, cwd, { db });
  const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, {
    projectPath,
    agentId: choice.agent.id,
    permission: PERMISSION,
    runtimeExperience: resolvedExperience,
  });
  process.exit(code);
}

// chat / open / 에이전트명 단독 → 네이티브 CLI 대화형 세션 (claude처럼 바로 접속)
function cmdOpen(db, query, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  launchInteractive(db, agent, runtimeOverride);
}

// ── 회사(firm) — CEO 위임 실행 ─────────────────────────────
function listFirms(db) {
  try {
    return db.prepare("SELECT * FROM firms ORDER BY installed_at DESC").all();
  } catch {
    return [];
  }
}
function resolveFirm(db, query) {
  if (!String(query || "").trim()) return null;
  const firms = listFirms(db);
  const q = (query || "").toLowerCase();
  return (
    firms.find((f) => f.slug === query || f.id === query) ||
    firms.find((f) => (f.name || "").toLowerCase() === q) ||
    firms.find((f) => (f.slug || "").toLowerCase().includes(q) || (f.name || "").toLowerCase().includes(q)) ||
    null
  );
}
function firmSystemPrompt(db, firm) {
  const ceo = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(firm.ceo_agent_id);
  let roster = "";
  try {
    const org = JSON.parse(firm.org_chart_json);
    roster = org
      .map((n) => `  - ${n.role}: ${n.agentSlug}${n.reportsTo ? ` (reports to ${n.reportsTo})` : ""}`)
      .join("\n");
  } catch {
    /* ignore */
  }
  const base = (ceo && ceo.system_prompt) || `You are the CEO of ${firm.name}.`;
  return `${base}\n\n[FIRM] 당신은 '${firm.name}' 회사의 CEO입니다. 사용자 명령을 부서에 위임해 처리하세요.\n조직도:\n${roster}`;
}
async function cmdFirm(db, query, prompt, runtimeOverride) {
  const firm = resolveFirm(db, query);
  if (!firm) fail(`회사를 찾을 수 없습니다: ${query}`);
  const sys = firmSystemPrompt(db, firm);
  if (prompt && prompt.trim()) {
    process.stderr.write(`▸ ${firm.name} CEO\n`);
    const runtime = resolveRuntime(db, runtimeOverride);
    const projectPath = ensureTerminalProjectForExecutionCli(db, projectCwd(), PERMISSION, "terminal-firm-run");
    const allocated = await allocateSingleWorkloadCli(db, prompt.trim(), {
      runtime,
      cwd: projectCwd(),
      projectPath,
      agentId: firm.ceo_agent_id,
      lang: prefsLang(),
      mode: "team",
      onWarning: (message) => process.stderr.write(`▸ ${message}\n`),
    });
    process.stderr.write(
      `▸ team model route · ${allocated.resolution.source} · ${allocated.resolution.model || runtime.kind || runtime.backend}` +
        `${allocated.resolution.effort ? ` · ${allocated.resolution.effort}` : ""}` +
        `${allocated.resolution.fallbackReason ? ` · ${allocated.resolution.fallbackReason}` : ""}\n`,
    );
    const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, {
      projectPath,
      agentId: firm.ceo_agent_id,
      permission: PERMISSION,
      model: allocated.resolution.model,
      effort: allocated.resolution.effort,
    });
    process.exit(code);
  }
  // 대화형 — agentlas TUI. CEO 페르소나를 system으로, 작업은 현재 폴더에서.
  const subject = {
    kind: "firm",
    id: firm.ceo_agent_id,
    slug: firm.slug,
    label: firm.name + " CEO",
    system: sys,
    capAgent: { name: firm.name, name_en: firm.name_en || firm.name, tagline: firm.tagline, tagline_en: firm.tagline_en, entity_kind: "team", system_prompt: sys },
  };
  return launchTui(db, subject, runtimeOverride);
}

// ── creds: 발급된 외부 키를 vault + 프로젝트 .env + 전역 메모리에 저장 ──────────
// 백그라운드 연결 스킬(global-skill.ts)이 브라우저로 키 발급을 마친 뒤 이 명령을 호출한다.
// 로컬·단일 사용자 환경 — 평문 저장을 의도적으로 허용(사용 편의 우선).
function parseCredFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        f[a.slice(2)] = next;
        i++;
      } else {
        f[a.slice(2)] = true;
      }
    }
  }
  return f;
}
function upsertEnvLine(file, key, value) {
  let body = "";
  try { body = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const line = `${key}=${value}`;
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
  if (re.test(body)) body = body.replace(re, line);
  else body = body ? body.replace(/\n?$/, "\n") + line + "\n" : line + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 이 헬퍼의 모든 호출자는 credential 값/경로를 기록한다. 새 파일뿐 아니라 기존 0644
  // 파일도 매번 0600으로 수렴시켜 같은 머신의 다른 계정이 읽지 못하게 한다.
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/읽기전용 FS best-effort */ }
}
function resolveCredentialSourcePath(source, cwd) {
  // `agentlas creds file`은 일반 CLI 명령이므로 상대경로 기준은 사용자가 명령을 실행한
  // 셸 cwd다. 런타임 격리용 agent-cwd를 쓰면 실제 프로젝트 파일을 조용히 못 찾는다.
  return path.resolve(cwd || process.cwd(), source);
}
async function cmdCredsFile(db, args) {
  const f = parseCredFlags(args);
  const source = typeof f.source === "string" ? f.source : typeof f.path === "string" ? f.path : "";
  if (!source) fail("usage: agentlas creds file --source <path> [--provider <name>] [--env <ENV_NAME>] [--dest <relative-path>] [--project <path>] [--force]");
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(db);
  if (!project) fail("creds file requires a project path");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : "credential_file";
  const envKey = typeof f.env === "string" && f.env ? f.env.trim() : "";
  if (envKey && !/^[A-Z][A-Z0-9_]*$/.test(envKey)) fail("credential env name must look like ENV_NAME");

  const arch = loadArch();
  const cfg = localCredentialConfigCli(arch);
  const projectName = path.basename(project) || "Project";
  ensureLocalCredentialStoreCli(project, projectName, arch);
  ensureSoulCredentialIndexCli(project, projectName, arch);

  const sourceAbs = resolveCredentialSourcePath(source);
  let stat;
  try { stat = fs.statSync(sourceAbs); } catch { fail(`credential source not found: ${source}`); }
  if (!stat.isFile()) fail(`credential source is not a file: ${source}`);

  const base = path.basename(sourceAbs);
  const lower = base.toLowerCase();
  const defaultDir = lower.includes("google-services") || lower.includes("googleservice-info")
    ? cfg.credentialsDir
    : cfg.signingDir;
  const destRel = safeCredentialDestRelCli(
    typeof f.dest === "string" && f.dest ? f.dest : path.join(defaultDir, base),
  );
  const destAbs = path.join(project, destRel);
  if (!path.resolve(destAbs).startsWith(path.resolve(project) + path.sep)) {
    fail("credential destination must stay inside the project");
  }
  if (fs.existsSync(destAbs) && !f.force) fail(`credential destination already exists: ${destRel} (use --force to replace)`);

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, destAbs);
  try { fs.chmodSync(destAbs, 0o600); } catch { /* best-effort */ }

  const targets = [destRel];
  if (envKey) {
    try { upsertEnvLine(path.join(project, ".env"), envKey, destRel); targets.push("project .env"); }
    catch (e) { process.stderr.write(".env write failed: " + e.message + "\n"); }
    const scopedKey = projectScopedGlobalEnvKeyCli(project, envKey);
    try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), scopedKey, destAbs); targets.push("global project env"); } catch { /* best-effort */ }
    try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), scopedKey, destAbs); } catch { /* best-effort */ }
  }

  upsertLocalCredentialMapCli(project, projectName, arch, {
    id: typeof f.id === "string" && f.id ? f.id : `${provider}:${envKey || destRel}`,
    provider,
    env: envKey ? [envKey] : [],
    localFiles: [destRel],
    owner: "project",
    valueMaterialized: true,
    storage: envKey ? ["project_file", "project_env", "global_project_env"] : ["project_file"],
    requiredFor: typeof f.requiredFor === "string" && f.requiredFor ? [f.requiredFor] : [],
    staleCheck: typeof f.staleCheck === "string" && f.staleCheck ? f.staleCheck : "Validate access before release or deploy.",
  });

  out(`✓ saved credential file for ${provider} — ${targets.join(", ")}.`);
}
async function cmdCreds(db, args) {
  const sub = args[0];
  if (sub === "file") return cmdCredsFile(db, args.slice(1));
  if (sub !== "save") {
    fail('usage: agentlas creds save --provider <name> --key <ENV_NAME> --value <value> [--project <path>] OR agentlas creds file --source <path> [--env <ENV_NAME>]');
  }
  const f = parseCredFlags(args.slice(1));
  const key = typeof f.key === "string" ? f.key.trim() : "";
  const value = f.value === undefined || f.value === true ? "" : String(f.value);
  if (!key || !value) fail("creds save requires --key and --value");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : key;
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(db);
  const targets = [];
  const arch = loadArch();
  const projectName = project ? path.basename(project) || "Project" : "Project";
  if (project) {
    ensureLocalCredentialStoreCli(project, projectName, arch);
    ensureSoulCredentialIndexCli(project, projectName, arch);
  }

  // 1) keychain vault — project-scoped when a project is active.
  // standalone(비-Electron)에서는 키체인 쓰기가 프롬프트로 멈출 수 있어 건너뛴다;
  // 값은 아래 .env/credentials.env 파일에 저장되므로 런타임 주입에 지장 없다.
  const keytar = isElectronRuntime() ? readKeytar() : null;
  if (keytar) {
    const vaultKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
    try { await keytar.setPassword(SERVICE, ENV_PREFIX + vaultKey, value); targets.push(project ? "project vault" : "vault"); }
    catch (e) { process.stderr.write("vault save failed: " + e.message + "\n"); }
  }
  // 2) 프로젝트 .env (평문)
  if (project) {
    try { upsertEnvLine(path.join(project, ".env"), key, value); targets.push("project .env"); }
    catch (e) { process.stderr.write(".env write failed: " + e.message + "\n"); }
    // 3) 프로젝트 메모리 노트 (.agentlas/project-soul-memory.md) — 값 자체는 .env/vault에, 여기엔 사실만
    try {
      const soulDir = path.join(project, ".agentlas");
      fs.mkdirSync(soulDir, { recursive: true });
      fs.appendFileSync(
        path.join(soulDir, "project-soul-memory.md"),
        `\n- Connected ${provider}: ${key} saved in local credential store during first setup.\n`,
        "utf8",
      );
    } catch { /* best-effort */ }
    try {
      upsertLocalCredentialMapCli(project, projectName, arch, {
        id: `${provider}:${key}`,
        provider,
        env: [key],
        localFiles: [],
        owner: "project",
        valueMaterialized: true,
        storage: ["project_env", "project_vault", "global_project_env"],
        staleCheck: "Validate access before release or deploy.",
      });
    } catch { /* best-effort */ }
  }
  // 4) 전역 로컬 env — 프로젝트가 있으면 프로젝트 이름이 붙은 키로 저장
  const globalKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
  try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), globalKey, value); targets.push(project ? "global project env" : "global memory"); } catch { /* best-effort */ }
  try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), globalKey, value); } catch { /* best-effort */ }

  out(`✓ connected ${provider} — saved ${key} to ${targets.join(", ") || "(nowhere — check keytar)"}.`);
}

// keytar.findCredentials(전체 열거)는 서명 안 된 standalone Node에서 macOS 키체인이
// 접근을 막으면 무한 대기하고, 그 네이티브 콜은 process.exit로도 안 죽는다.
// → Electron(앱) 런타임에서만 keytar를 쓰고, standalone에서는 credentials.env 파일에서 열거한다.
function isElectronRuntime() {
  return !!(process.versions && process.versions.electron);
}
async function cmdEnv(db) {
  // standalone(비-Electron): 파일 기반 열거 — keytar 접근이 막혀도 안전.
  if (!isElectronRuntime()) {
    const fromFiles = {
      ...readDotEnvFileCli(path.join(userDataDir(), "credentials.env")),
      ...readDotEnvFileCli(path.join(os.homedir(), ".agentlas", "credentials.env")),
    };
    const keys = Object.keys(fromFiles).sort();
    out(`공유 env 키 ${keys.length}개 (값은 표시 안 함, credentials.env 기준):`);
    for (const k of keys) out(`  ${k}`);
    out("");
    out("키체인 저장 키는 데스크탑 앱의 설정 → 자격증명에서 보입니다.");
    return;
  }
  const keytar = readKeytar();
  if (!keytar) fail("keytar 모듈을 불러올 수 없습니다(앱 런타임으로 실행 필요).");
  let creds;
  try {
    creds = await keytar.findCredentials(SERVICE);
  } catch (e) {
    fail("env 조회 실패: " + ((e && e.message) || e));
    return;
  }
  const keys = creds.map((c) => c.account).filter((a) => a.startsWith(ENV_PREFIX)).map((a) => a.slice(ENV_PREFIX.length));
  out(`공유 env 키 ${keys.length}개 (값은 표시 안 함):`);
  for (const k of keys.sort()) out(`  ${k}`);
}

async function multimodalStatusCli(db) {
  const mm = loadMultimodalCatalog();
  const settings = getMultimodalSettingsCli(db);
  const ids = { image: settings.imageProvider, video: settings.videoProvider, audio: settings.audioProvider };
  const keytar = readKeytar();
  const rows = [];
  for (const modality of ["image", "video", "audio"]) {
    const provider = mm.MULTIMODAL_PROVIDERS.find((p) => p.id === ids[modality]);
    if (!provider) continue;
    const env = [];
    for (const key of provider.envKeys || []) {
      let hasValue = Boolean(process.env[key]);
      if (!hasValue && keytar) {
        try { hasValue = Boolean(await keytar.getPassword(SERVICE, ENV_PREFIX + key)); } catch { hasValue = false; }
      }
      env.push({ key, hasValue });
    }
    rows.push({ modality, provider, env, ready: env.every((e) => e.hasValue) });
  }
  return rows;
}
function setMultimodalCli(db, modality, providerId) {
  const mm = loadMultimodalCatalog();
  if (!["image", "video", "audio"].includes(modality)) fail("usage: agentlas multimodal set <image|video|audio> <provider-id>");
  const provider = mm.MULTIMODAL_PROVIDERS.find((p) => p.id === providerId && p.modality === modality);
  if (!provider) fail(`provider를 찾을 수 없습니다: ${providerId} (${modality})`);
  const key = modality === "image" ? "imageProvider" : modality === "video" ? "videoProvider" : "audioProvider";
  return saveMultimodalSettingsCli(db, { [key]: providerId });
}
async function cmdMultimodal(db, args) {
  const sub = args[0] || "status";
  const mm = loadMultimodalCatalog();
  if (sub === "set") {
    const settings = setMultimodalCli(db, args[1], args[2]);
    out(`✓ multimodal ${args[1]} provider → ${args[2]}`);
    out(`  image=${settings.imageProvider}  video=${settings.videoProvider}  audio=${settings.audioProvider}`);
    return;
  }
  if (sub === "providers") {
    for (const modality of ["image", "video", "audio"]) {
      out(`${modality}:`);
      for (const p of mm.MULTIMODAL_PROVIDERS.filter((x) => x.modality === modality)) {
        out(`  ${p.id.padEnd(22)} ${p.label}${p.envKeys && p.envKeys.length ? "  env: " + p.envKeys.join(",") : "  env: none"}`);
      }
    }
    out("\nSet: agentlas multimodal set <image|video|audio> <provider-id>");
    return;
  }
  const rows = await multimodalStatusCli(db);
  out("Multimodal fallback:");
  for (const row of rows) {
    const env = row.env.length ? row.env.map((e) => `${e.key}:${e.hasValue ? "set" : "missing"}`).join(" ") : "no key";
    out(`  ${row.modality.padEnd(5)} ${row.provider.id.padEnd(20)} ${row.provider.label}  ${env}`);
  }
  out("\nCommands: agentlas multimodal providers  ·  agentlas multimodal set image openai-image");
}

function cmdDoctor(db) {
  out(`userData: ${userDataDir()}`);
  out(`db: ${fs.existsSync(dbPath()) ? "OK" : "missing"}`);
  const ar = activeRuntime(db);
  out(`active runtime: ${ar ? ar.kind : "(none)"}`);
  for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
    const p = which(bin);
    out(`  ${kind.padEnd(12)} ${p ? "installed: " + p : "not found on PATH"}`);
  }
}

function cmdVersion() {
  out(`agentlas ${readPackageVersion()}`);
}

function parseUpdateFlags(args) {
  const flags = {
    check: false,
    force: false,
    json: false,
    launch: true,
    url: process.env.AGENTLAS_DESKTOP_UPDATE_URL || "https://agentlas.cloud/api/desktop/latest",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--no-launch") flags.launch = false;
    else if (arg === "--url") flags.url = args[++i] || flags.url;
    else if (arg === "--help" || arg === "-h" || arg === "help") flags.help = true;
    else fail(`알 수 없는 update 옵션: ${arg}`);
  }
  return flags;
}

function cmdUpdateHelp() {
  out(
    [
      "agentlas update",
      "",
      "  update              최신 공개 Desktop 릴리즈를 확인하고 설치",
      "  update --check      설치하지 않고 현재/최신 버전만 확인",
      "  update --force      같은 버전이어도 다시 설치",
      "  update --json       상태를 JSON으로 출력",
      "",
      "macOS는 notarized DMG를 내려받아 검증한 뒤 /Applications/Agentlas.app을 교체합니다.",
      "Windows/Linux는 현재 자동 설치 대신 최신 다운로드 위치를 안내합니다.",
    ].join("\n"),
  );
}

function macReleaseArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return null;
}

const UPDATE_METADATA_MAX_BYTES = 1024 * 1024;
const UPDATE_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPDATE_TIMEOUT_DEFAULTS = Object.freeze({
  metadata: Object.freeze({ connectMs: 15_000, idleMs: 15_000, totalMs: 30_000 }),
  download: Object.freeze({ connectMs: 20_000, idleMs: 60_000, totalMs: 30 * 60_000 }),
});

function updateTimeoutConfig(env = process.env, kind = "download") {
  const selected = kind === "metadata" ? "metadata" : "download";
  const defaults = UPDATE_TIMEOUT_DEFAULTS[selected];
  const prefix = selected === "metadata" ? "AGENTLAS_UPDATE_METADATA" : "AGENTLAS_UPDATE_DOWNLOAD";
  const totalMs = finiteTimeoutMs(env[`${prefix}_TOTAL_TIMEOUT_MS`], defaults.totalMs, 5_000, 60 * 60_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(env[`${prefix}_CONNECT_TIMEOUT_MS`], defaults.connectMs, 1_000, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(env[`${prefix}_IDLE_TIMEOUT_MS`], defaults.idleMs, 1_000, 300_000)),
    totalMs,
  };
}

function directUpdateTimeoutConfig(value = {}, kind = "download") {
  const defaults = UPDATE_TIMEOUT_DEFAULTS[kind === "metadata" ? "metadata" : "download"];
  const totalMs = finiteTimeoutMs(value.totalMs, defaults.totalMs, 10, 60 * 60_000);
  return {
    connectMs: Math.min(totalMs, finiteTimeoutMs(value.connectMs, defaults.connectMs, 10, 120_000)),
    idleMs: Math.min(totalMs, finiteTimeoutMs(value.idleMs, defaults.idleMs, 10, 300_000)),
    totalMs,
  };
}

function updateDownloadMaxBytes(env = process.env) {
  return finiteTimeoutMs(env.AGENTLAS_UPDATE_DOWNLOAD_MAX_BYTES, UPDATE_DOWNLOAD_MAX_BYTES, 16 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
}

function updateTransferError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function updateTimeoutError(kind, ms) {
  const message = kind === "connect"
    ? `업데이트 서버 연결 제한 시간(${ms}ms)을 초과했습니다.`
    : kind === "idle"
      ? `업데이트 전송이 ${ms}ms 동안 멈췄습니다.`
      : `업데이트 요청 전체 제한 시간(${ms}ms)을 초과했습니다.`;
  return updateTransferError(`AGENTLAS_UPDATE_${kind.toUpperCase()}_TIMEOUT`, message);
}

function parseSafeUpdateUrl(value, label = "업데이트 URL") {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (error) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_URL", `${label} 형식이 올바르지 않습니다.`, error);
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw updateTransferError("AGENTLAS_UPDATE_INSECURE_URL", `${label}은 HTTPS여야 합니다(로컬 루프백 제외).`);
  }
  if (parsed.username || parsed.password) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_URL", `${label}에 사용자 정보가 포함될 수 없습니다.`);
  }
  return parsed.toString();
}

/** Headers 전 connect, chunk 사이 idle, 전체 total 제한을 적용하는 bounded 스트림 reader. */
async function consumeUpdateResponse(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw updateTransferError("AGENTLAS_UPDATE_FETCH_UNAVAILABLE", "이 런타임에 fetch가 없습니다.");
  const kind = options.kind === "metadata" ? "metadata" : "download";
  const timeout = options.timeoutConfig
    ? directUpdateTimeoutConfig(options.timeoutConfig, kind)
    : updateTimeoutConfig(options.env || process.env, kind);
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : kind === "metadata" ? UPDATE_METADATA_MAX_BYTES : updateDownloadMaxBytes(options.env || process.env);
  const expectedBytes = options.expectedBytes == null ? null : Number(options.expectedBytes);
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let connectTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let reader = null;
  let terminalError = null;
  let caughtError = null;
  let rejectTerminal;
  const terminal = new Promise((_, reject) => { rejectTerminal = reject; });
  const stop = (error) => {
    if (terminalError) return;
    terminalError = error;
    try { controller.abort(error); } catch { controller.abort(); }
    rejectTerminal(error);
  };
  const onUpstreamAbort = () => {
    const reason = upstreamSignal && upstreamSignal.reason;
    const error = reason instanceof Error ? reason : updateTransferError("ABORT_ERR", "업데이트 요청이 취소되었습니다.");
    if (!error.code) error.code = "ABORT_ERR";
    stop(error);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(updateTimeoutError("idle", timeout.idleMs)), timeout.idleMs);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  connectTimer = setTimeout(() => stop(updateTimeoutError("connect", timeout.connectMs)), timeout.connectMs);
  totalTimer = setTimeout(() => stop(updateTimeoutError("total", timeout.totalMs)), timeout.totalMs);

  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal })),
      terminal,
    ]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    if (!response || typeof response.ok !== "boolean") {
      throw updateTransferError("AGENTLAS_UPDATE_INVALID_RESPONSE", "업데이트 서버 응답 형식이 올바르지 않습니다.");
    }
    if (response.url) parseSafeUpdateUrl(response.url, "리디렉션된 업데이트 URL");
    if (!response.ok) {
      throw updateTransferError("AGENTLAS_UPDATE_HTTP_ERROR", `업데이트 요청 실패: HTTP ${response.status}`);
    }
    const contentLengthValue = response.headers && response.headers.get ? response.headers.get("content-length") : null;
    if (contentLengthValue != null && contentLengthValue !== "") {
      const contentLength = Number(contentLengthValue);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw updateTransferError("AGENTLAS_UPDATE_INVALID_CONTENT_LENGTH", "업데이트 서버의 Content-Length가 올바르지 않습니다.");
      }
      if (contentLength > maxBytes) {
        throw updateTransferError("AGENTLAS_UPDATE_TOO_LARGE", `업데이트 응답이 허용 크기(${maxBytes} bytes)를 초과합니다.`);
      }
      if (Number.isSafeInteger(expectedBytes) && contentLength !== expectedBytes) {
        throw updateTransferError("AGENTLAS_UPDATE_SIZE_MISMATCH", `다운로드 크기가 맞지 않습니다: expected=${expectedBytes} header=${contentLength}`);
      }
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw updateTransferError("AGENTLAS_UPDATE_BODY_UNAVAILABLE", "업데이트 응답을 스트림으로 읽을 수 없습니다.");
    }

    reader = response.body.getReader();
    let bytes = 0;
    armIdle();
    while (true) {
      const part = await Promise.race([reader.read(), terminal]);
      if (part.done) break;
      armIdle();
      const chunk = Buffer.from(part.value || []);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = updateTransferError("AGENTLAS_UPDATE_TOO_LARGE", `업데이트 응답이 허용 크기(${maxBytes} bytes)를 초과했습니다.`);
        stop(error);
        throw error;
      }
      if (typeof options.onChunk === "function") await options.onChunk(chunk);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    return { response, bytes };
  } catch (error) {
    caughtError = terminalError || error;
    try { controller.abort(caughtError); } catch { controller.abort(); }
    throw caughtError;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (upstreamSignal) upstreamSignal.removeEventListener?.("abort", onUpstreamAbort);
    if (reader && caughtError) {
      try { await reader.cancel(caughtError); } catch { /* ignore */ }
    }
  }
}

async function fetchUpdateMetadata(url, options = {}) {
  const safeUrl = parseSafeUpdateUrl(url, "업데이트 메타데이터 URL");
  const chunks = [];
  let bytes = 0;
  await consumeUpdateResponse(safeUrl, { headers: { accept: "application/json", "accept-encoding": "identity" }, signal: options.signal }, {
    ...options,
    kind: "metadata",
    maxBytes: Number.isSafeInteger(options.maxBytes) ? options.maxBytes : UPDATE_METADATA_MAX_BYTES,
    onChunk(chunk) {
      bytes += chunk.length;
      chunks.push(chunk);
    },
  });
  let json;
  try {
    json = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch (error) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_METADATA", "업데이트 정보가 올바른 JSON이 아닙니다.", error);
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || !parseSemVer(json.version)) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_METADATA", "업데이트 정보 형식이 올바르지 않습니다.");
  }
  return { ...json, version: normalizeSemVer(json.version) };
}

async function fetchDesktopRelease(url) {
  const controller = new AbortController();
  try {
    return await fetchUpdateMetadata(url, { signal: controller.signal });
  } catch (error) {
    const message = String((error && error.message) || error);
    fail(`업데이트 확인 실패: ${message}`);
  }
}

function findCurrentArtifact(release) {
  const arch = macReleaseArch();
  if (!arch || !Array.isArray(release.artifacts)) return null;
  return release.artifacts.find((artifact) => artifact && artifact.arch === arch && artifact.available !== false) || null;
}

function desktopReleaseUrl(release) {
  if (release.releaseRepositoryUrl && release.releaseTag) return `${String(release.releaseRepositoryUrl).replace(/\/$/, "")}/releases/tag/${release.releaseTag}`;
  return "https://github.com/agentlas-ai/agentlas-desktop/releases/latest";
}

function formatUpdateSummary(status) {
  const lines = [
    `현재 버전: ${status.currentVersion}`,
    `최신 버전: ${status.latestVersion}${status.releaseTag ? ` (${status.releaseTag})` : ""}`,
    `상태: ${status.updateAvailable ? "업데이트 가능" : "최신 상태"}`,
  ];
  if (status.releaseUrl) lines.push(`릴리즈: ${status.releaseUrl}`);
  if (status.downloadUrl) lines.push(`다운로드: ${status.downloadUrl}`);
  return lines.join("\n");
}

// standalone(npm 설치본): 데스크탑 DMG가 아니라 npm 레지스트리의 agentlas 최신판과 비교한다.
// (자동 설치는 하지 않는다 — 전역 설치 권한/프리픽스가 제각각이라 명령만 안내.)
async function cmdUpdateStandalone(flags) {
  const currentVersion = readPackageVersion();
  let latestVersion = null;
  try {
    const resp = await fetch("https://registry.npmjs.org/agentlas/latest", { headers: { accept: "application/json" } });
    if (resp.ok) latestVersion = String((await resp.json()).version || "");
  } catch { /* offline 등 — 아래에서 안내 */ }
  const comparison = latestVersion ? compareSemVer(currentVersion, latestVersion) : null;
  if (flags.json) {
    return out(JSON.stringify({ currentVersion, latestVersion, updateAvailable: comparison == null ? null : comparison < 0, channel: "npm" }, null, 2));
  }
  out(`현재 버전: ${currentVersion}`);
  if (!latestVersion) {
    out("npm 레지스트리에서 최신 버전을 확인하지 못했습니다 (오프라인이거나 아직 미발행).");
    out("수동 업데이트:  npm i -g agentlas@latest");
    return;
  }
  out(`최신 버전: ${latestVersion}`);
  if (comparison == null) {
    out("버전 형식을 비교하지 못했습니다. 수동 업데이트:  npm i -g agentlas@latest");
  } else if (comparison < 0) {
    out("업데이트:  npm i -g agentlas@latest");
  } else {
    out("이미 최신 버전입니다.");
  }
}

async function cmdUpdate(args) {
  const flags = parseUpdateFlags(args);
  if (flags.help) return cmdUpdateHelp();
  // npm 설치본(비-Electron)은 데스크탑 앱 버전(0.7.x)과 비교하면 항상 "업데이트 가능"으로
  // 오판해 데스크탑 앱을 설치해 버린다 — standalone은 npm 채널로 분기.
  if (!isElectronRuntime()) return cmdUpdateStandalone(flags);
  const currentVersion = readPackageVersion();
  const release = await fetchDesktopRelease(flags.url);
  const latestVersion = String(release.version || "");
  const artifact = findCurrentArtifact(release);
  const comparison = compareSemVer(currentVersion, latestVersion);
  if (comparison == null) fail(`현재/최신 버전이 SemVer 형식이 아닙니다: current=${currentVersion} latest=${latestVersion}`);
  const updateAvailable = comparison < 0;
  const status = {
    currentVersion,
    latestVersion,
    releaseTag: release.releaseTag || null,
    ready: release.ready === true,
    notarized: release.notarized === true,
    platform: process.platform,
    arch: process.arch,
    updateAvailable,
    releaseUrl: desktopReleaseUrl(release),
    downloadUrl: artifact ? artifact.url : null,
  };

  if (flags.json) return out(JSON.stringify(status, null, 2));
  out(formatUpdateSummary(status));
  if (flags.check) return;
  if (release.ready !== true) fail("최신 릴리즈가 아직 공개 설치 가능 상태가 아닙니다.");
  if (!updateAvailable && !flags.force) return out("이미 최신 버전입니다.");
  if (process.platform !== "darwin") return out("이 OS는 아직 자동 설치를 지원하지 않습니다. 위 릴리즈/다운로드 링크에서 최신 설치 파일을 받으세요.");
  if (!artifact || !artifact.url) fail("현재 Mac에 맞는 DMG를 찾지 못했습니다.");
  await installMacDesktopUpdate(release, artifact, flags);
}

function requirePath(commandPath, label) {
  if (!fs.existsSync(commandPath)) fail(`업데이트에 필요한 도구가 없습니다: ${label}`);
  return commandPath;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = Boolean(options.capture);
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) return resolve(result);
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(`${path.basename(command)} 실패 (${code})${detail ? `\n${detail}` : ""}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateDesktopUpdateArtifact(artifact, options = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_ARTIFACT", "업데이트 아티팩트 정보가 없습니다.");
  }
  const url = parseSafeUpdateUrl(artifact.url, "업데이트 아티팩트 URL");
  const sha256 = String(artifact.sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw updateTransferError("AGENTLAS_UPDATE_MISSING_DIGEST", "안전한 자동 업데이트를 위해 64자리 SHA-256이 반드시 필요합니다.");
  }
  const sizeBytes = Number(artifact.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw updateTransferError("AGENTLAS_UPDATE_MISSING_SIZE", "안전한 자동 업데이트를 위해 정확한 sizeBytes가 반드시 필요합니다.");
  }
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : updateDownloadMaxBytes(options.env || process.env);
  if (sizeBytes > maxBytes) {
    throw updateTransferError("AGENTLAS_UPDATE_TOO_LARGE", `업데이트 파일 크기(${sizeBytes} bytes)가 허용 한도(${maxBytes} bytes)를 초과합니다.`);
  }
  let fileName = artifact.fileName == null ? "" : String(artifact.fileName).trim();
  if (fileName) {
    if (fileName.length > 180 || /[\\/\0]/.test(fileName) || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(".dmg")) {
      throw updateTransferError("AGENTLAS_UPDATE_INVALID_FILENAME", "업데이트 파일 이름이 안전하지 않습니다.");
    }
  }
  return { ...artifact, url, sha256, sizeBytes, fileName };
}

async function downloadUpdateFile(url, destination, artifact, options = {}) {
  const validated = validateDesktopUpdateArtifact({ ...artifact, url }, options);
  if (fs.existsSync(destination)) {
    throw updateTransferError("AGENTLAS_UPDATE_DESTINATION_EXISTS", `업데이트 다운로드 대상이 이미 존재합니다: ${destination}`);
  }
  const partialPath = options.partialPath || `${destination}.partial.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  if (fs.existsSync(partialPath)) {
    throw updateTransferError("AGENTLAS_UPDATE_PARTIAL_EXISTS", `업데이트 임시 파일이 이미 존재합니다: ${partialPath}`);
  }
  const hash = crypto.createHash("sha256");
  let fd = null;
  let actualBytes = 0;
  try {
    fd = fs.openSync(partialPath, "wx", 0o600);
    await consumeUpdateResponse(validated.url, {
      headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
      signal: options.signal,
    }, {
      ...options,
      kind: "download",
      maxBytes: Number.isSafeInteger(options.maxBytes) ? options.maxBytes : updateDownloadMaxBytes(options.env || process.env),
      expectedBytes: validated.sizeBytes,
      onChunk(chunk) {
        fs.writeSync(fd, chunk, 0, chunk.length);
        hash.update(chunk);
        actualBytes += chunk.length;
      },
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (actualBytes !== validated.sizeBytes) {
      throw updateTransferError("AGENTLAS_UPDATE_SIZE_MISMATCH", `다운로드 크기가 맞지 않습니다: expected=${validated.sizeBytes} actual=${actualBytes}`);
    }
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== validated.sha256) {
      throw updateTransferError("AGENTLAS_UPDATE_DIGEST_MISMATCH", `다운로드 SHA-256이 맞지 않습니다: expected=${validated.sha256} actual=${actualSha256}`);
    }
    fs.renameSync(partialPath, destination);
    return { bytes: actualBytes, sha256: actualSha256, destination };
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(partialPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function parseHdiutilMountPoint(output) {
  const line = String(output || "").split(/\r?\n/).find((item) => item.includes("/Volumes/"));
  if (!line) return "";
  return line.slice(line.indexOf("/Volumes/")).trim();
}

function macAppInstallPath() {
  if (process.env.AGENTLAS_APP_PATH) return process.env.AGENTLAS_APP_PATH;
  const match = String(process.execPath || "").match(/^(.*?Agentlas\.app)(?:\/|$)/);
  if (match && match[1]) return match[1];
  return "/Applications/Agentlas.app";
}

async function verifyMacAppBundle(appPath, options = {}) {
  const runner = options.runCommand || runCommand;
  const commands = options.commands || {};
  if (!commands.codesign || !commands.spctl) {
    throw updateTransferError("AGENTLAS_UPDATE_VERIFY_TOOL_MISSING", "앱 서명 검증 도구가 지정되지 않았습니다.");
  }
  await runner(commands.codesign, ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const detail = await runner(commands.codesign, ["-d", "--verbose=4", appPath], { capture: true });
  const signatureText = `${(detail && detail.stdout) || ""}\n${(detail && detail.stderr) || ""}`;
  const identifier = (signatureText.match(/^Identifier=(.+)$/m) || [])[1]?.trim() || "";
  const teamIdentifier = (signatureText.match(/^TeamIdentifier=(.+)$/m) || [])[1]?.trim() || "";
  if (identifier !== "com.agentlas.desktop") {
    throw updateTransferError("AGENTLAS_UPDATE_SIGNER_MISMATCH", `앱 번들 식별자가 올바르지 않습니다: ${identifier || "missing"}`);
  }
  if (!teamIdentifier || teamIdentifier.toLowerCase() === "not set") {
    throw updateTransferError("AGENTLAS_UPDATE_SIGNER_MISSING", "앱 서명에서 Apple TeamIdentifier를 확인하지 못했습니다.");
  }
  await runner(commands.spctl, ["-a", "-t", "exec", "-vv", appPath]);
  return { identifier, teamIdentifier };
}

function assertSameMacSigningIdentity(expected, actual, phase) {
  if (!expected || !actual) return;
  if (expected.identifier !== actual.identifier || expected.teamIdentifier !== actual.teamIdentifier) {
    throw updateTransferError(
      "AGENTLAS_UPDATE_SIGNER_MISMATCH",
      `${phase} 앱의 서명 주체가 다릅니다: expected=${expected.identifier}/${expected.teamIdentifier} actual=${actual.identifier}/${actual.teamIdentifier}`,
    );
  }
}

async function removeUpdatePathChecked(targetPath, options) {
  const fsImpl = options.fs || fs;
  if (!fsImpl.existsSync(targetPath)) return;
  try {
    await options.runCommand(options.commands.rm, ["-rf", targetPath]);
  } catch (error) {
    if (fsImpl.existsSync(targetPath)) throw error;
  }
  if (fsImpl.existsSync(targetPath)) {
    throw updateTransferError("AGENTLAS_UPDATE_REMOVE_FAILED", `업데이트 임시 경로를 제거하지 못했습니다: ${targetPath}`);
  }
}

/**
 * 기존 앱을 같은 디렉터리의 backup으로 원자 이동한 뒤 staging 앱을 검증해 교체한다.
 * backup이 생긴 이후 어느 단계든 실패하면 원본을 다시 이동하고 서명까지 재검증한다.
 */
async function replaceMacAppBundle(options) {
  const rawPaths = [options.sourceApp, options.targetApp, options.backupPath, options.stagingPath];
  if (rawPaths.some((value) => typeof value !== "string" || !value.trim())) {
    throw updateTransferError("AGENTLAS_UPDATE_PATH_MISSING", "업데이트 source/target/backup/staging 경로가 모두 필요합니다.");
  }
  const sourceApp = path.resolve(options.sourceApp);
  const targetApp = path.resolve(options.targetApp);
  const backupPath = path.resolve(options.backupPath);
  const stagingPath = path.resolve(options.stagingPath);
  const runner = options.runCommand || runCommand;
  const fsImpl = options.fs || fs;
  const commands = options.commands || {};
  const verifyApp = options.verifyApp || ((appPath, context) => verifyMacAppBundle(appPath, {
    runCommand: runner,
    commands,
    context,
  }));
  if (!commands.mv || !commands.rm || !commands.ditto) {
    throw updateTransferError("AGENTLAS_UPDATE_INSTALL_TOOL_MISSING", "앱 교체 도구가 지정되지 않았습니다.");
  }
  if (!fsImpl.existsSync(sourceApp)) {
    throw updateTransferError("AGENTLAS_UPDATE_SOURCE_MISSING", `설치할 앱을 찾지 못했습니다: ${sourceApp}`);
  }
  if (!sourceApp.toLowerCase().endsWith(".app") || !targetApp.toLowerCase().endsWith(".app")) {
    throw updateTransferError("AGENTLAS_UPDATE_INVALID_APP_PATH", "업데이트 source와 target은 .app 번들이어야 합니다.");
  }
  if (new Set([sourceApp, targetApp, backupPath, stagingPath]).size !== 4) {
    throw updateTransferError("AGENTLAS_UPDATE_PATH_COLLISION", "업데이트 source/target/backup/staging 경로가 서로 달라야 합니다.");
  }
  if (path.dirname(backupPath) !== path.dirname(targetApp) || path.dirname(stagingPath) !== path.dirname(targetApp)) {
    throw updateTransferError("AGENTLAS_UPDATE_NONATOMIC_PATH", "backup과 staging은 대상 앱과 같은 디렉터리에 있어야 합니다.");
  }
  if (fsImpl.existsSync(backupPath) || fsImpl.existsSync(stagingPath)) {
    throw updateTransferError("AGENTLAS_UPDATE_PATH_EXISTS", "업데이트 backup 또는 staging 경로가 이미 존재합니다.");
  }

  const hadOriginal = fsImpl.existsSync(targetApp);
  let sourceIdentity = null;
  let originalIdentity = null;
  try {
    sourceIdentity = await verifyApp(sourceApp, { phase: "source" });
    if (hadOriginal) {
      originalIdentity = await verifyApp(targetApp, { phase: "original" });
      assertSameMacSigningIdentity(originalIdentity, sourceIdentity, "새 릴리즈");
      await runner(commands.mv, [targetApp, backupPath]);
      if (fsImpl.existsSync(targetApp) || !fsImpl.existsSync(backupPath)) {
        throw updateTransferError("AGENTLAS_UPDATE_BACKUP_FAILED", "기존 앱 백업 이동을 확인하지 못했습니다.");
      }
      const backupIdentity = await verifyApp(backupPath, { phase: "backup" });
      assertSameMacSigningIdentity(originalIdentity, backupIdentity, "백업");
    }

    await runner(commands.ditto, [sourceApp, stagingPath]);
    if (!fsImpl.existsSync(stagingPath)) {
      throw updateTransferError("AGENTLAS_UPDATE_STAGE_MISSING", "복사 후 staging 앱을 찾지 못했습니다.");
    }
    const stagingIdentity = await verifyApp(stagingPath, { phase: "staging" });
    assertSameMacSigningIdentity(sourceIdentity, stagingIdentity, "staging");
    await runner(commands.mv, [stagingPath, targetApp]);
    if (fsImpl.existsSync(stagingPath) || !fsImpl.existsSync(targetApp)) {
      throw updateTransferError("AGENTLAS_UPDATE_COMMIT_FAILED", "검증된 앱의 최종 이동을 확인하지 못했습니다.");
    }
    const installedIdentity = await verifyApp(targetApp, { phase: "installed" });
    assertSameMacSigningIdentity(sourceIdentity, installedIdentity, "설치된");

    let backupRetained = false;
    if (hadOriginal && fsImpl.existsSync(backupPath)) {
      try {
        await removeUpdatePathChecked(backupPath, { fs: fsImpl, runCommand: runner, commands });
      } catch {
        backupRetained = fsImpl.existsSync(backupPath);
      }
    }
    return { hadOriginal, backupRetained, backupPath: backupRetained ? backupPath : null };
  } catch (originalError) {
    if (hadOriginal && fsImpl.existsSync(backupPath)) {
      let rollbackError = null;
      try {
        if (fsImpl.existsSync(stagingPath)) {
          try { await removeUpdatePathChecked(stagingPath, { fs: fsImpl, runCommand: runner, commands }); } catch { /* does not block original restore */ }
        }
        if (fsImpl.existsSync(targetApp)) {
          await removeUpdatePathChecked(targetApp, { fs: fsImpl, runCommand: runner, commands });
        }
        await runner(commands.mv, [backupPath, targetApp]);
        if (fsImpl.existsSync(backupPath) || !fsImpl.existsSync(targetApp)) {
          throw updateTransferError("AGENTLAS_UPDATE_RESTORE_MOVE_FAILED", "백업 앱의 원위치 복구를 확인하지 못했습니다.");
        }
        const restoredIdentity = await verifyApp(targetApp, { phase: "restored" });
        assertSameMacSigningIdentity(originalIdentity, restoredIdentity, "복구된");
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError) {
        const critical = updateTransferError(
          "AGENTLAS_UPDATE_ROLLBACK_FAILED",
          `앱 교체 실패 후 원본 복구를 완료하지 못했습니다. target=${targetApp} backup=${backupPath}: ${rollbackError.message || rollbackError}`,
          originalError,
        );
        critical.rollbackError = rollbackError;
        critical.backupPath = fsImpl.existsSync(backupPath) ? backupPath : null;
        critical.targetPath = fsImpl.existsSync(targetApp) ? targetApp : null;
        throw critical;
      }
      const rolledBack = updateTransferError(
        "AGENTLAS_UPDATE_REPLACEMENT_FAILED_ROLLED_BACK",
        `앱 교체에 실패했지만 기존 앱을 복구하고 서명을 확인했습니다: ${originalError.message || originalError}`,
        originalError,
      );
      rolledBack.restoredPath = targetApp;
      throw rolledBack;
    }

    try {
      if (fsImpl.existsSync(stagingPath)) {
        await removeUpdatePathChecked(stagingPath, { fs: fsImpl, runCommand: runner, commands });
      }
      if (!hadOriginal && fsImpl.existsSync(targetApp)) {
        await removeUpdatePathChecked(targetApp, { fs: fsImpl, runCommand: runner, commands });
      }
    } catch (cleanupError) {
      const cleanupFailure = updateTransferError(
        "AGENTLAS_UPDATE_CLEANUP_FAILED",
        `앱 교체 실패 후 임시 앱을 제거하지 못했습니다: ${cleanupError.message || cleanupError}`,
        originalError,
      );
      cleanupFailure.cleanupError = cleanupError;
      throw cleanupFailure;
    }
    if (hadOriginal && !fsImpl.existsSync(targetApp)) {
      throw updateTransferError(
        "AGENTLAS_UPDATE_ROLLBACK_FAILED",
        `앱 교체 실패 후 기존 앱과 백업을 모두 찾지 못했습니다. target=${targetApp} backup=${backupPath}`,
        originalError,
      );
    }
    throw originalError;
  }
}

async function installMacDesktopUpdate(release, artifact, flags) {
  const hdiutil = requirePath("/usr/bin/hdiutil", "hdiutil");
  const xcrun = requirePath("/usr/bin/xcrun", "xcrun");
  const spctl = requirePath("/usr/sbin/spctl", "spctl");
  const codesign = requirePath("/usr/bin/codesign", "codesign");
  const osascript = requirePath("/usr/bin/osascript", "osascript");
  const ditto = requirePath("/usr/bin/ditto", "ditto");
  const plistBuddy = requirePath("/usr/libexec/PlistBuddy", "PlistBuddy");
  const mv = requirePath("/bin/mv", "mv");
  const rm = requirePath("/bin/rm", "rm");
  const open = requirePath("/usr/bin/open", "open");
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

  const validatedArtifact = validateDesktopUpdateArtifact(artifact);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-update."));
  const fileName = validatedArtifact.fileName || `Agentlas-${macReleaseArch() || "mac"}.dmg`;
  const dmgPath = path.join(tmpDir, fileName);
  let mountPoint = "";
  const targetApp = macAppInstallPath();
  const transactionId = `${Date.now()}.${process.pid}.${crypto.randomBytes(5).toString("hex")}`;
  const targetDir = path.dirname(targetApp);
  const targetName = path.basename(targetApp, path.extname(targetApp));
  const backupPath = path.join(targetDir, `.${targetName}.backup.${transactionId}.app`);
  const stagingPath = path.join(targetDir, `.${targetName}.installing.${transactionId}.app`);

  try {
    out(`다운로드: ${fileName}`);
    await downloadUpdateFile(validatedArtifact.url, dmgPath, validatedArtifact);
    out("검증: DMG, notarization, Gatekeeper");
    await runCommand(hdiutil, ["verify", dmgPath]);
    await runCommand(xcrun, ["stapler", "validate", dmgPath]);
    await runCommand(spctl, ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmgPath]);

    const mount = await runCommand(hdiutil, ["attach", "-nobrowse", "-readonly", dmgPath], { capture: true });
    mountPoint = parseHdiutilMountPoint(mount.stdout);
    const sourceApp = mountPoint ? path.join(mountPoint, "Agentlas.app") : "";
    if (!sourceApp || !fs.existsSync(sourceApp)) {
      throw updateTransferError("AGENTLAS_UPDATE_APP_MISSING", "DMG 안에서 Agentlas.app을 찾지 못했습니다.");
    }

    const installedVersion = await runCommand(plistBuddy, ["-c", "Print :CFBundleShortVersionString", path.join(sourceApp, "Contents", "Info.plist")], { capture: true });
    const appVersion = installedVersion.stdout.trim();
    if (appVersion !== String(release.version)) {
      throw updateTransferError("AGENTLAS_UPDATE_VERSION_MISMATCH", `앱 버전이 릴리즈와 다릅니다: release=${release.version} app=${appVersion}`);
    }

    out("설치: 기존 Agentlas 종료 후 앱 교체");
    await runCommand(osascript, ["-e", 'tell application "Agentlas" to quit'], { capture: true, allowFailure: true });
    await sleep(2_000);
    const replacement = await replaceMacAppBundle({
      sourceApp,
      targetApp,
      backupPath,
      stagingPath,
      runCommand,
      commands: { codesign, spctl, ditto, mv, rm },
    });
    if (replacement.backupRetained) out(`주의: 검증된 새 앱은 설치됐지만 이전 앱 백업을 지우지 못했습니다: ${replacement.backupPath}`);
    if (fs.existsSync(lsregister)) await runCommand(lsregister, ["-f", targetApp], { allowFailure: true });
    if (flags.launch) await runCommand(open, ["-a", "Agentlas"], { allowFailure: true });
    out(`Agentlas ${release.version} 설치 완료.`);
  } finally {
    if (mountPoint) await runCommand(hdiutil, ["detach", mountPoint], { allowFailure: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Oberon 필름 스튜디오 (터미널 헤드리스 렌더) ───────────
// GUI 없이 매니페스트 하나로 영상 렌더를 돌린다. 손으로 쓰던 JSON+env 노가다 대신:
//   agentlas oberon scaffold my.json      → 편집 가능한 렌더 매니페스트 생성
//   agentlas oberon render my.json         → full Electron 렌더 스폰 + 진행률 스트리밍
//   agentlas oberon list                   → 최근 렌더 산출물
// 프롬프트는 직접 채우거나 `agentlas run oberon-film-studio "<브리프>"`로 에이전트가 채운다
// (OpenMontage "어시스턴트=오케스트레이터" 스킴).

function oberonRepoRoot() {
  return path.resolve(__dirname, "..");
}

function oberonParseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

function oberonSampleTitles(title) {
  const koStyle = (over) => ({
    fontName: "Pretendard",
    fontStack: '"Pretendard", system-ui, sans-serif',
    fontCategory: "humanist_sans",
    cjk: true,
    sizePct: 5,
    weight: 700,
    tracking: 0,
    case: "none",
    position: "center",
    fill: "#FFFFFF",
    safeAreaPct: 10,
    ...over,
  });
  return {
    aspectRatio: "16:9",
    titleCard: { kind: "title", lines: [title], style: koStyle({ sizePct: 9, outline: { color: "rgba(0,0,0,0.45)", widthPx: 2 } }), bg: "#000000", durationSec: 2 },
    endCard: { kind: "end_card", lines: ["AGENTLAS"], style: koStyle({ sizePct: 7, cjk: false }), bg: "#0A0A0A", durationSec: 1.5 },
    lowerThirds: [],
    subtitles: [],
    subtitleStyle: koStyle({ sizePct: 4.6, weight: 600, position: "lower_center", boxBg: "rgba(0,0,0,0.34)", outline: { color: "rgba(0,0,0,0.9)", widthPx: 3 }, safeAreaPct: 8 }),
    rationale: "scaffold 기본 타이포 — 한국어 본문/자막은 CJK 폰트 강제",
  };
}

function oberonScaffold(args) {
  const { flags, rest } = oberonParseFlags(args);
  const outPath = path.resolve(rest[0] || "oberon-manifest.json");
  const title = flags.title || "My Oberon Film";
  const aspect = flags.aspect || "16:9";
  const shotCount = Math.max(1, Math.min(Number(flags.shots) || 2, 12));
  const shots = Array.from({ length: shotCount }, (_, i) => ({
    shotId: `SH_${String(i + 1).padStart(3, "0")}`,
    index: i,
    durationSec: 4,
    aspectRatio: aspect,
    providerId: "google-veo",
    providerMode: "text_to_video",
    prompt: `((샷 ${i + 1} 프롬프트를 여기에 — 카메라/피사체/조명/무드. 'agentlas run oberon-film-studio' 로 에이전트가 채우게 할 수 있다.))`,
    negativePrompt: "low quality, blurry, distorted text, watermark",
  }));
  const manifest = {
    productionId: `oberon-${Date.now().toString(36)}`,
    title,
    aspectRatio: aspect,
    maxShots: shotCount,
    takesPerShot: 1,
    provider: flags.provider || "google-gemini-veo",
    model: flags.model || "veo-3.1-lite-generate-001",
    resolution: flags.resolution || "720p",
    shots,
  };
  if (flags.titles) manifest.titles = oberonSampleTitles(title);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8");
  out(`✓ 매니페스트 생성: ${outPath}`);
  out(`  · 샷 ${shotCount}개 · ${aspect} · ${manifest.provider}`);
  out(`  · 프롬프트를 채운 뒤:  agentlas oberon render ${path.basename(outPath)}`);
  out(`  · 또는 에이전트로 채우기:  agentlas run oberon-film-studio "30초 향수 광고 트레일러"`);
  if (!flags.titles) out(`  · 타이틀/자막 번인 샘플 포함하려면 --titles 플래그`);
}

function oberonRender(args) {
  const { flags, rest } = oberonParseFlags(args);
  if (!rest[0]) fail("렌더할 매니페스트 경로가 필요합니다:  agentlas oberon render <manifest.json>");
  const manifestPath = path.resolve(rest[0]);
  if (!fs.existsSync(manifestPath)) fail(`매니페스트를 찾을 수 없습니다: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return fail(`매니페스트 JSON 파싱 실패: ${e.message}`);
  }
  if (!Array.isArray(manifest.shots) || !manifest.shots.length) fail("매니페스트에 shots[] 가 비어 있습니다.");

  const root = oberonRepoRoot();
  const script = path.join(root, "scripts", "render-oberon-live-request.cjs");
  const builtRender = path.join(root, "dist", "electron", "oberon", "render.js");
  if (!fs.existsSync(script)) fail(`헤드리스 렌더 스크립트가 없습니다(패키지 앱에는 미포함): ${script}`);
  if (!fs.existsSync(builtRender)) fail(`Electron 빌드가 필요합니다. 먼저:  npm run build:electron   (없는 파일: ${builtRender})`);

  // --max-shots 등 오버라이드가 있으면 사용자 매니페스트는 그대로 두고 임시 패치본을 만든다.
  let reqPath = manifestPath;
  const overrides = {};
  if (flags["max-shots"]) overrides.maxShots = Number(flags["max-shots"]);
  if (flags["takes"]) overrides.takesPerShot = Number(flags["takes"]);
  if (flags["resolution"]) overrides.resolution = flags["resolution"];
  if (Object.keys(overrides).length) {
    const patched = { ...manifest, ...overrides };
    reqPath = path.join(os.tmpdir(), `oberon-req-${Date.now().toString(36)}.json`);
    fs.writeFileSync(reqPath, JSON.stringify(patched, null, 2), "utf8");
  }

  const deliveryDir = path.resolve(flags.delivery || path.join(path.dirname(manifestPath), `${slugifyOberon(manifest.title)}-delivery`));

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // full Electron으로 부팅
  childEnv.OBERON_LIVE_VEO = "1";
  childEnv.OBERON_LIVE_REQUEST_FILE = reqPath;
  childEnv.OBERON_LIVE_DELIVERY_DIR = deliveryDir;
  if (flags["max-polls"]) childEnv.OBERON_LIVE_MAX_POLLS = String(flags["max-polls"]);
  if (flags["poll-ms"]) childEnv.OBERON_LIVE_POLL_MS = String(flags["poll-ms"]);
  if (flags.open) childEnv.OBERON_LIVE_OPEN_DELIVERY = "1";

  out(`▶ Oberon 렌더: "${manifest.title}"  (${manifest.shots.length}샷, 최대 ${overrides.maxShots ?? manifest.maxShots ?? 3})`);
  out(`  매니페스트: ${manifestPath}`);
  out(`  납품 폴더:  ${deliveryDir}`);
  if (manifest.titles) out(`  타이틀/자막 번인: 활성 → *_titled.mp4 추가 생성`);

  if (flags["dry-run"]) {
    out("\n[dry-run] 실행할 명령:");
    out(`  ${process.execPath} ${script}`);
    out("  env: OBERON_LIVE_VEO=1");
    out(`       OBERON_LIVE_REQUEST_FILE=${reqPath}`);
    out(`       OBERON_LIVE_DELIVERY_DIR=${deliveryDir}`);
    out("  (full Electron · GEMINI_API_KEY/GOOGLE_CLOUD_PROJECT 볼트 필요)");
    return;
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let buf = "";
    const handle = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        oberonRenderLine(line, files);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", (c) => process.stderr.write(c));
    child.on("close", (code) => {
      if (code === 0) {
        out(`\n✓ 렌더 완료 — 납품 폴더: ${deliveryDir}`);
        const titled = files.filter((f) => f.kind && f.kind.startsWith("titled"));
        if (titled.length) out(`  타이틀/자막 번인본: ${titled.map((f) => f.name).join(", ")}`);
      } else {
        process.stderr.write(`\n✖ 렌더 실패 (exit ${code})\n`);
        process.exitCode = code || 1;
      }
      resolve();
    });
  });
}

function oberonRenderLine(line, files) {
  let m;
  if ((m = line.match(/^POLL status=(\S+) phase=(\S+) clips=(\S+) percent=(\d+)/))) {
    const [, status, phase, clips, pct] = m;
    const bar = oberonBar(Number(pct));
    process.stdout.write(`\r⏳ ${bar} ${String(pct).padStart(3)}%  ${phase}  clips ${clips}   `);
    if (status === "succeeded") process.stdout.write("\n");
    return;
  }
  if ((m = line.match(/^FILE kind=(\S+) name=(\S+) bytes=(\d+)/))) {
    files.push({ kind: m[1], name: m[2], bytes: Number(m[3]) });
    return;
  }
  if ((m = line.match(/^DELIVERY kind=(\S+) name=(\S+) path=(\S+) bytes=(\d+)/))) {
    out(`  📦 ${m[1].padEnd(11)} ${m[2]}  (${oberonBytes(Number(m[4]))})`);
    return;
  }
  if (line.startsWith("WARNINGS=")) {
    out(`  ⚠ ${line.slice("WARNINGS=".length)}`);
    return;
  }
  if (line.startsWith("JOB=") || line.startsWith("OUT_DIR=")) return; // 내부 추적
  if (/=(present|missing)$/.test(line)) return; // 키 존재 점검 라인
  if (line.trim()) out(`  ${line}`);
}

function oberonBar(pct) {
  const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
}

function oberonBytes(n) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + "MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + "KB";
  return n + "B";
}

function slugifyOberon(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[^\w가-힣-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .slice(0, 48) || "oberon"
  );
}

function oberonList() {
  const dir = path.join(userDataDir(), "oberon");
  if (!fs.existsSync(dir)) {
    out("아직 렌더 산출물이 없습니다.  agentlas oberon scaffold my.json  으로 시작하세요.");
    return;
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      const files = (() => {
        try {
          return fs.readdirSync(full);
        } catch {
          return [];
        }
      })();
      return { name: d.name, full, mtime, files };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 15);
  if (!entries.length) {
    out("아직 렌더 산출물이 없습니다.");
    return;
  }
  out(`최근 Oberon 렌더 (${dir}):\n`);
  for (const e of entries) {
    const masters = e.files.filter((f) => /master|titled/.test(f) && /\.(mp4|mov)$/.test(f));
    const when = e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ") : "";
    out(`  ${when}  ${e.name}`);
    if (masters.length) out(`            ${masters.join(", ")}`);
  }
  out(`\n폴더 열기:  agentlas oberon open`);
}

function oberonOpen(args) {
  const target = args[0] ? path.resolve(args[0]) : path.join(userDataDir(), "oberon");
  if (!fs.existsSync(target)) fail(`경로가 없습니다: ${target}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
  out(`폴더 열기: ${target}`);
}

function oberonHelp() {
  out(
    [
      "agentlas oberon — 터미널에서 AI 필름 렌더",
      "",
      "  oberon scaffold [out.json] [--title T] [--aspect 16:9] [--shots N] [--titles]",
      "                         편집 가능한 렌더 매니페스트 생성 (--titles: 타이틀/자막 번인 샘플 포함)",
      "  oberon render <manifest.json> [--delivery DIR] [--max-shots N] [--open] [--dry-run]",
      "                         full Electron 렌더 스폰 + 진행률 스트리밍 (GEMINI_API_KEY 볼트 필요)",
      "  oberon list            최근 렌더 산출물",
      "  oberon open [path]     산출물 폴더 열기",
      "",
      "프롬프트는 직접 채우거나, 에이전트에게:  agentlas run oberon-film-studio \"30초 향수 광고\"",
    ].join("\n"),
  );
}

async function cmdOberon(args) {
  const sub = args[0] || "help";
  const rest = args.slice(1);
  switch (sub) {
    case "scaffold":
    case "new":
      return oberonScaffold(rest);
    case "render":
      return oberonRender(rest);
    case "list":
    case "ls":
      return oberonList(rest);
    case "open":
      return oberonOpen(rest);
    case "help":
    case "--help":
    case "-h":
      return oberonHelp();
    default:
      fail(`알 수 없는 oberon 하위명령: ${sub}  (scaffold|render|list|open|help)`);
  }
}

function cmdHelp() {
  const H = (s) => `\n\x1b[1m${s}\x1b[0m`;
  const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
  const hdr = (s) => (useColor ? H(s) : "\n" + s);
  out(
    [
      "agentlas — the operating system for agents, in your terminal",
      "",
      "  agentlas                 open the terminal (wordmark, then type a task)",
      "  agentlas \"<task>\"        auto-route to the best agent and run once",
      "",
      hdr("TALK & RUN"),
      "  <agent>                  jump into a chat with one agent (e.g. agentlas seo)",
      "  run [agent] [prompt]     one-shot — omit agent to auto-route (reads stdin if no prompt)",
      "    --experience-desktop-loadout  use Desktop's fresh exact Operational/Taste loadout receipt",
      "    --no-experience               highest precedence; do not read or inject a loadout",
      "  firm <firm> [cmd]        delegate to a company's CEO (interactive if no cmd)",
      "  chats [n]                recent conversations   ·   chat resume in REPL: /resume",
      "",
      hdr("AGENTS & HUB   (Agentlas OS surface)"),
      "  search \"<what you need>\" discover agents in the Hub + local            (hep-search)",
      "  install <slug>           install an agent from the Hub                    (hep-cloud)",
      "  build \"<request>\"        build/repair/package an agent or team           (hep-build)",
      "  upload <path>            save owner-private in Agent Cloud (default)       (hep-upload)",
      "    --visibility marketplace  explicit compatibility flag: publish to Hub",
      "  connect [<sub>]          wire Telegram / platforms to an agent team       (hep-connect)",
      "  import <path>            import a local agent/team folder",
      "  list                     installed agents/companies + active runtime",
      "  experience <sub>         portable Experience: list|inspect|validate|save|publish|status|export|unpublish",
      "                            legacy local intents require explicit legacy-* commands",
      "  variant resolve          local variant selection: selected|fallback|base-only|error",
      "",
      hdr("EXECUTE"),
      "  storm <goal>             Agentlas Goal+UltraCode harness: plan → allocate → execute → verify  [--research]",
      "  swarm <goal>             emergent agent swarm — parallel workers + synthesizer [--parallel N]",
      "  network <request>        decompose a request into an A2A task force       (hep-network)",
      "  call \"a,b\" \"<ctx>\"       invoke named Hub/Cloud agents                    (hep-call)",
      "  browser [<sub>]          real browser execution hardpoint                 (hep-browser)",
      "  route \"<request>\"        routing preview — which agent/pipeline would take this",
      "",
      hdr("KNOWLEDGE & RESEARCH"),
      "  research <sub>           Research Engine: status|gather|search|read|plan",
      "  career-graph <sub>       source routing index: status|list|add",
      "  ontology <sub>           project knowledge: status|list|add   (REPL: /ontology)",
      "  journal <sub>            Stormbreaker run journal: status|verify|repair|gate",
      "",
      hdr("ACCOUNT & OPS"),
      "  login | logout | whoami  Agentlas Cloud sign-in (browser flow)",
      "  automation <sub>         list|add|on|off|remove|run <id>|runs|daemon (local scheduler)",
      "  creds <sub> · env        credentials vault and shared env keys",
      "  multimodal               image/video/audio provider settings",
      "  usage · telegram · mcp   local usage · telegram bindings · MCP servers",
      "  doctor                   check runtimes, data, credentials",
      "  update                   check for a newer agentlas on npm",
      "  setup                    re-run first-launch setup (language · runtime · permission)",
      "  version                  print the Agentlas CLI version",
      "",
      hdr("ADVANCED"),
      "  hep <sub…>               full Hephaestus passthrough (wizard·security·cards·ao·plugins·meta-agent…)",
      "  netadmin <sub>           local network admin: init|status|reindex|bench|add-source",
      "  cloud <sub>              cloud assets: save|publish|package|list|restore|field-test",
      "  cd <agent>               print the agent folder — cd \"$(agentlas cd seo)\" && claude",
      "  oberon <sub>             AI film render (scaffold|render|list)",
      "",
      "Options: --runtime claude-code|codex|gemini  ·  --permission read|write|full (default write)",
      "In the REPL, type / for the command palette (/build /route /research /storm /swarm …).",
    ].join("\n"),
  );
}

// ── 유틸 ──────────────────────────────────────────────────
function out(s) {
  process.stdout.write(s + "\n");
}
function fail(msg) {
  process.stderr.write("✖ " + msg + "\n");
  process.exit(1);
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

// ── 엔트리 ─────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  let runtimeOverride = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runtime") {
      runtimeOverride = argv[++i];
    } else if (argv[i] === "--permission" || argv[i] === "-P") {
      const p = (argv[++i] || "").toLowerCase();
      if (!["read", "write", "full"].includes(p)) fail(`알 수 없는 권한: ${p} (read|write|full)`);
      PERMISSION = p;
      PERMISSION_EXPLICIT = true;
    } else {
      rest.push(argv[i]);
    }
  }
  const cmd = rest[0] || "";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cmdHelp();
  if (cmd === "version" || cmd === "--version" || cmd === "-V") return cmdVersion();
  if (cmd === "update") return cmdUpdate(rest.slice(1));

  const db = openDb();

  // Finish or compensate any Cloud install interrupted between the durable
  // filesystem swap and the SQLite transaction before normal agent resolution.
  recoverCloudInstallJournalsCli(db);

  // Agentlas 아키텍처 빌트인 에이전트를 보장(앱과 동일, 멱등·버전 게이팅). 스키마가 준비됐을 때만.
  try { seedBuiltins(db); } catch { /* best-effort */ }

  // 인자 없이 `agentlas` → 에이전트 1개면 바로 대화형, 아니면 목록 + 사용법
  if (cmd === "") {
    const agents = listAgents(db);
    if (agents.length === 1) return launchInteractive(db, agents[0], runtimeOverride);
    return launchTui(db, null, runtimeOverride); // splash + interactive agent picker
  }

  switch (cmd) {
    case "list":
      return cmdList(db);
    case "import":
      return cmdImport(db, rest[1]);
    case "cd":
      return cmdCd(db, rest[1]);
    case "run": {
      const runInput = parseRunExperienceArgs(rest.slice(2));
      return cmdRun(db, rest[1], runInput.prompt, runtimeOverride, runInput.experience);
    }
    case "chat":
    case "open":
      return cmdOpen(db, rest[1], runtimeOverride);
    case "firm":
      return cmdFirm(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "env":
      return cmdEnv(db);
    case "multimodal":
      return cmdMultimodal(db, rest.slice(1));
    case "oberon":
    case "film":
      return cmdOberon(rest.slice(1));
    case "ontology":
      return cmdOntology(rest.slice(1));
    case "career-graph":
    case "career_graph":
    case "graph":
      return cmdCareerGraph(rest.slice(1));
    case "cloud":
      return cmdCloud(db, rest.slice(1), runtimeOverride);
    case "creds":
      return cmdCreds(db, rest.slice(1));
    case "storm": {
      const cwd = projectCwd();
      const projectPath = ensureTerminalProjectForExecutionCli(db, cwd, PERMISSION, "terminal-storm");
      return parity().cmdStorm(db, rest.slice(1), runtimeOverride, { cwd, projectPath, permission: PERMISSION });
    }
    case "swarm": {
      const cwd = projectCwd();
      const projectPath = ensureTerminalProjectForExecutionCli(db, cwd, PERMISSION, "terminal-swarm");
      return parity().cmdSwarm(db, rest.slice(1), runtimeOverride, { cwd, projectPath, permission: PERMISSION });
    }
    case "automation":
    case "automations":
      return parity().cmdAutomation(db, rest.slice(1), runtimeOverride);
    case "hep":
    case "hephaestus":
      return parity().cmdHep(db, rest.slice(1));
    // ── Agentlas OS 정식 표면 (hep-*) 1급 노출 ──
    case "build":
      // Terminal-owned preflight: trusted system-global MCP metadata first, one consent,
      // then pass only approved catalog IDs/value-free shortages to the existing builder.
      ensureTerminalProjectForExecutionCli(db, projectCwd(), PERMISSION, "terminal-build");
      return terminalAssets.cmdBuild({
        db,
        args: rest.slice(1),
        userDataDir: userDataDir(),
        cwd: projectCwd(),
        input: process.stdin,
        promptOutput: process.stderr,
        out,
        probeMcpServer: (server, probeOptions) => probeApprovedTerminalMcp(db, server, runtimeOverride, projectCwd(), probeOptions),
        invokeBuild: (request, metadata) => runTerminalBuilder(db, request, metadata, runtimeOverride, projectCwd()),
      });
    case "experience":
      return terminalExperienceExchange.cmdExperienceExchange({
        args: rest.slice(1),
        userDataDir: userDataDir(),
        cwd: projectCwd(),
        out,
        env: process.env,
        getSessionCookie: cloudSessionCookieCli,
        fetchHub: (url, init) => fetchHubCli(url, init),
        legacyCommand: (legacyOptions) => terminalAssets.cmdExperience(legacyOptions),
      });
    case "variant":
      return terminalAssets.cmdVariant({
        db,
        args: rest.slice(1),
        userDataDir: userDataDir(),
        cwd: projectCwd(),
        out,
      });
    case "search": // hep-search — 에이전트 디렉터리 발견 (Hub + 로컬)
      if (!rest[1]) return fail('usage: agentlas search "<찾는 일>" [--limit 10]');
      return parity().cloudSearch(db, rest.slice(1));
    case "install": // public Hub package install — slug로 에이전트 설치
      if (!rest[1]) return fail('usage: agentlas install <slug>   (먼저 agentlas search "할 일" 로 찾으세요)');
      return cmdCloudInstall(db, rest[1]);
    case "upload": { // 기본은 owner-private Agent Cloud, public Hub는 명시 flag로만.
      if (!rest[1]) return fail("usage: agentlas upload <에이전트 폴더 경로> [--visibility marketplace]");
      const uploadArgs = rest.slice(1);
      return cmdCloud(db, [cloudActionForTopLevelUpload(uploadArgs), ...uploadArgs], runtimeOverride);
    }
    case "connect": // hep-connect — Telegram 등 플랫폼 연결
      return parity().cmdHep(db, ["hep-connect", ...rest.slice(1)]);
    case "browser": // hep-browser — 실제 브라우저 실행 하드포인트
      return parity().cmdHep(db, ["hep-browser", ...rest.slice(1)]);
    case "call": // hep-call — 지정 에이전트 호출/준비
      return parity().cmdHep(db, ["hep-call", ...rest.slice(1)]);
    case "network": // hep-network — A2A 태스크포스 분해/스케줄
    case "taskforce":
      return parity().cmdHep(db, ["hep-network", ...rest.slice(1)]);
    case "route": // 라우팅 미리보기 (실행 없음)
      return parity().cmdHep(
        db,
        rest.length > 1
          ? ["route", rest.slice(1).join(" "), "--project", runCwd(), "--runtime", "terminal"]
          : ["route"],
      );
    case "research": // Research Engine
      return parity().cmdHep(db, ["research", ...rest.slice(1)]);
    case "netadmin": // 로컬 에이전트 네트워크 관리 (init|status|reindex|bench|add-source)
      return parity().cmdHep(db, ["network", ...rest.slice(1)]);
    case "journal": // Stormbreaker 런 저널
      return parity().cmdHep(db, ["stormbreaker", "journal", ...rest.slice(1)]);
    case "mcp":
      return parity().cmdMcp(db);
    case "chats":
      return parity().cmdChats(db, rest.slice(1));
    case "login":
      return parity().cmdLogin(rest.slice(1));
    case "logout":
      return parity().cmdLogout();
    case "whoami":
      return parity().cmdWhoami();
    case "usage":
      return parity().cmdUsage(db);
    case "telegram":
    case "tg":
      return parity().cmdTelegram(db, rest.slice(1));
    case "doctor":
      return cmdDoctor(db);
    case "setup": {
      // re-run the first-launch onboarding wizard (language → runtime → permission)
      const cfg = require("./agentlas-config.cjs");
      const dir = userDataDir();
      const p = cfg.loadPrefs(dir);
      delete p.onboarded;
      cfg.savePrefs(dir, p);
      return launchTui(db, null, runtimeOverride);
    }
    default: {
      // 알려진 명령이 아니면 에이전트명 → (없으면) 회사명 → 대화형 세션
      const agent = resolveAgent(db, cmd);
      if (agent) return launchInteractive(db, agent, runtimeOverride);
      const firm = resolveFirm(db, cmd);
      if (firm) return cmdFirm(db, cmd, "", runtimeOverride);
      const prompt = rest.join(" ").trim();
      if (prompt) return cmdAutoRun(db, prompt, runtimeOverride);
      fail(`에이전트/회사를 찾을 수 없습니다: ${cmd}  (agentlas list 로 확인)`);
    }
  }
}

// 런처가 스폰하는 실행 파일일 때만 CLI main을 돌린다. 회귀 테스트/라이브러리 require는 종료하지 않는다.
if (require.main === module) {
  main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
}

module.exports = {
  runApi,
  normalizeCustomApiBaseUrl,
  readCustomApiBaseUrl,
  parseDotEnvCli,
  isProtectedChildEnvKeyCli,
  mergeChildEnvValuesCli,
  openNodeSqliteDb,
  ensureMemoryContextColumn,
  writeJsonPrivateAtomicCli,
  resolveCredentialSourcePath,
  upsertEnvLine,
  fetchHubCli,
  hubTimeoutConfig,
  compareSemVer,
  parseSemVer,
  updateTimeoutConfig,
  fetchUpdateMetadata,
  validateDesktopUpdateArtifact,
  downloadUpdateFile,
  verifyMacAppBundle,
  replaceMacAppBundle,
  captureRuntime,
  buildArgs,
  captureOutputLimit,
  materializeCloudListingCli,
  recoverCloudInstallJournalCli,
  recoverCloudInstallJournalsCli,
  persistCloudListingCli,
  cloudSystemPromptFromPackageCli,
  agentSystemPromptCli,
  listOwnedCloudAgentsCli,
  restoreOwnedCloudAgentCli,
  deleteCloudAgentCli,
  readCloudAssetStateCli,
  normalizeCloudAssetDescriptorCli,
  packageCloudAgentCli,
  cloudVisibilityForAction,
  cloudActionForTopLevelUpload,
  cloudHashPackage,
  cloudPackageHashVersion,
  cloudPortablePathConflict,
  cloudPortableExecutableForFile,
  parseRunExperienceArgs,
  resolveRuntimeExperienceCli,
  runTerminalBuilder,
  resolveRuntime,
  listAvailableRuntimes,
  probeApprovedTerminalMcp,
  finalizeExperienceExecutionCli,
  buildChildEnvCli,
  augmentSystem,
  curateCliReply,
  TERMINAL_MEMORY_CORE,
  TERMINAL_MEMORY_CORE_MAX_TOKENS,
  approximatePromptTokens,
  memoryEmitterPromptFor,
  credentialIndexReminderFor,
  ensureCoreProjectCli,
  ensureTerminalProjectForExecutionCli,
  ensureAgentlasProjectStateIgnoreCli,
  DEFAULT_API_MODEL,
  ANTHROPIC_COMPAT_API,
  // 자동 라우팅 회귀 테스트 표면 — 약한 매치 직답/오라우팅 방지 규칙 검증용.
  autoRouteAgent,
  autoRouteNote,
  autoRoutePreamble,
  directSystemPrompt,
};
