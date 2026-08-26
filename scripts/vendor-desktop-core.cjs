#!/usr/bin/env node
"use strict";
/*
 * vendor-desktop-core — 데스크탑의 컴파일된 코어를 터미널 패키지 안에 번들한다 (2026-08-06).
 *
 * 배경(오너: "데스크탑 설치 안 해도 돌아감?"): 그래프 실행 등 무거운 기능은 데스크탑을 다시
 * 짜지 않고 데스크탑의 컴파일된 코어를 **재사용**한다(engine/core/desktop-core.cjs). 이 스크립트가
 * 그 코어를 engine/vendor/desktop-core/ 로 복사해 npm 패키지에 실리게 한다 — 그러면
 * `npm install -g agentlas` 하나로 데스크탑 앱도 electron 도 없이 돈다.
 *
 * 안전 원칙 두 가지가 서로 부딪힌다:
 *  1. **부분 클로저를 손으로 고르지 않는다** — require.cache 를 한 번 실행해서 뽑으면 그
 *     실행에서 안 밟은 노드 종류(eval/code/subgraph)의 지연 require 가 조용히 빠진다.
 *  2. **무관한 서브시스템을 끌고 오지 않는다** — dist/electron 을 통째로 복사하면 그래프 실행과
 *     무관한 updater/oberon/computer-use 가 자기만의 무거운 외부 의존(playwright·electron-updater·
 *     @google/genai)을 끌어와 패키지가 부풀고, 그 의존들이 vendor 되지 않으면 로드 자체가 깨진다.
 *
 * 해법 = **정적 require 그래프 순회**. run-graph.js 를 뿌리로 모든 `require("...")` 호출(최상단이든
 * 함수 내부의 지연 호출이든 — 전부 정적 문자열 리터럴이라 실행 없이 파싱만으로 완전하다)을
 * 재귀적으로 따라가 실제 도달 가능한 내부 파일 전체 + 외부 npm 패키지 전체를 구한다. 이러면
 * 시나리오 의존적 누락도 없고, 무관한 서브시스템도 안 끌려온다 — 둘 다 만족.
 *
 * 사용: node scripts/vendor-desktop-core.cjs [--desktop <path-to-agentlas_desktop>]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const flagIdx = args.indexOf("--desktop");
const desktopRoot = flagIdx >= 0 && args[flagIdx + 1]
  ? path.resolve(args[flagIdx + 1])
  : path.resolve(__dirname, "..", "..", "agentlas_desktop");

const vendorRoot = path.resolve(__dirname, "..", "engine", "vendor", "desktop-core");
const distRoot = path.join(desktopRoot, "dist");
const ROOT_ENTRY = path.join(distRoot, "electron", "workflow", "run-graph.js");

// ★진입점은 하나가 아니다. 실측 2026-08-20: run-graph 하나만 기점으로 삼았더니
//   재조정 모듈(store/graph-reconciliation.js)이 벤더에 아예 안 실렸다. 그래서 터미널은
//   `automation_partial_reconciliation_required` 를 **낼 수는 있는데 풀 수단이 없는**
//   상태였다 — CLI 만 쓰는 사람은 그 자동화를 영원히 못 돌린다.
//   내는 오류가 있으면 푸는 길도 같이 실어야 한다.
const EXTRA_ENTRIES = [
  path.join(distRoot, "electron", "store", "graph-reconciliation.js"),
  // 저장 전 확인 — 동적 req() 로만 닿아 정적 분석이 못 본다(재조정과 같은 자리).
  path.join(distRoot, "electron", "workflow", "verify-before-save.js"),
];

// 컴파일된 코드를 잘라내지 않는다(정적으로 도달 가능한 걸 손으로 프루닝하면, 그 가지가 실제로
// 쓰이는 실행 경로 — 예: 에이전트 노드가 컴퓨터-use 도구를 쓰는 경우 — 를 조용히 깨뜨린다).
// 진짜 도달 가능한 것은 전부 vendor 한다 — 크면 큰 대로 정직하게 보고한다.
const PRUNE_INTERNAL = [];
const builtins = new Set(Module.builtinModules);

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith(".")) return { kind: "external", spec };
  let p = path.resolve(path.dirname(fromFile), spec);
  const tryFiles = [p, `${p}.js`, path.join(p, "index.js")];
  for (const t of tryFiles) if (fs.existsSync(t) && fs.statSync(t).isFile()) return { kind: "internal", file: t };
  return { kind: "missing", spec };
}

function requiresOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const specs = new Set();
  // `require(...)` 와 `require.resolve(...)` 둘 다 — 후자도 모듈을 실제로 resolve 하므로
  // (실측: browser-cdp-launcher.js 가 모듈 최상단에서 require.resolve("@playwright/mcp") 로
  // CLI 경로 문자열을 만든다 — 브라우저 기능을 안 써도 그 파일을 require 하는 순간 던진다).
  const re = /require(?:\.resolve)?\(\s*"([^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) specs.add(m[1]);
  return [...specs];
}

function isPruned(file) {
  const rel = path.relative(distRoot, file).replace(/\\/g, "/");
  return PRUNE_INTERNAL.some((p) => rel.startsWith(p));
}

/** run-graph.js 에서 정적으로 도달 가능한 {internalFiles, externalPkgs, missing}. */
function computeClosure(rootFiles) {
  const internal = new Set();
  const external = new Set();
  const missing = new Set();
  const queue = Array.isArray(rootFiles) ? [...rootFiles] : [rootFiles];
  while (queue.length) {
    const file = queue.pop();
    if (internal.has(file) || isPruned(file)) continue;
    internal.add(file);
    for (const spec of requiresOf(file)) {
      if (spec === "electron" || builtins.has(spec.replace(/^node:/, ""))) continue;
      const r = resolveRequire(file, spec);
      if (r.kind === "internal") { if (!isPruned(r.file)) queue.push(r.file); }
      else if (r.kind === "external") external.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      else missing.add(`${spec}  (from ${path.relative(distRoot, file)})`);
    }
  }
  return { internal, external, missing };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyFileInto(root, absFile) {
  const rel = path.relative(distRoot, absFile);
  const dst = path.join(root, "dist", rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(absFile, dst);
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
function dirSizeMB(p) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { bytes += fs.statSync(full).size; } catch { /* race */ } }
    }
  };
  try { walk(p); } catch { /* missing */ }
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 외부 패키지 집합을 그 package.json dependencies 로 재귀 확장한다(node_modules 는 평평하다). */
function expandExternalDeps(pkgNames, nodeModulesRoot) {
  const all = new Set();
  const queue = [...pkgNames];
  while (queue.length) {
    const name = queue.pop();
    if (all.has(name)) continue;
    all.add(name);
    const pkgJsonPath = path.join(nodeModulesRoot, name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue; // node builtin 이거나(없음) 뒤에서 정직하게 실패
    let deps = {};
    try { deps = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).dependencies || {}; } catch { /* malformed — skip */ }
    for (const dep of Object.keys(deps)) if (!all.has(dep)) queue.push(dep);
  }
  return all;
}

