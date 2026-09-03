"use strict";
/*
 * upload — `agentlas upload <path> [--visibility marketplace]`.
 * 기본은 owner-private `cloud save`다. 공개 Hub 발행은 오직 명시적
 * `--visibility marketplace` 로만 일어난다 (조용한 공개 승격 금지).
 */
const { runUpload } = require("../cloud-assets/commands.cjs");
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

function uploadSchema() {
  return Object.freeze({
    idField: (item) => item && item.manifest && item.manifest.slug,
    columns: [
      { header: "status", field: "status" },
      { header: "slug", field: (item) => item && item.manifest && item.manifest.slug },
      { header: "visibility", field: (item) => item && item.manifest && item.manifest.visibility },
      { header: "packageHash", field: (item) => item && item.manifest && item.manifest.packageHash },
      { header: "bundlePath", field: "bundlePath" },
    ],
  });
}

function machineOutputRequested(ctx) {
  const options = outputOptions(ctx);
  // noColor is automatically enabled for non-TTY output. The underlying
  // human renderer is already plain there, so only an explicit TTY color
  // request should switch this adapter to the structured path.
  const plainRequested = options.noColor && Boolean(process.stdout.isTTY);
  return options.quiet || options.format === "json" || options.format === "yaml" || options.noHeaders || plainRequested;
}

async function runMachine(ctx, args) {
  const capturedOut = [];
  const capturedErr = [];
  const machineCtx = {
    ...ctx,
    out(value = "") { capturedOut.push(String(value)); },
    err(value = "") { capturedErr.push(String(value)); },
  };
  const commandArgs = args.includes("--json") ? args : [...args, "--json"];
  const code = await runUpload(machineCtx, commandArgs);
  const raw = capturedOut.join("\n").trim();
  if (!raw) {
    if (capturedErr.length) {
      const error = new Error(capturedErr.join("\n"));
      error.code = code ? "UPLOAD_FAILED" : "UPLOAD_OUTPUT_MISSING";
      throw error;
    }
    if (code) {
      const error = new Error("Upload did not produce a machine-readable result.");
      error.code = "UPLOAD_OUTPUT_MISSING";
      throw error;
    }
    return code;
  }
  let result;
  try {
    result = JSON.parse(raw);
  } catch (error) {
    const outputError = new Error("Upload returned invalid machine-readable output.");
    outputError.code = "UPLOAD_OUTPUT_INVALID";
    outputError.details = { cause: String((error && error.message) || error).slice(0, 200) };
    throw outputError;
  }
  ctx.out(render(single(result, uploadSchema()), outputOptions(ctx)));
  return code;
}

async function run(ctx, args) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  try {
    if (machineOutputRequested(ctx)) return await runMachine(ctx, args);
    return await runUpload(ctx, args);
  } catch (e) {
    if (typeof ctx.fail === "function") ctx.fail(e);
    else ctx.err(renderError(e, outputOptions(ctx)));
    return 1;
  }
}

module.exports = { run };
