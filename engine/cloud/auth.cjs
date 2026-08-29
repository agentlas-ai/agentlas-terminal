"use strict";
/*
 * cloud/auth — Agentlas Cloud 로그인 세션. 단일 관심사:
 *   loopback OAuth 로그인 플로우 + CLI 세션 영속화 + whoami 조회.
 *
 * 보안 계약 (test/login-loopback-security.cjs 가 전부 검증한다 — 바꾸면 테스트부터):
 *  - state 는 32바이트 crypto 난수(base64url, 43자). 비교는 timingSafeEqual.
 *  - `/callback` GET 1회로 transaction 소비 — 성공/실패 무관. 잘못된 state 뒤에
 *    공격자 세션을 재주입하거나 성공 URL 재생으로 세션을 덮어쓸 수 없다.
 *  - 서버는 127.0.0.1 임시 포트만 listen, GET 외 405, 무관 경로 404(미소비),
 *    모든 응답에 no-store + 'none' CSP + nosniff.
 *  - OAuth error 코드는 화이트리스트 정규식 통과분만 에러 메시지에 반영(반사 방지).
 *
 * 세션 파일은 평문·0600 (`<userData>/auth/cli-session.v1.json`) — 데스크탑의
 * safeStorage 파일과 별개다. 쿠키 해석 순서: AGENTLAS_SESSION env → 세션 파일.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { userDataDir } = require("../core/paths.cjs");

const LOGIN_CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 180_000;
const MAX_LOGIN_SESSION_BYTES = 16 * 1024;

function validLoginSessionValue(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_LOGIN_SESSION_BYTES &&
    !/[\u0000-\u0020\u007f;,]/.test(value);
}

function webBaseUrl() {
  return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
}

function createLoginState(randomBytes = crypto.randomBytes) {
  const bytes = Buffer.from(randomBytes(32));
  if (bytes.length !== 32) throw new Error("Could not create the login state.");
  return bytes.toString("base64url");
}

function loginStatesMatch(actual, expected) {
  const left = Buffer.from(String(actual || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * OAuth loopback callback의 1회용 state guard. `/callback` GET이 도착하면 성공/실패와
 * 무관하게 transaction을 소비한다. 따라서 잘못된 state 뒤에 공격자 세션을 재주입하거나,
 * 성공 URL을 재생해 다른 세션으로 덮어쓸 수 없다.
 */
function createLoginCallbackGuard(expectedState) {
  let consumed = false;
  return {
    consume(rawUrl, method = "GET") {
      let url;
      try {
        url = new URL(String(rawUrl || "/"), "http://127.0.0.1");
      } catch {
        return { handled: true, final: false, ok: false, statusCode: 400, message: "Invalid login callback." };
      }
      if (url.pathname !== LOGIN_CALLBACK_PATH) {
        return { handled: false, final: false, ok: false, statusCode: 404, message: "not found" };
      }
      if (method !== "GET") {
        return { handled: true, final: false, ok: false, statusCode: 405, message: "method not allowed" };
      }
      if (consumed) {
        return { handled: true, final: false, ok: false, statusCode: 410, message: "Login callback has already been used." };
      }
      consumed = true;

      if (!loginStatesMatch(url.searchParams.get("state"), expectedState)) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "Login callback state validation failed. Run agentlas login again.",
        };
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        // 에러 코드는 화이트리스트 통과분만 반영 — error_description 등 자유 텍스트는 절대 반사하지 않는다.
        const safeCode = /^[A-Za-z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "oauth_error";
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: `Agentlas login denied: ${safeCode}`,
        };
      }
      const value = url.searchParams.get("session") || url.searchParams.get("token") || "";
      if (!value) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "The callback did not include a session value.",
        };
      }
      if (!validLoginSessionValue(value)) {
        return {
          handled: true,
          final: true,
          ok: false,
          statusCode: 400,
          message: "The login session value is invalid.",
        };
      }
      return { handled: true, final: true, ok: true, statusCode: 200, value, message: "Agentlas login complete" };
    },
    isConsumed() { return consumed; },
  };
}

// URL 출력은 이미 호출자가 했다는 전제 — 브라우저를 못 열어도 조용히 넘어간다(수동으로 열면 된다).
function openInBrowser(url) {
  const argv =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
    // spawn failures such as a missing xdg-open arrive asynchronously. Without
    // a listener Node treats them as an uncaught process error.
    child.once("error", () => {});
    child.unref();
  } catch { /* ignore */ }
}

function loginCallbackHtml(ok) {
  const title = ok ? "Agentlas login complete" : "Agentlas login failed";
  const body = ok
    ? "Return to the terminal. You can close this window."
    : "Return to the terminal and run agentlas login again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentlas</title></head><body style="font-family:-apple-system,system-ui,sans-serif;padding:40px"><h3>${title}</h3><p>${body}</p></body></html>`;
}