function main() {
  if (!fs.existsSync(ROOT_ENTRY)) {
    /*
     * ★데스크탑 소스가 아예 없는 곳에서는 할 일이 없다 — 실패가 아니다.
     *
     * `prepublishOnly` 가 이것을 부른다. 그 자리에서 무조건 실패하게 두었더니 CI 발행이
     * 통째로 막혔다(실측: 1.0.61 npm 게시 실패). 러너에는 데스크탑 저장소가 체크아웃되지
     * 않으니 당연히 없고, 애초에 **필요하지도 않다** — 무거운 tar.gz 는 패키지에 안 실리고,
     * CLI 는 커밋된 매니페스트를 보고 실행 시점에 내려받는다. 발행에 필요한 것은 그
     * 매니페스트뿐이고 그건 이미 저장소에 있다.
     *
     * 다만 "데스크탑 저장소는 있는데 빌드를 안 한" 개발 기계는 여전히 실패해야 한다.
     * 그 경우는 진짜로 사본이 낡은 채 나갈 수 있는 자리다. 그래서 둘을 가른다:
     * 저장소 자체가 없으면 건너뛰고, 있는데 dist 가 없으면 예전처럼 멈춘다.
     */
    if (!fs.existsSync(desktopRoot)) {
      const manifestPath = path.join(__dirname, "..", "engine", "vendor", "desktop-core.manifest.json");
      if (!fs.existsSync(manifestPath)) {
        console.error("✖ no desktop source here and no committed engine manifest — the CLI would have no engine to fetch.");
        process.exit(1);
      }
      console.log(`vendor:core: skipped — no desktop checkout at ${desktopRoot}.`);
      console.log("  Nothing to do: the tarball is never packaged, and the committed manifest is what the CLI fetches.");
      return;
    }
    console.error(`✖ desktop core not found at ${distRoot} (expected electron/workflow/run-graph.js).`);
    console.error(`  Build it first: cd ${desktopRoot} && npm run build:electron`);
    process.exit(1);
  }
  console.log(`Computing the static require-graph closure from ${path.relative(distRoot, ROOT_ENTRY)} …`);
  const entries = [ROOT_ENTRY, ...EXTRA_ENTRIES.filter((p) => fs.existsSync(p))];
  const { internal, external, missing } = computeClosure(entries);
  if (missing.size) {
    console.error(`✖ ${missing.size} module(s) could not be resolved statically:`);
    for (const m of missing) console.error(`   - ${m}`);
    process.exit(1);
  }
  console.log(`  internal files: ${internal.size}  |  external packages: ${external.size}`);

  rmrf(vendorRoot);
  for (const f of internal) copyFileInto(vendorRoot, f);

  const nodeModulesRoot = path.join(desktopRoot, "node_modules");
  const vendorNodeModules = path.join(vendorRoot, "node_modules");
  fs.mkdirSync(vendorNodeModules, { recursive: true });
  const skip = new Set(["better-sqlite3", "keytar"]); // 터미널이 이미 자기 ABI 로 갖고 있음
  // 소스코드 정적 스캔은 코드가 직접 부르는 패키지만 본다 — 그 패키지의 npm 의존(예: cross-spawn
  // → which → isexe)까지는 못 본다. package.json dependencies 로 재귀 확장해야 완전하다.
  const fullExternal = expandExternalDeps(external, nodeModulesRoot);
  console.log(`  external (재귀 확장): ${external.size} → ${fullExternal.size}`);
  let copied = 0;
  for (const dep of [...fullExternal].sort()) {
    if (skip.has(dep)) continue;
    const src = path.join(nodeModulesRoot, dep);
    if (!fs.existsSync(src)) { console.error(`✖ missing external dep in desktop node_modules: ${dep}`); process.exit(1); }
    copyDir(src, path.join(vendorNodeModules, dep));
    copied += 1;
  }
  console.log(`  vendored dist/  (${dirSizeMB(path.join(vendorRoot, "dist"))} MB)`);
  console.log(`  vendored node_modules/  (${copied} packages, ${dirSizeMB(vendorNodeModules)} MB)`);

  fs.writeFileSync(
    path.join(vendorRoot, "VENDORED.json"),
    JSON.stringify({
      vendoredAt: new Date().toISOString(),
      sourceDesktopRoot: desktopRoot,
      rootEntry: path.relative(distRoot, ROOT_ENTRY),
      internalFileCount: internal.size,
      externalDeps: [...fullExternal].filter((d) => !skip.has(d)).sort(),
      directExternalDeps: [...external].sort(),
      prunedInternal: PRUNE_INTERNAL,
    }, null, 2) + "\n",
  );
  console.log(`✓ Vendored desktop core (static closure) → ${vendorRoot} (total ${dirSizeMB(vendorRoot)} MB)`);

  // 코덱스 CLI 패턴: 이 무거운 산출물은 git 에 커밋하지 않고 GitHub Release 자산으로 올린 뒤,
  // 처음 필요할 때만 사용자 머신이 내려받는다(engine/core/desktop-core-fetch.cjs). 여기서는
  // 업로드할 tar.gz 와 그 sha256 을 만들어 둔다 — 실제 릴리스 업로드는 별도 승인 대상.
  const tarPath = path.join(path.dirname(vendorRoot), "desktop-core.tar.gz");
  fs.rmSync(tarPath, { force: true });
  const tarRes = spawnSync("tar", ["-czf", tarPath, "-C", vendorRoot, "dist", "node_modules", "VENDORED.json"]);
  if (tarRes.status !== 0) { console.error("✖ tar failed:", tarRes.stderr?.toString() || tarRes.error); process.exit(1); }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");
  const sizeBytes = fs.statSync(tarPath).size;
  console.log(`✓ Packaged ${path.relative(process.cwd(), tarPath)}  (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…)`);
  console.log(`  Next: upload this asset to a GitHub Release, then run`);
  console.log(`    node scripts/write-desktop-core-manifest.cjs --version <n> --url <release-asset-url>`);

  // 벤더 갱신 직후가 구조 상수 쌍둥이(manifest.ts ↔ architecture.data.json)가
  // 갈라질 수 있는 유일한 순간이다 — 값 대조 게이트를 여기서 강제한다.
  const parity = spawnSync("node", [path.join(__dirname, "verify-architecture-parity.cjs")], { stdio: "inherit" });
  if (parity.status !== 0) {
    console.error("✖ architecture parity failed — vendored core and engine/architecture.data.json disagree");
    process.exit(1);
  }
}

main();
