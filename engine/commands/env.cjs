"use strict";
/*
 * env — 공유 env 키 열거 (값은 절대 출력하지 않음).
 *
 * standalone(비-Electron)에서는 keytar를 건드리지 않는다: 서명 안 된 Node에서
 * keytar.findCredentials가 macOS 키체인에 막히면 무한 대기하고 process.exit로도
 * 안 죽는다(v1 실사고). credentials.env 파일 기반 열거만 수행한다.
 */
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
// readDotEnvFile 본체는 engine/project/env-file.cjs 로 이관 (creds 명령과 공유 —
// 명령 파일끼리 import 금지 규칙 때문에 기능 모듈로 내려갔다). 여기서는 re-export.
const { readDotEnvFile } = require("../project/env-file.cjs");

function sharedEnvKeys() {
  const fromFiles = {
    ...readDotEnvFile(path.join(userDataDir(), "credentials.env")),
    ...readDotEnvFile(path.join(os.homedir(), ".agentlas", "credentials.env")),
  };
  return Object.keys(fromFiles).sort();
}

function run(ctx, args = []) {
  if (args.length) {
    const error = new Error("usage: agentlas env");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const keys = sharedEnvKeys();
  ctx.out(`Shared env keys: ${keys.length} (values hidden; from credentials.env):`);
  for (const k of keys) ctx.out(`  ${k}`);
  ctx.out("");
  ctx.out(ctx.ui.dim("Keychain entries are available in Desktop settings → Credentials."));
  return 0;
}

module.exports = { run, readDotEnvFile, sharedEnvKeys };
