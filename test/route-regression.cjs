#!/usr/bin/env node
"use strict";
/*
 * 자동 라우팅 회귀 테스트 — 2026-07-12 오라우팅 사고 고정.
 *
 * 사고: 일반 맥 질문("맥이 잠금상태에서 자꾸 ai 돌릴때 안켜지게 하는법 없나")이
 * "ai" 단어 하나(+2점)로 Pitch Deck Architect에 라우팅되고, 그 에이전트의 이미지
 * 힌트 때문에 런타임까지 gemini로 끌려갔다.
 * 수리: 초범용 토큰 스톱워드 + IDF 근사 필터 + 정체성 가중치 + 확신 임계값(MIN_ROUTE_SCORE)
 * 미만이면 direct(에이전트·능력 라우팅 없음) 판정.
 */

const assert = require("node:assert/strict");
const { autoRouteAgent, resolveAutoRoute, autoRouteNote, autoRoutePreamble, directSystemPrompt, installJudgmentRunner } = require("../engine/agentlas.cjs");
const caps = require("../engine/agentlas-capabilities.cjs");
const { needsImage, needsImageLexical, autoRuntimeFor } = caps;
const judgment = require("../engine/agentlas-judgment.cjs");

// 실제 설치 상태를 흉내 낸 스텁 DB — 모든 에이전트 프롬프트에 "AI"가 들어 있다(현실과 동일).
const AGENTS = [
  {
    id: "a1",
    slug: "pitch-deck-architect",
    name: "Pitch Deck Architect",
    name_en: "Pitch Deck Architect",
    tagline: "투자 유치용 피치덱 설계",
    tagline_en: "Investor pitch deck design",
    system_prompt: "You are an AI pitch deck architect. Design slides, visuals, images, 디자인, storytelling for investors.",
  },
  {
    id: "a2",
    slug: "thumbnail-studio",
    name: "썸네일 스튜디오",
    name_en: "Thumbnail Studio",
    tagline: "유튜브 썸네일 디자인",
    tagline_en: "YouTube thumbnail design",
    system_prompt: "You are an AI thumbnail designer. Generate 썸네일 images with bold typography.",
  },
  {
    id: "a3",
    slug: "agentlas-pm-soul",
    name: "PM Soul",
    name_en: "PM Soul",
    tagline: "프로젝트 연속성 관리",
    tagline_en: "Project continuity",
    system_prompt: "You are an AI project manager. Track decisions, plans, handoffs.",
  },
  {
    id: "a4",
    slug: "agentlas-memory-curator",
    name: "Memory Curator",
    name_en: "Memory Curator",
    tagline: "기억 저장/회상 관리",
    tagline_en: "Memory curation",
    system_prompt: "You are an AI memory curator. Store and recall durable memory entries.",
  },
];
const META = [
  {
    id: "m1",
    slug: "agentlas-meta-agent",
    name: "메타에이전트",
    name_en: "Meta Agent",
    tagline: "에이전트/팀 빌더",
    tagline_en: "Agent/team builder",
    system_prompt: "You build new agents and teams.",
  },
];
// 스텁 DB 팩토리 — 엔진의 쿼리 분기(/WHERE slug IN/ = 메타빌더 조회) 계약을 한 곳에 고정.
function makeDb(agents, meta = []) {
  return { prepare: (sql) => ({ all: () => (/WHERE slug IN/.test(sql) ? meta : agents) }) };
}
const db = makeDb(AGENTS, META);

