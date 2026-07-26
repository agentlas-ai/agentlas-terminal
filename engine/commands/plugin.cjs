"use strict";
/*
 * plugin — `agentlas plugin add <slug>` / `agentlas plugin list`.
 * 기능 로직은 hub/plugins.cjs. v1 cmdPluginAdd/cmdPluginList의 출력 계약 유지:
 *  - 설치할 MCP 서버가 없으면 조용히 성공했다고 하지 않는다 — 사용자는 이 플러그인이
 *    붙었다고 믿고 도구를 기대하게 된다. 레포 URL을 http MCP 서버로 등록하는 일도
 *    절대 하지 않는다(연결 불가능한 가짜 서버).
 */
const {
  fetchPluginManifest,
  planPluginMcpInstall,
  installPluginMcpRows,
  listHubPlugins,
} = require("../hub/plugins.cjs");

async function pluginAdd(ctx, slug) {
  if (!slug) {
    ctx.err("usage: agentlas plugin add <slug>   (run agentlas plugin list first)");
    return 1;
  }
  let manifest;
  try {
    manifest = await fetchPluginManifest(slug);
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  if (!manifest) {
    ctx.err(`Hub plugin not found: ${slug}`);
    return 1;
  }
  const { rows, refused } = planPluginMcpInstall(slug, manifest);
  const docsLink = manifest.docs || manifest.source?.repo || manifest.source?.homepage || null;
  if (!rows.length) {
    const reasonLines = refused.map((item) => `  ✗ ${item.name}: ${item.reason}${item.source ? ` (${item.source})` : ""}`);
    ctx.err(
      [
        `${slug} ships no machine-connectable MCP endpoint yet. Nothing was registered.`,
        ...reasonLines,
        docsLink ? `  docs: ${docsLink} (upstream project page — not an MCP endpoint)` : null,
        "  When the catalog gains verified connection info for this plugin, re-run: agentlas plugin add " + slug,
      ].filter(Boolean).join("\n"),
    );
    return 1;
  }
  let installed, reused;
  try {
    ({ installed, reused } = installPluginMcpRows(ctx.db(), rows));
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  ctx.out(`${ctx.ui.green("✓")} Plugin installed ${ctx.ui.accent(manifest.slug)} — ${manifest.name}`);
  for (const item of refused) {
    ctx.out(`  ⚠ skipped ${item.name}: ${item.reason}${item.source ? ` (${item.source})` : ""}`);
  }
  ctx.out(`  MCP servers: ${installed} added${reused ? `, ${reused} already present` : ""}`);
  const authKind = manifest.auth?.kind;
  if (authKind && authKind !== "none") {
    ctx.out(`  ⚠ Requires ${authKind} — set credentials before use (agentlas creds).`);
  }
  if (Array.isArray(manifest.skills) && manifest.skills.length) {
    ctx.out(`  skills declared: ${manifest.skills.map((skill) => skill.name).filter(Boolean).join(", ")}`);
  }
  ctx.out(ctx.ui.dim("  Only full-access turns wire active stdio servers into the runtime (agentlas mcp)."));
  return 0;
}

async function pluginList(ctx) {
  let plugins;
  try {
    plugins = await listHubPlugins();
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  if (!plugins.length) {
    ctx.out("No Hub plugins are available.");
    return 0;
  }
  for (const plugin of plugins.slice(0, 60)) {
    ctx.out(`${ctx.ui.accent(String(plugin.slug || "").padEnd(32).slice(0, 32))} ${String(plugin.name || "").slice(0, 44)}`);
  }
  ctx.out("");
  ctx.out(ctx.ui.dim("Install: agentlas plugin add <slug>"));
  return 0;
}

function run(ctx, args) {
  const action = args[0];
  if (action === "add") return pluginAdd(ctx, args[1]);
  if (action === "list" || !action) return pluginList(ctx);
  ctx.err("usage: agentlas plugin add <slug> | agentlas plugin list");
  return 1;
}

module.exports = { run };
