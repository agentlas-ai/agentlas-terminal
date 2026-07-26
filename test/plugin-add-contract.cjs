#!/usr/bin/env node
"use strict";
/*
 * Hub 플러그인 설치 회귀 테스트 — 2026-07-23 "레포 URL이 MCP 서버로 등록되던" 사고 고정.
 *
 * 사고: 서버 매니페스트가 third-party 항목마다 install.sourceUrl(= repo || homepage,
 * 즉 GitHub HTML 페이지)로 mcp 행을 합성했고, 터미널 pluginMcpRowCli는 http(s)면
 * 무조건 transport:"http"로 mcp_servers에 등록했다 → 절대 연결될 수 없는 가짜 MCP 서버.
 * 수리: (1) 서버는 검증된 연결정보만 mcp 행으로 방출(없으면 mcp:[] + docs 링크),
 *      (2) 터미널은 레포/홈페이지 HTML URL을 어떤 경로로도 http 서버로 등록하지 않고
 *          정직하게 거부, (3) transport:"stdio" 행은 command/args로 stdio 서버 설치.
 */

const assert = require("node:assert/strict");
// v2: 엔트리 심볼만 이관 — hub/plugins.cjs가 Cli 접미사 없이 같은 계약을 export한다.
const {
  pluginMcpRow: pluginMcpRowCli,
  planPluginMcpInstall: planPluginMcpInstallCli,
  installPluginMcpRows: installPluginMcpRowsCli,
  pluginLooksLikeMcpEndpoint: pluginLooksLikeMcpEndpointCli,
} = require("../engine/hub/plugins.cjs");

// ── 1. 레거시 {name, source}가 레포/홈페이지 URL이면 거부 (절대 http 행이 되면 안 된다) ──
for (const source of [
  "https://github.com/stripe/agent-toolkit",
  "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack",
  "https://gitlab.com/example/repo",
  "https://bitbucket.org/example/repo",
  "https://www.mongodb.com/products/tools/mcp-server", // 홈페이지 HTML — MCP 관례 신호 없음
]) {
  const result = pluginMcpRowCli("demo", { name: "demo", source }, 0);
  assert.ok(result && result.refused, `repo/homepage URL must be refused: ${source}`);
  assert.ok(!result.row, `repo/homepage URL must never become a row: ${source}`);
}

// ── 2. 명시적 transport:"http"라도 코드호스팅 HTML 페이지면 거부 (방어층) ──
{
  const result = pluginMcpRowCli("demo", { name: "demo", transport: "http", url: "https://github.com/example/repo" }, 0);
  assert.ok(result.refused, "explicit http transport with a github page must still be refused");
}

// ── 3. 진짜 http(s) MCP 엔드포인트는 계속 동작 ──
for (const url of [
  "https://mcp.linear.app/sse",
  "https://mcp.sentry.dev/mcp",
  "https://api.githubcopilot.com/mcp/",
  "https://mcp.atlassian.com/v1/sse",
]) {
  assert.equal(pluginLooksLikeMcpEndpointCli(url), true, `must look like an MCP endpoint: ${url}`);
  const legacy = pluginMcpRowCli("demo", { name: "demo", source: url }, 0);
  assert.ok(legacy.row, `legacy endpoint URL must install: ${url}`);
  assert.equal(legacy.row.transport, "http");
  assert.equal(legacy.row.url, url);
  assert.equal(legacy.row.command, null);
}
// 명시적 transport 선언은 접미사 관례가 없어도 신뢰 (예: https://mcp.vercel.com)
{
  const result = pluginMcpRowCli("vercel", { name: "vercel", transport: "http", url: "https://mcp.vercel.com" }, 0);
  assert.ok(result.row, "explicitly declared http endpoint must install");
  assert.equal(result.row.url, "https://mcp.vercel.com");
}

// ── 4. transport:"stdio" 행은 로컬 mcp_servers 스키마 그대로 설치 ──
{
  const result = pluginMcpRowCli(
    "stripe",
    { name: "stripe", transport: "stdio", command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"], envKeys: ["STRIPE_SECRET_KEY"] },
    0,
  );
  assert.ok(result.row, "stdio row must install");
  assert.equal(result.row.transport, "stdio");
  assert.equal(result.row.command, "npx");
  assert.deepEqual(JSON.parse(result.row.argsJson), ["-y", "@stripe/mcp", "--tools=all"]);
  assert.deepEqual(JSON.parse(result.row.envKeysJson), ["STRIPE_SECRET_KEY"]);
  assert.equal(result.row.url, null, "stdio row must not carry a url (codex config.toml url-key kills the runtime)");
  assert.equal(result.row.catalogId, "hub:stripe:stripe");

  // 스텁 DB로 INSERT 컬럼 형태 검증 (멱등성 포함)
  const inserts = [];
  const known = new Set();
  const db = {
    prepare(sql) {
      if (/^SELECT id FROM mcp_servers/.test(sql)) {
        return { get: (catalogId) => (known.has(catalogId) ? { id: "existing" } : undefined) };
      }
      assert.match(sql, /INSERT INTO mcp_servers/);
      return {
        run: (...params) => {
          inserts.push(params);
          known.add(params[1]); // catalog_id
        },
      };
    },
  };
  const first = installPluginMcpRowsCli(db, [result.row]);
  assert.deepEqual(first, { installed: 1, reused: 0 });
  const again = installPluginMcpRowsCli(db, [result.row]);
  assert.deepEqual(again, { installed: 0, reused: 1 }, "re-install must be idempotent");
  const [, catalogId, name, nameEn, transport, command, argsJson, url] = inserts[0];
  assert.equal(catalogId, "hub:stripe:stripe");
  assert.equal(name, "stripe");
  assert.equal(nameEn, "stripe");
  assert.equal(transport, "stdio");
  assert.equal(command, "npx");
  assert.deepEqual(JSON.parse(argsJson), ["-y", "@stripe/mcp", "--tools=all"]);
  assert.equal(url, null);
}

// ── 5. 레거시 비-URL source는 기존대로 stdio 커맨드로 해석 (하위호환) ──
{
  const result = pluginMcpRowCli("demo", { name: "demo", source: "npx -y demo-mcp-server" }, 0);
  assert.ok(result.row);
  assert.equal(result.row.transport, "stdio");
  assert.equal(result.row.command, "npx");
  assert.deepEqual(JSON.parse(result.row.argsJson), ["-y", "demo-mcp-server"]);
}

// ── 6. 매니페스트 단위 계획: 레포 링크뿐인 매니페스트는 rows 0 + 거부 사유 노출 ──
{
  const plan = planPluginMcpInstallCli("slack", {
    mcp: [{ name: "slack", source: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack" }],
  });
  assert.equal(plan.rows.length, 0, "repo-link-only manifest must register nothing");
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0].reason, /docs|not an MCP endpoint/i);

  const mixed = planPluginMcpInstallCli("mixed", {
    mcp: [
      { name: "good", transport: "stdio", command: "npx", args: ["-y", "good-mcp"] },
      { name: "bad", source: "https://github.com/example/repo" },
    ],
  });
  assert.equal(mixed.rows.length, 1);
  assert.equal(mixed.rows[0].name, "good");
  assert.equal(mixed.refused.length, 1);
  assert.equal(mixed.refused[0].name, "bad");

  const empty = planPluginMcpInstallCli("empty", { mcp: [] });
  assert.deepEqual(empty, { rows: [], refused: [] });
}

console.log("plugin-add-contract: OK");
