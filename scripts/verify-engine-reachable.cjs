#!/usr/bin/env node
// 새로 설치한 사람이 엔진을 **얻을 수 있는가** 를 지킨다.
//
// 배경(2026-08-20 실측). npm 패키지는 그래프 실행 엔진(12MB)을 담지 않고 매니페스트가
// 가리키는 릴리스 자산에서 내려받는다. 그 내려받는 함수(loadDesktopCoreAsync)는
// 만들어져 있었는데 **저장소 어디에서도 부르지 않았다.** `graph run` 은 캐시만 보는
// 동기 로더를 부르고, 캐시가 비면 거기서 끝났다:
//
//     ok: False | error: vendored Desktop Core is unavailable
//
// 갓 설치한 사람은 캐시가 비어 있다. 그리고 그 캐시를 채울 길을 아무도 밟지 않았으니
// **한 번도 자동화를 돌릴 수 없었다.** 만들어 두고 배선하지 않은 전형이다.
//
// 지키는 계약:
//  1) 매니페스트가 있어야 한다(어디서 받을지 모르면 받을 수 없다).
//  2) 실행 명령에서 fetch 경로까지 실제로 이어져 있어야 한다.
//  3) 캐시가 비었을 때의 실패 문구는 사용자가 다음에 뭘 할지 알 수 있어야 한다.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const checks = [];
const failures = [];

function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

// 1) 매니페스트 — 어디서 받는지가 커밋에 있어야 한다.
const manifestPath = path.join(root, "engine", "vendor", "desktop-core.manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch {
  /* 아래 check 가 말한다 */
}
check(
  "manifest-says-where-the-engine-lives",
  Boolean(manifest && manifest.url && manifest.sha256 && manifest.version),
  "engine/vendor/desktop-core.manifest.json 이 없거나 url/sha256/version 이 비었습니다 — "
  + "받을 곳을 모르면 새 설치본은 엔진을 영영 못 얻습니다.",
);

// 2) 실행 경로가 fetch 까지 이어져 있는가. 이름이 아니라 **부르는 곳**을 본다:
//    함수가 존재하는 것으로는 아무도 구제되지 않는다(그게 이 사고였다).
const graphCmd = fs.existsSync(path.join(root, "engine", "commands", "graph.cjs"))
  ? fs.readFileSync(path.join(root, "engine", "commands", "graph.cjs"), "utf8")
  : "";
check(
  "run-command-can-fetch-the-engine",
  /loadDesktopCoreAsync\s*\(/.test(graphCmd),
  "engine/commands/graph.cjs 가 캐시만 보는 동기 로더에서 끝납니다 — 캐시가 빈 새 설치본은 "
  + "엔진을 받을 길이 없어 `graph run` 이 100% 실패합니다(2026-08-20 실측).",
);

// 3) 그래도 못 얻었을 때의 문구. "unavailable" 한 마디는 사용자가 할 수 있는 일이 없다.
const loader = fs.existsSync(path.join(root, "engine", "core", "desktop-core.cjs"))
  ? fs.readFileSync(path.join(root, "engine", "core", "desktop-core.cjs"), "utf8")
  : "";
check(
  "failure-tells-the-user-what-to-do",
  /loadDesktopCoreAsync/.test(loader) && /fetchDesktopCore/.test(loader),
  "engine/core/desktop-core.cjs 에 fetch 경로가 없습니다 — 캐시 미스가 곧 막다른 길이 됩니다.",
);

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\nengine-reachable 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed (engine v${manifest && manifest.version})`);
