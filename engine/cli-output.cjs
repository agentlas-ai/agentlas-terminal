"use strict";
/*
 * CLI 출력 계약 — 명령은 **문자열이 아니라 {데이터 + 스키마}** 를 돌려준다.
 *
 * 왜(2026-08-08, Paseo CLI 대조 실측):
 * 우리 명령들은 각자 `ctx.out("...")` 로 직접 찍었다. 그래서
 *  · `--json` 이 어떤 명령엔 있고 어떤 명령엔 없다,
 *  · 에러 형식이 명령마다 다르다,
 *  · 스크립트가 쓰려면 사람용 문장을 파싱해야 한다.
 *
 * Paseo CLI(`packages/cli/src/output/`)는 명령이 `{type,data,schema}` 를 반환하고
 * 렌더러 하나가 `--json/--yaml/--quiet/--no-color/--no-headers` 를 해석한다.
 * 그 계약을 그대로 가져온다. 규칙 셋:
 *
 *  1. **quiet 이 모든 것을 이긴다.** `--quiet` 는 id 만 한 줄씩 — `xargs` 로 바로 흐른다.
 *  2. **에러도 같은 형식 규율을 따른다.** `--json` 이면 `{"error":{"code","message"}}`.
 *     사람용이면 빨간 `Error: `.
 *  3. **색은 옵션이 정한다.** 명령이 직접 ANSI 를 박지 않는다(파이프 오염 금지).
 *
 * 이 파일은 의존성이 없다(테스트가 순수 함수로 검증한다).
 */

/** @typedef {"table"|"json"|"yaml"} OutputFormat */

const DEFAULT_OPTIONS = Object.freeze({
  format: "table",
  quiet: false,
  noHeaders: false,
  noColor: false,
});

/** 명령이 돌려주는 단일 항목 결과. */
function single(data, schema) {
  return { type: "single", data, schema };
}

/** 명령이 돌려주는 목록 결과. */
function list(data, schema) {
  return { type: "list", data: Array.isArray(data) ? data : [], schema };
}

function isResult(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value.type === "single" || value.type === "list") &&
      value.schema &&
      Array.isArray(value.schema.columns),
  );
}

function rowsOf(result) {
  return result.type === "list" ? result.data : [result.data];
}

function readField(item, field) {
  if (typeof field === "function") return field(item);
  if (item && typeof item === "object") return item[field];
  return undefined;
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function terminalTextOf(value, maxLength = Number.POSITIVE_INFINITY) {
  const text = textOf(value);
  if (typeof text !== "string") return "";
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, maxLength);
}

/**
 * 표시 폭 — ANSI 를 벗기고, CJK 전각을 2칸으로 센다.
 * 한글 표가 어긋나던 이유가 이것이다(폭을 문자 수로 세면 열이 밀린다).
 */
function displayWidth(value) {
  const plain = terminalTextOf(value);
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padTo(value, width, align) {
  const pad = Math.max(0, width - displayWidth(value));
  if (align === "right") return " ".repeat(pad) + value;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + value + " ".repeat(pad - left);
  }
  return value + " ".repeat(pad);
}

function renderQuiet(result) {
  const idField = result.schema.idField;
  return rowsOf(result)
    .map((item) => terminalTextOf(readField(item, idField)))
    .filter((line) => line.length > 0)
    .join("\n");
}

function renderJson(result) {
  const serialize = result.schema.serialize;
  const project = (item) => (serialize ? serialize(item) : item);
  const payload = result.type === "list" ? result.data.map(project) : project(result.data);
  return JSON.stringify(payload, null, 2);
}

