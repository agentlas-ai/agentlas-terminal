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
    helpers: { RUNTIME: RUNTIME_BIN, which: whichSync },
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runWizard(ctx, rl);
    return result && result.onboarded ? 0 : 1;
  } finally {
    rl.close();
  }
}

module.exports = { run, runWizard };
