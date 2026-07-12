"use strict";
/*
 * Runtime capability registry (core) + capability-aware auto-routing.
 *
 * User-verified (2026-05): images are produced by the native CLIs themselves —
 *   codex  → Imagen,  gemini → nano-banana (Gemini 2.5 Flash Image),  claude → NO image gen.
 * BYOK: openai (gpt-image) and google (imagen) can do images; anthropic/ollama cannot.
 *
 * So a multi-LLM team = each agent runs on a runtime whose capabilities match its job:
 * an image/design agent auto-routes to gemini/codex, a coding agent to claude/codex.
 */

// keyed by runtime "spec": cli kind (claude-code|codex|gemini) or api backend (anthropic|openai|google|ollama)
const RUNTIME_CAPS = {
  "claude-code": { code: true, image: false, label: "claude" },
  codex: { code: true, image: true, label: "codex" }, // Imagen
  gemini: { code: true, image: true, label: "gemini" }, // nano-banana
  grok: { code: true, image: true, label: "grok" }, // Grok Imagine (generate_image/generate_video, 구독 키리스)
  anthropic: { code: true, image: false, label: "anthropic" },
  openai: { code: true, image: true, label: "openai" }, // gpt-image
  google: { code: true, image: true, label: "google" }, // imagen
  ollama: { code: true, image: false, label: "ollama" },
  upstage: { code: true, image: false, label: "solar" }, // Upstage Solar — Korean sovereign LLM (OpenAI-compatible)
};

// NOTE: grok은 CAPS(멀티모달 능력 인지)만 등록 — 터미널 스폰 러너(RUNTIME_BIN)가 아직 없어
// CLI_KINDS에 넣으면 repl의 which(RUNTIME_BIN[k]) 탐지가 깨진다. 러너 추가 시 함께 확장할 것.
const CLI_KINDS = ["claude-code", "codex", "gemini"];

function capsFor(spec) {
  return RUNTIME_CAPS[spec] || { code: true, image: false, label: spec || "?" };
}

// runtime object ⇄ spec string
function specOf(rt) {
  if (!rt) return "";
  return rt.mode === "cli" ? rt.kind : rt.backend;
}
function runtimeFromSpec(spec) {
  return CLI_KINDS.includes(spec) ? { mode: "cli", kind: spec } : { mode: "api", backend: spec, model: null };
}

// Does this agent's job involve generating/handling images?
// /그림(?!자)/ — "그림자"(shadow)는 이미지 힌트가 아니다.
const IMAGE_HINTS = [
  /image/i, /이미지/, /그림(?!자)/, /\bdesign\b/i, /디자인/, /쇼핑몰/, /상품\s*(사진|이미지|상세)/, /상세\s*페이지/,
  /thumbnail/i, /썸네일/, /banner/i, /배너/, /poster/i, /포스터/, /visual/i, /비주얼/, /illustrat/i, /일러스트/,
  /로고/, /\blogo\b/i, /사진/, /photo/i, /nano-?banana/i, /imagen/i, /이미지\s*생성/, /그래픽/, /graphic/i,
];
// 빌더/메타/조율/거버넌스 역할은 (이미지 에이전트를 *만들* 수는 있어도) 스스로 이미지를 생산하지 않는다.
// 이런 역할이 system_prompt에 "이미지/디자인"을 언급한다는 이유로 gemini로 끌려가면 코드/빌드 품질이 떨어진다.
const NON_IMAGE_ROLES = new Set(["meta", "builder", "orchestrator", "pm", "curator", "governance"]);
// 부정/거절 문장("이미지 생성 금지", "영상·이미지 생성은 하지 않는다")은 능력이 아니라
// 반(反)능력 선언이다 — 그 문장 안의 힌트는 세지 않는다. 단, "묻지 않고 바로 생성한다"처럼
// 긍정문에 흔한 보조 부정("않고","없다" 단독)은 잡지 않도록 강한 금지 구문만 매칭한다.
const IMAGE_NEGATION_RE = /(금지|하지\s*않|하지\s*마|말\s*것|거절|불가(?!피)|아니다|refuse|\bnever\b|\bdo(es)?\s+not\b|\bdon'?t\b)/i;
// 이미지 생성 도구 이름은 단독으로도 이미지 생산 역할의 강한 증거다.
const IMAGE_TOOL_MARKERS = [/nano-?banana/i, /\bimagen\b/i, /gpt-image/i, /grok\s*imagine/i];
// 사고(2026-07-12): appbridge CEO 프롬프트의 "코드/디자인/스토어 결정의 owner가 아니다" 속
// "디자인" 한 단어로 이미지 에이전트 판정 → PPT 요청 세션이 통째로 gemini로 전환됐다.
// 수리: 정체성 존(이름/태그라인)은 그대로 신뢰하되, 본문 단독으로는 "힌트를 포함한 긍정문
// 3문장 이상"을 요구한다. 문장 단위로 세므로 "상품 이미지 생성 금지" 같은 한 문장이
// 겹치는 정규식 여러 개를 동시에 때려도 1클러스터다.
const MIN_BODY_IMAGE_SENTENCES = 3;
const BODY_SCAN_CAP = 16000; // 로컬 임포트 상한과 동일 — 클라우드 무제한 프롬프트의 전문 스캔 방지
function needsImage(agent) {
  if (!agent) return false;
  if (NON_IMAGE_ROLES.has(String(agent.role || "").toLowerCase())) return false;
  // 정체성 존은 사용자가 선언한 이름/태그라인만 — slug는 폴더명에서 기계 파생되므로
  // ("design-system" 리포 임포트 등) 단독 신뢰 대상이 아니다.
  const identity = [agent.name, agent.name_en, agent.tagline, agent.tagline_en].filter(Boolean).join(" ");
  if (IMAGE_HINTS.some((re) => re.test(identity))) return true;
  // 팀 CEO 두뇌(부서 소개·위임 규칙)에서는 body 키워드가 역할 증거가 아니다 — vibecoder처럼
  // "Design and Publishing HQ" 부서명이 10문장씩 나오는 조율용 프롬프트가 이미지 팀으로
  // 오판되던 사례. entity_kind='team'은 사용자가 선언한 정체성 존만 신뢰한다.
  if (String(agent.entity_kind || "").toLowerCase() === "team") return false;
  const body = String(agent.system_prompt || "").slice(0, BODY_SCAN_CAP);
  let clusters = 0;
  for (const sentence of body.split(/[\n.!?。！？]+/)) {
    if (!sentence || IMAGE_NEGATION_RE.test(sentence)) continue;
    if (IMAGE_TOOL_MARKERS.some((re) => re.test(sentence))) return true;
    if (IMAGE_HINTS.some((re) => re.test(sentence))) {
      clusters += 1;
      if (clusters >= MIN_BODY_IMAGE_SENTENCES) return true;
    }
  }
  return false;
}

// Auto-pick a runtime spec for an agent given installed CLI kinds and the session default spec.
// Image agents route to an installed image-capable runtime; otherwise keep the session default.
function autoRuntimeFor(agent, { installedKinds, activeSpec }) {
  if (needsImage(agent)) {
    if (capsFor(activeSpec).image) return activeSpec;
    for (const k of ["gemini", "codex"]) if ((installedKinds || []).includes(k)) return k;
  }
  return activeSpec;
}

// short capability badge for display
function badge(spec) {
  const c = capsFor(spec);
  return c.image ? "🖼" : "";
}

module.exports = { RUNTIME_CAPS, CLI_KINDS, capsFor, specOf, runtimeFromSpec, needsImage, autoRuntimeFor, badge };