/** 의존성 없이 쓰는 최소 YAML(스칼라·객체·배열 1단계). */
function renderYaml(result) {
  const serialize = result.schema.serialize;
  const project = (item) => (serialize ? serialize(item) : item);
  const scalar = (value) => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    const text = textOf(value);
    // YAML implicitly retypes unquoted strings such as yes/null/001/dates.
    // Machine output must round-trip the command result without changing a
    // string into a boolean, null, number, or timestamp. Conservatively leave
    // only unambiguous word/path-like strings plain; JSON quoting is valid YAML.
    const ambiguousWord = /^(?:~|null|true|false|yes|no|on|off|[-+]?\.?(?:inf|nan))$/i.test(text);
    return /^[A-Za-z_./][\w./:@-]*$/.test(text) && !ambiguousWord ? text : JSON.stringify(text);
  };
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
  const assertBoundedTree = (root) => {
    let nodes = 0;
    const visit = (value, ancestors, depth) => {
      if ((!isObject(value) && !Array.isArray(value)) || value instanceof Date) return;
      if (depth > 64) throw new TypeError("YAML output exceeds the maximum nesting depth");
      if (ancestors.has(value)) throw new TypeError("YAML output contains a circular reference");
      nodes += 1;
      if (nodes > 100_000) throw new TypeError("YAML output contains too many nodes");
      const next = new Set(ancestors);
      next.add(value);
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, next, depth + 1);
    };
    visit(root, new Set(), 0);
  };
  const objectLines = (object, indent) => {
    const pad = " ".repeat(indent);
    const entries = Object.entries(object);
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, value]) => {
      const renderedKey = scalar(key);
      if (isObject(value) || Array.isArray(value)) {
        const nested = value.length === 0 ? [`${pad}  ${Array.isArray(value) ? "[]" : "{}"}`] : valueLines(value, indent + 2);
        if (nested.length === 1 && /^(?:\{\}|\[\])$/.test(nested[0].trim())) return [`${pad}${renderedKey}: ${nested[0].trim()}`];
        return [`${pad}${renderedKey}:`, ...nested];
      }
      return [`${pad}${renderedKey}: ${scalar(value)}`];
    });
  };
  const valueLines = (value, indent) => {
    const pad = " ".repeat(indent);
    if (Array.isArray(value)) {
      if (!value.length) return [`${pad}[]`];
      return value.flatMap((entry) => {
        if (isObject(entry)) {
          const nested = objectLines(entry, indent + 2);
          return [`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1)];
        }
        if (Array.isArray(entry)) {
          const nested = valueLines(entry, indent + 2);
          return [`${pad}-`, ...nested];
        }
        return [`${pad}- ${scalar(entry)}`];
      });
    }
    if (isObject(value)) return objectLines(value, indent);
    return [`${pad}${scalar(value)}`];
  };
  const payload = result.type === "list" ? result.data.map(project) : project(result.data);
  assertBoundedTree(payload);
  if (result.type === "list" && result.data.length === 0) return "[]";
  return valueLines(payload, 0).join("\n");
}

function renderTable(result, options) {
  const columns = result.schema.columns;
  const rows = rowsOf(result);
  if (rows.length === 0) return "";
  const cells = rows.map((item) =>
    columns.map((column) => terminalTextOf(readField(item, column.field))),
  );
  const widths = columns.map((column, index) =>
    Math.max(
      options.noHeaders ? 0 : displayWidth(terminalTextOf(column.header)),
      ...cells.map((row) => displayWidth(row[index] ?? "")),
    ),
  );
  const lines = [];
  if (!options.noHeaders) {
    lines.push(
      columns
        .map((column, index) => padTo(terminalTextOf(column.header).toUpperCase(), widths[index], column.align))
        .join("  ")
        .trimEnd(),
    );
  }
  for (const row of cells) {
    lines.push(
      columns
        .map((column, index) => padTo(row[index] ?? "", widths[index], column.align))
        .join("  ")
        .trimEnd(),
    );
  }
  return lines.join("\n");
}

/** 형식 선택은 여기 한 곳. quiet 이 언제나 이긴다. */
function render(result, options = {}) {
  if (!isResult(result)) {
    throw new TypeError("render() expects a {type,data,schema} command result");
  }
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (opts.quiet) return renderQuiet(result);
  if (opts.format === "json") return renderJson(result);
  if (opts.format === "yaml") return renderYaml(result);
  if (typeof result.schema.renderHuman === "function") return result.schema.renderHuman(result, opts);
  return renderTable(result, opts);
}

/** 무엇이든 구조화 에러로. code 는 기계가 분기할 값이다. */
function toCommandError(error) {
  if (error && typeof error === "object" && typeof error.code === "string" && typeof error.message === "string") {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof Error) {
    return { code: "unknown_error", message: error.message, ...(error.stack ? { details: error.stack } : {}) };
  }
  return { code: "unknown_error", message: String(error) };
}

/** 에러도 같은 형식 규율을 따른다 — 사람용만 색을 쓴다. */
function renderError(error, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const commandError = toCommandError(error);
  if (opts.format === "json") return JSON.stringify({ error: commandError }, null, 2);
  if (opts.format === "yaml") {
    return ["error:", `  code: ${JSON.stringify(commandError.code)}`, `  message: ${JSON.stringify(commandError.message)}`].join("\n");
  }
  const prefix = opts.noColor ? "Error: " : "[31mError: [0m";
  const safeMessage = terminalTextOf(commandError.message, 8192);
  return commandError.details && typeof commandError.details === "string" && opts.format === "table"
    ? `${prefix}${safeMessage}`
    : `${prefix}${safeMessage}`;
}

/**
 * argv 에서 전역 출력 플래그를 뜯어낸다. **모든 명령이 같은 이름·같은 의미**를 갖도록
 * 파서가 한 곳이다(명령마다 --json 유무가 갈리던 것을 막는다).
 *
 * 색 규칙은 clig.dev 를 따른다: `NO_COLOR` 환경변수, `--no-color`, 그리고 TTY 가
 * 아니면 자동으로 끈다(파이프에 ANSI 를 흘리지 않는다).
 */
function parseOutputFlags(argv, env = process.env, isTty = Boolean(process.stdout.isTTY)) {
  const rest = [];
  const options = { ...DEFAULT_OPTIONS };
  let sawJson = false;
  let sawYaml = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (token === "--json") {
      sawJson = true;
      options.format = "json";
    }
    else if (token === "--yaml") {
      sawYaml = true;
      options.format = "yaml";
    }
    else if (token === "--quiet" || token === "-q") options.quiet = true;
    else if (token === "--no-headers") options.noHeaders = true;
    else if (token === "--no-color") options.noColor = true;
    else rest.push(token);
  }
  if (sawJson && sawYaml) {
    const error = new Error("--json and --yaml cannot be used together");
    error.code = "INVALID_ARGUMENT";
    error.details = { flags: ["--json", "--yaml"] };
    throw error;
  }
  if (env && (env.NO_COLOR || env.AGENTLAS_NO_COLOR)) options.noColor = true;
  if (!isTty) options.noColor = true;
  return { options, rest };
}

/** 사람용 표현이 스피너·배너를 써도 되는가(비대화형이면 평문으로 떨어진다). */
function isRichUi(options, isTty = Boolean(process.stdout.isTTY)) {
  return Boolean(isTty) && options.format === "table" && !options.quiet;
}

module.exports = {
  DEFAULT_OPTIONS,
  single,
  list,
  isResult,
  render,
  renderError,
  toCommandError,
  parseOutputFlags,
  isRichUi,
  displayWidth,
  terminalTextOf,
};
