#!/usr/bin/env node
// 데스크탑 리포의 cli/ 엔진을 engine/ 으로 벤더링한다.
//
//   node scripts/sync-engine.mjs [desktop-repo-root]
//
// 기본 소스: AGENTLAS_DESKTOP_REPO 또는 형제 폴더 ../agentlas_desktop
// 결과: engine/*.cjs + architecture.data.json + ENGINE_META.json(추적용)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(
  process.argv[2] || process.env.AGENTLAS_DESKTOP_REPO || path.join(pkgRoot, "..", "agentlas_desktop")
);
const srcDir = path.join(repo, "cli");
const outDir = path.join(pkgRoot, "engine");

if (!fs.existsSync(path.join(srcDir, "agentlas.cjs"))) {
  console.error(`엔진 소스를 찾을 수 없습니다: ${srcDir}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith(".cjs") || f === "architecture.data.json")
  .sort();
for (const f of files) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}

let commit = null;
let version = null;
try { commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim(); } catch { /* not a repo */ }
try { version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version; } catch { /* ignore */ }

fs.writeFileSync(
  path.join(outDir, "ENGINE_META.json"),
  // source는 로컬 절대경로 대신 공개 리포 좌표로 기록한다 (패키지에 포함되므로).
  JSON.stringify({ source: "agentlas-ai/agentlas-desktop/cli", desktopVersion: version, commit, syncedAt: new Date().toISOString(), files }, null, 2) + "\n"
);
console.log(`synced ${files.length} files from ${srcDir} (desktop ${version ?? "?"} @ ${commit ?? "?"})`);
