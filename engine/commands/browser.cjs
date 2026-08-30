"use strict";
/*
 * browser — 실제 브라우저 실행 하드포인트 + 사이트 로그인 볼트·조종 (2026-08-06 확장).
 *
 * 오너 원칙("조종을 다른 흐름으로 확장"): telegram 뿐 아니라 데스크탑의 브라우저-볼트
 * 흐름(사이트별 전용-프로필 로그인/세션)도 터미널에서 조종·공유되어야 한다. 저장 테이블은
 * 데스크탑과 공유(browser_sites/…)하고, 조종은 CDP(engine/browser/cdp.cjs)로 한다.
 *
 * 하위 명령(볼트·조종):
 *   browser status                브라우저(Chrome/CDP) 준비 상태 + 사이트 세션 요약
 *   browser sites                 저장된 사이트와 로그인 세션 상태(valid/expired/none)
 *   browser add <site> [--label L] [--user U]   사이트 카드 추가(비밀번호 없음)
 *   browser login <site>          그 사이트를 Agentlas 브라우저로 연다 — 로그인은 사용자가 직접
 *   browser mark <site> <valid|expired|none>    로그인 뒤 세션 상태를 기록
 *   browser go <url>              이미 열린 Agentlas 브라우저를 그 URL 로 몬다(조종)
 *   browser rm <site>             사이트 카드 삭제
 *
 * 그 외(무인자 포함, URL·검색어)는 v1 그대로 hep-browser 하드포인트로 넘겨 Chrome 을 띄운다.
 *
 * 보안(데스크탑과 동일): 비밀번호를 받지도, 자동 입력하지도 않는다. 로그인은 제공자 페이지에서
 * 사용자가 직접 한다 — 터미널은 페이지를 열어 주고 세션 상태만 기록한다.
 */
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");
const vault = require("../browser/vault.cjs");
const cdp = require("../browser/cdp.cjs");

const SUBS = new Set(["status", "sites", "add", "login", "mark", "go", "rm", "remove"]);

function browserArgumentError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function parseBrowserRest(rest, { values = [], positionals, usage }) {
  const allowedValues = new Set(values);
  const seen = new Set();
  const parsed = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    if (!token.startsWith("-")) {
      parsed._.push(token);
      continue;
    }
    if (!token.startsWith("--")) throw browserArgumentError(usage);
    const equal = token.indexOf("=");
    const key = token.slice(2, equal === -1 ? undefined : equal);
    if (!allowedValues.has(key) || seen.has(key)) throw browserArgumentError(usage);
    let value;
    if (equal !== -1) value = token.slice(equal + 1);
    else {
      value = rest[index + 1];
      if (value === undefined || String(value).startsWith("-")) throw browserArgumentError(usage);
      index += 1;
    }
    if (!String(value)) throw browserArgumentError(usage);
    seen.add(key);
    parsed[key] = String(value);
  }
  if (parsed._.length !== positionals) throw browserArgumentError(usage);
  return parsed;
}

function siteUrl(site) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`; }

function statusDot(ui, status) {
  if (status === "valid") return ui.green("●");
  if (status === "expired") return ui.yellow ? ui.yellow("●") : ui.dim("●");
  return ui.dim("○");
}

async function browserStatus(ctx) {
  const ko = ctx.lang === "ko";
  const ready = await cdp.cdpReady();
  ctx.out(`${ready ? ctx.ui.green("✓") : ctx.ui.dim("○")} ${ko ? "Agentlas 브라우저(CDP)" : "Agentlas browser (CDP)"}: ${ready ? (ko ? "실행 중 — 조종 가능" : "running — pilotable") : (ko ? "꺼짐" : "not running")} (port ${cdp.DEFAULT_PORT})`);
  const sites = vault.listBrowserSites(ctx.db());
  if (!sites.length) {
    ctx.out(ctx.ui.dim(ko ? "저장된 사이트 없음. 추가: agentlas browser add <site>" : "No saved sites. Add one: agentlas browser add <site>"));
    return 0;
  }
  const valid = sites.filter((s) => s.session.status === "valid").length;
  ctx.out(ctx.ui.dim(ko ? `사이트 ${sites.length}개 (로그인 유효 ${valid}개) — 목록: agentlas browser sites` : `${sites.length} sites (${valid} logged in) — list: agentlas browser sites`));
  return 0;
}

function browserSites(ctx) {
  const ko = ctx.lang === "ko";
  const sites = vault.listBrowserSites(ctx.db());
  if (!sites.length) {
    ctx.out(ctx.ui.dim(ko ? "저장된 사이트가 없습니다. 추가: agentlas browser add <site>" : "No saved sites yet. Add one: agentlas browser add <site>"));
    return 0;
  }
  for (const s of sites) {
    const when = s.session.capturedAt ? new Date(s.session.capturedAt).toLocaleDateString() : "";
    const label = s.label ? ` ${ctx.ui.dim(s.label)}` : "";
    const user = s.username ? ctx.ui.dim(` (${s.username})`) : "";
    ctx.out(`${statusDot(ctx.ui, s.session.status)} ${s.site}${label}${user}  ${ctx.ui.dim(`${s.session.status}${when ? " · " + when : ""}`)}`);
  }
  return 0;
}

function browserAdd(ctx, parsed) {
  const ko = ctx.lang === "ko";
  const site = parsed._[0];
  try {
    const row = vault.upsertBrowserSite(ctx.db(), { site, label: parsed.label || null, username: parsed.user || null });
    vault.logBrowserAction(ctx.db(), { site: row.site, action: "vault.save", result: "ok" });
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "사이트를 저장했습니다" : "site saved"}: ${row.site}`);
    ctx.out(ctx.ui.dim(ko ? `로그인: agentlas browser login ${row.site}` : `Log in: agentlas browser login ${row.site}`));
    return 0;
  } catch (e) { ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`); return 1; }
}

async function browserLogin(ctx, site) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  let row;
  try { row = vault.upsertBrowserSite(db, { site }); } catch (e) { ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`); return 1; }
  const url = siteUrl(row.site);

  if (await cdp.cdpReady()) {
    // 사용자의 현재 탭을 건드리지 않고 Agentlas 브라우저의 새 탭을 연다.
    // 로그인은 사용자가 직접 한다.
    try {
      const page = await cdp.attachPage({ selection: "new" });
      try { await page.navigate(url, { waitMs: 1500 }); } finally { page.close(); }
      vault.logBrowserAction(db, { site: row.site, action: "login.open", target: url, result: "navigated" });
      ctx.out(`${ctx.ui.green("✓")} ${ko ? "새 브라우저 탭을 로그인 페이지로 열었습니다" : "opened a new browser tab for login"}: ${url}`);
    } catch (e) {
      ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`);
      return 1;
    }
  } else {
    // CDP 미기동 — 조종할 대상이 없다. 먼저 브라우저를 띄우도록 정직하게 안내(자동 실행 안 함).
    ctx.out(ko
      ? `Agentlas 브라우저가 아직 실행 중이 아닙니다. 먼저 열어 주세요:\n  agentlas browser ${url}`
      : `The Agentlas browser is not running yet. Open it first:\n  agentlas browser ${url}`);
  }
  ctx.out(ctx.ui.dim(ko
    ? `그 창에서 직접 로그인한 뒤, 세션을 기록하세요:\n  agentlas browser mark ${row.site} valid`
    : `Log in yourself in that window, then record the session:\n  agentlas browser mark ${row.site} valid`));
  ctx.out(ctx.ui.dim(ko ? "비밀번호는 받지도, 자동 입력하지도 않습니다 — 로그인은 사용자만." : "No password is ever taken or auto-typed — you log in, not the tool."));
  return 0;
}

function browserMark(ctx, site, status) {
  const ko = ctx.lang === "ko";
  try {
    const row = vault.setBrowserSession(ctx.db(), site, status);
    vault.logBrowserAction(ctx.db(), { site: row.site, action: "session.mark", result: status });
    ctx.out(`${ctx.ui.green("✓")} ${row.site}: ${ko ? "세션 상태" : "session"} → ${status}`);
    return 0;
  } catch (e) { ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`); return 1; }
}

