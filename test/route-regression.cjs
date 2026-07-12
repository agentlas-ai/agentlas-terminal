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
const { autoRouteAgent, autoRouteNote, autoRoutePreamble, directSystemPrompt } = require("../engine/agentlas.cjs");

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
const db = {
  prepare(sql) {
    if (/WHERE slug IN/.test(sql)) return { all: () => META };
    return { all: () => AGENTS };
  },
};

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
  const empty = { prepare: (sql) => ({ all: () => (/WHERE slug IN/.test(sql) ? [] : []) }) };
  const choice = autoRouteAgent(empty, "안녕 오늘 날씨 어때", "ko");
  assert.equal(choice.direct, true);
}

// 7) 직답 시스템 프롬프트 — 페르소나 없음, 양 언어 모두 존재
assert.match(directSystemPrompt("ko"), /기본 어시스턴트/);
assert.match(directSystemPrompt("en"), /default assistant/);

console.log("route-regression: PASS");
