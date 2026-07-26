"use strict";
/*
 * oberon/render — 헤드리스 렌더 스폰 + 진행률 스트리밍.
 * v1 §12360-12471 (oberonRender / oberonRenderLine) 충실 포팅.
 *
 * 렌더 경로가 실제로 필요로 하는 것 (v1 계약):
 *  - <packageRoot>/scripts/render-oberon-live-request.cjs  (헤드리스 렌더 진입 스크립트)
 *  - <packageRoot>/dist/electron/oberon/render.js          (Electron 렌더 빌드 산출물)
 *  둘 다 Desktop 쪽 Electron 빌드 산출물이며 터미널 npm 패키지에는 실려 있지 않다.
 *  v1도 fs.existsSync 검사 후 정직하게 실패했다 — 렌더를 가짜로 성공시키지 않는다.
 *
 * v2 seam: 렌더 진입점 해석과 spawn은 deps 파라미터로 주입 가능하다.
 *   deps.resolveRenderEntry() → { script, builtRender }
 *   deps.spawn / deps.execPath / deps.stdout / deps.stderr
 *  테스트는 가짜 렌더 스크립트를 주입해 프로토콜(POLL/FILE/DELIVERY 라인)을 검증하고,
 *  실제 배포에서는 진입점이 없으면 v1과 동일한 메시지로 정직 정지한다.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { packageRoot } = require("../core/paths.cjs");
const { fail, parseFlags, oberonBar, oberonBytes, slugifyOberon } = require("./common.cjs");

// v1 oberonRepoRoot() = engine/의 부모 = 패키지 루트. v2에서는 core/paths가 정본.
function defaultRenderEntry() {
  const root = packageRoot();
  return {
    script: path.join(root, "scripts", "render-oberon-live-request.cjs"),
    builtRender: path.join(root, "dist", "electron", "oberon", "render.js"),
  };
}

/*
 * 렌더 자식의 stdout 프로토콜 한 줄 처리 (v1 oberonRenderLine).
 *   POLL status= phase= clips= percent=   → \r 진행률 바 갱신
 *   FILE kind= name= bytes=               → 산출물 수집 (titled 요약용)
 *   DELIVERY kind= name= path= bytes=     → 딜리버리 복사 알림
 *   WARNINGS=                             → 경고 표시
 *   JOB= / OUT_DIR= / *=present|missing   → 내부 추적/키 존재 점검 라인 — 숨김
 */
function oberonRenderLine(line, files, io) {
  let m;
  if ((m = line.match(/^POLL status=(\S+) phase=(\S+) clips=(\S+) percent=(\d+)/))) {
    const [, status, phase, clips, pct] = m;
    const bar = oberonBar(Number(pct));
    io.write(`\r⏳ ${bar} ${String(pct).padStart(3)}%  ${phase}  clips ${clips}   `);
    if (status === "succeeded") io.write("\n");
    return;
  }
  if ((m = line.match(/^FILE kind=(\S+) name=(\S+) bytes=(\d+)/))) {
    files.push({ kind: m[1], name: m[2], bytes: Number(m[3]) });
    return;
  }
  if ((m = line.match(/^DELIVERY kind=(\S+) name=(\S+) path=(\S+) bytes=(\d+)/))) {
    io.out(`  📦 ${m[1].padEnd(11)} ${m[2]}  (${oberonBytes(Number(m[4]))})`);
    return;
  }
  if (line.startsWith("WARNINGS=")) {
    io.out(`  ⚠ ${line.slice("WARNINGS=".length)}`);
    return;
  }
  if (line.startsWith("JOB=") || line.startsWith("OUT_DIR=")) return; // 내부 추적
  if (/=(present|missing)$/.test(line)) return; // 키 존재 점검 라인
  if (line.trim()) io.out(`  ${line}`);
}

