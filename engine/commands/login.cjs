"use strict";
/*
 * login — Agentlas Cloud 로그인 (데스크탑과 동일한 loopback 브라우저 플로우).
 * 웹 /account?desktop=1&callback=<loopback+state> 이 유효 세션이면 callback의 state를
 * 보존한 채 session을 추가해 302한다. Terminal은 state를 1회 검증한 뒤에만 저장한다.
 * 보안 속성(1회용 state guard, GET-only, no-store)은 cloud/auth.cjs 가 소유한다.
 */
const auth = require("../cloud/auth.cjs");
const {
  DEFAULT_OPTIONS,
  single,
  render,
  parseOutputFlags,
  renderError,
} = require("../cli-output.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

function withOutputFlags(ctx, args) {
  if (!args.some((arg) => OUTPUT_FLAGS.has(arg))) return { ctx, args };
  const parsed = parseOutputFlags(args);
  return {
    ctx: { ...ctx, output: { ...(ctx.output || DEFAULT_OPTIONS), ...parsed.options } },
    args: parsed.rest,
  };
}

function outputOptions(ctx) {
  return { ...DEFAULT_OPTIONS, ...(ctx.output || {}) };
}

function machineOutputRequested(ctx) {
  const options = outputOptions(ctx);
  return options.quiet || options.format === "json" || options.format === "yaml";
}

function styled(ctx, method, value, options) {
  const text = String(value);
  if (options.noColor) return text;
  const fn = ctx.ui && ctx.ui[method];
  return typeof fn === "function" ? fn(text) : text;
}

const LOGIN_SCHEMA = Object.freeze({
  idField: "status",
  columns: [
    { header: "status", field: "status" },
    { header: "authenticated", field: "authenticated" },
    { header: "email", field: "email" },
    { header: "workspace", field: (item) => item && item.workspace && item.workspace.name },
  ],
});

function emitMachine(ctx, payload) {
  ctx.out(render(single(payload, LOGIN_SCHEMA), outputOptions(ctx)));
}

function machineError(error, code = "LOGIN_FAILED") {
  const typed = new Error(String((error && error.message) || error));
  typed.code = code;
  return typed;
}

function emitMachineError(ctx, error, code = "LOGIN_FAILED") {
  const typed = machineError(error, code);
  if (typeof ctx.fail === "function") ctx.fail(typed);
  else ctx.err(renderError(typed, outputOptions(ctx)));
}

function workspaceReceipt(meta) {
  const workspace = meta && meta.workspace;
  return {
    name: workspace && typeof workspace.name === "string" ? workspace.name : null,
    plan: workspace && typeof workspace.plan === "string" ? workspace.plan : null,
  };
}

async function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  const ko = ctx.lang === "ko";
  const options = outputOptions(ctx);
  const machine = machineOutputRequested(ctx);
  if (args.some((arg) => arg !== "--force") || args.filter((arg) => arg === "--force").length > 1) {
    const error = new Error("usage: agentlas login [--force]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const force = args.includes("--force");
  if (!force) {
    const existing = auth.cloudSessionCookie();
    if (existing) {
      try {
        const j = await auth.fetchSessionMeta(existing);
        if (j && j.authenticated) {
          const email = (j.user && j.user.email) || null;
          if (machine) {
            emitMachine(ctx, {
              status: "already_signed_in",
              authenticated: true,
              email,
              workspace: workspaceReceipt(j),
              reauthenticated: false,
            });
          } else {
            ctx.out(ko
              ? `이미 로그인되어 있습니다 (${email || "?"}). 다시 인증하려면: agentlas login --force`
              : `Already signed in (${email || "?"}). Re-authenticate with agentlas login --force`);
          }
          return 0;
        }
      } catch { /* 확인 실패 — 새로 로그인 진행 */ }
    }
  }

  let value;
  try {
    value = await auth.waitForLoopbackSession({
      onLoginUrl(url) {
        const heading = ko
          ? "브라우저에서 Agentlas에 로그인하세요 (자동으로 열립니다):"
          : "Sign in to Agentlas in the browser (opening automatically):";
        // Machine stdout is a single receipt. Keep the interactive URL visible
        // on stderr while the browser opens, so piping JSON/YAML stays valid.
        if (machine) {
          ctx.err(heading);
          ctx.err("  " + url);
        } else {
          ctx.out(heading);
          ctx.out("  " + styled(ctx, "accent", url, options));
        }
        auth.openInBrowser(url);
      },
    });
  } catch (e) {
    if (machine) emitMachineError(ctx, e);
    else ctx.err(String((e && e.message) || e));
    return 1;
  }

  let sessionPath;
  try {
    sessionPath = auth.saveCliSession(value);
  } catch (e) {
    if (machine) {
      emitMachineError(ctx, e, "LOGIN_SESSION_SAVE_FAILED");
      return 1;
    }
    throw e;
  }
  if (!machine) ctx.out((ko ? "세션 저장됨: " : "Session saved: ") + styled(ctx, "dim", sessionPath, options));

  // 저장 직후 세션 유효성 확인 (whoami 와 동일한 출력 — 명령끼리 참조 금지 규칙 때문에 인라인)
  try {
    const j = await auth.fetchSessionMeta(auth.cloudSessionCookie());
    if (j && j.authenticated) {
      const email = (j.user && j.user.email) || null;
      const ws = workspaceReceipt(j);
      if (machine) {
        emitMachine(ctx, {
          status: "signed_in",
          authenticated: true,
          email,
          workspace: ws,
          sessionSaved: true,
        });
      } else {
        ctx.out(ko
          ? `로그인됨: ${styled(ctx, "bold", email || "?", options)}  ·  작업 공간: ${ws.name || "?"} (${ws.plan || "free"})`
          : `Signed in: ${styled(ctx, "bold", email || "?", options)}  ·  workspace: ${ws.name || "?"} (${ws.plan || "free"})`);
      }
      return 0;
    }
    if (machine) {
      emitMachine(ctx, { status: "invalid_session", authenticated: false, email: null, workspace: workspaceReceipt(j) });
    } else {
      ctx.out(ko
        ? "세션이 만료되었거나 유효하지 않습니다. `agentlas login`으로 다시 로그인하세요."
        : "The session is expired or invalid. Sign in again with agentlas login.");
    }
    return 1;
  } catch (e) {
    if (machine) emitMachineError(ctx, e, "LOGIN_SESSION_CHECK_FAILED");
    else ctx.err((ko ? "세션 확인 실패: " : "Session check failed: ") + String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
