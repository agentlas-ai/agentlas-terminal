"use strict";
/*
 * browser/cdp — 터미널 명령적 브라우저 조종 (2026-08-06).
 *
 * 배경(오너): 데스크탑은 Electron BrowserWindow.executeJavaScript 로 페이지를
 * 명령적으로 조종한다(navigate → innerText 읽기 → 타이핑 → 토큰 파싱). 터미널
 * `agentlas browser` 는 리서치용(URL 읽기·검색)이라 그 명령적 조종이 없었다.
 * 공유 CDP 엔진(browser-cdp-launcher.js)이 이미 Agentlas 전용 Chrome 을 원격
 * 디버깅 포트(기본 9222)로 띄우므로, 그 포트에 raw CDP(DevTools Protocol)로 붙어
 * navigate/evaluate/waitFor 를 제공한다. Node 22+ 의 global WebSocket·fetch 만
 * 쓴다(의존성 0).
 *
 * evaluate(js) 는 데스크탑 executeJavaScript 와 동형(Runtime.evaluate,
 * returnByValue + awaitPromise). BotFather 자동생성 같은 데스크탑 흐름이 이 위에
 * 얹힌다.
 *
 * 안전: Agentlas 전용 프로필 Chrome 에만 붙는다(개인 크롬 아님). 되돌릴 수 없는
 * 행동은 호출자가 판단한다 — 이 모듈은 조종 primitive 만 제공한다.
 */
const http = require("node:http");

const DEFAULT_PORT = Number(process.env.AGENTLAS_CDP_PORT || 9222);
const DEFAULT_WS_OPEN_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function httpJson(port, path, { timeout = 3000, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, timeout, method }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`CDP ${path} timed out`)); });
    req.end();
  });
}

/** 9222 가 살아있나(Agentlas 전용 Chrome). */
async function cdpReady(port = DEFAULT_PORT) {
  try {
    const version = await httpJson(port, "/json/version");
    if (!version || typeof version !== "object" || typeof version.webSocketDebuggerUrl !== "string") return false;
    const targets = await httpJson(port, "/json");
    return Array.isArray(targets);
  } catch { return false; }
}

function verifiedPageTarget(target, port, ownsTarget = false) {
  if (!target || target.type !== "page" || typeof target.id !== "string" || typeof target.webSocketDebuggerUrl !== "string") return null;
  try {
    const socket = new URL(target.webSocketDebuggerUrl);
    if (socket.protocol !== "ws:" || !LOOPBACK_HOSTS.has(socket.hostname.toLowerCase()) || Number(socket.port) !== port) return null;
  } catch {
    return null;
  }
  return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl, ownsTarget };
}

async function resolvePageTarget(port, { selection = "new", targetId = null } = {}) {
  if (selection !== "new" && selection !== "existing") {
    throw new Error(`unsupported CDP target selection: ${selection}`);
  }
  const rawTargets = await httpJson(port, "/json");
  const pages = (Array.isArray(rawTargets) ? rawTargets : [])
    .map((target) => verifiedPageTarget(target, port))
    .filter(Boolean);

  if (selection === "existing") {
    if (!targetId) throw new Error("existing CDP target selection requires an explicit targetId");
    const exact = pages.find((target) => target.id === String(targetId));
    if (!exact) throw new Error(`no CDP page target matches targetId ${targetId}`);
    return exact;
  }

  // Never reuse an arbitrary first page. It may be a user's active tab, and
  // browser/document/Telegram flows must not navigate it behind their back.
  // Create a target we own, then return its socket identity to the caller.
  const created = await httpJson(port, `/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  const exact = verifiedPageTarget(created, port, true);
  if (!exact) throw new Error("CDP did not return a verified page target for the new tab");
  return exact;
}

/**
 * Pick a page target without guessing ownership.
 *
 * The safe default is a fresh target. Reusing a page requires selection:
 * `pickPageTarget(port, { selection: "existing", targetId })`.
 */
async function pickPageTarget(port = DEFAULT_PORT, options = {}) {
  return (await resolvePageTarget(port, options)).webSocketDebuggerUrl;
}

function closePageTarget(port, targetId) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/json/close/${encodeURIComponent(String(targetId))}`,
      timeout: 3_000,
    }, (res) => {
      res.resume();
      res.once("end", resolve);
    });
    req.once("error", resolve);
    req.once("timeout", () => { req.destroy(); resolve(); });
    req.end();
  });
}

function waitForWebSocketOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      const error = new Error(`CDP websocket open timed out after ${timeoutMs}ms`);
      error.code = "CDP_WEBSOCKET_OPEN_TIMEOUT";
      try { ws.close(); } catch { /* already closed */ }
      finish(error);
    }, timeoutMs);
    ws.addEventListener("open", () => finish(), { once: true });
    ws.addEventListener("error", () => finish(new Error("CDP websocket failed to open")), { once: true });
    ws.addEventListener("close", () => finish(new Error("CDP websocket closed before opening")), { once: true });
  });
}

/**
 * 페이지 하나에 CDP 로 붙는다. 반환: { navigate, evaluate, waitFor, close }.
 * primitive:
 *   navigate(url)                 Page.navigate + load 대기(간이)
 *   evaluate(js, {awaitPromise})  Runtime.evaluate(returnByValue) — 값 반환
 *   waitFor(jsPredicate, {timeoutMs, pollMs})  predicate 가 truthy 될 때까지
 */
