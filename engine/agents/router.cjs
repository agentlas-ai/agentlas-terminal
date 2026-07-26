"use strict";
/*
 * agents/router — 자동 라우팅: `agentlas "<task>"` 의 최적 에이전트 판정.
 *
 * v1 모놀리스(legacy-v1-engine-snapshot engine/agentlas.cjs ~209-890)의 라우팅
 * 로직을 v2 모듈 경계로 포팅했다. 하우스 룰(오너 결정, 위반 = 하드 실패):
 *
 *  1. 최종 픽 = 호스트 LLM 판정(engine/agentlas-judgment.cjs). 어휘/키워드
 *     스코어러(rankRouteAgents)는 후보 "모집(recall widening)" 전용이다 —
 *     절대 최종 라우트를 결정하지 않는다.
 *  2. 판정 런타임이 없으면 정직한 폴백: 오케스트레이터/기본 에이전트로 가되
 *     반드시 note(왜 판정을 못 했는지)를 실어 보낸다. 조용한 폴백 금지.
 *  3. 웹 전용(private) 에이전트는 후보에 절대 들어가지 않는다 —
 *     registry.listRoutableAgents 가 유일한 후보 소스다.
 *
 * 닫힌형 결정적 가드(모델 호출 전, v1 동형):
 *  - 잡담 short-circuit (isTrivialRoutePrompt)
 *  - 경로 스트리핑 (ROUTE_PATH_RE — 경로 토큰이 strong 채널을 때리던 사고 수리)
 *  - 명시적 "에이전트/팀/회사 만들기" 의도 → 메타빌더 직행 (AGENT_BUILD_TERMS 게이트;
 *    큐레이션된 닫힌형 의도 목록으로, 약한 키워드 점수 경쟁이 아니다)
 */
const crypto = require("node:crypto");
const { listRoutableAgents, listAgents, rowToAgent } = require("./registry.cjs");

const GLOBAL_ORCHESTRATOR_SLUG = "agentlas-orchestrator";
// 메타-빌더(에이전트/팀/회사 생성) — 약한 키워드 점수 경쟁에서 빼고, 명시적 build 의도일 때만 직행.
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

// "ai"/"llm" 같은 초범용 토큰은 판별력이 0 — 이런 단어 하나로 전문 에이전트가 선택되던
// 오라우팅을 막는다. "local"/"imported"/"team"은 임포터 보일러플레이트/slug에 편재.
const ROUTE_STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "make", "build", "create", "agent", "agents", "team", "please", "ai", "llm", "local", "imported", "인공지능", "에이아이", "좀", "해주세요", "해줘", "만들어", "붙여", "연결", "작업", "요청"]);

