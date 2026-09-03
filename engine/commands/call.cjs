"use strict";
/*
 * call — 지정한 Hub/Cloud 에이전트 호출·준비 (hep-call 라우트).
 *
 * v1 디스패처 매핑 그대로:
 *   `agentlas call "a,b" "<맥락>"` → cmdHep(["hep-call", ...rest])
 *   무인자 → usage 실패 exit 1 (missingArgumentUsage 가드 — 슬러그 없는
 *   호출이 자연어 라우팅으로 새는 것 방지).
 *
 * 사람용 호출은 네이티브 스트리밍을 그대로 유지한다. 기계 출력은 자식의
 * stdout/stderr를 부모 stdout에 상속하지 않고 캡처해 JSON/YAML renderer를
 * 거친다. 그래야 사전고지나 Core의 부수 문장이 machine wire를 오염시키지 않는다.
 */
const {
  DEFAULT_OPTIONS,
  single,
  render,
  renderError,
  parseOutputFlags,
  terminalTextOf,
} = require("../cli-output.cjs");
const { create, usageFor, isHelpToken } = require("../hephaestus/runtime.cjs");

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

function isMachineOutput(ctx) {
  const output = outputOptions(ctx);
  return output.quiet || output.format === "json" || output.format === "yaml";
}

function typedError(message, code = "INVALID_ARGUMENT", details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function emit(ctx, result) {
  if (typeof ctx.emit === "function") {
    ctx.emit(result);
    return;
  }
  const text = render(result, outputOptions(ctx));
  if (text) ctx.out(text);
}

function failOutput(ctx, error) {
  const normalized = error instanceof Error ? error : typedError(String(error));
  if (typeof ctx.fail === "function") ctx.fail(normalized);
  else if (typeof ctx.err === "function") ctx.err(renderError(normalized, outputOptions(ctx)));
  return 1;
}

function outputSchema(en) {
  return Object.freeze({
    idField: (value) => value?.receipt_id ?? value?.receiptId ?? value?.id ?? "",
    columns: [
      { header: en ? "result" : "결과", field: (value) => value },
    ],
  });
}

function parseChildPayload(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { found: false, value: null };
  try {
    return { found: true, value: JSON.parse(text) };
  } catch { /* the runtime may prefix a single JSON payload with a notice */ }
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return { found: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch { /* keep looking */ }
  }
  return { found: false, value: null };
}

function emitChildPayload(ctx, payload) {
  const schema = outputSchema(ctx.lang === "en");
  // An array is a natural list result; objects/primitives stay one structured
  // value so JSON/YAML preserve the child response rather than a lossy preview.
  if (Array.isArray(payload)) {
    emit(ctx, { type: "list", data: payload, schema });
    return;
  }
  const data = payload && typeof payload === "object" ? payload : { value: payload };
  emit(ctx, single(data, schema));
}

function emitMachineChildError(ctx, result) {
  if (result?.unavailable) return failOutput(ctx, typedError(
    ctx.lang === "en"
      ? "Hephaestus runtime is unavailable."
      : "Hephaestus 런타임을 사용할 수 없습니다.",
    "CALL_RUNTIME_UNAVAILABLE",
  ));
  if (result?.timedOut) return failOutput(ctx, typedError(
    ctx.lang === "en" ? "Call timed out after 30 seconds." : "호출이 30초 제한을 넘었습니다.",
    "CALL_TIMEOUT",
  ));
  if (result?.overflow) return failOutput(ctx, typedError(
    ctx.lang === "en" ? "Call output exceeded the 2 MB limit." : "호출 출력이 2MB 제한을 넘었습니다.",
    "CALL_OUTPUT_LIMIT",
  ));
  const stderr = terminalTextOf(result?.stderr, 8192).trim();
  return failOutput(ctx, typedError(
    stderr || (ctx.lang === "en" ? "Call returned no readable result." : "호출 결과를 읽지 못했습니다."),
    result?.stdout ? "CALL_OUTPUT_INVALID" : "CALL_OUTPUT_EMPTY",
    result?.code == null ? undefined : { exitCode: result.code },
  ));
}

async function runMachine(ctx, args) {
  const runtime = create(ctx);
  if (typeof runtime.captureHephaestus !== "function") {
    return emitMachineChildError(ctx, { unavailable: true });
  }
  let result;
  try {
    result = await runtime.captureHephaestus(["hep-call", ...args]);
  } catch (error) {
    return failOutput(ctx, typedError(
      terminalTextOf(error?.message || error, 8192),
      "CALL_FAILED",
    ));
  }
  const parsed = !result?.overflow && !result?.timedOut ? parseChildPayload(result.stdout) : { found: false, value: null };
  if (parsed.found) {
    if (result.stderr) {
      const detail = terminalTextOf(result.stderr, 8192).trim();
      if (detail && typeof ctx.err === "function") ctx.err(detail);
    }
    emitChildPayload(ctx, parsed.value);
    return Number.isInteger(result.code) ? result.code : 0;
  }
  return emitMachineChildError(ctx, result);
}

async function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  const machine = isMachineOutput(ctx);
  if (args.length === 1 && isHelpToken(args[0])) {
    if (machine) {
      emit(ctx, single({ usage: usageFor("call", ctx.lang) }, {
        idField: "usage",
        columns: [{ header: "usage", field: "usage" }],
      }));
    } else {
      ctx.out(usageFor("call", ctx.lang));
    }
    return 0;
  }
  if (!args.length) {
    const error = typedError(usageFor("call", ctx.lang));
    if (machine) return failOutput(ctx, error);
    ctx.err("✖ " + error.message);
    return 1;
  }
  // 과금 사전 고지 — 가격은 서버가 청구 시 확정하므로 숫자를 지어내지 않는다.
  const disclosure = ctx.lang !== "en"
    ? "ℹ 공개 Hub 에이전트·팀 호출은 크레딧이 소모됩니다(활성 장기대여 중에는 0). 잔액 확인: agentlas billing"
    : "ℹ Public Hub agent/team calls consume credits (0 while a day-lease is active). Check balance: agentlas billing";
  if (machine) {
    if (typeof ctx.err === "function") ctx.err(disclosure);
    return runMachine(ctx, args);
  }
  ctx.out(disclosure);
  return create(ctx).cmdHep(["hep-call", ...args]);
}

module.exports = { run };
