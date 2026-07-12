#!/usr/bin/env node
"use strict";
/*
 * bug-hunter(2026-07-12) 확정 결함 회귀 고정:
 *  1) node:sqlite 폴백 래퍼 API 패리티 — exec/pragma 누락으로 ensureMemoryContextColumn이
 *     조용히 죽어 context_json 마이그레이션이 안 되던 버그.
 *  2) 민감 상태 파일 원자적·0600 쓰기 — 크래시 중간쓰기 JSON 손상 + world-readable 노출.
 *  3) /install 중복 case — i18n 핸들러가 죽은 코드가 되던 버그(정적 검증).
 *  4) gemini 2턴+ 시스템 프롬프트 소실(정적 검증: resume 게이트).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const engine = require("../engine/agentlas.cjs");

// ── 1) node:sqlite 폴백 래퍼: exec/pragma 존재 + ensureMemoryContextColumn 실동작 ──
{
  const tmpDb = path.join(os.tmpdir(), `agentlas-wrap-${process.pid}.sqlite`);
  try { fs.unlinkSync(tmpDb); } catch { /* fresh */ }
  const db = engine.openNodeSqliteDb(tmpDb);
  assert.equal(typeof db.exec, "function", "폴백 래퍼에 exec가 있어야 함");
  assert.equal(typeof db.pragma, "function", "폴백 래퍼에 pragma가 있어야 함");

  // 앱 마이그레이션 전(context_json 없는) memory_entries를 만든 뒤 ensureMemoryContextColumn 실행
  db.exec("CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, kind TEXT, content TEXT)");
  engine.ensureMemoryContextColumn(db); // 예전 버그: db.exec undefined → TypeError를 try/catch가 삼킴
  const cols = db.prepare("PRAGMA table_info(memory_entries)").all().map((c) => c.name);
  assert.ok(cols.includes("context_json"), `context_json 컬럼이 추가돼야 함 — 실제: ${cols.join(",")}`);

  // pragma() 스칼라 근사 관례
  const uv = db.pragma("user_version");
  assert.ok(typeof uv === "number" || typeof uv === "bigint", `pragma 스칼라 반환 — 실제: ${typeof uv}`);
  db.close();
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
}

// ── 2) writeJsonPrivateAtomicCli: 유효 JSON + 0600 + 원자성(temp 잔여물 없음) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-priv-"));
  const target = path.join(dir, "cli-sessions.json");
  const value = [{ kind: "claude-code", sessionId: "s-123", cwd: "/x" }];
  engine.writeJsonPrivateAtomicCli(target, value);

  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), value, "쓴 JSON을 그대로 읽어야 함");
  if (process.platform !== "win32") {
    const mode = fs.statSync(target).mode & 0o777;
    assert.equal(mode, 0o600, `민감 파일은 0600 — 실제: 0o${mode.toString(8)}`);
  }
  // temp 잔여물이 남지 않아야 함
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.equal(leftovers.length, 0, `temp 잔여물 없어야 함 — 실제: ${leftovers.join(",")}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3) /install 중복 case 제거(정적) — handleSlash에 case "install"은 정확히 하나 ──
{
  const repl = fs.readFileSync(path.join(__dirname, "..", "engine", "agentlas-repl.cjs"), "utf8");
  const count = (repl.match(/case "install":/g) || []).length;
  assert.equal(count, 1, `case "install"은 하나여야 함(중복 시 i18n 핸들러가 죽은 코드) — 실제: ${count}`);
  // 살아남은 핸들러는 i18n 키를 쓴다(하드코딩 한국어 아님)
  assert.ok(/ui\.t\("installUsage"\)/.test(repl), "살아있는 install 핸들러는 installUsage i18n 키 사용");
}

// ── 4) gemini 시스템 프롬프트 유지(정적) — resume 게이트가 claude/codex로 한정 ──
{
  const repl = fs.readFileSync(path.join(__dirname, "..", "engine", "agentlas-repl.cjs"), "utf8");
  assert.ok(/resumesServerSide\s*=\s*rt\.kind\s*===\s*"claude-code"\s*\|\|\s*rt\.kind\s*===\s*"codex"/.test(repl),
    "resume 게이트는 claude-code/codex로 한정돼야 함(gemini는 매 턴 시스템 프롬프트 재전송)");
  assert.ok(/systemPrompt:\s*session\.id\s*&&\s*resumesServerSide\s*\?\s*""\s*:\s*sys/.test(repl),
    "gemini는 session.id가 있어도 시스템 프롬프트를 비우지 않아야 함");
}

console.log("engine-hardening-regression: PASS");
