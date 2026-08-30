"use strict";
/*
 * document — 문서 산출(2026-08-06). 지금은 PDF 내보내기.
 *
 * 오너 원칙("터미널인데 모든 기능이 다 돼야"): 데스크탑 document/export-pdf.ts 는 offscreen
 * BrowserWindow.printToPDF 로 HTML/URL 을 PDF 로 굽는다. 터미널은 같은 메커니즘을 CDP
 * Page.printToPDF(engine/browser/cdp.cjs)로 한다 — GUI 창 없이 Agentlas 전용 Chrome 에서.
 *
 *   document pdf <html-file|url> [-o out.pdf] [--landscape]
 *
 * 로컬 HTML 파일은 file:// 로, http(s) 는 그대로 연다. 브라우저(CDP)가 없으면 정직하게
 * 멈추고 먼저 띄우도록 안내한다(조용히 안 되는 척하지 않는다).
 */
const path = require("node:path");
const fs = require("node:fs");
const cdp = require("../browser/cdp.cjs");

function usage(ko) {
  return ko
    ? "사용법: agentlas document pdf <html파일|url> [-o 출력.pdf] [--landscape]"
    : "Usage: agentlas document pdf <html-file|url> [-o out.pdf] [--landscape]";
}

function toUrl(src) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return src;           // http(s):// · file:// · data:
  return "file://" + path.resolve(src);                            // 로컬 파일
}

function documentArgumentError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function parsePdfArgs(args, ko) {
  let landscape = false;
  let out = null;
  let src = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (token === "--landscape") {
      if (landscape) throw documentArgumentError(usage(ko));
      landscape = true;
      continue;
    }
    if (token === "-o") {
      if (out !== null) throw documentArgumentError(usage(ko));
      const value = args[index + 1];
      if (!value || String(value).startsWith("-")) throw documentArgumentError(usage(ko));
      out = String(value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) throw documentArgumentError(usage(ko));
    if (src !== null) throw documentArgumentError(usage(ko));
    src = token;
  }
  if (!src) throw documentArgumentError(usage(ko));
  return { landscape, out, src };
}

async function toPdf(ctx, args) {
  const ko = ctx.lang === "ko";
  const { landscape, out, src } = parsePdfArgs(args, ko);

  // 로컬 파일이면 존재 확인(없는 걸 조용히 빈 PDF 로 굽지 않는다).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !fs.existsSync(path.resolve(src))) {
    ctx.err((ko ? "파일이 없습니다: " : "no such file: ") + src);
    return 1;
  }
  const url = toUrl(src);
  const outPath = path.resolve(out || (src.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").replace(/\.(html?|md)$/i, "") || "document") + ".pdf");

  if (!(await cdp.cdpReady())) {
    ctx.err(ko
      ? `Agentlas 브라우저가 실행 중이 아닙니다. 먼저 띄우세요: agentlas browser ${url}`
      : `The Agentlas browser is not running. Start it first: agentlas browser ${url}`);
    return 1;
  }
  let page;
  try {
    if (typeof ctx.ui.startSpinner === "function") ctx.ui.startSpinner(ko ? "PDF 굽는 중…" : "Rendering PDF…");
    page = await cdp.attachPage({ selection: "new" });
    await page.navigate(url, { waitMs: 1800 });
    await page.waitFor("document.readyState === 'complete'", { timeoutMs: 8000 });
    const r = await page.printPdf(outPath, { landscape });
    if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "PDF 를 만들었습니다" : "wrote PDF"}: ${r.path} ${ctx.ui.dim(`(${Math.round(r.bytes / 1024)} KB)`)}`);
    return 0;
  } catch (e) {
    if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();
    ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`);
    return 1;
  } finally {
    if (page) await page.close({ closeTarget: true });
  }
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const sub = String(args[0] || "").toLowerCase();
  if (!sub || (["help", "-h", "--help"].includes(sub) && args.length === 1)) { ctx.out(usage(ko)); return 0; }
  if (sub === "pdf") return toPdf(ctx, args.slice(1));
  throw documentArgumentError(usage(ko));
}

module.exports = { run, parsePdfArgs };