// `oberon render <manifest.json> [--delivery DIR] [--max-shots N] [--takes N]
//                [--resolution R] [--max-polls N] [--poll-ms N] [--open] [--dry-run]`
async function render(io, args, deps = {}) {
  const { flags, rest } = parseFlags(args);
  if (!rest[0]) fail("A manifest path is required: agentlas oberon render <manifest.json>");
  const manifestPath = path.resolve(rest[0]);
  if (!fs.existsSync(manifestPath)) fail(`Manifest not found: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`Failed to parse manifest JSON: ${e.message}`);
  }
  if (!Array.isArray(manifest.shots) || !manifest.shots.length) fail("The manifest has no shots[].");

  // seam: 다른 산출물 배치(예: Desktop 동봉 빌드)가 생기면 여기만 주입 교체.
  const { script, builtRender } = (deps.resolveRenderEntry || defaultRenderEntry)();
  // 정직 정지 — v1과 동일한 문구. 렌더 진입점이 없으면 절대 가짜 렌더를 하지 않는다.
  if (!fs.existsSync(script)) fail(`Headless render script not found (not included in the packaged app): ${script}`);
  if (!fs.existsSync(builtRender)) fail(`An Electron build is required. Run npm run build:electron first (missing: ${builtRender})`);

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
  delete childEnv.ELECTRON_RUN_AS_NODE; // full Electron으로 부팅 (Desktop execPath일 때)
  childEnv.OBERON_LIVE_VEO = "1";
  childEnv.OBERON_LIVE_REQUEST_FILE = reqPath;
  childEnv.OBERON_LIVE_DELIVERY_DIR = deliveryDir;
  if (flags["max-polls"]) childEnv.OBERON_LIVE_MAX_POLLS = String(flags["max-polls"]);
  if (flags["poll-ms"]) childEnv.OBERON_LIVE_POLL_MS = String(flags["poll-ms"]);
  if (flags.open) childEnv.OBERON_LIVE_OPEN_DELIVERY = "1";

  io.out(`▶ Oberon render: "${manifest.title}"  (${manifest.shots.length} shots, max ${overrides.maxShots ?? manifest.maxShots ?? 3})`);
  io.out(`  Manifest: ${manifestPath}`);
  io.out(`  Delivery folder: ${deliveryDir}`);
  if (manifest.titles) io.out(`  title/subtitle burn-in: enabled → generating additional *_titled.mp4`);

  if (flags["dry-run"]) {
    const execPath = deps.execPath || process.execPath;
    io.out("\n[dry-run] Command to run:");
    io.out(`  ${execPath} ${script}`);
    io.out("  env: OBERON_LIVE_VEO=1");
    io.out(`       OBERON_LIVE_REQUEST_FILE=${reqPath}`);
    io.out(`       OBERON_LIVE_DELIVERY_DIR=${deliveryDir}`);
    io.out("  (full Electron · GEMINI_API_KEY/GOOGLE_CLOUD_PROJECT vault required)");
    return 0;
  }

  const doSpawn = deps.spawn || spawn;
  const execPath = deps.execPath || process.execPath;
  const stdoutStream = deps.stdout || process.stdout;
  const stderrStream = deps.stderr || process.stderr;
  const lineIo = { out: io.out, write: (s) => stdoutStream.write(s) };

  return new Promise((resolve) => {
    const child = doSpawn(execPath, [script], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let buf = "";
    const handle = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        oberonRenderLine(line, files, lineIo);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", (c) => stderrStream.write(c));
    child.on("close", (code) => {
      if (code === 0) {
        io.out(`\n✓ Render complete — delivery folder: ${deliveryDir}`);
        const titled = files.filter((f) => f.kind && f.kind.startsWith("titled"));
        if (titled.length) io.out(`  title/subtitle burn-in files: ${titled.map((f) => f.name).join(", ")}`);
        resolve(0);
      } else {
        stderrStream.write(`\n✖ Render failed (exit ${code})\n`);
        resolve(code || 1); // v1은 process.exitCode 설정 — v2는 코드 반환
      }
    });
  });
}

module.exports = { render, oberonRenderLine, defaultRenderEntry };
