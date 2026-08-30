"use strict";
/*
 * mcp — 등록된 MCP 서버 목록 + stdio 연결 프리플라이트.
 *
 *   agentlas mcp             공유 DB의 레지스트리 목록 (기존 동작 유지)
 *   agentlas mcp probe <id>  신뢰 레지스트리 행을 격리 자식 env로 띄워
 *                            initialize→tools/list 핸드셰이크만 확인
 *
 * probe는 engine/mcp 모듈만 쓴다: 서버 정의는 항상 신뢰 레지스트리 행에서
 * 물질화하고(materialize), 자식 env는 agentlas.mcp-child-launch.v1 경계를 따른다.
 * "연결됨"은 툴 호출 성공을 의미하지 않는다 — 프리플라이트일 뿐이다.
 */
const { userDataDir } = require("../core/paths.cjs");
const { materializeTrustedSystemMcpServer } = require("../mcp/inventory.cjs");
const { probeSystemMcpServerConnection } = require("../mcp/probe.cjs");
const {
  DEFAULT_OPTIONS,
  list: outputList,
  render,
  single,
  parseOutputFlags,
  displayWidth,
  terminalTextOf,
} = require("../cli-output.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

function commandError(message, code = "INVALID_ARGUMENT", details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function withOutputFlags(ctx, args) {
  if (!args.some((arg) => OUTPUT_FLAGS.has(arg))) return { ctx, args };
  const parsed = parseOutputFlags(args);
  return {
    ctx: { ...ctx, output: { ...(ctx.output || DEFAULT_OPTIONS), ...parsed.options } },
    args: parsed.rest,
  };
}

function emit(ctx, result) {
  if (typeof ctx.emit === "function") {
    ctx.emit(result);
    return;
  }
  ctx.out(render(result, ctx.output || DEFAULT_OPTIONS));
}

function ansi(options, code, value) {
  const text = String(value);
  return options?.noColor ? text : `\u001b[${code}m${text}\u001b[0m`;
}

function isMachineOutput(ctx) {
  const output = ctx.output || DEFAULT_OPTIONS;
  return output.quiet || output.format === "json" || output.format === "yaml";
}

function mcpListSchema(en) {
  return Object.freeze({
    idField: "id",
    columns: [
      { header: "id", field: "id" },
      { header: en ? "name" : "이름", field: "name" },
    ],
    renderHuman(result, options = {}) {
      const rows = Array.isArray(result.data) ? result.data : [];
      if (!rows.length) {
        return options.noHeaders ? "" : (en ? "No MCP servers registered." : "등록된 MCP 서버가 없습니다.");
      }
      const lines = [];
      if (!options.noHeaders) lines.push(ansi(options, 1, en ? "MCP servers" : "MCP 서버"));
      for (const row of rows) {
        const id = terminalTextOf(row.id, 256);
        const name = terminalTextOf(row.name, 4096);
        const padding = " ".repeat(Math.max(1, 28 - displayWidth(id)));
        lines.push(`  ${ansi(options, 36, id)}${padding}${name}`);
      }
      return lines.join("\n");
    },
  });
}

function mcpProbeSchema(en) {
  return Object.freeze({
    idField: "serverId",
    columns: [
      { header: en ? "server" : "서버", field: "serverId" },
      { header: en ? "status" : "상태", field: "status" },
      { header: en ? "tools" : "툴", field: "toolCount" },
    ],
    renderHuman(result, options = {}) {
      const row = result.data || {};
      const serverId = terminalTextOf(row.serverId, 256);
      const toolCount = Number.isSafeInteger(row.toolCount) ? row.toolCount : 0;
      const status = row.connected ? ansi(options, 32, en ? "connected" : "연결됨") : ansi(options, 31, en ? "failed" : "실패");
      const toolLabel = en ? `${toolCount} tool(s) listed` : `툴 ${toolCount}개 확인`;
      const note = en
        ? "Preflight only: connection readiness does not imply tool-call success."
        : "프리플라이트일 뿐입니다: 연결 준비됨 ≠ 툴 호출 성공.";
      return [
        `${status} ${ansi(options, 1, serverId)} · ${toolLabel}`,
        ansi(options, 2, note),
      ].join("\n");
    },
  });
}

function list(ctx) {
  const en = ctx.lang === "en";
  const db = ctx.db();
  const rows = ctx.tableExists(db, "mcp_servers")
    ? db.prepare("SELECT id, name FROM mcp_servers ORDER BY name").all().map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || ""),
    }))
    : [];
  emit(ctx, outputList(rows, mcpListSchema(en)));
  return 0;
}

