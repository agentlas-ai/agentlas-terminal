#!/usr/bin/env node
/*
 * scripts/vendor-tui — 셸 렌더러 소스를 engine/vendor/ 로 내재화한다.
 *
 * 왜: npm 의존성은 정확 핀 + 무결성 해시로 버전 드리프트·변조는 막지만,
 * 레지스트리에서 그 버전이 삭제되면 설치가 실패한다. 소스를 우리 저장소에
 * 두면 그 마지막 위험이 사라지고, 우리가 언제든 고칠 수 있다.
 * (선례: engine/vendor/desktop-core — 같은 방식으로 12MB를 이미 내재화 중)
 *
 * 라이선스: MIT / Apache-2.0 는 소스 복사·수정·재배포를 허용한다. 단 저작권
 * 고지 보존이 조건이므로 각 벤더 폴더에 LICENSE 를 함께 둔다. 이 스크립트는
 * 고지가 없으면 실패한다 — 고지 없는 벤더링은 라이선스 위반이다.
 *
 * 사용: node scripts/vendor-tui.mjs        (node_modules 에서 복사)
 *      node scripts/vendor-tui.mjs --check (동기화 여부만 검사, CI/게이트용)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => path.join(root, "node_modules", p);
const out = (p) => path.join(root, "engine", "vendor", p);
const checkOnly = process.argv.includes("--check");

/*
 * 각 항목: npm 패키지 → 벤더 경로. `strip` 은 복사에서 제외할 접미사.
 * bare import 는 relative 로 바꾼다 — 벤더 트리는 node_modules 해석에
 * 의존하지 않아야 "의존성 0"이 진짜가 된다.
 */
const PLAN = [
  {
    pkg: "@earendil-works/pi-tui", from: "dist", to: "tui",
    license: { text: MIT_PI(), file: "LICENSE" },
    rewrite: [
      [/from "marked"/g, (depth) => `from "${up(depth)}deps/marked/index.js"`],
      [/from "get-east-asian-width"/g, (depth) => `from "${up(depth)}deps/east-asian-width/index.js"`],
    ],
  },
  { pkg: "marked", from: "lib", to: "tui/deps/marked", only: ["marked.esm.js"], rename: { "marked.esm.js": "index.js" }, license: { copyFrom: "LICENSE" } },
  // 파일 목록을 손으로 적지 않는다 — 한 번 빠뜨렸더니(utilities.js) 로드가 깨졌다.
  { pkg: "get-east-asian-width", from: ".", to: "tui/deps/east-asian-width", license: { copyFrom: "license" } },
  { pkg: "grok-mermaid", from: "dist", to: "mermaid", license: { copyFrom: "LICENSE" } },
];

/*
 * 벤더 트리는 ESM 이고 이 저장소는 CJS 다. 저장소 전체를 type:module 로 돌릴 수는
 * 없으므로(엔진 178개가 .cjs) 벤더 폴더에만 경계 package.json 을 둔다.
 * 없으면 Node 가 매 로드마다 MODULE_TYPELESS_PACKAGE_JSON 경고를 낸다.
 */
const ESM_BOUNDARY = ["tui", "mermaid"];

function up(depth) { return depth === 0 ? "./" : "../".repeat(depth); }

function MIT_PI() {
  return `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE CONNECTION WITH THE SOFTWARE.
`;
}

/*
 * 라이선스는 아래 명시 경로(LICENSE)로만 쓴다. 원본이 소문자 `license` 인 패키지가
 * 있는데(get-east-asian-width), 그걸 같이 복사하면 macOS 는 대소문자를 무시해
 * 한 파일로 합쳐지고 Linux CI 에서는 두 파일이 된다 — 플랫폼마다 산출물이 달라진다.
 */
const SKIP = [".map", ".d.ts", ".d.mts", ".ts", "package.json", "readme.md", "README.md", ".umd.js"];
const LICENSE_NAMES = new Set(["license", "LICENSE", "LICENSE.md", "license.md", "NOTICE"]);
const collected = [];

function walk(dir, base = dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) entries.push(...walk(full, base));
    else if (!SKIP.some((s) => name.endsWith(s)) && !LICENSE_NAMES.has(name)) entries.push(path.relative(base, full));
  }
  return entries;
}

for (const item of PLAN) {
  const src = path.join(nm(item.pkg), item.from);
  if (!fs.existsSync(src)) {
    console.error(`missing source: ${src} — run npm install first`);
    process.exit(1);
  }
  const files = item.only || walk(src);
  for (const rel of files) {
    const target = item.rename?.[rel] || rel;
    const dest = path.join(out(item.to), target);
    let text = fs.readFileSync(path.join(src, rel), "utf8");
    if (item.rewrite) {
      const depth = target.split(path.sep).length - 1;
      for (const [pattern, make] of item.rewrite) text = text.replace(pattern, make(depth));
    }
    collected.push({ dest, text });
  }
  // 라이선스 고지 — 없으면 벤더링 자체를 중단한다.
  const licenseDest = path.join(out(item.to), "LICENSE");
  if (item.license.copyFrom) {
    const lic = path.join(nm(item.pkg), item.license.copyFrom);
    if (!fs.existsSync(lic)) { console.error(`missing license for ${item.pkg}`); process.exit(1); }
    collected.push({ dest: licenseDest, text: fs.readFileSync(lic, "utf8") });
  } else {
    collected.push({ dest: licenseDest, text: item.license.text });
  }
}

for (const dir of ESM_BOUNDARY) {
  collected.push({ dest: path.join(out(dir), "package.json"), text: `{ "type": "module" }\n` });
}

if (checkOnly) {
  const drift = collected.filter((f) => !fs.existsSync(f.dest) || fs.readFileSync(f.dest, "utf8") !== f.text);
  if (drift.length) {
    console.error(`FAIL vendor-tui: ${drift.length} file(s) differ from node_modules`);
    for (const f of drift.slice(0, 8)) console.error("  - " + path.relative(root, f.dest));
    console.error("  run: node scripts/vendor-tui.mjs");
    process.exit(1);
  }
  console.log(`PASS vendor-tui (${collected.length} files match)`);
  process.exit(0);
}

for (const f of collected) {
  fs.mkdirSync(path.dirname(f.dest), { recursive: true });
  fs.writeFileSync(f.dest, f.text, "utf8");
}
console.log(`vendored ${collected.length} files into engine/vendor/{tui,mermaid}`);
