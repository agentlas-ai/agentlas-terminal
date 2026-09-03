"use strict";
/*
 * memory — 레거시 마크다운 메모리 → 공유 agentlas.sqlite 이관 (Phase 1b).
 *   agentlas memory import <folder-or-file> --agent <agentId> [--apply]
 * 기본은 dry-run 프리뷰, --apply 일 때만 쓴다. 로직은 복원된 계약 모듈
 * engine/agentlas-memory-import.cjs 가 소유한다(여기서는 주입만).
 * v1의 fail(process.exit)은 v2에서 throw 로 바꿔 엔진이 stderr+exit 1 처리한다.
 */
const { cmdMemory, parseMemoryArgs } = require("../agentlas-memory-import.cjs");
const {
  DEFAULT_OPTIONS,
  single,
  render,
  parseOutputFlags,
} = require("../cli-output.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

const MEMORY_OUTPUT_SCHEMA = Object.freeze({
  idField: "source",
  columns: [
    { header: "source", field: "source" },
    { header: "target", field: "target" },
    { header: "mode", field: "mode" },
    { header: "total", field: "total" },
    { header: "new", field: "newCount" },
    { header: "duplicate", field: "duplicateCount" },
    { header: "redacted", field: "redactedCount" },
    { header: "imported", field: "imported" },
  ],
});

function withOutputFlags(ctx, args) {
  if (!args.some((arg) => OUTPUT_FLAGS.has(arg))) return { ctx, args };
  const parsed = parseOutputFlags(args);
  return {
    ctx: { ...ctx, output: { ...(ctx.output || DEFAULT_OPTIONS), ...parsed.options } },
    args: parsed.rest,
  };
}

function typedFailure(message) {
  const error = message instanceof Error ? message : new Error(String(message ?? ""));
  if (!error.code) {
    error.code = /^(?:usage:|unknown memory subcommand|duplicate option:|--agent requires|memory import accepts exactly one|unknown option:)/i.test(error.message)
      ? "INVALID_ARGUMENT"
      : /^Import source not found:/i.test(error.message)
        ? "IMPORT_SOURCE_NOT_FOUND"
        : "MEMORY_IMPORT_FAILED";
  }
  return error;
}

function parsePreview(lines) {
  const list = Array.isArray(lines) ? lines.map((line) => String(line)) : [];
  const mode = list[0] && /^== memory import \((DRY-RUN|APPLY)\) ==$/.exec(list[0]);
  const source = list.find((line) => line.startsWith("source: "))?.slice(8) || "";
  const targetLine = list.find((line) => line.startsWith("target: ")) || "";
  const targetMatch = /^target: (.+?) \((agent|team)\)$/.exec(targetLine);
  const summaryLine = list.find((line) => /^total \d+ · new \d+ · duplicate \d+ · redacted \d+$/.test(line)) || "";
  const summary = /^total (\d+) · new (\d+) · duplicate (\d+) · redacted (\d+)$/.exec(summaryLine);
  const importedLine = list.find((line) => /^imported \d+ memory entries/.test(line)) || "";
  const importedMatch = /^imported (\d+) memory entries/.exec(importedLine);
  const headerIndex = list.findIndex((line) => /^OWNER\s+KIND\s+STATUS\s+SECTION$/.test(line.trim()));
  const rows = [];
  if (headerIndex >= 0) {
    for (const line of list.slice(headerIndex + 1)) {
      if (!line.trim() || /^total \d+ /.test(line) || /^dry-run — /.test(line) || /^imported \d+ /.test(line)) continue;
      rows.push({
        owner: line.slice(0, 26).trim(),
        kind: line.slice(26, 36).trim(),
        status: line.slice(36, 44).trim(),
        section: line.slice(44).trim(),
      });
    }
  }
  const total = summary ? Number(summary[1]) : rows.length;
  const newCount = summary ? Number(summary[2]) : rows.filter((row) => row.status === "new").length;
  const duplicateCount = summary ? Number(summary[3]) : rows.filter((row) => row.status === "dup").length;
  const redactedCount = summary ? Number(summary[4]) : rows.filter((row) => row.status === "skip").length;
  const dryRun = mode ? mode[1] === "DRY-RUN" : importedMatch === null;
  return {
    source,
    target: targetMatch ? targetMatch[1] : "",
    targetKind: targetMatch ? targetMatch[2] : "",
    mode: dryRun ? "dry-run" : "apply",
    dryRun,
    total,
    newCount,
    duplicateCount,
    redactedCount,
    imported: importedMatch ? Number(importedMatch[1]) : 0,
    preview: rows,
  };
}

function emitMachine(ctx, lines) {
  const result = single(parsePreview(lines), MEMORY_OUTPUT_SCHEMA);
  if (typeof ctx.emit === "function") ctx.emit(result);
  else ctx.out(render(result, ctx.output || DEFAULT_OPTIONS));
}

function run(ctx, args) {
  const prepared = withOutputFlags(ctx, args);
  ctx = prepared.ctx;
  args = prepared.args;
  const output = { ...DEFAULT_OPTIONS, ...(ctx.output || {}) };
  const machine = output.quiet || output.format === "json" || output.format === "yaml";
  const captureOutput = machine || output.noHeaders;
  const lines = [];
  const out = captureOutput ? (line = "") => lines.push(String(line)) : ctx.out;
  try {
    const parsed = parseMemoryArgs(args);
    cmdMemory({
      db: parsed.help ? null : ctx.db(),
      args,
      out,
      fail: (msg) => { throw typedFailure(msg); },
    });
  } catch (error) {
    if (typeof ctx.fail === "function") ctx.fail(typedFailure(error));
    else if (typeof ctx.err === "function") ctx.err(String((error && error.message) || error));
    return 1;
  }
  if (machine) {
    emitMachine({ ...ctx, output }, lines);
  } else if (output.noHeaders) {
    for (const line of lines) {
      if (/^OWNER\s+KIND\s+STATUS\s+SECTION$/.test(line.trim())) continue;
      ctx.out(line);
    }
  }
  return 0;
}

module.exports = { run };
