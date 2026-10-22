"use strict";
/*
 * `agentlas context window [--json|--yaml] [<chat-or-session>]` — the context inspector as a table and JSON
 * (docs/2026-10-13-native-harness/20 §3: Terminal = the same snapshot as a table and JSON).
 * Also reachable as bare `agentlas context [--json] [<chat-or-session>]`; the code-map subcommands
 * (refresh|locate|refs|slice|impact|verify) stay in commands/context.cjs unchanged.
 * Read-only: no model call, login, compaction or session change.
 */
const { DEFAULT_OPTIONS, single, render, parseOutputFlags } = require("./cli-output.cjs");
const inspector = require("./context-inspect.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

function invalid(message, details) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  if (details) error.details = details;
  return error;
}

function schema(ko) {
  return Object.freeze({
    idField: "schemaVersion",
    columns: [{ header: ko ? "항목" : "item", field: "schemaVersion" }],
    // --json / --yaml print the snapshot itself (agentlas.context-snapshot.v1), nothing wrapped around it.
    serialize: (item) => item.snapshot,
    renderHuman: (result) => inspector.renderTable(result.data.snapshot, { ko, chat: result.data.chat }),
  });
}

/**
 * True for the window forms: no args, `window …`, an output flag first, or a first word that is not a code-map
 * subcommand (a chat or session reference — the launcher strips `--json`, so `context --json <id>` arrives as `<id>`).
 */
function isContextWindowInvocation(args, codeMapSubcommands = new Set()) {
  if (!Array.isArray(args) || args.length === 0) return true;
  const first = String(args[0]);
  return first === "window" || first.startsWith("-") || !codeMapSubcommands.has(first);
}

function run(ctx, rawArgs = []) {
  let args = rawArgs.slice();
  if (args[0] === "window") args = args.slice(1);
  const scope = {};
  args = args.filter((arg, index, all) => {
    if (index > 0 && ["--request", "--source"].includes(all[index - 1])) return false;
    if (!["--request", "--source"].includes(arg)) return true;
    const value = all[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) throw invalid(`${arg} requires an id`);
    const key = arg === "--request" ? "requestId" : "occurrenceId";
    if (scope[key] !== undefined) throw invalid(`${arg} specified twice`);
    scope[key] = value; return false;
  });
  // Same rule as commands/usage.cjs: flags still present in args win; otherwise the launcher's ctx.output stands.
  const hasOutputFlag = args.some((token) => OUTPUT_FLAGS.has(token));
  const parsed = hasOutputFlag ? parseOutputFlags(args) : { options: {}, rest: args };
  const options = { ...DEFAULT_OPTIONS, ...(ctx.output || {}), ...parsed.options };
  const rest = parsed.rest;
  const flag = rest.find((token) => String(token).startsWith("-"));
  if (flag) throw invalid(`unknown option for context window: ${flag}`);
  if (rest.length > 1) throw invalid("usage: agentlas context window [--json] [<chat-or-session>]");
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  const found = inspector.resolveChat(db, rest[0]);
  if (found.error) {
    const error = new Error(found.error.message);
    error.code = found.error.code;
    if (found.error.matches) error.details = { matches: found.error.matches };
    throw error;
  }
  if (scope.occurrenceId !== undefined) {
    const source = inspector.getContextSource(db, found.chat.id, scope.occurrenceId);
    if (source.status !== "ok" || (scope.requestId !== undefined && source.requestId !== scope.requestId)) throw invalid("context source not found in this chat/request");
    const sourceSchema = { idField: "occurrenceId", columns: [], serialize: item => item,
      renderHuman: result => result.data.original === "retained" ? result.data.text : result.data.original };
    const text = render(single(source, sourceSchema), options);
    if (text) ctx.out(text); return 0;
  }
  const snapshot = inspector.inspectChat(db, found.chat.id, scope);
  const chat = { id: found.chat.id, title: found.chat.title || "" };
  const result = single({ schemaVersion: inspector.SCHEMA, snapshot, chat }, schema(ko));
  const text = render(result, options);
  if (text) ctx.out(text);
  return 0;
}

module.exports = { run, isContextWindowInvocation };