// 1) 사고 재현 프롬프트 → direct (어떤 에이전트도, 특히 Pitch Deck Architect도 선택 금지)
{
  const choice = autoRouteAgent(db, "맥이 잠금상태에서 자꾸 ai 돌릴때 안켜지게 하는법 없나", "ko");
  assert.equal(choice.direct, true, `일반 질문은 direct여야 함 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
  assert.equal(choice.agent, null);
  assert.match(autoRouteNote(choice, "ko"), /사용 에이전트: 없음/);
  assert.match(autoRouteNote(choice, "en"), /Selected agent: none/);
  assert.match(autoRoutePreamble(choice, "ko"), /direct answer/i);
}

// 2) "ai"/"llm" 단독 언급의 영어 일반 질문도 direct
{
  const choice = autoRouteAgent(db, "how do I keep my mac from sleeping while ai jobs run", "en");
  assert.equal(choice.direct, true, "영어 일반 질문도 direct여야 함");
}

// 3) 정체성(이름/태그라인) 적중은 여전히 전문 라우트 — 썸네일 요청은 썸네일 에이전트로
{
  const choice = autoRouteAgent(db, "유튜브 썸네일 하나 뽑아줘", "ko");
  assert.equal(choice.direct, undefined, "썸네일 요청이 direct로 새면 안 됨");
  assert.equal(choice.agent.slug, "thumbnail-studio");
}

// 4) 에이전트 이름을 직접 부르면 그 에이전트로
{
  const choice = autoRouteAgent(db, "pitch deck 초안 잡아줘", "ko");
  assert.equal(choice.direct, undefined);
  assert.equal(choice.agent.slug, "pitch-deck-architect");
}

// 5) 빌드 의도는 메타빌더 직행 (기존 동작 유지)
{
  const choice = autoRouteAgent(db, "인스타 카드뉴스 에이전트 하나 만들어줘", "ko");
  assert.equal(choice.agent.slug, "agentlas-meta-agent");
  assert.equal(choice.score, 1000);
}

// 6) 설치 에이전트가 없어도 direct로 답한다 (픽커 오류 대신)
{
  const choice = autoRouteAgent(makeDb([]), "안녕 오늘 날씨 어때", "ko");
  assert.equal(choice.direct, true);
}

// 7) 직답 시스템 프롬프트 — 페르소나 없음, 양 언어 모두 존재
assert.match(directSystemPrompt("ko"), /기본 어시스턴트/);
assert.match(directSystemPrompt("en"), /default assistant/);

// ── 2026-07-12 두 번째 오라우팅 사고 고정 ─────────────────────────────────────
// 사고: "/Users/operator/Documents/법인관련/Appbridge_Template.이 양식으로 …" 프롬프트가
// 경로 토큰("users","operator","documents","users-operator-documents-")으로 appbridge에 +2씩 쌓여
// 라우팅 근거에까지 노출되고, appbridge CEO 프롬프트 속 지나가는 "디자인" 한 단어 때문에
// needsImage가 참이 되어 PPT 요청 세션이 통째로 gemini로 전환됐다.
const PATH_AGENTS = [
  {
    id: "p1",
    slug: "local-appbridge",
    name: "appbridge",
    name_en: "appbridge",
    tagline: "Imported local team",
    tagline_en: "Imported local team",
    system_prompt:
      "You are the AppBridge CEO coordination team imported from /Users/operator/Documents/Appbridge. " +
      "CEO는 코디네이션·라우팅의 owner다. 코드/디자인/스토어/보안 결정의 owner가 아니다. " +
      "Templates live under /Users/operator/Documents/Appbridge/templates (Appbridge_Template).",
  },
  {
    id: "p2",
    slug: "local-stock-team",
    name: "주식 팀",
    name_en: "Stock Team",
    tagline: "Imported local team",
    tagline_en: "Imported local team",
    system_prompt: "You trade stocks. Sources under /Users/operator/Documents/StockTeam. 리포트 디자인 지침을 따른다.",
  },
];
const pathDb = makeDb(PATH_AGENTS);

// 8) 사고 재현 — 이름을 실제로 부른 경로 프롬프트는 그 에이전트로 가되, 근거에 경로 쓰레기 토큰이 없어야 한다
{
  const choice = autoRouteAgent(pathDb, "/Users/operator/Documents/법인관련/Appbridge_Template.이 양식으로 고정 시켜서 못만드나 피피티 잘만드는거..", "en");
  assert.equal(choice.direct, undefined, "Appbridge_Template을 직접 언급했으므로 appbridge 라우트 유지");
  assert.equal(choice.agent.slug, "local-appbridge");
  for (const junk of ["users", "operator", "documents", "users-operator-documents"]) {
    assert.ok(!choice.terms.some((t) => t.toLowerCase().includes(junk)), `경로 토큰 "${junk}"이 라우팅 근거에 노출되면 안 됨 — 실제: ${JSON.stringify(choice.terms)}`);
  }
}

// 9) 무관한 파일 경로 프롬프트 — 경로↔경로 우연 일치로 위임되면 안 된다 (direct)
{
  const choice = autoRouteAgent(pathDb, "/Users/operator/Documents/법인관련/세금계산서.pdf 이거 요약해줘", "ko");
  assert.equal(choice.direct, true, `무관 경로 프롬프트는 direct여야 함 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
}

// 10) 약한 본문 단어 적중만으로는(strong 신호 없이) 절대 위임하지 않는다
{
  const choice = autoRouteAgent(pathDb, "리포트 지침 owner 정리해줘 coordination 관점에서", "ko");
  assert.equal(choice.direct, true, `약한 본문 적중만으로 위임 금지 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
}

// 11) name === name_en 인 에이전트가 이름 보너스 +20을 두 번 받지 않는다 (점수 상한 검증)
{
  const choice = autoRouteAgent(pathDb, "appbridge 팀 상태 알려줘", "ko");
  assert.equal(choice.agent.slug, "local-appbridge");
  assert.ok(choice.score < 40, `이름 중복 보너스 금지 — score ${choice.score} < 40 이어야 함`);
}

// 12) needsImageLexical — 조율 CEO 프롬프트의 지나가는 "디자인" 한 단어로 이미지 힌트 금지
//     (needsImageLexical는 이제 힌트 스코어러 전용 — 최종 판정은 모델이 하고, 동기 needsImage는
//      모델 웜캐시만 읽는다. 어휘 정밀도 회귀는 needsImageLexical로 계속 고정한다.)
{
  assert.equal(needsImageLexical(PATH_AGENTS[0]), false, "appbridge는 이미지 에이전트가 아님");
  assert.equal(needsImageLexical(PATH_AGENTS[1]), false, "stock team은 이미지 에이전트가 아님");
  // 정체성 존(이름/태그라인)의 이미지 힌트는 그대로 신뢰
  assert.equal(
    needsImageLexical({ slug: "thumbnail-studio", name: "썸네일 스튜디오", tagline: "유튜브 썸네일 디자인", system_prompt: "" }),
    true,
    "정체성 존 이미지 힌트는 유지",
  );
  // 본문 단독: 힌트를 포함한 "긍정문"이 3문장 이상이어야 이미지 힌트
  assert.equal(
    needsImageLexical({ slug: "s1", name: "스튜디오", tagline: "제작", system_prompt: "요청마다 이미지를 생성한다. 유튜브 썸네일을 만든다. 배너 시안을 뽑아 저장한다." }),
    true,
    "긍정문 3문장 이상이면 이미지 힌트 유지",
  );
  // 겹치는 정규식 여러 개를 때리는 "한 문장"으로는 힌트 금지 (상관 힌트 무력화)
  assert.equal(
    needsImageLexical({ slug: "s2", name: "스튜디오", tagline: "제작", system_prompt: "이미지 생성 후 썸네일과 배너, 포스터를 만든다." }),
    false,
    "한 문장 안의 상관 힌트 여러 개는 1클러스터",
  );
  // 모델 판정(웜캐시)이 없으면 동기 needsImage는 이미지로 인정하지 않는다 → 런타임 하이재킹 금지.
  // (연결 모델 없음/미웜 상태에서 어휘 힌트만으로 세션 런타임이 gemini로 끌려가던 사고의 근본 수리)
  assert.equal(needsImage(PATH_AGENTS[0]), false, "웜캐시 없으면 동기 needsImage는 not-image");
  assert.equal(
    autoRuntimeFor(PATH_AGENTS[0], { installedKinds: ["claude-code", "codex", "gemini"], activeSpec: "claude-code" }),
    "claude-code",
    "appbridge 세션이 gemini로 하이재킹되면 안 됨",
  );
}

// ── max 리뷰(2026-07-12)에서 실증된 잔여 결함 고정 ───────────────────────────
// 13) 힌트 채널 비대칭 — 경로 디렉터리명("projects/plan")이 pm-soul strong 위임을 만들면 안 된다
{
  const choice = autoRouteAgent(db, "/Users/operator/projects/plan/발표자료.pptx 열어서 요약해줘", "ko");
  assert.equal(choice.direct, true, `경로 힌트 위임 금지 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
}

// 14) 이름 채널 비대칭 — 부모 폴더명("…/Appbridge/…")만으로 +20 strong 위임 금지
{
  const choice = autoRouteAgent(pathDb, "/Users/operator/Documents/Appbridge/세금계산서.pdf 이거 요약해줘", "ko");
  assert.equal(choice.direct, true, `부모 폴더명 위임 금지 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
}

// 15) 메타빌더 우회 — 경로 속 "agent-tools"가 빌드 의도(score 1000)로 둔갑하면 안 된다
{
  const choice = autoRouteAgent(db, "/Users/operator/agent-tools/notes.md 요약본 만들어줘", "ko");
  assert.notEqual(choice.agent && choice.agent.slug, "agentlas-meta-agent", "경로 토큰이 메타빌더를 부르면 안 됨");
  assert.equal(choice.direct, true);
  // 진짜 빌드 의도는 여전히 메타빌더로 (test 5와 동일 경로 재확인)
  const build = autoRouteAgent(db, "인스타 카드뉴스 에이전트 하나 만들어줘", "ko");
  assert.equal(build.agent.slug, "agentlas-meta-agent");
  assert.equal(build.strong, true, "메타 직행 choice도 strong 계약을 지켜야 함");
}

// 16) 약점수 1위 가림 — 장황한 약한 적중이 점수 1위여도, strong 자격자가 위임을 받는다
{
  const noisy = [
    {
      id: "w1", slug: "verbose-ops", name: "운영 도우미", name_en: "Ops Helper", tagline: "운영", tagline_en: "ops",
      system_prompt: "youtube channel upload schedule traffic metrics publish calendar checklist 관리 매뉴얼 ".repeat(3),
    },
    {
      id: "s1", slug: "banner-studio", name: "배너 스튜디오", name_en: "Banner Studio", tagline: "썸네일 배너 디자인", tagline_en: "thumbnail banner design",
      system_prompt: "유튜브 썸네일과 배너를 디자인한다.",
    },
  ];
  const choice = autoRouteAgent(makeDb(noisy), "youtube channel upload schedule traffic metrics publish calendar checklist 썸네일 배너 만들어줘", "ko");
  assert.equal(choice.direct, undefined, "strong 자격자가 있는데 직답으로 새면 안 됨");
  assert.equal(choice.agent.slug, "banner-studio");
}

// 17) 공백 포함 macOS 경로("Mobile Documents")도 junk 토큰 없이 접힌다
{
  const choice = autoRouteAgent(
    pathDb,
    "/Users/operator/Library/Mobile Documents/com~apple~CloudDocs/Appbridge_Template.md 이 양식으로 appbridge 정리해줘",
    "en",
  );
  assert.equal(choice.agent.slug, "local-appbridge");
  for (const junk of ["mobile", "documents", "com", "apple", "users", "operator", "library"]) {
    assert.ok(!choice.terms.some((t) => t.toLowerCase() === junk), `공백 경로 토큰 "${junk}" 노출 금지 — 실제: ${JSON.stringify(choice.terms)}`);
  }
}

// 18) 임포터 보일러플레이트 태그라인("Imported local team")은 정체성 신호가 아니다 (IDF 꺼지는 소규모 설치)
{
  const choice = autoRouteAgent(makeDb(PATH_AGENTS), "local imported 항목 정리해줘", "ko");
  assert.equal(choice.direct, true, `보일러플레이트 위임 금지 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
  // 'team'은 아무 임포트 팀 slug의 부분문자열(+6 strong)이라 스톱워드여야 한다:
  // 스톱워드에서 빠지면 'team' 정체성 적중 + 약한 본문 적중으로 10을 넘어 위임된다.
  const teamProbe = autoRouteAgent(makeDb(PATH_AGENTS), "team 리포트 디자인 지침 정리해줘", "ko");
  assert.equal(teamProbe.direct, true, `범용어 'team' 위임 금지 — 실제: ${JSON.stringify(teamProbe.agent && teamProbe.agent.slug)}`);
}

// 18b) 상대경로 파일 참조의 디렉터리명("plan")이 힌트 strong 채널을 때리면 안 된다
{
  const choice = autoRouteAgent(db, "docs/plan/roadmap.md 열어서 정리해줘", "ko");
  assert.equal(choice.direct, true, `상대경로 힌트 위임 금지 — 실제: ${JSON.stringify(choice.agent && choice.agent.slug)}`);
}

// 18c) 파일명 속 "agent"는 빌드 의도가 아니다 — 산문 빌드 의도만 메타빌더로
{
  const file = autoRouteAgent(db, "agent-notes.md 요약본 만들어줘", "ko");
  assert.notEqual(file.agent && file.agent.slug, "agentlas-meta-agent", "파일명 토큰이 메타빌더를 부르면 안 됨");
  const rel = autoRouteAgent(db, "agent-tools/notes/summary.md 초안 만들어줘", "ko");
  assert.notEqual(rel.agent && rel.agent.slug, "agentlas-meta-agent", "상대경로 토큰이 메타빌더를 부르면 안 됨");
}

// 18d) 공백 병합은 대문자 세그먼트("Mobile Documents")만 — 한글 프로즈를 경로로 삼키지 않는다
{
  const choice = autoRouteAgent(makeDb(PATH_AGENTS), "지금 /tmp/out 확인하고 기획/디자인 관련 파일 목록 정리해줘", "ko");
  assert.equal(choice.direct, true);
  // 프로즈 토큰("기획","디자인")이 라우팅 어휘에서 사라지지 않았는지 — 스텁에 디자인 전문가를 넣어 확인
  const designers = [
    { id: "d1", slug: "design-desk", name: "디자인 데스크", name_en: "Design Desk", tagline: "기획 디자인 전문", tagline_en: "design", system_prompt: "기획과 디자인 자료를 정리한다." },
  ];
  const kept = autoRouteAgent(makeDb(designers), "지금 /tmp/out 확인하고 기획/디자인 관련 파일 목록 정리해줘", "ko");
  assert.equal(kept.direct, undefined, "프로즈 '기획/디자인'이 경로로 삼켜지면 안 됨");
  assert.equal(kept.agent.slug, "design-desk");
}

// 19) needsImageLexical 정밀도 — 부정문·그림자·기계 파생 slug는 이미지 힌트 금지, 도구 마커는 단독 인정
//     (힌트 스코어러의 정밀도가 곧 모델에 넘기는 힌트 품질 — needsImageLexical로 직접 고정)
{
  assert.equal(
    needsImageLexical({ slug: "coord", name: "코디네이터", tagline: "조율", system_prompt: "상품 이미지 생성 금지. 코드 리뷰와 배포만 담당한다." }),
    false,
    "부정문(금지)의 힌트는 능력이 아님",
  );
  // 긍정문에 흔한 보조 부정("묻지 않고 바로 …")까지 부정으로 오판하면 안 된다
  assert.equal(
    needsImageLexical({ slug: "fastgen", name: "생성기", tagline: "콘텐츠", system_prompt: "묻지 않고 바로 이미지를 생성한다. 요청 즉시 썸네일을 뽑는다. 지체 없이 배너를 만든다." }),
    true,
    "보조 부정이 낀 긍정문은 능력으로 인정",
  );
  assert.equal(
    needsImageLexical({ slug: "fx", name: "이펙트 코더", tagline: "CSS 전문", system_prompt: "그림자 효과를 코드로 구현한다. 그림자 블러를 조정한다. 그림자 색을 계산한다." }),
    false,
    "'그림자'(shadow)는 이미지 힌트가 아님",
  );
  assert.equal(
    needsImageLexical({ slug: "local-design-system", name: "토큰 린터", tagline: "코드 린트", system_prompt: "Lint CSS variables and tokens." }),
    false,
    "폴더명 파생 slug('design-system')는 단독 신뢰 대상이 아님",
  );
  assert.equal(
    needsImageLexical({ slug: "gen", name: "제너레이터", tagline: "콘텐츠 제작", system_prompt: "결과물은 nano-banana로 렌더링해 저장한다." }),
    true,
    "이미지 도구 마커는 단독으로도 인정",
  );
  // 팀 CEO 두뇌는 body 채널을 신뢰하지 않는다 — 부서명("Design HQ")이 몇 문장 나와도
  // entity_kind='team'이면 정체성 존만 본다. 같은 본문이라도 단일 에이전트면 body로 판정.
  const orgBody = "디자인 부서가 배너를 만든다. 디자인 부서가 썸네일을 만든다. 디자인 부서가 포스터를 만든다.";
  assert.equal(
    needsImageLexical({ slug: "eng-team", name: "엔지니어링 팀", tagline: "제품 개발", entity_kind: "team", system_prompt: orgBody }),
    false,
    "팀은 body 키워드로 이미지 힌트 금지 (vibecoder 사례)",
  );
  assert.equal(
    needsImageLexical({ slug: "solo", name: "제작기", tagline: "콘텐츠", entity_kind: "agent", system_prompt: orgBody }),
    true,
    "단일 에이전트는 body 클러스터 힌트 유지",
  );
}

// 20) 슬래시로 붙은 엔티티도 빌드 의도로 인식 — 슬래시 토큰 통삭제 회귀 수리(2026-07-12 max 리뷰)
// 사고: isAgentBuildIntent가 `\S*[\\/]\S*`로 슬래시 포함 토큰을 통째로 지워
// "에이전트/팀 만들어줘"의 엔티티가 사라져 빌드 의도를 놓치고 direct로 샜다.
{
  const b1 = autoRouteAgent(db, "에이전트/팀 하나 만들어줘", "ko");
  assert.equal(b1.agent && b1.agent.slug, "agentlas-meta-agent", "슬래시-엔티티('에이전트/팀')도 빌드 의도");
  const b2 = autoRouteAgent(db, "회사/조직 만들어줘", "ko");
  assert.equal(b2.agent && b2.agent.slug, "agentlas-meta-agent", "'회사/조직'도 빌드 의도");
  // 경로/파일 참조는 여전히 빌드 의도가 아니다 — 수리가 test 15의 회귀를 되살리지 않았는지 재확인
  const nf = autoRouteAgent(db, "/Users/operator/agent-tools/notes.md 요약본 만들어줘", "ko");
  assert.notEqual(nf.agent && nf.agent.slug, "agentlas-meta-agent", "경로 속 'agent-tools'는 빌드 아님");
  assert.equal(nf.direct, true);
}

// ── 2026-07-25 모델 최종 판정 계약 — 어휘 점수는 후보 모집/라벨 붙은 폴백 전용 ──────
// 하우스 룰: 단어목록/정규식은 최종 라우트·능력 결정을 내리지 않는다. 연결 모델(스텁
// 러너)이 있으면 그 판정이 어휘 픽을 이기고(어휘 0점 에이전트도 뽑는다), 러너가 없으면
// 오늘의 결정적 라우팅과 동일하게 동작하되 폴백임을 라벨한다.
(async () => {
  const cleanup = () => {
    judgment.setJudgmentRunner(null);
    judgment.clearJudgmentCache();
    caps.clearImageJudgments();
  };
  try {
    // 21) 모델 판정이 어휘 픽을 이긴다 — 어휘 0점(아랍어) 요청도 전문 에이전트로 라우팅
    {
      cleanup();
      let seenSystem = "";
      judgment.setJudgmentRunner(async ({ system }) => {
        seenSystem = system;
        return JSON.stringify({ labels: ["thumbnail-studio"], reason: "the user asks for a YouTube thumbnail in Arabic" });
      });
      const arabic = "صمّم لي صورة مصغّرة لفيديو يوتيوب عن الطبخ";
      const lexical = autoRouteAgent(db, arabic, "en");
      assert.equal(lexical.direct, true, "전제: 어휘 스코어러는 아랍어 요청을 못 읽는다(0점)");
      const judged = await resolveAutoRoute(db, arabic, "en");
      assert.equal(judged.agent && judged.agent.slug, "thumbnail-studio", "모델 판정이 어휘 0점 에이전트를 뽑아야 함");
      assert.equal(judged.routeSource, "llm");
      assert.equal(judged.strong, true, "모델 확답은 strong 계약 충족");
      assert.match(autoRouteNote(judged, "en"), /judged by the connected model/);
      // 판정 요청 자체의 계약 — 설치 에이전트 전원 + 합성 라벨 + 힌트로 강등된 옛 단어목록
      assert.match(seenSystem, /thumbnail-studio/, "어휘 0점 에이전트도 라벨 후보에 있어야 함");
      assert.match(seenSystem, /meta-builder/, "메타빌더 합성 라벨 제시");
      assert.match(seenSystem, /direct/, "direct 합성 라벨 제시");
      assert.match(seenSystem, /may suggest "meta-builder"/, "AGENT_BUILD_TERMS는 힌트로 강등");
    }

    // 22) 모델이 어휘 픽(strong)을 뒤집어 direct로 — 단어 언급은 의도가 아니다
    {
      judgment.clearJudgmentCache();
      judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["direct"], reason: "a vocabulary question, not deck work" }));
      const lexical = autoRouteAgent(db, "pitch deck 라는 용어가 무슨 뜻이야?", "en");
      assert.equal(lexical.agent && lexical.agent.slug, "pitch-deck-architect", "전제: 어휘로는 위임된다");
      const judged = await resolveAutoRoute(db, "pitch deck 라는 용어가 무슨 뜻이야?", "en");
      assert.equal(judged.direct, true, "모델의 direct 판정이 어휘 위임을 이겨야 함");
      assert.equal(judged.routeSource, "llm");
    }

    // 23) 합성 라벨 meta-builder — 어떤 언어의 빌드 요청이든 메타빌더로
    {
      judgment.clearJudgmentCache();
      judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["meta-builder"], reason: "the user wants a new agent built" }));
      const judged = await resolveAutoRoute(db, "ساعدني في إنشاء وكيل جديد لبطاقات إنستغرام", "en");
      assert.equal(judged.agent && judged.agent.slug, "agentlas-meta-agent");
      assert.equal(judged.routeSource, "llm");
    }

    // 24) 합성 라벨 app-builder — 라우팅되어도 동의 핸드셰이크(효과 전 확인 질문)는 그대로
    {
      judgment.clearJudgmentCache();
      const appDb = makeDb(
        [
          ...AGENTS,
          {
            id: "ab1",
            slug: "agentlas-app-builder",
            name: "앱 빌더",
            name_en: "App Builder",
            tagline: "전용 앱 생성",
            tagline_en: "Dedicated app builder",
            system_prompt: "You build dedicated internal Agentlas apps.",
          },
        ],
        META,
      );
      judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["app-builder"], reason: "a recurring dashboard workflow" }));
      const judged = await resolveAutoRoute(appDb, "매주 채널 지표를 모아 보는 대시보드를 반복 관리하고 싶어", "ko");
      assert.equal(judged.agent && judged.agent.slug, "agentlas-app-builder");
      assert.equal(judged.routeSource, "llm");
      assert.match(autoRoutePreamble(judged, "ko"), /명시적으로 승인하지 않았습니다/, "App Builder 동의 핸드셰이크 보존");
      assert.match(autoRoutePreamble(judged, "en"), /has not explicitly approved/, "App Builder 동의 핸드셰이크 보존(en)");
    }

    // 25) 잡담 short-circuit은 닫힌형 결정적 가드 — 러너가 있어도 모델에 묻지 않는다
    {
      judgment.clearJudgmentCache();
      let calls = 0;
      judgment.setJudgmentRunner(async () => {
        calls += 1;
        return JSON.stringify({ labels: ["direct"] });
      });
      const judged = await resolveAutoRoute(db, "hi", "en");
      assert.equal(judged.direct, true);
      assert.equal(judged.routeSource, "deterministic");
      assert.equal(calls, 0, "TRIVIAL_ROUTE_PROMPTS는 모델 판정 없이 결정적으로 처리");
    }

    // 26) 정크 판정(비JSON) = 런타임은 연결됐지만 그 판정이 실패 → 어휘 전문 에이전트로
    //     떨어지지 않는다. "판단 못 함" 직답 + "모델이 응답 안 함" 안내(런타임 미연결과 구분).
    {
      judgment.clearJudgmentCache();
      judgment.setJudgmentRunner(async () => "totally not json");
      const judged = await resolveAutoRoute(db, "유튜브 썸네일 두 장만 더 뽑아줘", "ko");
      assert.equal(judged.direct, true, "정크 판정은 어휘 전문 에이전트가 아니라 직답");
      assert.equal(judged.agent, null, "어휘 스코어 1위(thumbnail-studio)로 새면 안 됨");
      assert.equal(judged.noModel, true, "판정 불가 = noModel 신호");
      assert.equal(judged.noModelReason, "model_unavailable", "런타임은 있으나 응답 실패 = model_unavailable");
      assert.equal(judged.routeSource, "deterministic", "기계 플래그는 deterministic(=판정 없음)");
      assert.match(autoRouteNote(judged, "ko"), /제때 응답하지 않아/);
      // 같은 정크 판정을 en 세션에서 → 안내도 en (route lang == note lang, 실사용과 동일)
      judgment.clearJudgmentCache();
      const judgedEn = await resolveAutoRoute(db, "draw me two more youtube thumbnails", "en");
      assert.equal(judgedEn.direct, true);
      assert.equal(judgedEn.agent, null);
      assert.match(autoRouteNote(judgedEn, "en"), /didn't answer in time/);
    }

    // 27) 러너 없음 → 어휘로 전문 에이전트를 고르지 않는다. DIRECT(기본 어시스턴트) + "모델 연결" 안내.
    //     핵심: 어휘 1위 specialist(thumbnail-studio)를 절대 반환하지 않는다.
    {
      cleanup();
      // 어휘로는 thumbnail-studio strong 위임이지만, 러너 없으면 그 픽을 반환하면 안 된다.
      const lexical = autoRouteAgent(db, "유튜브 썸네일 하나 뽑아줘", "ko");
      assert.equal(lexical.agent && lexical.agent.slug, "thumbnail-studio", "전제: 어휘로는 specialist 위임");
      const offline = await resolveAutoRoute(db, "유튜브 썸네일 하나 뽑아줘", "ko");
      assert.equal(offline.direct, true, "러너 없으면 어휘 specialist가 아니라 직답");
      assert.equal(offline.agent, null, "어휘 specialist(thumbnail-studio)로 새면 안 됨");
      assert.equal(offline.noModel, true);
      assert.equal(offline.routeSource, "deterministic");
      assert.match(autoRouteNote(offline, "ko"), /모델을 연결하면 자동 라우팅/);
      // 일반 질문도 동일하게 DIRECT + "모델 연결" 안내 (en 세션)
      const offlineDirect = await resolveAutoRoute(db, "how do I keep my mac awake while ai jobs run", "en");
      assert.equal(offlineDirect.direct, true, "러너 없으면 DIRECT");
      assert.equal(offlineDirect.noModel, true);
      assert.match(autoRouteNote(offlineDirect, "en"), /connect a model/);
    }

    // 28) 이미지 능력 — 모델 판정이 어휘 판정을 이긴다 (힌트 0개의 아랍어 이미지 에이전트)
    const arabicPainter = {
      id: "i1",
      slug: "marsam",
      name: "مرسم",
      name_en: "Marsam",
      tagline: "استوديو صور يوتيوب",
      tagline_en: "",
      system_prompt: "أنت وكيل ينشئ صورًا ولافتات وشعارات لقنوات يوتيوب.",
    };
    {
      cleanup();
      assert.equal(needsImage(arabicPainter), false, "전제: 어휘 스코어러는 아랍어 이미지 역할을 못 읽는다");
      judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["image"], reason: "generates images per its Arabic instructions" }));
      const verdict = await caps.resolveNeedsImage(arabicPainter);
      assert.equal(verdict.image, true);
      assert.equal(verdict.source, "llm");
      assert.equal(needsImage(arabicPainter), true, "warm-cache 후 동기 needsImage도 모델 판정을 읽는다");
      assert.equal(caps.imageJudgmentSource(arabicPainter), "llm");
      assert.equal(
        autoRuntimeFor(arabicPainter, { installedKinds: ["claude-code", "codex", "gemini"], activeSpec: "claude-code" }),
        "gemini",
        "모델 이미지 판정이 런타임 자동 배정까지 흘러야 함",
      );
    }

    // 29) 반대 방향 — 어휘로는 이미지(정체성 존 "디자인")인데 모델이 not-image로 뒤집는다
    {
      judgment.clearJudgmentCache();
      judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["not-image"], reason: "lints tokens, produces no images" }));
      const lintTool = {
        id: "i2",
        slug: "style-lint",
        name: "디자인 린터",
        name_en: "Design Linter",
        tagline: "디자인 토큰 린트",
        tagline_en: "design token lint",
        system_prompt: "Lint CSS variables and design tokens. No rendering.",
      };
      assert.equal(caps.needsImageLexical(lintTool), true, "전제: 어휘로는 이미지 판정");
      const verdict = await caps.resolveNeedsImage(lintTool);
      assert.equal(verdict.image, false);
      assert.equal(verdict.source, "llm");
      assert.equal(needsImage(lintTool), false, "모델 not-image 판정이 어휘 힌트를 이겨야 함");
      assert.equal(
        autoRuntimeFor(lintTool, { installedKinds: ["claude-code", "codex", "gemini"], activeSpec: "claude-code" }),
        "claude-code",
        "not-image 판정이면 세션 런타임 유지",
      );
    }

    // 30) 팀/역할 하드 가드 — 보수적 베토는 모델 판정 대상에서 제외(호출 자체 금지)
    {
      judgment.clearJudgmentCache();
      let calls = 0;
      judgment.setJudgmentRunner(async () => {
        calls += 1;
        return JSON.stringify({ labels: ["image"] });
      });
      const orgTeam = { id: "i3", slug: "org-hq", name: "조직 HQ", tagline: "부서 조율", entity_kind: "team", system_prompt: "디자인 부서가 배너를 만든다." };
      const verdict = await caps.resolveNeedsImage(orgTeam);
      assert.equal(verdict.image, false);
      assert.equal(verdict.source, "deterministic");
      assert.equal(calls, 0, "팀 베토는 하드 가드 — 모델에 묻지 않는다");
    }

    // 31) 러너 없음 → 이미지 여부를 단어목록으로 결정하지 않는다. source:"unavailable"(판정 불가) +
    //     안전 기본값(런타임 하이재킹 금지). 어휘로는 명백히 이미지인 에이전트로 반증한다.
    {
      cleanup();
      const lexicalImageAgent = {
        slug: "poster-shop", name: "포스터 샵", name_en: "Poster Shop",
        tagline: "배너 포스터 썸네일 디자인", tagline_en: "banner poster thumbnail design",
        system_prompt: "이미지를 생성한다. 썸네일을 만든다. 배너를 뽑는다.",
      };
      assert.equal(needsImageLexical(lexicalImageAgent), true, "전제: 어휘로는 명백히 이미지 에이전트");
      const verdict = await caps.resolveNeedsImage(lexicalImageAgent);
      assert.equal(verdict.image, false, "러너 없으면 이미지 여부를 단어목록으로 결정하지 않는다(안전 기본값)");
      assert.equal(verdict.source, "unavailable", "판정 불가는 반드시 라벨(조용한 어휘 결정 금지)");
      assert.equal(verdict.decided, false, "판정 불가 = decided:false");
      assert.equal(needsImage(lexicalImageAgent), false, "동기 needsImage도 어휘로 이미지 판정하지 않는다");
      assert.equal(caps.imageJudgmentSource(lexicalImageAgent), "deterministic");
      // 핵심: 어휘로는 이미지지만 러너가 없으니 세션 런타임(claude-code)이 gemini로 하이재킹되면 안 된다
      assert.equal(
        autoRuntimeFor(lexicalImageAgent, { installedKinds: ["claude-code", "codex", "gemini"], activeSpec: "claude-code" }),
        "claude-code",
        "러너 없으면 어휘 이미지 추정으로 런타임 하이재킹 금지",
      );
    }

    // 32) API/Ollama/BYOK 런타임도 판정 러너를 받는다 — CLI 전용 배선이면 ollama 사용자는
    //     모든 라우트/의도/분류가 조용히 어휘 폴백으로 떨어졌다(실사고, 2026-07-25 실측).
    {
      cleanup();
      const savedFetch = globalThis.fetch;
      try {
        // mode:"api" backend:"ollama" → runApi가 127.0.0.1:11434/api/chat 호출.
        let hitOllama = false;
        globalThis.fetch = async (url, init) => {
          hitOllama = /11434\/api\/chat/.test(String(url));
          // system 프롬프트가 실제로 전달되는지도 확인.
          const body = JSON.parse(init.body);
          assert.ok(body.messages.some((m) => m.role === "system"), "판정 system 프롬프트 전달");
          return { ok: true, json: async () => ({ message: { content: JSON.stringify({ labels: ["task"], reason: "ollama judged" }) } }) };
        };
        installJudgmentRunner({}, { mode: "api", backend: "ollama", model: "qwen-test" });
        assert.equal(judgment.hasJudgmentRunner(), true, "api-mode 런타임도 판정 러너를 설치해야 함");
        const verdict = await judgment.judgeLabels({
          kind: "api-wiring-smoke",
          question: "task or conversation?",
          labels: ["task", "conversation"],
          input: "افتح المتصفح وانشر تغريدة",
          multi: false,
          fallback: ["conversation"],
        });
        assert.equal(hitOllama, true, "판정이 실제 ollama HTTP 경로를 타야 함");
        assert.deepEqual(verdict.labels, ["task"]);
        assert.equal(verdict.source, "llm", "연결 모델이 판정 — 어휘 폴백 아님");
      } finally {
        globalThis.fetch = savedFetch;
      }

      // backend 없는 api 런타임/런타임 없음 → 러너 미설치(조용한 어휘 폴백 대신 라벨된 폴백).
      cleanup();
      installJudgmentRunner({}, { mode: "api" });
      assert.equal(judgment.hasJudgmentRunner(), false, "backend 없으면 러너 미설치");
      installJudgmentRunner({}, null);
      assert.equal(judgment.hasJudgmentRunner(), false, "런타임 없으면 러너 미설치");
    }
  } finally {
    cleanup();
  }
  console.log("route-regression: PASS");
})().catch((err) => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
