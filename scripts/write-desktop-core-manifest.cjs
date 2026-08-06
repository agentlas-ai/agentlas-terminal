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
fs.writeFileSync(manifestPath, JSON.stringify({ version, url, sha256, sizeBytes, writtenAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`✓ wrote ${path.relative(process.cwd(), manifestPath)}`);
console.log(`  version=${version} sha256=${sha256.slice(0, 16)}… size=${(sizeBytes / 1024 / 1024).toFixed(1)}MB`);
console.log(`  Commit this manifest file (not the tar.gz) so the CLI can fetch it on demand.`);
