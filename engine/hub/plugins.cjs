"use strict";
/*
 * hub/plugins — Hub 플러그인 매니페스트 조회 + MCP 행 정규화 + 멱등 설치.
 *
 * 배경(v1 주석 승계): 서버는 처음부터 준비돼 있었다 — /api/plugins/<slug>가
 * agentlas.plugin/v1 매니페스트를 주고, 그 라우트 주석이 이 CLI
 * (`agentlas plugin add <slug>`)를 소비자로 지목한다. 그런데 이 명령이 구현된 적이
 * 없어서, 카탈로그 146개가 전부 "존재하지 않는 설치 명령"을 광고하고 있었다.
 * (`agentlas install`은 marketplace.get_manifest{kind:"agent"} 고정이라 플러그인엔 안 먹는다.)
 *
 * 이 파일의 transport 정규화 규칙은 런타임 전멸 사고들의 근본수리다 — 약화 금지:
 *  - 2026-07-23: 레포/홈페이지 HTML URL이 transport:"http" MCP 행으로 등록되어
 *    "절대 연결될 수 없는 MCP 서버"가 생기던 사고.
 *  - codex config.toml: 원격은 URL, stdio는 실행 커맨드. 둘을 섞으면 스키마 위반으로
 *    런타임이 통째로 죽는다(Runtime Doctor가 반복해서 잡던 사고 계열).
 */
const crypto = require("node:crypto");
const { callHubTool, fetchHub, parseHubJson, webBaseUrl } = require("../cloud/hub-client.cjs");

// 레포/홈페이지 HTML 페이지는 문서지 MCP 연결이 아니다. 이 URL들을 transport:"http"로
// 등록하면 "절대 연결될 수 없는 MCP 서버"가 생긴다(2026-07-23 근본수리 계열).
const PLUGIN_CODE_HOSTING_HTML_RE = /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//i;

