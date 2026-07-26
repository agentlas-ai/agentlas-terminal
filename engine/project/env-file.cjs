"use strict";
/*
 * project/env-file — .env 계열 파일 읽기/한 줄 갱신 헬퍼.
 *
 * readDotEnvFile은 commands/env.cjs에서 이관했다 (명령 파일끼리 import 금지 규칙
 * 때문에 creds 명령이 공유하려면 기능 모듈로 내려와야 한다).
 * upsertEnvLine은 v1 monolith 11226–11238 포팅.
 */
const fs = require("node:fs");
const path = require("node:path");

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

function upsertEnvLine(file, key, value) {
  let body = "";
  try { body = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const line = `${key}=${value}`;
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
  if (re.test(body)) body = body.replace(re, line);
  else body = body ? body.replace(/\n?$/, "\n") + line + "\n" : line + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 이 헬퍼의 모든 호출자는 credential 값/경로를 기록한다. 새 파일뿐 아니라 기존 0644
  // 파일도 매번 0600으로 수렴시켜 같은 머신의 다른 계정이 읽지 못하게 한다.
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/읽기전용 FS best-effort */ }
}

module.exports = { readDotEnvFile, upsertEnvLine };
