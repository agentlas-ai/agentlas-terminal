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

// 타입 스키마가 있으면 알 수 없는/중복/값 누락 플래그를 fail-closed 한다.
// `--key=value`와 위치 인자용 `--` sentinel도 지원한다.
function parseFlags(args, schema = null) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--") {
      rest.push(...args.slice(i + 1).map(String));
      break;
    }
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const equals = a.indexOf("=");
    const key = a.slice(2, equals >= 0 ? equals : undefined);
    const inlineValue = equals >= 0 ? a.slice(equals + 1) : null;
    if (!key) fail("Oberon option name is empty");
    if (Object.prototype.hasOwnProperty.call(flags, key)) fail(`Duplicate Oberon option: --${key}`);
    const type = schema && schema[key];
    if (schema && !type) fail(`Unknown Oberon option: --${key}`);
    if (!schema) {
      const next = args[i + 1];
      if (inlineValue != null) flags[key] = inlineValue;
      else if (next === undefined || String(next).startsWith("--")) flags[key] = true;
      else { flags[key] = String(next); i += 1; }
      continue;
    }
    if (type === "boolean") {
      if (inlineValue != null) fail(`Boolean Oberon option does not take a value: --${key}`);
      flags[key] = true;
      continue;
    }
    if (type !== "value") fail(`Invalid Oberon option schema: --${key}`);
    if (inlineValue != null) {
      if (!inlineValue) fail(`Oberon option requires a value: --${key}`);
      flags[key] = inlineValue;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || String(next).startsWith("--")) fail(`Oberon option requires a value: --${key}`);
    flags[key] = String(next);
    i += 1;
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