/**
 * 127.0.0.1 임시 포트에 1회용 loopback 서버를 열고, 웹 `/account?desktop=1&callback=…`
 * 로그인 흐름이 state 를 보존한 채 세션을 되돌려줄 때까지 기다린다.
 * options: { baseUrl?, timeoutMs?, onLoginUrl?, http?, randomBytes? }
 */
function waitForLoopbackSession(options = {}) {
  const http = options.http || require("node:http");
  const timeoutCandidate = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : LOGIN_TIMEOUT_MS;
  const state = createLoginState(options.randomBytes || crypto.randomBytes);
  const guard = createLoginCallbackGuard(state);
  const onLoginUrl = options.onLoginUrl || ((url) => {
    process.stdout.write("Sign in to Agentlas in the browser (opening automatically):\n  " + url + "\n");
    openInBrowser(url);
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let server;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (server) server.close(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(value);
    };

    server = http.createServer((req, res) => {
      const result = guard.consume(req.url, req.method || "GET");
      const headers = {
        "content-type": result.handled ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        connection: "close",
      };
      if (result.statusCode === 405) headers.allow = "GET";
      res.writeHead(result.statusCode, headers);
      res.end(result.handled ? loginCallbackHtml(result.ok) : result.message);
      if (!result.final) return;
      if (result.ok) finish(null, result.value);
      else finish(new Error(result.message));
    });
    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      if (!port) {
        finish(new Error("Could not open the login loopback port."));
        return;
      }
      const callback = new URL(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}`);
      callback.searchParams.set("state", state);
      let loginUrl;
      try {
        loginUrl = new URL("/account", `${options.baseUrl || webBaseUrl()}/`);
      } catch {
        finish(new Error("The Agentlas login URL is invalid."));
        return;
      }
      loginUrl.searchParams.set("desktop", "1");
      loginUrl.searchParams.set("callback", callback.toString());
      timer = setTimeout(
        () => finish(new Error(`Login timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try: agentlas login`)),
        timeoutMs,
      );
      if (timer.unref) timer.unref();
      try {
        const notified = onLoginUrl(loginUrl.toString());
        if (notified && typeof notified.then === "function") {
          void notified.catch((error) => finish(error));
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

// ── CLI 세션 영속화 (v1 포맷 그대로: { version: 1, value, updatedAt }) ──
function cliSessionPath() {
  return path.join(userDataDir(), "auth", "cli-session.v1.json");
}

function readCliSessionValue() {
  try {
    const p = cliSessionPath();
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOGIN_SESSION_BYTES * 2) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && validLoginSessionValue(j.value) ? j.value : null;
  } catch {
    return null;
  }
}

function saveCliSession(value) {
  if (!validLoginSessionValue(value)) throw new Error("Refusing to save an invalid Agentlas login session value.");
  const p = cliSessionPath();
  // 디렉터리 0700 + 파일 0600 — 기본 umask(0644)로 세션이 world-readable 이 되는 것을 막는다.
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* win32 */ }
  const temp = path.join(dir, `.cli-session.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, value, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, p);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original */ }
    throw error;
  }
  try { fs.chmodSync(p, 0o600); } catch { /* win32 */ }
  return p;
}

function deleteCliSession() {
  const p = cliSessionPath();
  if (!fs.existsSync(p)) return { existed: false, path: p };
  fs.rmSync(p);
  return { existed: true, path: p };
}

// 쿠키 해석 순서 계약: AGENTLAS_SESSION env → 세션 파일. (v1의 keytar 폴백은
// 데스크탑이 세션을 keytar에 두지 않아 항상 비어 있었다 — v2에서는 싣지 않는다.)
function cloudSessionCookie() {
  if (validLoginSessionValue(process.env.AGENTLAS_SESSION)) return `agentlas_session=${process.env.AGENTLAS_SESSION}`;
  const fileValue = readCliSessionValue();
  if (fileValue) return `agentlas_session=${fileValue}`;
  return null;
}

async function fetchSessionMeta(cookie) {
  const resp = await fetch(`${webBaseUrl()}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Session check returned ${resp.status}`);
  return resp.json();
}

// 레거시 테스트 호환 표면 (v1 agentlas-parity.cjs 의 create(deps) 모양).
// v2 명령은 위의 모듈 함수들을 직접 쓰고, 이 create 는 아무 deps 도 요구하지 않는다.
function create() {
  return { waitForLoopbackSession };
}

module.exports = {
  create,
  webBaseUrl,
  openInBrowser,
  waitForLoopbackSession,
  cliSessionPath,
  readCliSessionValue,
  saveCliSession,
  deleteCliSession,
  cloudSessionCookie,
  fetchSessionMeta,
  _test: { createLoginState, createLoginCallbackGuard, validLoginSessionValue },
};
