"use strict";
/*
 * oberon 계약 테스트 (오프라인 — 실 Electron/Veo 불필요, 가짜 렌더 seam 주입).
 * 검증:
 *  1. scaffold — 매니페스트 생성 위치/필드(v1 계약: 샷 클램프, provider/model 기본값,
 *     --titles 타이포 프리셋), no-clobber(EXISTS는 정직 실패), --overwrite, 심볼릭 링크 거부.
 *  2. render 정직 정지 — 렌더 진입점(scripts/render-oberon-live-request.cjs,
 *     dist/electron/oberon/render.js)이 없으면 v1과 동일한 메시지로 exit 1. 가짜 렌더 금지.
 *  3. render(가짜 seam) — POLL/FILE/DELIVERY 스트리밍 프로토콜 파싱, 진행률 바,
 *     titled 요약, --max-shots 오버라이드가 임시 패치본으로 가고 원본은 불변,
 *     딜리버리 폴더 산출물, 실패 exit code 전파.
 *  4. list — <userData>/oberon/ 의 렌더 잡 폴더 + master/titled 필터 노출 (v1 위치 계약).
 *  5. film 별칭 — v1 디스패처의 `case "film"` 과 동일하게 oberon 모듈 그대로.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-oberon-test-"));
process.env.AGENTLAS_USER_DATA_DIR = path.join(tmp, "userdata");
fs.mkdirSync(process.env.AGENTLAS_USER_DATA_DIR, { recursive: true });

const oberonCmd = require("../engine/commands/oberon.cjs");
const filmCmd = require("../engine/commands/film.cjs");
const { oberonBar, oberonBytes, slugifyOberon } = require("../engine/oberon/common.cjs");
const { oberonHome } = require("../engine/oberon/outputs.cjs");

function makeCtx() {
  const stdout = [];
  const stderr = [];
  return {
    lang: "en",
    ui: { bold: (s) => s, dim: (s) => s, accent: (s) => s, green: (s) => s, red: (s) => s },
    out: (s = "") => stdout.push(String(s)),
    err: (s = "") => stderr.push(String(s)),
    db: () => { throw new Error("oberon must not touch the DB"); },
    stdout,
    stderr,
  };
}

function collector() {
  const chunks = [];
  return { write: (s) => chunks.push(String(s)), chunks, text: () => chunks.join("") };
}

let passed = 0;
function ok(label) { passed++; console.log(`ok ${passed} - ${label}`); }

(async () => {
  // ── 0. 순수 유틸 스팟체크 (v1 동작 고정) ──
  assert.equal(oberonBar(0), "░".repeat(20));
  assert.equal(oberonBar(100), "█".repeat(20));
  assert.equal(oberonBar(50), "█".repeat(10) + "░".repeat(10));
  assert.equal(oberonBytes(500), "500B");
  assert.equal(oberonBytes(2048), "2KB");
  assert.equal(oberonBytes(3_500_000), "3.5MB");
  assert.equal(slugifyOberon("향수 광고 Trailer!"), "향수_광고_Trailer_");
  assert.equal(slugifyOberon(""), "oberon");
  ok("common utils match v1 (bar / bytes / slugify keeps 한글)");

  // ── 1. list — 산출물 없는 초기 상태 ──
  {
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["list"]);
    assert.equal(code, 0);
    assert.match(ctx.stdout.join("\n"), /No render outputs yet/);
    ok("list before any render: honest empty message");
  }

  // ── 2. scaffold ──
  const work = path.join(tmp, "work");
  fs.mkdirSync(work, { recursive: true });
  const manifestPath = path.join(work, "my-film.json");
  {
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, [
      "scaffold", manifestPath,
      "--title", "향수 광고", "--aspect", "9:16", "--shots", "99", "--titles",
    ]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(manifestPath), "manifest file created at requested path");
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(m.title, "향수 광고");
    assert.equal(m.aspectRatio, "9:16");
    assert.equal(m.shots.length, 12); // v1 계약: 샷 수 1..12 클램프
    assert.equal(m.maxShots, 12);
    assert.equal(m.takesPerShot, 1);
    assert.equal(m.provider, "google-gemini-veo");
    assert.equal(m.model, "veo-3.1-lite-generate-001");
    assert.equal(m.resolution, "720p");
    assert.equal(m.shots[0].shotId, "SH_001");
    assert.equal(m.shots[11].shotId, "SH_012");
    assert.equal(m.shots[0].providerId, "google-veo");
    assert.equal(m.shots[0].providerMode, "text_to_video");
    assert.match(m.shots[0].prompt, /샷 1 프롬프트/);
    // --titles 타이포 프리셋: 한국어 자막은 CJK 폰트 강제 (v1 oberonSampleTitles)
    assert.equal(m.titles.titleCard.style.fontName, "Pretendard");
    assert.equal(m.titles.subtitleStyle.cjk, true);
    assert.equal(m.titles.endCard.lines[0], "AGENTLAS");
    assert.match(ctx.stdout.join("\n"), /Manifest created/);
    ok("scaffold: file + v1 field contract (clamp, defaults, --titles preset)");
  }
  {
    // no-clobber: 같은 경로 재-scaffold는 정직 실패, 파일 불변
    const before = fs.readFileSync(manifestPath, "utf8");
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["scaffold", manifestPath]);
    assert.equal(code, 1);
    assert.match(ctx.stderr.join("\n"), /✖ .*already exists.*--overwrite/);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), before, "existing manifest untouched");
    ok("scaffold no-clobber: EXISTS is an honest stop, file preserved");
  }
  {
    // --overwrite 는 교체 허용
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["scaffold", manifestPath, "--title", "Second", "--overwrite"]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).title, "Second");
    ok("scaffold --overwrite replaces atomically");
  }
  if (process.platform !== "win32") {
    // 심볼릭 링크 타깃 오염 방지 (v1 AGENTLAS_OBERON_SYMLINK)
    const realTarget = path.join(work, "real.json");
    fs.writeFileSync(realTarget, "{}\n");
    const link = path.join(work, "link.json");
    fs.symlinkSync(realTarget, link);
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["scaffold", link, "--overwrite"]);
    assert.equal(code, 1);
    assert.match(ctx.stderr.join("\n"), /symbolic link/);
    assert.equal(fs.readFileSync(realTarget, "utf8"), "{}\n", "symlink target untouched");
    ok("scaffold refuses to write through a symlink");
  }

  // scaffold를 렌더 테스트용 3샷 매니페스트로 재생성
  {
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, [
      "scaffold", manifestPath, "--overwrite",
      "--title", "향수 광고", "--shots", "3", "--titles",
    ]);
    assert.equal(code, 0);
  }

  // ── 3. render 정직 정지 (seam 미주입 → 실 진입점 부재) ──
  {
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["render", manifestPath]);
    assert.equal(code, 1);
    assert.match(
      ctx.stderr.join("\n"),
      /✖ (Headless render script not found|An Electron build is required)/,
      "missing render entry must be an honest v1-style stop, never a fake render",
    );
    ok("render without entry: honest stop (no fake render)");
  }
  {
    // 매니페스트 부재/샷 없음도 정직 실패
    const ctx = makeCtx();
    assert.equal(await oberonCmd.run(ctx, ["render"]), 1);
    assert.match(ctx.stderr.join("\n"), /manifest path is required/);
    const empty = path.join(work, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ title: "x", shots: [] }));
    const ctx2 = makeCtx();
    assert.equal(await oberonCmd.run(ctx2, ["render", empty]), 1);
    assert.match(ctx2.stderr.join("\n"), /no shots/);
    ok("render input validation matches v1 (missing path / empty shots)");
  }

  // ── 4. render — 가짜 seam 주입 (스트리밍 프로토콜 + 산출물) ──
  const seamRoot = path.join(tmp, "seam");
  const fakeScript = path.join(seamRoot, "scripts", "render-oberon-live-request.cjs");
  const fakeBuilt = path.join(seamRoot, "dist", "electron", "oberon", "render.js");
  fs.mkdirSync(path.dirname(fakeScript), { recursive: true });
  fs.mkdirSync(path.dirname(fakeBuilt), { recursive: true });
  fs.writeFileSync(fakeBuilt, "// fake electron build artifact\n");
  fs.writeFileSync(fakeScript, `
"use strict";
// 가짜 헤드리스 렌더: v1 렌더 자식의 stdout 프로토콜을 그대로 흉내낸다.
const fs = require("node:fs");
const path = require("node:path");
const req = JSON.parse(fs.readFileSync(process.env.OBERON_LIVE_REQUEST_FILE, "utf8"));
if (process.env.EXPECTED_MAX_SHOTS && String(req.maxShots) !== process.env.EXPECTED_MAX_SHOTS) {
  console.error("maxShots mismatch: " + req.maxShots);
  process.exit(3);
}
if (process.env.FAKE_RENDER_FAIL) process.exit(2);
const delivery = process.env.OBERON_LIVE_DELIVERY_DIR;
fs.mkdirSync(delivery, { recursive: true });
// Desktop 렌더 잡과 동일하게 <userData>/oberon/<productionId>/ 아래에 잡 산출물을 남긴다.
const jobDir = path.join(process.env.AGENTLAS_USER_DATA_DIR, "oberon", req.productionId);
fs.mkdirSync(jobDir, { recursive: true });
fs.writeFileSync(path.join(jobDir, "master.mp4"), "fake");
fs.writeFileSync(path.join(jobDir, "master_titled.mp4"), "fake-titled");
fs.writeFileSync(path.join(jobDir, "clip_001.mp4"), "clip");
const masterPath = path.join(delivery, "master.mp4");
fs.writeFileSync(masterPath, "fake-master");
console.log("JOB=" + req.productionId);
console.log("OUT_DIR=" + jobDir);
console.log("GEMINI_API_KEY=present");
console.log("POLL status=running phase=generate clips=1/" + req.maxShots + " percent=40");
console.log("POLL status=succeeded phase=assemble clips=" + req.maxShots + "/" + req.maxShots + " percent=100");
console.log("FILE kind=master name=master.mp4 bytes=11");
console.log("FILE kind=titled_master name=master_titled.mp4 bytes=12");
console.log("DELIVERY kind=master name=master.mp4 path=" + masterPath + " bytes=11");
console.log("WARNINGS=1 shot fell back to a retake");
process.exit(0);
`);
  const seam = { resolveRenderEntry: () => ({ script: fakeScript, builtRender: fakeBuilt }) };

  let productionId;
  {
    const stdoutCol = collector();
    const stderrCol = collector();
    const ctx = makeCtx();
    process.env.EXPECTED_MAX_SHOTS = "2"; // --max-shots 오버라이드가 자식에 도달하는지
    const deliveryDir = path.join(work, "delivery");
    const code = await oberonCmd.run(
      ctx,
      ["render", manifestPath, "--max-shots", "2", "--delivery", deliveryDir],
      { ...seam, stdout: stdoutCol, stderr: stderrCol },
    );
    delete process.env.EXPECTED_MAX_SHOTS;
    assert.equal(code, 0);
    const lines = ctx.stdout.join("\n");
    // 헤더 + 오버라이드 반영 (max 2), 원본 매니페스트는 불변(maxShots 3 유지)
    assert.match(lines, /▶ Oberon render: "향수 광고" {2}\(3 shots, max 2\)/);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).maxShots, 3, "user manifest untouched by --max-shots");
    assert.match(lines, /title\/subtitle burn-in: enabled/);
    // 스트리밍 프로토콜 파싱
    assert.match(stdoutCol.text(), /⏳ █{8}░{12} {2}40% {2}generate {2}clips 1\/2/);
    assert.match(stdoutCol.text(), /█{20} 100%/);
    assert.match(lines, /📦 master {6}master\.mp4 {2}\(11B\)/);
    assert.match(lines, /⚠ 1 shot fell back to a retake/);
    assert.doesNotMatch(lines, /JOB=|OUT_DIR=|GEMINI_API_KEY=present/, "internal tracking lines hidden");
    assert.match(lines, /✓ Render complete — delivery folder: /);
    assert.match(lines, /title\/subtitle burn-in files: master_titled\.mp4/);
    assert.ok(fs.existsSync(path.join(deliveryDir, "master.mp4")), "delivery output exists");
    productionId = fs.readdirSync(path.join(process.env.AGENTLAS_USER_DATA_DIR, "oberon"))[0];
    assert.ok(productionId && productionId.startsWith("oberon-"), "job dir under <userData>/oberon");
    ok("render with injected seam: protocol, override patching, delivery outputs");
  }
  {
    // 실패 exit code 전파 (v1: process.exitCode = code)
    const stderrCol = collector();
    const ctx = makeCtx();
    process.env.FAKE_RENDER_FAIL = "1";
    const code = await oberonCmd.run(ctx, ["render", manifestPath], { ...seam, stdout: collector(), stderr: stderrCol });
    delete process.env.FAKE_RENDER_FAIL;
    assert.equal(code, 2);
    assert.match(stderrCol.text(), /✖ Render failed \(exit 2\)/);
    ok("render failure propagates child exit code honestly");
  }
  {
    // dry-run: 스폰 없이 커맨드/환경만 출력
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["render", manifestPath, "--dry-run"], seam);
    assert.equal(code, 0);
    const linesJoined = ctx.stdout.join("\n");
    assert.match(linesJoined, /\[dry-run\] Command to run:/);
    assert.match(linesJoined, /OBERON_LIVE_REQUEST_FILE=/);
    ok("render --dry-run prints plan without spawning");
  }

  // ── 5. list — 렌더 잡이 <userData>/oberon 에 보인다 ──
  {
    const ctx = makeCtx();
    const code = await oberonCmd.run(ctx, ["list"]);
    assert.equal(code, 0);
    const linesJoined = ctx.stdout.join("\n");
    assert.match(linesJoined, new RegExp(`Recent Oberon renders \\(${oberonHome().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    assert.ok(linesJoined.includes(productionId), "scaffolded/rendered production listed");
    assert.match(linesJoined, /master\.mp4, master_titled\.mp4|master_titled\.mp4, master\.mp4/);
    assert.doesNotMatch(linesJoined, /clip_001\.mp4/, "intermediate clips filtered from summary");
    ok("list shows the rendered production from <userData>/oberon");
  }

  // ── 6. film 별칭 + help + unknown sub ──
  {
    assert.equal(filmCmd, oberonCmd, "film is the same module (v1 dispatcher parity)");
    const ctx = makeCtx();
    assert.equal(await filmCmd.run(ctx, []), 0);
    assert.match(ctx.stdout.join("\n"), /agentlas oberon — AI film rendering from the terminal/);
    const ctx2 = makeCtx();
    assert.equal(await filmCmd.run(ctx2, ["frobnicate"]), 1);
    assert.match(ctx2.stderr.join("\n"), /✖ Unknown oberon subcommand: frobnicate/);
    ok("film alias === oberon; help default; unknown subcommand honest error");
  }

  console.log(`\nPASS oberon-contract (${passed} checks)`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error("FAIL oberon-contract:", e && e.stack || e);
  process.exit(1);
});
