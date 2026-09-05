#!/usr/bin/env node
"use strict";
/*
 * write-desktop-core-manifest — 그래프 실행 엔진 다운로드 매니페스트를 커밋용으로 굳힌다.
 *
 * 흐름: `npm run vendor:core` 로 engine/vendor/desktop-core.tar.gz 를 만든 뒤, 그 tar.gz 를
 * GitHub Release 자산으로 **직접 업로드**(이 스크립트는 업로드하지 않는다 — 공개 행위라 별도
 * 승인 대상)한 다음, 이 스크립트로 그 자산의 실제 URL 을 매니페스트에 박는다. 매니페스트는
 * 작아서(몇 줄) git 에 커밋된다 — 무거운 tar.gz 는 커밋하지 않는다(코덱스 CLI 패턴).
 *
 * 사용: node scripts/write-desktop-core-manifest.cjs --version 1 --url <release-asset-url>
 *       [--desktop-release v1.1.1 --desktop-schema-version 107]
 *
 * ★릴리스 순서 선언(2026-09-06, scripts/verify-desktop-release-order.cjs 가 지키는 값).
 * `--desktop-release`/`--desktop-schema-version` 을 주지 않으면 기존 매니페스트의 값을
 * 그대로 들고 간다 — 평범한 재실행(예: sha256 갱신)이 이 선언을 조용히 지우면 안 된다.
 * 벤더한 코어가 요구하는 스키마를 올릴 때는 반드시 두 플래그를 **같이** 새로 준다:
 * `--desktop-release`는 실제로 서명 릴리스가 나간 태그(예: `git -C ../agentlas_desktop
 * tag` 로 확인), `--desktop-schema-version`은 그 태그의 `electron/store/db.ts`
 * SCHEMA_VERSION(예: `git -C ../agentlas_desktop show v1.1.1:electron/store/db.ts`) —
 * 둘 다 손으로 지어내지 않고 실제로 나간 릴리스를 확인한 값이어야 한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; }

const version = flag("version");
const url = flag("url");
if (!version || !url) {
  console.error("Usage: node scripts/write-desktop-core-manifest.cjs --version <n> --url <release-asset-url>");
  process.exit(1);
}

const tarPath = path.resolve(__dirname, "..", "engine", "vendor", "desktop-core.tar.gz");
if (!fs.existsSync(tarPath)) {
  console.error(`✖ ${tarPath} not found. Run \`npm run vendor:core\` first.`);
  process.exit(1);
}
const buf = fs.readFileSync(tarPath);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
const sizeBytes = buf.length;

const manifestPath = path.resolve(__dirname, "..", "engine", "vendor", "desktop-core.manifest.json");
let previous = {};
try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first write */ }

const desktopReleaseFlag = flag("desktop-release");
const desktopSchemaFlag = flag("desktop-schema-version");
if (Boolean(desktopReleaseFlag) !== Boolean(desktopSchemaFlag)) {
  console.error("✖ --desktop-release and --desktop-schema-version must be given together (or neither, to keep the current declaration).");
  process.exit(1);
}
const desktopCompatibleRelease = desktopReleaseFlag || previous.desktopCompatibleRelease;
const desktopCompatibleSchemaVersion = desktopSchemaFlag ? Number(desktopSchemaFlag) : previous.desktopCompatibleSchemaVersion;
const desktopCompatibleNote = desktopReleaseFlag
  ? `Declared by write-desktop-core-manifest.cjs on ${new Date().toISOString()} — verify with \`git -C ../agentlas_desktop show ${desktopCompatibleRelease}:electron/store/db.ts\` before trusting this.`
  : previous.desktopCompatibleNote;

const manifest = {
  version, url, sha256, sizeBytes, writtenAt: new Date().toISOString(),
  ...(desktopCompatibleRelease ? { desktopCompatibleRelease } : {}),
  ...(Number.isFinite(desktopCompatibleSchemaVersion) ? { desktopCompatibleSchemaVersion } : {}),
  ...(desktopCompatibleNote ? { desktopCompatibleNote } : {}),
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ wrote ${path.relative(process.cwd(), manifestPath)}`);
console.log(`  version=${version} sha256=${sha256.slice(0, 16)}… size=${(sizeBytes / 1024 / 1024).toFixed(1)}MB`);
if (desktopCompatibleRelease) {
  console.log(`  desktopCompatibleRelease=${desktopCompatibleRelease} desktopCompatibleSchemaVersion=${desktopCompatibleSchemaVersion}`);
} else {
  console.log(`  ⚠ no desktopCompatibleRelease declared yet — npm run verify:desktop-release-order will fail until one is set.`);
}
console.log(`  Commit this manifest file (not the tar.gz) so the CLI can fetch it on demand.`);
