"use strict";
/*
 * runtimes/auth-evidence — CLI 런타임의 "로그인 흔적" 관측.
 *
 * 배경(2026-08-05 감사, 결함 B): doctor의 런타임 검사는 which(bin) 하나였다.
 * codex가 로그아웃 상태여도 "✓ runtimes … ✓ active runtime — codex" +
 * "doctor: all clear"가 나갔고, 사용자는 첫 실행이 죽을 때까지 몰랐다.
 * 설치 여부와 인증 여부는 다른 축이다.
 *
 * 계약 — 증거이지 증명이 아니다:
 *  - 여기서는 각 CLI가 로그인 시 남기는 로컬 산출물(파일·키체인 항목·환경 변수)의
 *    존재만 관측한다. 모델 호출·네트워크 왕복 없음. 파일 내용도 읽지 않는다
 *    (토큰 만료까지는 판정하지 않는다 — 그건 실행이 판정한다).
 *  - 산출물이 있어도 만료됐을 수 있으므로 "로그인됨"이라고 단정하지 않는다.
 *    산출물이 없으면 "흔적 없음 — 로그인이 필요할 수 있음"까지만 말한다.
 *  - 검사법을 모르는 런타임은 unknown — 모르는 것을 없다고 말하지 않는다.
 *
 * 반환: { status: "evidence" | "none" | "unknown", detail: string }
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const home = () => os.homedir();
const MAX_AUTH_EVIDENCE_BYTES = 256 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function fileEvidence(rel, label) {
  const p = path.join(home(), ...rel);
  let fd = null;
  try {
    const before = fs.lstatSync(p);
    if (
      before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
      before.size <= 0 || before.size > MAX_AUTH_EVIDENCE_BYTES
    ) return null;
    fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW);
    const after = fs.fstatSync(fd);
    if (
      after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 ||
      after.size <= 0 || after.size > MAX_AUTH_EVIDENCE_BYTES ||
      after.dev !== before.dev || after.ino !== before.ino
    ) return null;
    return { status: "evidence", detail: label || p };
  } catch { /* unreadable == no evidence */ }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function envEvidence(names) {
  for (const name of names) {
    if (typeof process.env[name] === "string" && process.env[name].trim()) {
      return { status: "evidence", detail: `env ${name}` };
    }
  }
  return null;
}

/** macOS 키체인 generic password 존재 확인 — 값은 읽지 않는다(-w 금지). */
function keychainEvidence(service, label) {
  if (process.platform !== "darwin") return null;
  try {
    const res = spawnSync("security", ["find-generic-password", "-s", service], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    if (res.status === 0) return { status: "evidence", detail: label || `keychain ${service}` };
  } catch { /* security unavailable == no evidence */ }
  return null;
}

const CHECKS = {
  "claude-code": () =>
    envEvidence(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])
    || keychainEvidence("Claude Code-credentials", "keychain")
    || fileEvidence([".claude", ".credentials.json"], "~/.claude/.credentials.json"),
  codex: () =>
    fileEvidence([".codex", "auth.json"], "~/.codex/auth.json")
    || envEvidence(["OPENAI_API_KEY"]),
  gemini: () =>
    fileEvidence([".gemini", "oauth_creds.json"], "~/.gemini/oauth_creds.json")
    || envEvidence(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
};

// Antigravity and legacy Gemini use the same Google local OAuth evidence on
// this host. Keep the product/runtime identity distinct while reusing the
// evidence probe; an unknown agy result would make doctor contradict the
// actual executable path and would block runtime-independent selection.
CHECKS.agy = CHECKS.gemini;

function runtimeAuthEvidence(kind) {
  const check = CHECKS[kind];
  if (!check) return { status: "unknown", detail: "no local evidence check for this runtime" };
  const found = check();
  if (found) return found;
  return { status: "none", detail: "" };
}

module.exports = { runtimeAuthEvidence };
