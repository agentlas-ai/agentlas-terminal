"use strict";
/*
 * logout — CLI 세션 파일 삭제. 네트워크 호출 없음(서버 세션은 웹에서 관리).
 * AGENTLAS_SESSION env 는 파일과 별개 경로라 삭제 후에도 로그인 상태로 보일 수 있다 — 경고만 한다.
 */
const auth = require("../cloud/auth.cjs");
const {
  DEFAULT_OPTIONS,
  single,
  render,
  renderError,
  parseOutputFlags,
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

function logoutSchema(en) {
  return Object.freeze({
    idField: "command",
    columns: [
      { header: en ? "status" : "상태", field: "status" },
      { header: en ? "session" : "세션", field: "existed" },
    ],
    serialize(item) {
      const { command, ...payload } = item || {};
      return payload;
    },
    renderHuman(result) {
      const data = result.data || {};
      const lines = [data.existed
        ? (en ? "Signed out (CLI session deleted)." : "로그아웃되었습니다 (CLI 세션 삭제).")
        : (en ? "No saved CLI session." : "저장된 CLI 세션이 없습니다.")];
      if (data.warning) lines.push(data.warning);
      return lines.join("\n");
    },
  });
}

function emit(ctx, result) {
  if (typeof ctx.emit === "function") {
    ctx.emit(result);
    return;
  }
  const text = render(result, outputOptions(ctx));
  if (text) ctx.out(text);
}

function fail(ctx, error, humanMessage) {
  if (outputOptions(ctx).format !== "table" || outputOptions(ctx).quiet) {
    if (typeof ctx.fail === "function") ctx.fail(error);
    else if (typeof ctx.err === "function") ctx.err(renderError(error, outputOptions(ctx)));
  } else if (typeof ctx.err === "function") {
    ctx.err(humanMessage);
  }
  return 1;
}

function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  const ko = ctx.lang === "ko";
  if (args.length) {
    const error = new Error("usage: agentlas logout");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  let result;
  try {
    result = auth.deleteCliSession();
  } catch (e) {
    const detail = String((e && e.message) || e);
    const error = new Error(detail);
    error.code = "LOGOUT_FAILED";
    return fail(
      ctx,
      error,
      (ko ? "세션 파일을 삭제하지 못했습니다: " : "Could not delete the session file: ") + detail,
    );
  }
  const warning = process.env.AGENTLAS_SESSION
    ? (ko
      ? "경고: AGENTLAS_SESSION 이 아직 설정되어 있어 CLI가 로그인 상태로 보일 수 있습니다."
      : "Warning: AGENTLAS_SESSION is still set, so the CLI may appear signed in.")
    : null;
  const data = {
    command: "logout",
    status: result.existed ? "signed_out" : "no_session",
    existed: Boolean(result.existed),
    ...(warning ? { warning } : {}),
  };
  emit(ctx, single(data, logoutSchema(!ko)));
  return 0;
}

module.exports = { run };
