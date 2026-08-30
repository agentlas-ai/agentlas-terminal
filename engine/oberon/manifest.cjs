"use strict";
/*
 * oberon/manifest — 렌더 매니페스트 scaffold + 원자적 쓰기.
 * v1 §12243-12358 (oberonSampleTitles / writeOberonManifestCli / oberonScaffold) 충실 포팅.
 *
 * 사용 흐름 (v1 헤더 주석 그대로):
 *   agentlas oberon scaffold my.json      → 편집 가능한 렌더 매니페스트 생성
 *   agentlas oberon render my.json        → 헤드리스 렌더 스폰 + 진행률 스트리밍
 * 프롬프트는 직접 채우거나 `agentlas run oberon-film-studio "<브리프>"`로 에이전트가
 * 채운다 (OpenMontage "어시스턴트=오케스트레이터" 스킴).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fail, parseFlags } = require("./common.cjs");

// scaffold 기본 타이포 프리셋 (v1 oberonSampleTitles).
// 한국어 본문/자막은 CJK 폰트를 강제한다 — 비-CJK 폰트로 한글을 태우면 두부(tofu)가 뜬다.
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

/*
 * 원자적 no-clobber 매니페스트 쓰기 (v1 writeOberonManifestCli).
 * 비자명 제약 — 전부 v1에서 실사고/보안 검토로 굳은 규칙:
 *  - 심볼릭 링크를 통해 쓰지 않는다 (링크 타깃 오염 방지).
 *  - 일반 파일이 아니면 거부.
 *  - overwrite 아님 + 존재 → EXISTS 에러 (사용자 편집본을 조용히 덮지 않는다).
 *  - tmp에 wx(0o600)로 쓰고 fsync 후:
 *      overwrite → rename(2)
 *      신규      → link(2). link(2)는 원자적 no-clobber publish다. 우리 lstat 이후
 *                  다른 writer가 타깃을 만들었으면 EEXIST가 그 파일을 보존한다.
 */
function writeOberonManifest(outPath, manifest, options = {}) {
  const overwrite = options.overwrite === true;
  let existing = null;
  try { existing = fs.lstatSync(outPath); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (existing && existing.isSymbolicLink()) {
    const error = new Error(`Refusing to write through a symbolic link: ${outPath}`);
    error.code = "AGENTLAS_OBERON_SYMLINK";
    throw error;
  }
  if (existing && !existing.isFile()) {
    const error = new Error(`Manifest target is not a regular file: ${outPath}`);
    error.code = "AGENTLAS_OBERON_NOT_FILE";
    throw error;
  }
  if (existing && !overwrite) {
    const error = new Error(`Manifest already exists: ${outPath}`);
    error.code = "AGENTLAS_OBERON_EXISTS";
    throw error;
  }

  const dir = path.dirname(outPath);
  const tmp = path.join(dir, `.${path.basename(outPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try { fs.chmodSync(tmp, 0o644); } catch { /* win32 */ }
    if (overwrite) {
      fs.renameSync(tmp, outPath);
    } else {
      // link(2) is an atomic no-clobber publish. If another writer created the
      // target after our lstat, EEXIST preserves that file.
      fs.linkSync(tmp, outPath);
      fs.unlinkSync(tmp);
    }
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* already published or never created */ }
  }
}

// scaffold 매니페스트 본문 구성 (v1 oberonScaffold의 순수 부분 분리 — 테스트 용이성).
function buildScaffoldManifest({ title, aspect, shotCount, provider, model, resolution, withTitles }) {
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
    provider,
    model,
    resolution,
    shots,
  };
  if (withTitles) manifest.titles = oberonSampleTitles(title);
  return manifest;
}

// `oberon scaffold [out.json] [--title T] [--aspect 16:9] [--shots N] [--titles] [--overwrite]`
function scaffold(io, args) {
  const { flags, rest } = parseFlags(args, {
    title: "value",
    aspect: "value",
    shots: "value",
    provider: "value",
    model: "value",
    resolution: "value",
    titles: "boolean",
    overwrite: "boolean",
  });
  if (rest.length > 1) fail("Oberon scaffold accepts at most one output path");
  const outPath = path.resolve(rest[0] || "oberon-manifest.json");
  const title = flags.title || "My Oberon Film";
  const aspect = flags.aspect || "16:9";
  for (const [label, value, max] of [
    ["title", title, 300],
    ["aspect", aspect, 32],
    ["provider", flags.provider || "google-gemini-veo", 128],
    ["model", flags.model || "veo-3.1-lite-generate-001", 128],
    ["resolution", flags.resolution || "720p", 32],
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) {
      fail(`Oberon ${label} is invalid`);
    }
  }
  // v1 계약: 샷 수는 1..12로 클램프, 기본 2 (Veo 폴링 비용 상한).
  const requestedShots = flags.shots === undefined ? 2 : Number(flags.shots);
  if (!Number.isInteger(requestedShots)) fail("Oberon --shots must be an integer");
  const shotCount = Math.max(1, Math.min(requestedShots, 12));
  const manifest = buildScaffoldManifest({
    title,
    aspect,
    shotCount,
    provider: flags.provider || "google-gemini-veo",
    model: flags.model || "veo-3.1-lite-generate-001",
    resolution: flags.resolution || "720p",
    withTitles: !!flags.titles,
  });
  try {
    writeOberonManifest(outPath, manifest, { overwrite: !!flags.overwrite });
  } catch (error) {
    if (error && error.code === "AGENTLAS_OBERON_EXISTS") {
      fail(`Manifest already exists; it was not changed. Re-run with --overwrite to replace it: ${outPath}`, error.code);
    }
    fail((error && error.message) || String(error), error && error.code);
  }
  io.out(`✓ Manifest created: ${outPath}`);
  io.out(`  · ${shotCount} shots · ${aspect} · ${manifest.provider}`);
  io.out(`  · fill prompts, then run: agentlas oberon render ${path.basename(outPath)}`);
  io.out(`  · or use an agent: agentlas run oberon-film-studio "30-second fragrance ad trailer"`);
  if (!flags.titles) io.out(`  · use --titles to include title/subtitle burn-in samples`);
  return 0;
}

module.exports = { oberonSampleTitles, writeOberonManifest, buildScaffoldManifest, scaffold };
