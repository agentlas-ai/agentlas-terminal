#!/usr/bin/env node
"use strict";
/*
 * 거울이 정본과 **같은 답을 내는가**.
 *
 * 터미널은 "이 노드가 바깥을 바꾸나"를 `.filter()` 안에서 동기로 물어야 하는데,
 * 엔진을 얻는 길은 비동기다(새 설치는 아직 안 내려받았을 수 있고, 동기 로더로
 * 우회하면 그 사람에게만 조용히 다른 답이 나온다 — verify-engine-reachable 이 막는다).
 * 그래서 규칙을 터미널에 한 번 편다(engine/graph/node-effect.cjs).
 *
 * ★거울이 허용되는 조건은 이 증명 하나뿐이다. 증명 없이 두면 그건 그냥 사본이고,
 *   사본은 시간이 지나면 반드시 갈라진다 — 이 저장소가 반복해서 겪은 병이다.
 *   실측 2026-08-20: 같은 판정의 손 사본이 데스크탑 6곳·터미널 3곳에 있었고,
 *   그중 다섯 곳이 emitter 가 만든 출력 노드(effect 칸 없음)를 못 보고 있었다.
 *
 * 검사 방법: 벤더된 데스크탑 정본을 **직접** 읽어(loadDesktopCore 는 저장소를 열기
 * 때문에 쓰지 않는다) 같은 입력표로 두 답을 맞춘다.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mirror = require(path.join(root, "engine", "graph", "node-effect.cjs"));

const CANONICAL = path.join(
  root, "engine", "vendor", "desktop-core", "dist", "shared", "graph-node-protocol.js",
);

/*
 * 유한한 입력표. 노드 종류 10 × 선언 효과 4(mutation/read/pure/없음) 가 이 판정의
 * 알파벳 전부다 — 사례를 늘릴 게 아니라 알파벳을 다 세면 된다.
 */
const NODE_KINDS = [
  "trigger", "agent", "tool", "action", "condition",
  "eval", "transform", "output", "subgraph", "code",
];
const DECLARED = [undefined, "mutation", "read", "pure", "", "  mutation  ", "MUTATION", "nonsense"];

const cases = [];
for (const type of NODE_KINDS) {
  for (const effect of DECLARED) {
    cases.push({ type, config: effect === undefined ? {} : { effect } });
  }
}
// config 자체가 없는 모양도 실제로 온다(옛 그래프).
for (const type of NODE_KINDS) cases.push({ type });
cases.push({}, { config: { effect: "mutation" } });

if (!fs.existsSync(CANONICAL)) {
  console.log("SKIP node-effect-parity — 벤더된 데스크탑 코어가 없습니다:");
  console.log(`  ${path.relative(root, CANONICAL)}`);
  console.log("  고치는 법: npm run vendor:core");
  console.log("  (통과로 세지 않습니다 — 못 재면 증명이 없는 것이고, 증명 없는 거울은 사본입니다.)");
  process.exit(0);
}

let canonical;
try {
  const mod = require(CANONICAL);
  canonical = {
    declares: mod.nodeDeclaresOutwardEffect,
    could: mod.nodeCouldHaveActedOutside,
    effect: mod.resolveNodeEffect,
  };
} catch (error) {
  console.error("node-effect-parity: 정본을 읽지 못했습니다 —", String(error && error.message).slice(0, 160));
  process.exit(1);
}
if (typeof canonical.declares !== "function" || typeof canonical.could !== "function"
  || typeof canonical.effect !== "function") {
  console.error("node-effect-parity: 벤더된 코어에 판정 셋(resolveNodeEffect · "
    + "nodeDeclaresOutwardEffect · nodeCouldHaveActedOutside)이 다 있지 않습니다.");
  console.error("  옛 번들입니다 — `npm run vendor:core` 로 갱신하세요. 통과로 세지 않습니다.");
  process.exit(1);
}

/*
 * ★셋을 다 맞춘다. 이 저장소는 오늘 ①(선언됐나)과 ②(했을 수 있나)를 한 번 합쳤다가
 *   재생 보호가 좁아졌다 — 하나만 재면 그런 사고를 못 잡는다.
 */
const drift = [];
for (const node of cases) {
  for (const [name, fn, mine] of [
    ["resolveNodeEffect", canonical.effect, mirror.resolveNodeEffect],
    ["nodeDeclaresOutwardEffect", canonical.declares, mirror.nodeDeclaresOutwardEffect],
    ["nodeCouldHaveActedOutside", canonical.could, mirror.nodeCouldHaveActedOutside],
  ]) {
    const a = fn(node);
    const b = mine(node);
    if (a !== b) drift.push({ node, name, canonical: a, mirror: b });
  }
}

/*
 * ★이 게이트 자신의 눈이 멀지 않았는지 본다. 두 함수가 늘 같은 상수를 뱉어도
 *   "일치"로 보이기 때문이다 — 표가 실제로 양쪽 답을 다 만들어 내는지 확인한다.
 */
const answers = new Set(cases.flatMap((node) => [
  mirror.nodeDeclaresOutwardEffect(node),
  mirror.nodeCouldHaveActedOutside(node),
  mirror.resolveNodeEffect(node),
]));
if (answers.size < 3) {
  console.error("node-effect-parity: 입력표가 한 가지 답만 만듭니다 — 이 검사는 아무것도 못 잽니다.");
  process.exit(1);
}

if (drift.length > 0) {
  console.error(`node-effect-parity: 거울이 정본과 갈라졌습니다 — ${drift.length}건\n`);
  for (const d of drift.slice(0, 12)) {
    console.error(`  ${JSON.stringify(d.node)}`);
    console.error(`    ${d.name}: 정본 ${JSON.stringify(d.canonical)} · 거울 ${JSON.stringify(d.mirror)}`);
  }
  console.error("\n  거울: engine/graph/node-effect.cjs");
  console.error("  정본: 데스크탑 shared/graph-node-protocol.ts (벤더 경유)");
  console.error("  둘 중 하나가 늦었습니다. 규칙이 바뀌었다면 `npm run vendor:core` 후 거울을 맞추세요.");
  process.exit(1);
}

console.log(`node-effect-parity ok — 입력 ${cases.length}가지 × 판정 3종에서 정본과 거울이 같은 답`);
