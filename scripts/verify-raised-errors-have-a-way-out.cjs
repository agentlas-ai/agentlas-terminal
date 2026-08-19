#!/usr/bin/env node
// 내는 오류에는 **푸는 길**이 있어야 한다.
//
// 배경(2026-08-20 실측). 터미널이 실행한 그래프가 이렇게 멈췄다:
//
//   automation_partial_reconciliation_required: a legacy partial occurrence has
//   committed nodes but no resumable output receipt.
//
// 이 상태를 푸는 것은 재조정(store/graph-reconciliation)인데, 그 모듈이 **벤더 코어에
// 아예 실리지 않았다.** 벤더링이 run-graph 한 곳에서만 정적 도달 가능한 것을 담았고,
// 재조정은 데스크탑 UI 에서만 닿는 자리였기 때문이다. 그래서 터미널은 그 오류를
// **낼 수는 있는데 풀 수단이 없는** 상태였다 — CLI 만 쓰는 사람은 그 자동화를 영원히
// 못 돌린다. 실행할 때마다 같은 문장을 듣고, 할 수 있는 일이 없다.
//
// 이 게이트가 지키는 것:
//  1) 재조정 모듈이 벤더 코어에 실린다.
//  2) 코어 표면이 그것을 내놓는다(실려 있어도 표면에 없으면 아무도 못 쓴다).
//  3) CLI 에 그 결정을 내리는 명령이 있다.
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

const vendored = path.join(root, "engine", "vendor", "desktop-core", "dist", "electron", "store", "graph-reconciliation.js");
check(
  "the-way-out-ships-with-the-engine",
  fs.existsSync(vendored),
  "재조정 모듈이 벤더 코어에 없습니다 — 터미널은 `automation_partial_reconciliation_required` 를 "
  + "낼 수는 있는데 풀 수단이 없습니다. scripts/vendor-desktop-core.cjs 의 진입점에 추가하세요.",
);

const surface = fs.readFileSync(path.join(root, "engine", "core", "desktop-core.cjs"), "utf8");
check(
  "the-core-surface-exposes-it",
  /graphReconciliation\s*:/.test(surface),
  "코어 표면에 graphReconciliation 이 없습니다 — 모듈이 실려 있어도 아무도 부를 수 없습니다.",
);

const graphCmd = fs.readFileSync(path.join(root, "engine", "commands", "graph.cjs"), "utf8");
check(
  "the-cli-can-make-the-decision",
  /sub === "reconcile"/.test(graphCmd) && /graphReconciliation/.test(graphCmd),
  "`agentlas graph reconcile` 이 없습니다 — 사람이 판단할 자리가 없으면 그 자동화는 막힌 채로 끝납니다.",
);

// 값을 받는 깃발은 반드시 파서에서 걷어내야 한다. 안 그러면 그 값이 그래프 이름에 붙어
// "맞는 그래프가 없다"는 엉뚱한 실패가 된다 — 이 저장소에서 --name 으로 이미 한 번 났고,
// 새 깃발 셋(--done/--not-done/--output)에서 그대로 재현됐다(실측 2026-08-20).
for (const flag of ["--done", "--not-done", "--output"]) {
  check(
    `value-flag-${flag.replace(/^--/, "")}-is-stripped-from-the-name`,
    graphCmd.includes(`"${flag}"`),
    `${flag} 이(가) 인자 파서에서 걷어지지 않습니다 — 그 값이 그래프 이름에 붙어 엉뚱한 실패가 됩니다.`,
  );
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\nway-out 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
