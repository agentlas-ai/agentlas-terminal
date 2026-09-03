"use strict";
/*
 * browser/vault — 터미널 독립 브라우저 볼트 (2026-08-06).
 *
 * 배경(오너: "조종을 다른 흐름으로 확장"): 데스크탑 electron/store/browser-vault.ts 는
 * 사이트별 전용-프로필 로그인/세션 상태를 관리한다(사이트 카드 · 세션 valid/expired/none ·
 * 권한 · 행동 로그). 저장 테이블(browser_sites/browser_sessions/…)은 이미 터미널 부트스트랩
 * 스키마에 있어 **데스크탑과 그대로 공유**된다. 그 핵심 CRUD 만 이식한다.
 *
 * 보안(데스크탑과 동일): 사이트 비밀번호를 받거나 자동 입력하지 않는다. 로그인은 제공자
 * 페이지에서 사용자가 직접 하고, 터미널은 페이지를 열어 주고(조종) 세션 상태만 기록한다.
 * has_password 는 항상 0 — CLI 로는 어떤 자격증명도 볼트에 들어가지 않는다.
 */
const crypto = require("node:crypto");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");

const REDACTED_USERINFO_URL = "[redacted-userinfo-url]";

function nowIso() { return new Date().toISOString(); }

function parseHttpUrl(input, allowBareHost) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    if (!hasScheme && !allowBareHost) return null;
    const parsed = new URL(hasScheme ? raw : `https://${raw}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch { return null; }
}

/** Detect URL credentials without returning or logging the credential-bearing value. */
function siteHasUrlUserinfo(input) {
  const raw = String(input || "");
  const parsed = parseHttpUrl(raw, true);
  if (parsed && (parsed.username || parsed.password)) return true;
  // Also fail closed for malformed legacy URLs that visibly place an '@'
  // inside an explicit HTTP(S) authority.
  return /https?:\/\/[^\s/?#]*@[^\s/?#]+/iu.test(raw);
}

/** Audit targets are free-form, so only explicit HTTP(S) URL userinfo is redacted. */
function targetHasUrlUserinfo(input) {
  return /https?:\/\/[^\s/?#]*@[^\s/?#]+/iu.test(String(input || ""));
}

function safeAuditTarget(input) {
  if (input === undefined || input === null) return null;
  return targetHasUrlUserinfo(input) ? REDACTED_USERINFO_URL : input;
}

/** 입력을 host 로 정규화한다(데스크탑 normalizeSite 와 같은 규칙 — userinfo 는 거부). */
function normalizeSite(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.username || u.password) return ""; // 자격증명은 사이트 키에 절대 들이지 않는다
  const host = u.host.toLowerCase().replace(/^www\./, "");
  return host && !/\s/.test(host) ? host : "";
}

function listBrowserSites(db) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT s.id, s.site, s.label, s.username, s.created_at, s.updated_at,
              se.status AS sess_status, se.captured_at AS sess_captured
       FROM browser_sites s
       LEFT JOIN browser_sessions se ON se.site = s.site
       ORDER BY s.updated_at DESC`,
    ).all();
  } catch { return []; }
  return rows
    .filter((r) => !siteHasUrlUserinfo(String(r.site)))
    .map((r) => ({
      id: String(r.id),
      site: String(r.site),
      label: r.label ?? null,
      username: r.username ?? null,
      session: { status: r.sess_status ?? "none", capturedAt: r.sess_captured ?? null },
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
}

function getBrowserSite(db, site) {
  const norm = normalizeSite(site);
  return listBrowserSites(db).find((s) => s.site === norm) || null;
}

/** 사이트 카드를 만들거나 갱신한다(비밀번호 없음 — has_password 항상 0). */
function upsertBrowserSite(db, input) {
  const site = normalizeSite(input.site);
  if (!site) throw new Error("site address is empty or malformed");
  const now = nowIso();
  runWriteTransaction(db, () => {
    const existing = db.prepare("SELECT id FROM browser_sites WHERE site = ?").get(site);
    if (existing) {
      db.prepare(
        "UPDATE browser_sites SET label = COALESCE(?, label), username = COALESCE(?, username), updated_at = ? WHERE site = ?",
      ).run(input.label ?? null, input.username ?? null, now, site);
    } else {
      db.prepare(
        "INSERT INTO browser_sites (id, site, label, username, has_password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run(crypto.randomUUID(), site, input.label ?? null, input.username ?? null, 0, now, now);
      db.prepare(
        "INSERT OR IGNORE INTO browser_sessions (id, site, status, captured_at) VALUES (?, ?, 'none', NULL)",
      ).run(crypto.randomUUID(), site);
    }
  });
  return getBrowserSite(db, site);
}

function deleteBrowserSite(db, site) {
  const norm = normalizeSite(site) || String(site || "").trim();
  runWriteTransaction(db, () => {
    db.prepare("DELETE FROM browser_sessions WHERE site = ?").run(norm);
    db.prepare("DELETE FROM browser_permissions WHERE site = ?").run(norm);
    db.prepare("DELETE FROM browser_sites WHERE site = ?").run(norm);
  });
  return { ok: true };
}

/** 세션 상태를 기록한다(valid 면 captured_at 을 지금으로, 아니면 비운다). 데스크탑과 동일. */
function setBrowserSession(db, site, status) {
  const norm = normalizeSite(site);
  if (!norm) throw new Error("site address is empty or malformed");
  if (status !== "valid" && status !== "expired" && status !== "none") {
    throw new Error(`status must be valid | expired | none, got ${status}`);
  }
  const captured = status === "valid" ? nowIso() : null;
  runWriteTransaction(db, () => {
    const existing = db.prepare("SELECT id FROM browser_sessions WHERE site = ?").get(norm);
    if (existing) {
      db.prepare("UPDATE browser_sessions SET status = ?, captured_at = ? WHERE site = ?").run(status, captured, norm);
    } else {
      db.prepare("INSERT INTO browser_sessions (id, site, status, captured_at) VALUES (?,?,?,?)")
        .run(crypto.randomUUID(), norm, status, captured);
    }
  });
  return getBrowserSite(db, norm);
}

/** 되돌릴 수 없는/외부로 나가는 행동을 날짜 로그에 남긴다(데스크탑과 같은 테이블). */
function logBrowserAction(db, { site = null, action, target = null, result = null, approval = null, meta = null } = {}) {
  try {
    const normalizedSite = site ? normalizeSite(site) : "";
    runWriteTransaction(db, () => {
      db.prepare(
        "INSERT INTO browser_action_logs (id, ts, site, action, target, result, approval, meta) VALUES (?,?,?,?,?,?,?,?)",
      ).run(crypto.randomUUID(), nowIso(), normalizedSite || null, action, safeAuditTarget(target), result, approval, meta ? JSON.stringify(meta) : null);
    });
  } catch { /* 로그 실패는 치명적이지 않다 */ }
}

module.exports = {
  normalizeSite, listBrowserSites, getBrowserSite,
  upsertBrowserSite, deleteBrowserSite, setBrowserSession, logBrowserAction,
};
