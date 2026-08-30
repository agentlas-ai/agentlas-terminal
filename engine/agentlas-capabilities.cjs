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
  agy: { code: true, image: true, label: "antigravity" },
  grok: { code: true, image: true, label: "grok" }, // Grok Imagine (generate_image/generate_video, 구독 키리스)
  anthropic: { code: true, image: false, label: "anthropic" },
  openai: { code: true, image: true, label: "openai" }, // gpt-image
  google: { code: true, image: true, label: "google" }, // imagen
  ollama: { code: true, image: false, label: "ollama" },
  upstage: { code: true, image: false, label: "solar" }, // Upstage Solar — Korean sovereign LLM (OpenAI-compatible)
};

// 목록·별칭의 정본은 runtimes/kinds.cjs다. ACP 공용 러너가 추가된 뒤에도 이 파일이
// 옛 native 4종만 보아 grok/kimi/cursor를 API backend로 잘못 만들지 않게 한다.
const KINDS = require("./runtimes/kinds.cjs");
const CLI_KINDS = KINDS.CLI_KINDS;
const API_SPECS = new Set(KINDS.API_BACKEND_SPECS);

function capsFor(spec) {
  const canonical = KINDS.canonicalRuntimeKind(spec);
  return RUNTIME_CAPS[canonical] || { code: true, image: false, label: canonical || "?" };
}

// runtime object ⇄ spec string
function specOf(rt) {
  if (!rt) return "";
  return rt.mode === "cli" ? KINDS.canonicalRuntimeKind(rt.kind) : rt.backend;
}
function runtimeFromSpec(spec) {
  const canonical = KINDS.canonicalRuntimeKind(spec);
  if (CLI_KINDS.includes(canonical)) return { mode: "cli", kind: canonical };
  if (API_SPECS.has(canonical)) return { mode: "api", backend: canonical, model: null };
  return null;
}

// Image capability is judged only by the connected model from the complete
// agent identity and instructions. No regex, keyword glossary, role veto, or
// default runtime may make this semantic decision.
// needsImage 호출자(REPL 배지·autoRuntimeFor·routingNote)는 동기라서 warm-cache 패턴:
// 비동기 경로(resolveNeedsImage)가 먼저 판정해 캐시를 데우고, 동기 needsImage는 캐시만
// 읽는다. 캐시 미스 = "이미지 아님"으로 처리(어휘 폴백 없음) — 모델 판정만 이미지로 인정한다.
const IMAGE_VERDICT_CACHE_MAX = 200;
const imageVerdicts = new Map();
function imageJudgeInput(agent) {
  const identity = [agent.slug, agent.name, agent.name_en, agent.tagline, agent.tagline_en].filter(Boolean).join(" | ");
  return `${identity}\n---\n${String(agent.system_prompt || "").slice(0, 6000)}`;
}
// 이 에이전트의 직무가 이미지 생산인지를 연결 모델이 의미로 판정한다.
// 하우스 룰(2026-07-25): 연결 모델이 없으면 단어목록으로 이미지 여부를 결정하지 않는다.
// 러너 없음/타임아웃/정크 → source:"unavailable"(판정 불가)로 반환하고, 호출자는 안전
// 기본값(세션 런타임 유지, gemini/codex 하이재킹 금지)을 지킨다. 이미지 판정은 저위험
// 능력 추론이라 실패-닫힘이 아니라 "판정 안 함"으로 정직하게 둔다.
async function resolveNeedsImage(agent) {
  if (!agent) return { image: false, source: "unavailable", decided: false };
  let judgment;
  try {
    judgment = require("./agentlas-judgment.cjs");
  } catch {
    judgment = null;
  }
  if (!judgment || !judgment.hasJudgmentRunner()) return { image: false, source: "unavailable", decided: false };
  const input = imageJudgeInput(agent);
  const cached = imageVerdicts.get(input);
  if (cached) return cached;
  const verdict = await judgment.judgeLabels({
    kind: "agent-produces-images",
    question:
      "Does this agent's OWN job include producing images (generating or designing visual assets such as thumbnails, banners, logos, posters, product shots)?",
    labels: ["image", "not-image"],
    multi: false,
    input,
    guidance:
      "Judge the agent's role from its identity and instructions, in any language. Mentioning images is not " +
      "producing them: builders, orchestrators, PMs, curators, and coordination brains that commission or " +
      "delegate image work are 'not-image'. Refusals or prohibitions ('never generate images') declare the " +
      "opposite of a capability.",
  });
  // 모델이 판정을 못 냈다 → 어휘 폴백 없이 "판정 불가". 캐시하지 않아 이후 모델 연결 시 재판정한다.
  if (verdict.source !== "llm" || !verdict.labels.length) return { image: false, source: "unavailable", decided: false };
  const out = { image: verdict.labels[0] === "image", source: "llm", reason: verdict.reason || "" };
  imageVerdicts.set(input, out);
  if (imageVerdicts.size > IMAGE_VERDICT_CACHE_MAX) {
    const oldest = imageVerdicts.keys().next().value;
    if (oldest !== undefined) imageVerdicts.delete(oldest);
  }
  return out;
}
// Does this agent's job involve generating/handling images? Sync surface for badges and
// autoRuntimeFor. House rule (2026-07-25): only a warm MODEL verdict counts as "image".
// A cache miss (no model judgment / not warmed) is treated as "not specifically an image
// agent" so an unproven semantic guess can never hijack the runtime to gemini/codex.
function needsImage(agent) {
  if (!agent) return false;
  const cached = imageVerdicts.get(imageJudgeInput(agent));
  return cached ? cached.image : false;
}
// 라벨용 — 모델 판정이 없으면 unavailable이며 다른 의미 판정으로 대체하지 않는다.
function imageJudgmentSource(agent) {
  if (agent && imageVerdicts.has(imageJudgeInput(agent))) return "llm";
  return "unavailable";
}
function clearImageJudgments() {
  imageVerdicts.clear();
}

// Auto-pick a runtime spec for an agent given installed CLI kinds and the session default spec.
// Image agents route to an installed image-capable runtime; otherwise keep the session default.
function autoRuntimeFor(agent, { installedKinds, activeSpec }) {
  if (needsImage(agent)) {
    const canonicalActive = KINDS.canonicalRuntimeKind(activeSpec);
    if (capsFor(canonicalActive).image) return canonicalActive;
    const installed = new Set((installedKinds || []).map(KINDS.canonicalRuntimeKind));
    for (const k of ["agy", "gemini", "codex"]) if (installed.has(k)) return k;
  }
  return KINDS.canonicalRuntimeKind(activeSpec);
}

// short capability badge for display
function badge(spec) {
  const c = capsFor(spec);
  return c.image ? "🖼" : "";
}

module.exports = {
  RUNTIME_CAPS,
  CLI_KINDS,
  capsFor,
  specOf,
  runtimeFromSpec,
  needsImage,
  resolveNeedsImage,
  imageJudgmentSource,
  clearImageJudgments,
  autoRuntimeFor,
  badge,
};
