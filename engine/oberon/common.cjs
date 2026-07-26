"use strict";
/*
 * oberon/common — Oberon 필름 스튜디오 공용 유틸.
 * v1 모놀리스(engine/agentlas.cjs, legacy-v1-engine-snapshot §12213-12580)의
 * oberonParseFlags / oberonBar / oberonBytes / slugifyOberon 충실 포팅.
 *
 * v2 규칙: v1의 fail()은 process.exit(1)로 즉사했지만, v2 명령은 exit code를
 * 반환해야 한다. 그래서 사용자-레벨 실패는 OberonFail throw → 명령 래퍼가
 * "✖ <msg>" + return 1 로 변환한다 (v1 fail의 "✖ " 접두 계약 유지).
 */

class OberonFail extends Error {
  constructor(message, code) {
    super(message);
    this.oberonFail = true;
    if (code) this.code = code;
  }
}

function fail(msg, code) {
  throw new OberonFail(String(msg ?? ""), code);
}

// v1 oberonParseFlags 그대로: `--key value` / `--key`(불리언) / 나머지는 위치 인자.
// 다음 토큰이 `--`로 시작하면 값이 아니라 다른 플래그로 본다.
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

// 20-셀 진행률 바 (v1 oberonBar)
function oberonBar(pct) {
  const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
}

// 사람이 읽는 바이트 표기 (v1 oberonBytes)
function oberonBytes(n) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + "MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + "KB";
  return n + "B";
}

// 딜리버리 폴더 이름용 슬러그 (v1 slugifyOberon).
// 한국어 제목이 흔해서 가-힣을 보존한다 — ASCII만 남기면 폴더명이 전부 "_"가 된다.
function slugifyOberon(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[^\w가-힣-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .slice(0, 48) || "oberon"
  );
}

module.exports = { OberonFail, fail, parseFlags, oberonBar, oberonBytes, slugifyOberon };
