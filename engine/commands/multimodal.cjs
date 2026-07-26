"use strict";
/*
 * multimodal — 이미지/영상/오디오 공급자 상태·선택 (공유 DB meta에 저장, 데스크탑과 공유).
 *   agentlas multimodal                 현재 선택 + 카탈로그
 *   agentlas multimodal set <modality> <provider-id>
 * 키 존재 여부는 credentials.env(standalone)만 관측한다 — 값은 출력하지 않는다.
 */
const { sharedEnvKeys } = require("./env.cjs");

const MULTIMODAL_META_KEY = "multimodal_settings_v1";

const PROVIDERS = [
  { id: "codex-cli-image", modality: "image", label: "Codex CLI image", labelKo: "Codex CLI 이미지", envKeys: [], billing: "subscription" },
  { id: "grok-cli-image", modality: "image", label: "Grok CLI image (Imagine)", labelKo: "Grok CLI 이미지 (Imagine)", envKeys: [], billing: "subscription" },
  { id: "grok-cli-video", modality: "video", label: "Grok CLI video (Imagine)", labelKo: "Grok CLI 영상 (Imagine)", envKeys: [], billing: "subscription" },
  { id: "openai-image", modality: "image", label: "OpenAI Images API", labelKo: "OpenAI 이미지 API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api" },
  { id: "google-image", modality: "image", label: "Google Gemini Image", labelKo: "Google Gemini 이미지", envKeys: ["GOOGLE_API_KEY"], billing: "paid-api" },
  { id: "runway-video", modality: "video", label: "Runway API", labelKo: "Runway API", envKeys: ["RUNWAY_API_KEY"], billing: "paid-api" },
  { id: "google-veo", modality: "video", label: "Google Veo", labelKo: "Google Veo", envKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"], billing: "provider-billing" },
  { id: "openai-sora", modality: "video", label: "OpenAI Sora API", labelKo: "OpenAI Sora API", envKeys: ["OPENAI_API_KEY"], billing: "paid-api" },
  { id: "openai-audio", modality: "audio", label: "OpenAI Audio", labelKo: "OpenAI 오디오", envKeys: ["OPENAI_API_KEY"], billing: "paid-api" },
  { id: "elevenlabs-audio", modality: "audio", label: "ElevenLabs", labelKo: "ElevenLabs", envKeys: ["ELEVENLABS_API_KEY"], billing: "paid-api" },
  { id: "deepgram-audio", modality: "audio", label: "Deepgram", labelKo: "Deepgram", envKeys: ["DEEPGRAM_API_KEY"], billing: "paid-api" },
  { id: "replicate-video", modality: "video", label: "Replicate", labelKo: "Replicate", envKeys: ["REPLICATE_API_TOKEN"], billing: "paid-api" },
];
const DEFAULTS = { imageProvider: "codex-cli-image", videoProvider: "runway-video", audioProvider: "openai-audio" };

function normalizeSettings(input) {
  return { ...DEFAULTS, ...(input || {}) };
}

function getSettings(db) {
  let raw = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(MULTIMODAL_META_KEY);
    raw = row && row.value;
  } catch { raw = null; }
  try {
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeSettings(null);
  }
}

function saveSettings(db, patch) {
  const next = normalizeSettings({ ...getSettings(db), ...patch, updatedAt: new Date().toISOString() });
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(MULTIMODAL_META_KEY, JSON.stringify(next));
  return next;
}

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();

  if (args[0] === "set") {
    const modality = String(args[1] || "");
    const providerId = String(args[2] || "");
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!["image", "video", "audio"].includes(modality) || !provider || provider.modality !== modality) {
      ctx.err(ko
        ? "사용법: agentlas multimodal set <image|video|audio> <provider-id>  (id는 agentlas multimodal 목록 참고)"
        : "Usage: agentlas multimodal set <image|video|audio> <provider-id>  (ids: agentlas multimodal)");
      return 1;
    }
    const key = modality === "image" ? "imageProvider" : modality === "video" ? "videoProvider" : "audioProvider";
    saveSettings(db, { [key]: providerId });
    ctx.out(`${ctx.ui.green("✓")} ${modality} → ${providerId}`);
    return 0;
  }

  const settings = getSettings(db);
  const keys = new Set(sharedEnvKeys());
  const selected = { image: settings.imageProvider, video: settings.videoProvider, audio: settings.audioProvider };
  for (const modality of ["image", "video", "audio"]) {
    ctx.out(ctx.ui.bold(modality));
    for (const p of PROVIDERS.filter((x) => x.modality === modality)) {
      const isSel = p.id === selected[modality];
      const needsKeys = (p.envKeys || []).filter((k) => !keys.has(k) && !process.env[k]);
      const keyNote = p.envKeys.length
        ? (needsKeys.length ? ctx.ui.dim(` (${ko ? "키 필요" : "needs"}: ${needsKeys.join(", ")})`) : ctx.ui.dim(` (${ko ? "키 있음" : "keys ok"})`))
        : "";
      ctx.out(`  ${isSel ? ctx.ui.accent("▸") : " "} ${p.id.padEnd(20)} ${ko ? p.labelKo : p.label}${keyNote}`);
    }
  }
  ctx.out("");
  ctx.out(ctx.ui.dim(ko ? "변경: agentlas multimodal set <image|video|audio> <provider-id>" : "Change: agentlas multimodal set <image|video|audio> <provider-id>"));
  return 0;
}

module.exports = { run, getSettings, saveSettings, PROVIDERS, DEFAULTS, MULTIMODAL_META_KEY };
