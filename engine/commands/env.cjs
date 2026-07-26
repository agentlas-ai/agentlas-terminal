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
const fs = require("node:fs");
const { userDataDir } = require("../core/paths.cjs");

/** .env 파싱 — 값 보존 없이 키만 필요할 때도 같은 파서를 쓴다 (KEY=VALUE, # 주석). */
function readDotEnvFile(file) {
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) result[key] = trimmed.slice(eq + 1);
  }
  return result;
}

function sharedEnvKeys() {
  const fromFiles = {
    ...readDotEnvFile(path.join(userDataDir(), "credentials.env")),
    ...readDotEnvFile(path.join(os.homedir(), ".agentlas", "credentials.env")),
  };
  return Object.keys(fromFiles).sort();
}

function run(ctx) {
  const keys = sharedEnvKeys();
  ctx.out(`Shared env keys: ${keys.length} (values hidden; from credentials.env):`);
  for (const k of keys) ctx.out(`  ${k}`);
  ctx.out("");
  ctx.out(ctx.ui.dim("Keychain entries are available in Desktop settings → Credentials."));
  return 0;
}

module.exports = { run, readDotEnvFile, sharedEnvKeys };