async function browserGo(ctx, url) {
  const ko = ctx.lang === "ko";
  if (!(await cdp.cdpReady())) {
    ctx.err(ko
      ? `Agentlas 브라우저가 실행 중이 아닙니다. 먼저 열어 주세요: agentlas browser ${siteUrl(url)}`
      : `The Agentlas browser is not running. Open it first: agentlas browser ${siteUrl(url)}`);
    return 1;
  }
  try {
    const page = await cdp.attachPage({ selection: "new" });
    let title;
    try { await page.navigate(siteUrl(url), { waitMs: 1500 }); title = await page.evalExpr("document.title"); } finally { page.close(); }
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "새 브라우저 탭에서 열었습니다" : "opened a new browser tab"}: ${siteUrl(url)}${title ? ctx.ui.dim(` — ${title}`) : ""}`);
    return 0;
  } catch (e) { ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`); return 1; }
}

function browserRemove(ctx, site) {
  const ko = ctx.lang === "ko";
  vault.deleteBrowserSite(ctx.db(), site);
  vault.logBrowserAction(ctx.db(), { site: vault.normalizeSite(site), action: "vault.delete", result: "ok" });
  ctx.out(`${ctx.ui.green("✓")} ${ko ? "사이트를 삭제했습니다" : "site removed"}: ${vault.normalizeSite(site) || site}`);
  return 0;
}

async function run(ctx, args) {
  if (args.length === 1 && isHelpToken(args[0])) { ctx.out(usageFor("browser", ctx.lang)); return 0; }
  const sub = String(args[0] || "").toLowerCase();
  const rest = args.slice(1);
  if (SUBS.has(sub)) {
    if (sub === "status" || sub === "sites") {
      parseBrowserRest(rest, { positionals: 0, usage: `Usage: agentlas browser ${sub}` });
      return sub === "status" ? browserStatus(ctx) : browserSites(ctx);
    }
    if (sub === "add") {
      const parsed = parseBrowserRest(rest, {
        values: ["label", "user"], positionals: 1,
        usage: "Usage: agentlas browser add <site> [--label name] [--user handle]",
      });
      return browserAdd(ctx, parsed);
    }
    if (sub === "mark") {
      const parsed = parseBrowserRest(rest, { positionals: 2, usage: "Usage: agentlas browser mark <site> <valid|expired|none>" });
      return browserMark(ctx, parsed._[0], parsed._[1]);
    }
    const usage = `Usage: agentlas browser ${sub} <${sub === "go" ? "url" : "site"}>`;
    const parsed = parseBrowserRest(rest, { positionals: 1, usage });
    if (sub === "login") return browserLogin(ctx, parsed._[0]);
    if (sub === "go") return browserGo(ctx, parsed._[0]);
    return browserRemove(ctx, parsed._[0]);
  }
  // 그 외(무인자·URL·검색어)는 v1 그대로 hep-browser 하드포인트로 — Chrome 을 실제로 띄운다.
  return create(ctx).cmdHep(["hep-browser", ...args]);
}

module.exports = { run };
