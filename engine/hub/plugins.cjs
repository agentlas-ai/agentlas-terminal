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

// 데스크탑 hub-plugin-bridge.ts:38 REPO_PAGE_HOSTS 동형 — 저장소/패키지 HTML 페이지
// 호스트. 데스크탑은 npm/pypi 패키지 페이지도 엔드포인트가 아니라고 본다.
const PLUGIN_REPO_PAGE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
]);

/**
 * 데스크탑 isLikelyRemoteMcpEndpoint 동형 (electron/mcp-tools/hub-plugin-bridge.ts:61):
 * https 필수, 저장소/패키지 HTML 페이지 호스트는 거부. v1 터미널은 http://도 원격
 * 엔드포인트로 수용했지만 현 데스크탑 모델은 평문 원격 MCP 등록을 허용하지 않는다.
 */
function pluginIsLikelyRemoteMcpEndpoint(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (PLUGIN_REPO_PAGE_HOSTS.has(url.hostname.toLowerCase())) return false;
  return true;
}

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

/**
 * 휴리스틱: 명시적 transport 선언이 없는 레거시 source URL이 진짜 MCP 엔드포인트로 보이는가.
 * 데스크탑 hub-plugin-bridge.ts:94 동형 — https 엔드포인트이면서 경로가 명시적으로
 * MCP(/mcp, /sse)를 가리킬 때만 신뢰한다. v1의 "mcp.* 호스트면 경로 없이 수용" 완화는
 * 데스크탑 모델에 없다(호스트명만으로 엔드포인트를 추정하지 않는다).
 */
function pluginLooksLikeMcpEndpoint(rawUrl) {
  if (!pluginIsLikelyRemoteMcpEndpoint(rawUrl)) return false;
  return /\/(mcp|sse)(?:$|[/?#])/.test(String(rawUrl));
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
    // 명시 선언이어도 데스크탑과 동일하게 isLikelyRemoteMcpEndpoint를 통과해야 한다
    // (hub-plugin-bridge.ts:90) — https 필수, 저장소/패키지 페이지 호스트 거부.
    if (!pluginIsLikelyRemoteMcpEndpoint(url)) {
      return refuse("URL is not a usable remote MCP endpoint (https required; repo/package pages are docs)");
    }
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

/**
 * 정규화된 행들을 로컬 mcp_servers 스키마에 멱등 삽입.
 * { installed, reused, needsApproval } 반환.
 *
 * 데스크탑 hub-plugin-bridge.ts:209-228 동형(자율 경계, 2026-07-23 재설계):
 * stdio(로컬 프로세스 실행 = 원격 메타데이터발 코드 실행)는 절대 자동 활성화하지
 * 않는다 — enabled=0으로 등록하고 승인 필요로 정직하게 표면화한다. 이 테이블은
 * 데스크탑과 공유되므로, 터미널이 enabled=1로 넣으면 데스크탑 런타임 구성이
 * 승인 게이트 없이 그 로컬 프로세스를 실행하게 된다. http/sse 원격 연결만
 * 자동 활성화한다(네트워크 연결일 뿐 로컬 실행이 없다).
 */
function installPluginMcpRows(db, rows) {
  let installed = 0;
  let reused = 0;
  const needsApproval = [];
  for (const row of rows) {
    const stdioNeedsApproval = row.transport === "stdio";
    const existing = db.prepare("SELECT id FROM mcp_servers WHERE catalog_id = ? LIMIT 1").get(row.catalogId);
    if (existing) { reused += 1; continue; } // 멱등: 재설치가 중복 행을 만들지 않는다
    db.prepare(
      `INSERT INTO mcp_servers (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.catalogId, row.name, row.name, row.transport,
      row.command, row.argsJson, row.url, row.envKeysJson,
      stdioNeedsApproval ? 0 : 1, new Date().toISOString(),
    );
    installed += 1;
    if (stdioNeedsApproval) needsApproval.push(row.name);
  }
  return { installed, reused, needsApproval };
}

/** Hub 플러그인 카탈로그 목록 (marketplace.list_plugins). 실패는 그대로 throw — 폴백 카탈로그 금지. */
async function listHubPlugins({ callTool } = {}) {
  const call = callTool || callHubTool;
  const result = await call("marketplace.list_plugins", {});
  return (result && (result.plugins || result.results)) || [];
}

module.exports = {
  PLUGIN_CODE_HOSTING_HTML_RE,
  PLUGIN_REPO_PAGE_HOSTS,
  fetchPluginManifest,
  pluginIsLikelyRemoteMcpEndpoint,
  pluginLooksLikeMcpEndpoint,
  pluginMcpRow,
  planPluginMcpInstall,
  installPluginMcpRows,
  listHubPlugins,
};
