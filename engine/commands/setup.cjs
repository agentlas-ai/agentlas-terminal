"use strict";
/*
 * setup — 첫 실행 마법사 재실행 (언어 → 기본 런타임 → 기본 권한).
 * 결과는 cli-prefs.json에 저장된다. REPL은 onboarded가 아니면 이 마법사를 먼저 연다.
 */
const readline = require("node:readline");
const { runOnboard } = require("../agentlas-onboard.cjs");
const { updatePrefs } = require("../agentlas-config.cjs");
const { userDataDir } = require("../core/paths.cjs");
const { RUNTIME_BIN, whichSync } = require("../runtimes/detect.cjs");

async function runWizard(ctx, rl) {
  const result = await runOnboard({
    ui: ctx.uiInstance,
    rl,
    helpers: { RUNTIME_BIN, which: whichSync },
  });
  if (result && result.onboarded) {
    updatePrefs(userDataDir(), {
      onboarded: true,
      ...(result.lang ? { language: result.lang } : {}),
      ...(result.runtime ? { runtime: result.runtime } : {}),
      ...(result.permission ? { permission: result.permission } : {}),
    });
  }
  return result;
}

async function run(ctx) {
  if (!process.stdin.isTTY) {
    // 비-TTY에서 마법사를 돌리면 EOF로 이벤트 루프가 비어 exit 0으로 "조용히 성공"
    // 하는 함정이 있다 — 정직하게 거부한다.
    ctx.err(ctx.lang === "ko" ? "setup은 대화형 터미널에서만 실행됩니다." : "setup requires an interactive terminal.");
    return 1;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runWizard(ctx, rl);
    return result && result.onboarded ? 0 : 1;
  } finally {
    rl.close();
  }
}

module.exports = { run, runWizard };
