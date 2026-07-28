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
  // 저장을 마법사 "밖"에서 하면 이미 "완료" 문구가 찍힌 뒤다. 저장 함수를 넘겨
  // 성공 문구보다 먼저 쓰게 하고, updatePrefs가 던지는 실패를 그대로 올려보낸다
  // (예전엔 반환값을 버려서 잠금 경합·읽기전용 디렉터리에서도 exit 0으로 거짓말).
  return runOnboard({
    ui: ctx.uiInstance,
    rl,
    helpers: { RUNTIME_BIN, which: whichSync },
    persist: (choices) => updatePrefs(userDataDir(), {
      onboarded: true,
      ...(choices.lang ? { language: choices.lang } : {}),
      ...(choices.runtime ? { runtime: choices.runtime } : {}),
      ...(choices.permission ? { permission: choices.permission } : {}),
    }),
  });
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
    // 저장까지 성공해야 0 — 설정이 디스크에 없으면 사용자에겐 아무것도 안 한 것과 같다.
    return result && result.onboarded && result.saved ? 0 : 1;
  } finally {
    rl.close();
  }
}

module.exports = { run, runWizard };