async function probe(ctx, args) {
  const en = ctx.lang === "en";
  const ref = String(args[0] || "").trim();
  if (!ref || args.length !== 1 || ref.startsWith("-")) {
    throw commandError(en ? "Usage: agentlas mcp probe <server-id|catalog-id>" : "사용법: agentlas mcp probe <server-id|catalog-id>");
  }
  const db = ctx.db();
  if (!ctx.tableExists(db, "mcp_servers")) {
    throw commandError(en ? "No MCP servers registered." : "등록된 MCP 서버가 없습니다.", "MCP_SERVER_NOT_FOUND");
  }
  // catalog_id는 데스크탑 스키마 열 — 오래된 DB에는 없을 수 있어 방어적으로 조회.
  const byCatalog = ctx.columnExists(db, "mcp_servers", "catalog_id");
  const row = byCatalog
    ? db.prepare("SELECT id, catalog_id, name, name_en, transport, command, args_json, env_keys_json, enabled FROM mcp_servers WHERE id=? OR catalog_id=? LIMIT 1").get(ref, ref)
    : db.prepare("SELECT id, NULL AS catalog_id, name, name_en, transport, command, args_json, env_keys_json, enabled FROM mcp_servers WHERE id=? LIMIT 1").get(ref);
  if (!row) {
    throw commandError(
      en ? `MCP server not found: ${ref}` : `MCP 서버를 찾을 수 없습니다: ${ref}`,
      "MCP_SERVER_NOT_FOUND",
      { serverId: ref },
    );
  }
  const server = materializeTrustedSystemMcpServer(row, { userDataDir: userDataDir() });
  if (!server) {
    // 이유를 지어내지 않는다 — materialize는 비활성/비-stdio/안전하지 않은
    // 정의를 하나의 fail-closed로 접기 때문에 관찰 가능한 사실만 알린다.
    throw commandError(
      en
        ? `'${ref}' is not probe-eligible (disabled, non-stdio transport, or an unsafe runtime definition).`
        : `'${ref}' 은(는) probe 대상이 아닙니다 (비활성, stdio가 아닌 transport, 또는 안전하지 않은 실행 정의).`,
      "MCP_PROBE_INELIGIBLE",
      { serverId: ref },
    );
  }
  if (!isMachineOutput(ctx)) {
    const options = ctx.output || DEFAULT_OPTIONS;
    ctx.out(ansi(options, 2, en
      ? `Probing ${server.catalog_id} (isolated child env, handshake only)…`
      : `${server.catalog_id} 연결 확인 중 (격리 자식 env, 핸드셰이크만)…`));
  }
  const result = await probeSystemMcpServerConnection(server, { userDataDir: userDataDir(), cwd: process.cwd() });
  if (!result.connected) {
    throw commandError(
      en
        ? `MCP probe failed: ${server.catalog_id} · ${result.reason || "connection_failed"}`
        : `MCP 연결 확인 실패: ${server.catalog_id} · ${result.reason || "connection_failed"}`,
      "MCP_PROBE_FAILED",
      { serverId: server.catalog_id, reason: result.reason || "connection_failed" },
    );
  }
  const toolCount = Array.isArray(result.tools) ? result.tools.length : 0;
  emit(ctx, single({
    serverId: server.catalog_id,
    status: "connected",
    connected: true,
    reason: result.reason || "connected",
    toolCount,
  }, mcpProbeSchema(en)));
  return 0;
}

function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  const [sub, ...rest] = args;
  if (!sub) return list(ctx);
  // 무인자 기본 동작이 목록인데 이름으로 부르면 거부되는 비대칭이 있었다
  // (2026-08-05 감사 결함 G): 다른 명령들(cloud list, plugin list)이 만든
  // "list를 붙이는" 습관이 여기서만 usage 오류가 됐다.
  if (sub === "list" || sub === "ls") {
    if (rest.length) {
      throw commandError(ctx.lang === "en" ? "Usage: agentlas mcp list" : "사용법: agentlas mcp list");
    }
    return list(ctx);
  }
  if (sub === "probe") return probe(ctx, rest);
  const en = ctx.lang === "en";
  throw commandError(en
    ? `unknown mcp subcommand: ${sub} (available: list · probe)`
    : `알 수 없는 mcp 하위 명령: ${sub} (사용 가능: list · probe)`);
}

module.exports = { run };