/** Hub 플러그인 매니페스트 조회. 404 → null, 스키마 불일치/HTTP 오류 → throw. */
async function fetchPluginManifest(slug, { fetch: fetchImpl } = {}) {
  const resp = await fetchHub(`${webBaseUrl()}/api/plugins/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
  }, { fetch: fetchImpl });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`plugin lookup failed with HTTP ${resp.status}`);
  const manifest = parseHubJson(resp, "plugin manifest");
  if (!manifest || manifest.schema !== "agentlas.plugin/v1") {
    throw new Error(`Unexpected plugin manifest schema for ${slug}.`);
  }
  return manifest;
}

/** 휴리스틱: 명시적 transport 선언이 없는 레거시 source URL이 진짜 MCP 엔드포인트로 보이는가. */
function pluginLooksLikeMcpEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (PLUGIN_CODE_HOSTING_HTML_RE.test(parsed.href)) return false;
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (/\/(mcp|sse)$/i.test(pathname)) return true; // …/mcp, …/sse 관례
  if (/^mcp\./i.test(parsed.hostname)) return true; // mcp.linear.app 류 전용 호스트
  return false;
}

/**
 * 매니페스트의 mcp[] 항목을 mcp_servers 행으로 정규화. stdio(command)와 remote(url)를 구분한다.
 * 반환: { row } | { refused: { name, source, reason } } | null(빈 항목).
 *
 * 규칙(근본수리): 레포 URL은 어떤 경우에도 transport:"http" 행으로 쓰이지 않는다.
 *  - transport:"stdio" + command 명시 → stdio 행 (mcp_servers는 command/args_json을 이미 지원).
 *  - transport:"http" + url 명시 → http 행. 단 코드호스팅 HTML 페이지(github.com/…)면 거부.
 *  - 레거시 {name, source}: http(s)면 MCP 엔드포인트로 보일 때만(…/mcp, …/sse, mcp.* 호스트) 수용,
 *    아니면 거부. 비-URL 문자열은 기존대로 stdio 실행 커맨드로 해석.
 */
function pluginMcpRow(slug, entry, index) {
  const name = (typeof entry?.name === "string" && entry.name.trim()) || `${slug}-${index + 1}`;
  const source = typeof entry?.source === "string" ? entry.source.trim() : "";
  const transport = typeof entry?.transport === "string" ? entry.transport.trim().toLowerCase() : "";
  const envKeys = Array.isArray(entry?.envKeys)
    ? entry.envKeys.filter((key) => typeof key === "string")
    : entry?.env && typeof entry.env === "object"
      ? Object.keys(entry.env)
      : [];
  const makeRow = (fields) => ({
    row: {
      id: crypto.randomUUID(),
      catalogId: `hub:${slug}:${name}`,
      name,
      envKeysJson: JSON.stringify(envKeys),
      ...fields,
    },
  });
  const refuse = (reason) => ({ refused: { name, source: source || (typeof entry?.url === "string" ? entry.url : ""), reason } });

  if (transport === "stdio") {
    const command = typeof entry?.command === "string" ? entry.command.trim() : "";
    if (!command) return refuse("stdio row without a launch command");
    const args = Array.isArray(entry?.args) ? entry.args.filter((a) => typeof a === "string") : [];
    return makeRow({ transport: "stdio", command, argsJson: JSON.stringify(args), url: null });
  }
  if (transport === "http" || transport === "sse") {
    const url = typeof entry?.url === "string" && entry.url.trim() ? entry.url.trim() : source;
    if (!/^https?:\/\//i.test(url)) return refuse("http row without a usable endpoint URL");
    if (PLUGIN_CODE_HOSTING_HTML_RE.test(url)) {
      return refuse("URL is a code-hosting HTML page (docs), not an MCP endpoint");
    }
    // 명시적 transport 선언은 서버가 검증한 연결정보로 신뢰한다 (레포 페이지만 방어).
    return makeRow({ transport: "http", command: null, argsJson: "[]", url });
  }
  if (transport) return refuse(`unsupported transport "${transport}"`);

  // ── 레거시 {name, source} 행 ──
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    if (!pluginLooksLikeMcpEndpoint(source)) {
      return refuse(
        PLUGIN_CODE_HOSTING_HTML_RE.test(source)
          ? "URL is a code-hosting HTML page (docs), not an MCP endpoint"
          : "URL does not look like an MCP endpoint (no /mcp, /sse, or mcp.* host, and no declared transport)",
      );
    }
    return makeRow({ transport: "http", command: null, argsJson: "[]", url: source });
  }
  // 원격은 URL, stdio는 실행 커맨드다. 둘을 섞으면 codex config.toml 스키마 위반으로
  // 런타임이 통째로 죽는다(Runtime Doctor가 반복해서 잡던 사고 계열).
  const argv = source.split(/\s+/).filter(Boolean);
  return makeRow({ transport: "stdio", command: argv[0] ?? null, argsJson: JSON.stringify(argv.slice(1)), url: null });
}

/** 매니페스트 전체를 설치 계획으로 정규화: 등록할 행과, 정직하게 거부한 항목을 분리한다. */
function planPluginMcpInstall(slug, manifest) {
  const entries = Array.isArray(manifest?.mcp) ? manifest.mcp : [];
  const rows = [];
  const refused = [];
  entries.forEach((entry, index) => {
    const normalized = pluginMcpRow(slug, entry, index);
    if (!normalized) return;
    if (normalized.row) rows.push(normalized.row);
    else if (normalized.refused) refused.push(normalized.refused);
  });
  return { rows, refused };
}

/** 정규화된 행들을 로컬 mcp_servers 스키마에 멱등 삽입. { installed, reused } 반환. */
function installPluginMcpRows(db, rows) {
  let installed = 0;
  let reused = 0;
  for (const row of rows) {
    const existing = db.prepare("SELECT id FROM mcp_servers WHERE catalog_id = ? LIMIT 1").get(row.catalogId);
    if (existing) { reused += 1; continue; } // 멱등: 재설치가 중복 행을 만들지 않는다
    db.prepare(
      `INSERT INTO mcp_servers (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      row.id, row.catalogId, row.name, row.name, row.transport,
      row.command, row.argsJson, row.url, row.envKeysJson, new Date().toISOString(),
    );
    installed += 1;
  }
  return { installed, reused };
}

/** Hub 플러그인 카탈로그 목록 (marketplace.list_plugins). 실패는 그대로 throw — 폴백 카탈로그 금지. */
async function listHubPlugins({ callTool } = {}) {
  const call = callTool || callHubTool;
  const result = await call("marketplace.list_plugins", {});
  return (result && (result.plugins || result.results)) || [];
}

module.exports = {
  PLUGIN_CODE_HOSTING_HTML_RE,
  fetchPluginManifest,
  pluginLooksLikeMcpEndpoint,
  pluginMcpRow,
  planPluginMcpInstall,
  installPluginMcpRows,
  listHubPlugins,
};