async function attachPage({ port = DEFAULT_PORT, wsUrl, selection = "new", targetId, connectTimeoutMs = DEFAULT_WS_OPEN_TIMEOUT_MS } = {}) {
  const target = wsUrl
    ? (() => {
      try {
        const socket = new URL(wsUrl);
        if (socket.protocol !== "ws:" || !LOOPBACK_HOSTS.has(socket.hostname.toLowerCase()) || Number(socket.port) !== port) return null;
      } catch { return null; }
      return { id: null, webSocketDebuggerUrl: wsUrl, ownsTarget: false };
    })()
    : await resolvePageTarget(port, { selection, targetId });
  if (!target) throw new Error(`invalid CDP websocket target for port ${port}`);

  const url = target.webSocketDebuggerUrl;
  let ws;
  try {
    ws = new WebSocket(url);
    await waitForWebSocketOpen(ws, connectTimeoutMs);
  } catch (error) {
    if (target.ownsTarget) await closePageTarget(port, target.id);
    throw error;
  }

  let nextId = 0;
  const pending = new Map();
  let closed = false;
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message || "CDP error"), { cdp: msg.error }));
      else resolve(msg.result);
    }
  });
  ws.addEventListener("close", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  }, { once: true });

  function send(method, params = {}, { timeout = 30000 } = {}) {
    if (closed) return Promise.reject(new Error("CDP page is closed"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeout);
      pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  await send("Page.enable").catch(() => {});
  await send("Runtime.enable").catch(() => {});

  async function evaluate(expression, { awaitPromise = true } = {}) {
    const res = await send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise,
    });
    if (res && res.exceptionDetails) {
      throw new Error("page evaluate threw: " + (res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)));
    }
    return res && res.result ? res.result.value : undefined;
  }

  // 편의: 표현식(값) 하나를 평가.
  async function evalExpr(expression, opts) {
    return evaluate(`return (${expression});`, opts);
  }

  async function navigate(target, { waitMs = 1500 } = {}) {
    await send("Page.navigate", { url: target });
    // 간이 로드 대기 — 필요하면 waitFor 로 정밀 대기.
    await new Promise((r) => setTimeout(r, waitMs));
  }

  async function waitFor(predicateExpr, { timeoutMs = 60000, pollMs = 800 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let ok = false;
      try { ok = await evalExpr(predicateExpr); } catch { ok = false; }
      if (ok) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /*
   * 진짜 조종(읽기만이 아니라 몰기). 데스크탑은 Electron sendInputEvent 로 키·클릭을
   * 넣는다. 여기서는 CDP Input.* 로 같은 일을 한다:
   *   focusSelector(sel)         해당 요소에 포커스(evaluate)
   *   typeInto(sel, text)        요소에 포커스 후 Input.insertText 로 문자열 삽입
   *   pressKey("Enter")          Input.dispatchKeyEvent (keyDown+keyUp)
   *   clickSelector(sel)         요소를 클릭(evaluate element.click — SPA에 안정적)
   * BotFather /newbot 같은 데스크탑 흐름이 이 위에 얹힌다.
   */
  const KEYS = { Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" } };

  async function focusSelector(selector) {
    const ok = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.focus(); return true;`);
    if (!ok) throw new Error(`no element matches ${selector}`);
    return true;
  }

  async function typeInto(selector, text) {
    await focusSelector(selector);
    await send("Input.insertText", { text: String(text) });
    return true;
  }

  async function pressKey(name) {
    const k = KEYS[name];
    if (!k) throw new Error(`unsupported key: ${name}`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    return true;
  }

  async function clickSelector(selector) {
    const ok = await evaluate(`const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.click(); return true;`);
    if (!ok) throw new Error(`no element matches ${selector}`);
    return true;
  }

  /*
   * 현재 페이지를 PDF 로 인쇄한다(데스크탑 document/export-pdf.ts 의 offscreen
   * BrowserWindow.printToPDF 와 같은 메커니즘 — 여기서는 CDP Page.printToPDF).
   * base64 를 디코드해 outPath 에 쓴다. 반환: {path, bytes}.
   */
  async function printPdf(outPath, { landscape = false, printBackground = true, scale = 1 } = {}) {
    const res = await send("Page.printToPDF", { landscape, printBackground, scale, transferMode: "ReturnAsBase64" }, { timeout: 60000 });
    const b64 = res && res.data;
    if (!b64) throw new Error("Page.printToPDF returned no data");
    const buf = Buffer.from(b64, "base64");
    require("node:fs").writeFileSync(outPath, buf);
    return { path: outPath, bytes: buf.length };
  }

  async function close({ closeTarget = false } = {}) {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
    if (closeTarget && target.ownsTarget && target.id) await closePageTarget(port, target.id);
  }

  return {
    navigate, evaluate, evalExpr, waitFor, focusSelector, typeInto, pressKey,
    clickSelector, printPdf, close, send,
    targetId: target.id,
    ownsTarget: target.ownsTarget,
  };
}

module.exports = { cdpReady, pickPageTarget, attachPage, DEFAULT_PORT, DEFAULT_WS_OPEN_TIMEOUT_MS };