const ROUTE_HINTS = [
  {
    slug: "agentlas-app-builder",
    terms: [
      "apps generate", "app builder", "make an app", "build an app", "create an app",
      "generated app", "generate app", "internal app", "dedicated app", "workflow app",
      "dashboard app", "studio app", "service-app", "creative-studio", "scaffold-app",
      "operate-app", "앱빌더", "앱 빌더", "앱 만들어", "앱 만들", "전용 앱", "내장 앱",
      "내부 앱", "생성 앱", "워크플로우 앱", "대시보드 앱", "스튜디오 앱",
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
// (v1 사고 2026-07-12: 프롬프트 속 절대경로 토큰이 임포트 에이전트 system_prompt 속
// 절대경로와 우연 일치해 점수를 쌓고 strong 게이트까지 뚫었다. 대칭 적용 필수.)
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

// 정체성 존(slug/이름/태그라인) 적중은 강한 신호. systemPrompt 본문 적중은 약한 신호.
function routeIdentityHaystack(agent) {
  return routeNormalize(routeStripPaths([agent.slug, agent.name, agent.nameEn, agent.tagline, agent.taglineEn].join("\n")));
}
function routeHaystack(agent) {
  return routeNormalize(routeStripPaths([
    agent.slug, agent.name, agent.nameEn, agent.tagline, agent.taglineEn,
    String(agent.systemPrompt || "").slice(0, 3500),
  ].join("\n")));
}

const APP_BUILDER_EXPLICIT_TERMS = ROUTE_HINTS[0].terms;
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

function isAgentBuildIntent(prompt) {
  // 경로/파일 참조는 빌드 의도의 증거가 아니다 — "agent-notes.md" 같은 파일명이
  // BUILD_ENTITY_RE를 때려 메타빌더(score 1000)로 직행하던 우회로 차단(v1 수리 유지).
  // ⚠️ 남은 슬래시는 통째로 지우지 않고 공백으로만 벌린다 — "에이전트/팀 만들어줘"의
  // 슬래시-엔티티를 삭제하면 빌드 의도를 놓친다.
  const p = routeNormalize(
    routeStripPaths(prompt)
      .replace(/\S+\.[A-Za-z0-9]{1,6}(?=\s|$)/g, " ")
      .replace(/[\\/]+/g, " "),
  );
  if (!p.trim() || isTrivialRoutePrompt(p)) return false;
  if (AGENT_BUILD_TERMS.some((term) => p.includes(routeNormalize(term)))) return true;
  return BUILD_ENTITY_RE.test(p) && BUILD_VERB_RE.test(p);
}

/** 메타빌더 해석 — private 필터를 우회한 직접 조회(v1 동형): 메타빌더는 목록/일반
 *  스코어링에서는 숨겨지지만, 명시적 build 의도로는 직행 라우팅되어야 한다. */
function resolveMetaBuilder(db) {
  try {
    const rows = db
      .prepare("SELECT * FROM installed_agents WHERE slug IN ('agentlas-core-engine-meta-agent-builtin','agentlas-meta-agent')")
      .all();
    for (const slug of META_BUILDER_SLUGS) {
      const row = rows.find((r) => r.slug === slug);
      if (row) return rowToAgent(row);
    }
  } catch { /* ignore */ }
  return null;
}

/** 판정 폴백용 기본 에이전트: 오케스트레이터 → 첫 visible 에이전트. */
function resolveDefaultRouteAgent(db) {
  try {
    const routable = listRoutableAgents(db);
    const orch = routable.find((a) => a.slug === GLOBAL_ORCHESTRATOR_SLUG);
    if (orch) return orch;
    const visible = listAgents(db);
    return visible[0] || routable[0] || null;
  } catch {
    return null;
  }
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
  // 대칭 스트리핑 필수: promptText는 이름(+20)·힌트(+12↑) strong 채널의 입력이다.
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
  const identityHay = (pre && pre.identityHay) || routeIdentityHaystack(agent);
  const haystack = (pre && pre.haystack) || routeHaystack(agent);
  let score = 0;
  let strong = false; // 이름 언급/정체성 적중/큐레이션 힌트 — strong 증거가 있어야 후보로서 의미가 있다
  const terms = [];
  const seenNames = new Set();
  for (const name of [agent.slug, agent.name, agent.nameEn].filter(Boolean)) {
    const n = routeNormalize(name);
    // 4자 미만 일반 단어가 +20을 독식하지 않도록 가드; name===nameEn 중복 +20 방지.
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
      score += 6;
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

/**
 * 어휘 스코어링 — 후보 "모집" 전용(recall widening). 하우스 룰: 이 점수는 절대 최종
 * 라우트를 결정하지 않는다. 후보는 listRoutableAgents(웹 전용 private 제외)만 쓴다.
 */
function rankRouteAgents(db, prompt, lang) {
  const resolvedLang = lang || "en";
  const agents = listRoutableAgents(db).filter((agent) => !NON_GENERIC_ROUTE_SLUGS.has(agent.slug));
  if (!agents.length) return [];
  let terms = routeTokenize(prompt);
  const hays = agents.map((agent) => ({ identityHay: routeIdentityHaystack(agent), haystack: routeHaystack(agent) }));
  // IDF 근사 — 설치 에이전트 절반 이상의 haystack에 나오는 단어는 판별력이 없어 제외.
  if (agents.length >= 3) {
    terms = terms.filter((term) => hays.filter((h) => h.haystack.includes(term)).length * 2 <= agents.length);
  }
  return agents
    .map((agent, i) => scoreRouteAgent(prompt, terms, agent, resolvedLang, hays[i]))
    .sort((a, b) => b.score - a.score);
}

function directRouteChoice(lang) {
  return {
    direct: true,
    agent: null,
    score: 0,
    terms: [],
    strong: false,
    reason: lang === "ko"
      ? "특정 전문 에이전트가 필요 없는 일반 요청입니다"
      : "this is a general request that needs no specialist agent",
  };
}

/**
 * 판정 불가 정직 폴백(하우스 룰): 어휘로 전문 에이전트를 고르지 않는다. 기본
 * 에이전트(오케스트레이터)로 가되 사유를 note로 반드시 노출한다 — 조용한 폴백 금지.
 * reason 구분: "no_runtime"=연결 모델 없음, "model_unavailable"=모델은 연결됐지만
 * 이번 판정이 타임아웃/불량 응답으로 실패.
 */
function noModelRouteChoice(db, lang, reason = "no_runtime") {
  const fallbackAgent = resolveDefaultRouteAgent(db);
  const message = reason === "model_unavailable"
    ? (lang === "ko"
        ? "연결된 모델이 제때 응답하지 않아 어떤 전문 에이전트가 맞는지 판단하지 못했습니다. 잠시 후 다시 시도하거나 모델 상태를 확인해 주세요. 지금은 기본 에이전트로 실행합니다"
        : "the connected model didn't answer in time, so I couldn't judge which specialist agent fits; retry in a moment or check the model — running with the default agent for now")
    : (lang === "ko"
        ? "연결된 모델이 없어 어떤 전문 에이전트가 맞는지 판단하지 못했습니다. 모델을 연결하면 자동 라우팅이 됩니다. 지금은 기본 에이전트로 실행합니다"
        : "no model is connected, so I couldn't judge which specialist agent fits; connect a model to enable auto-routing — running with the default agent for now");
  return {
    direct: !fallbackAgent,
    agent: fallbackAgent,
    score: 0,
    terms: [],
    strong: false,
    noModel: true,
    noModelReason: reason,
    routeSource: "deterministic",
    reason: message,
  };
}

/** 직답 모드 시스템 프롬프트 — 페르소나·라우팅 오염 없이 현재 런타임 그대로 답한다. */
function directSystemPrompt(lang) {
  return lang === "ko"
    ? "당신은 Agentlas 터미널의 기본 어시스턴트입니다. 특별한 페르소나 없이 사용자의 요청에 정확하고 간결하게 바로 답하세요. 에이전트 라우팅이나 이미지 생성 능력을 스스로 언급하지 마세요."
    : "You are the Agentlas terminal's default assistant. Answer the user's request directly and concisely, with no special persona. Do not bring up agent routing or image-generation capabilities on your own.";
}

// ── 판정 러너 배선 ─────────────────────────────────────────
// 하우스 룰: 모델 접근은 주입식(setJudgmentRunner). 이미 러너가 설치돼 있으면 절대
// 덮어쓰지 않는다(테스트의 fake 러너 / 상위 호스트의 배선 존중). 없을 때만, 해석된
// 런타임으로 헤드리스 캡처(workforce/capture.cjs captureRuntime) 러너를 깐다.
// BYOK/Ollama는 같은 모듈의 runApi 원샷 경로 — "연결 모델이 판정한다"는 계약이
// CLI 서브프로세스 런타임에만 성립하는 반쪽이 되지 않게 한다(v1 수리 유지).
function ensureJudgeRunner(db, runtime) {
  let judgment;
  try {
    judgment = require("../agentlas-judgment.cjs");
  } catch {
    return null;
  }
  if (judgment.hasJudgmentRunner()) return judgment;
  const capture = require("../workforce/capture.cjs");
  let rt = runtime || null;
  if (!rt && db) {
    // 명시 런타임이 없으면 공유 DB의 active_runtime(데스크탑이 확정한 런타임)로 시도.
    try {
      const ar = require("../runtimes/detect.cjs").activeRuntimeRow(db);
      if (ar && capture.RUNTIME_BIN[ar.kind]) rt = { kind: ar.kind, model: ar.model || null };
      else if (ar && ar.kind === "byok" && ar.backend) rt = { kind: "byok", backend: ar.backend, model: ar.model || null };
      else if (ar && ar.kind === "ollama") rt = { kind: "ollama", model: ar.model || null };
    } catch { /* 러너 미설치로 남는다 — 정직 폴백 경로 */ }
  }
  if (rt && capture.RUNTIME_BIN[rt.kind]) {
    judgment.setJudgmentRunner(async ({ system, prompt, signal }) => {
      try {
        return await capture.captureRuntime(rt.kind, system, prompt, {
          cwd: capture.projectCwd(),
          permission: "read",
          model: rt.model || undefined,
          signal,
        });
      } catch {
        return ""; // 러너 실패 → judgeLabels가 fallback verdict로 정직하게 처리
      }
    });
    return judgment;
  }
  if (rt && (rt.kind === "byok" || rt.kind === "ollama")) {
    const backend = rt.kind === "ollama" ? "ollama" : rt.backend;
    if (backend) {
      judgment.setJudgmentRunner(async ({ system, prompt, signal }) => {
        const baseFetch = globalThis.fetch;
        const fetchImpl = typeof baseFetch === "function" && signal
          ? (url, init) => baseFetch(url, { ...(init || {}), signal })
          : baseFetch;
        try {
          return await capture.runApi(backend, rt.model || null, system, prompt, { fetch: fetchImpl });
        } catch {
          return "";
        }
      });
      return judgment;
    }
  }
  return judgment;
}

// ── 모델 최종 라우팅 판정 ──────────────────────────────────
const ROUTE_JUDGE_CANDIDATE_CAP = 30;
const ROUTE_JUDGE_DIRECT_LABEL = "direct";
const ROUTE_JUDGE_META_LABEL = "meta-builder";
const ROUTE_JUDGE_APP_LABEL = "app-builder";
const APP_BUILDER_ROUTE_SLUG = "agentlas-app-builder";

/**
 * 자동 라우팅 최종 판정.
 * @param db 공유 SQLite
 * @param task 사용자 요청 원문
 * @param opts { lang?, signal?, runtime?, timeoutMs? }
 *   runtime: runtimes/resolve.cjs 가 확정한 런타임 — 판정 러너 배선에 쓴다.
 * @returns choice = { agent|null, direct?, score, terms, strong, reason,
 *   routeSource: "llm"|"deterministic", noModel?, noModelReason?, note }
 *   note는 사용자에게 반드시 출력해야 하는 한 줄(조용한 라우팅 금지).
 */
async function resolveAutoRoute(db, task, opts = {}) {
  const lang = opts.lang === "ko" ? "ko" : "en";
  const finish = (choice) => ({ ...choice, note: autoRouteNote(choice, lang) });
  const judgment = ensureJudgeRunner(db, opts.runtime || null);

  const promptText = routeNormalize(routeStripPaths(task));
  // 잡담은 닫힌형 결정적 가드로 직답 — 모델 호출 없이 종결(v1 동형).
  if (!promptText.trim() || isTrivialRoutePrompt(promptText)) {
    return finish({ ...directRouteChoice(lang), routeSource: "deterministic" });
  }
  // 명확한 "에이전트/팀/회사 만들기" 의도 → 메타빌더 직행. AGENT_BUILD_TERMS는
  // 큐레이션된 닫힌형 의도 게이트(잡담 가드와 같은 계층)이지 점수 경쟁이 아니다 —
  // 명시적 build 구문일 때만 발화하고, 파일명/경로로는 발화하지 않는다.
  if (isAgentBuildIntent(task)) {
    const meta = resolveMetaBuilder(db);
    if (meta) {
      return finish({
        agent: meta,
        score: 1000,
        strong: true,
        terms: [],
        routeSource: "deterministic",
        reason: lang === "ko"
          ? "새 에이전트/팀/회사를 만드는 요청이라 메타에이전트(빌더)로 라우팅했습니다"
          : "the request is to build a new agent/team/company, so it routes to the meta-agent (builder)",
      });
    }
  }
  // 연결 모델 없음 → 어휘로 전문 에이전트를 고르지 않는다. 정직한 기본 에이전트 폴백 + note.
  if (!judgment || !judgment.hasJudgmentRunner()) {
    return finish(noModelRouteChoice(db, lang, "no_runtime"));
  }

  const ranked = rankRouteAgents(db, task, lang);
  const meta = resolveMetaBuilder(db);
  if (!ranked.length && !meta) {
    return finish({ ...directRouteChoice(lang), routeSource: "deterministic" });
  }
  // App Builder는 합성 라벨로만 제시(동의 핸드셰이크가 걸린 특수 라우트임을 모델에 명시).
  const appBuilder = ranked.find((r) => r.agent.slug === APP_BUILDER_ROUTE_SLUG) || null;
  const candidates = ranked.filter((r) => r.agent.slug !== APP_BUILDER_ROUTE_SLUG).slice(0, ROUTE_JUDGE_CANDIDATE_CAP);
  const bySlug = new Map(candidates.map((r) => [r.agent.slug, r]));
  const labels = [...bySlug.keys()];
  const hints = {};
  const roster = [];
  for (const r of candidates) {
    const a = r.agent;
    const name = [...new Set([a.name, a.nameEn].filter(Boolean))].join(" / ");
    const tagline = [...new Set([a.tagline, a.taglineEn].filter(Boolean))].join(" / ");
    roster.push(`- ${a.slug}: ${String(name).slice(0, 80)}${tagline ? ` — ${String(tagline).slice(0, 120)}` : ""}`);
    // 옛 단어목록은 힌트로 강등: 큐레이션 힌트 용어 + 이 프롬프트에서 어휘 스코어러가 맞춘 용어.
    const curated = ROUTE_HINTS.find((h) => h.slug === a.slug);
    const hintTerms = [...new Set([...(curated ? curated.terms : []), ...(r.terms || [])])];
    if (hintTerms.length) hints[a.slug] = hintTerms;
  }
  if (appBuilder) {
    labels.push(ROUTE_JUDGE_APP_LABEL);
    roster.push(`- ${ROUTE_JUDGE_APP_LABEL}: build a dedicated internal Agentlas App (recurring workflow, durable state, editing surfaces); explicit user consent is asked separately before anything is created`);
    hints[ROUTE_JUDGE_APP_LABEL] = APP_BUILDER_EXPLICIT_TERMS;
  }
  if (meta) {
    labels.push(ROUTE_JUDGE_META_LABEL);
    roster.push(`- ${ROUTE_JUDGE_META_LABEL}: build a NEW agent/team/company itself (the meta-builder)`);
    hints[ROUTE_JUDGE_META_LABEL] = AGENT_BUILD_TERMS;
  }
  labels.push(ROUTE_JUDGE_DIRECT_LABEL);
  roster.push(`- ${ROUTE_JUDGE_DIRECT_LABEL}: no installed agent clearly fits; answer as the plain assistant`);

  const verdict = await judgment.judgeLabels({
    // 라벨 집합(설치 상태)이 바뀌면 캐시 키도 바뀌어야 한다 — kind에 라벨 지문을 넣는다.
    kind: `terminal-auto-route:${crypto.createHash("sha256").update(labels.join("\n")).digest("hex").slice(0, 12)}`,
    question: "Which installed agent should own this user request, if any?",
    labels,
    input: routeStripPaths(String(task || "")),
    hints,
    guidance: [
      "Installed agents:",
      ...roster,
      "Mentioning a word is not intent — judge what the user actually asks to be done, in any language.",
      `Pick "${ROUTE_JUDGE_META_LABEL}" only when the user asks to create a new agent/team/company itself.`,
      `Pick "${ROUTE_JUDGE_DIRECT_LABEL}" when no installed agent clearly fits the request.`,
    ].join("\n"),
    multi: false,
    fallback: [],
    signal: opts.signal,
    // 라우팅은 1회성 사전 게이트 — 정확성이 지연보다 중요. 로컬 30B 모델 + 전체 로스터는
    // 기본 20s를 넘길 수 있다. judge의 abort signal이 요청까지 전파되므로 진짜 행은 여기서 끊긴다.
    timeoutMs: opts.timeoutMs || 40000,
  });

  // 모델이 판정을 못 냄(러너 실패/타임아웃/정크) → 어휘 픽으로 떨어지지 않는다.
  if (verdict.source !== "llm" || !verdict.labels.length) {
    return finish(noModelRouteChoice(db, lang, "model_unavailable"));
  }
  const picked = verdict.labels[0];
  const reason = verdict.reason ||
    (lang === "ko" ? "연결 모델이 요청의 의미로 판정했습니다" : "the connected model judged the request by meaning");
  if (picked === ROUTE_JUDGE_DIRECT_LABEL) {
    return finish({ ...directRouteChoice(lang), reason, routeSource: "llm" });
  }
  if (picked === ROUTE_JUDGE_META_LABEL && meta) {
    return finish({ agent: meta, score: 1000, strong: true, terms: [], reason, routeSource: "llm" });
  }
  const chosen = picked === ROUTE_JUDGE_APP_LABEL ? appBuilder : bySlug.get(picked);
  // 모델이 라벨을 골랐지만 설치 에이전트로 해석되지 않음(경계 케이스) → 어휘 픽 대신 직답.
  if (!chosen) return finish({ ...directRouteChoice(lang), routeSource: "deterministic" });
  // 모델 확답은 strong 계약을 충족 — 어휘 근거(terms/score)는 참고로 보존.
  return finish({ ...chosen, strong: true, reason, routeSource: "llm" });
}

// 라우트 영수증 라벨 — 누가 최종 판정했는지 반드시 찍는다(조용한 폴백 금지 하우스 룰).
function routeJudgeSourceNote(choice, lang) {
  if (!choice || !choice.routeSource) return "";
  if (choice.routeSource === "llm") return lang === "ko" ? " (판정: 연결 모델)" : " (judged by the connected model)";
  if (choice.noModel) {
    if (choice.noModelReason === "model_unavailable") {
      return lang === "ko" ? " (판정 없음 — 모델 응답 없음)" : " (no judgment — model did not answer)";
    }
    return lang === "ko" ? " (판정 없음 — 연결 모델 없음)" : " (no judgment — no model connected)";
  }
  return "";
}

function autoRouteNote(choice, lang) {
  const sourceNote = routeJudgeSourceNote(choice, lang);
  if (choice.direct || !choice.agent) {
    return lang === "ko"
      ? `사용 에이전트: 없음 — 바로 답합니다. 이유: ${choice.reason}.${sourceNote}`
      : `Selected agent: none — answering directly. Reason: ${choice.reason}.${sourceNote}`;
  }
  const name = lang === "ko" ? choice.agent.name : choice.agent.nameEn || choice.agent.name;
  return lang === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.${sourceNote}`
    : `Selected agent: ${name}. Reason: ${choice.reason}.${sourceNote}`;
}

module.exports = {
  GLOBAL_ORCHESTRATOR_SLUG,
  META_BUILDER_SLUGS,
  AGENT_BUILD_TERMS,
  resolveAutoRoute,
  rankRouteAgents,
  isAgentBuildIntent,
  isTrivialRoutePrompt,
  resolveMetaBuilder,
  resolveDefaultRouteAgent,
  ensureJudgeRunner,
  autoRouteNote,
  directSystemPrompt,
  routeStripPaths,
  routeTokenize,
};
