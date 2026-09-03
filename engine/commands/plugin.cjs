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
  planPluginSkillInstall,
  installPluginSkills,
  listInstalledLocalPlugins,
} = require("../hub/plugins.cjs");
const { webBaseUrl } = require("../cloud/hub-client.cjs");
const { terminalProjectCandidateCli, initializedAgentlasProjectPathCli } = require("../project/state.cjs");
const {
  DEFAULT_OPTIONS,
  list: outputList,
  render,
  parseOutputFlags,
  terminalTextOf,
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

function isMachineOutput(ctx) {
  const output = ctx.output || DEFAULT_OPTIONS;
  return output.quiet || output.format === "json" || output.format === "yaml";
}

function emitMachinePluginList(ctx, rows) {
  const schema = {
    idField: "slug",
    columns: [
      { header: "slug", field: "slug" },
      { header: "name", field: "name" },
      { header: "installed", field: "installed" },
    ],
  };
  const result = outputList(rows, schema);
  if (typeof ctx.emit === "function") ctx.emit(result);
  else ctx.out(render(result, ctx.output || DEFAULT_OPTIONS));
}

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
  // 스킬 번들 절반 — 실콘텐츠(files[])가 실린 스킬은 ~/.agentlas/plugins/<slug>/ 에
  // 파일로 착지한다(오너 결정 2026-08-20: 플러그인 = MCP와 별개의 능력 패키지).
  const skillPlan = planPluginSkillInstall(slug, manifest);
  const docsLink = manifest.docs || manifest.source?.repo || manifest.source?.homepage || null;
  if (!rows.length && !skillPlan.skills.length) {
    const reasonLines = [
      ...refused.map((item) => `  ✗ ${item.name}: ${item.reason}${item.source ? ` (${item.source})` : ""}`),
      ...skillPlan.refused.map((item) => `  ✗ skill ${item.name}: ${item.reason}`),
      ...(skillPlan.declaredOnly.length
        ? [`  ✗ skills declared without content payloads: ${skillPlan.declaredOnly.join(", ")}`]
        : []),
    ];
    ctx.err(
      [
        `${slug} ships no machine-connectable MCP endpoint and no installable skill payload. Nothing was installed.`,
        ...reasonLines,
        docsLink ? `  docs: ${docsLink} (upstream project page — not an MCP endpoint)` : null,
        "  When the catalog gains verified connection info or skill payloads for this plugin, re-run: agentlas plugin add " + slug,
      ].filter(Boolean).join("\n"),
    );
    return 1;
  }
  let installed = 0, reused = 0, needsApproval = [];
  if (rows.length) {
    try {
      ({ installed, reused, needsApproval } = installPluginMcpRows(ctx.db(), rows));
    } catch (e) {
      ctx.err(String((e && e.message) || e));
      return 1;
    }
  }
  let skillResult = null;
  if (skillPlan.skills.length) {
    skillResult = installPluginSkills(slug, skillPlan, {
      manifestUrl: `${webBaseUrl()}/api/plugins/${encodeURIComponent(slug)}`,
      meta: { name: manifest.name, family: manifest.family, version: manifest.version },
    });
    if (!skillResult.installed.length && !rows.length) {
      // 스킬만 실린 매니페스트인데 하나도 못 썼다 — 조용한 성공 금지.
      for (const item of skillResult.failed) ctx.err(`  ✗ skill ${item.name}: ${item.reason}`);
      ctx.err(`${slug}: no skill could be installed.`);
      return 1;
    }
  }
  ctx.out(`${ctx.ui.green("✓")} Plugin installed ${ctx.ui.accent(manifest.slug)} — ${manifest.name}`);
  for (const item of refused) {
    ctx.out(`  ⚠ skipped ${item.name}: ${item.reason}${item.source ? ` (${item.source})` : ""}`);
  }
  if (rows.length) {
    ctx.out(`  MCP servers: ${installed} added${reused ? `, ${reused} already present` : ""}`);
  }
  // 데스크탑 hub-plugin-bridge.ts 동형: stdio는 비활성 등록 + 승인 필요 표면화.
  for (const name of needsApproval || []) {
    ctx.out(`  ⚠ needs-approval ${name}: local execution requires one-click approval in MCP settings`);
  }
  if (skillResult) {
    ctx.out(`  skills installed: ${skillResult.installed.join(", ")} → ${skillResult.dir}`);
    if (!skillResult.verified) {
      ctx.out(ctx.ui.dim("  (no content hash declared — manifest URL recorded as provenance)"));
    }
    for (const item of skillResult.failed) {
      ctx.out(`  ⚠ skipped skill ${item.name}: ${item.reason}`);
    }
  }
  if (skillPlan.declaredOnly.length) {
    ctx.out(`  skills declared (no payload yet): ${skillPlan.declaredOnly.join(", ")}`);
  }
  const authKind = manifest.auth?.kind;
  if (authKind && authKind !== "none") {
    ctx.out(`  ⚠ Requires ${authKind} — set credentials before use (agentlas creds).`);
  }
  if (rows.length) {
    ctx.out(ctx.ui.dim("  Only full-access turns wire active stdio servers into the runtime (agentlas mcp)."));
  }
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
    if (isMachineOutput(ctx)) emitMachinePluginList(ctx, []);
    else ctx.out("No Hub plugins are available.");
    return 0;
  }
  // 설치 여부는 ~/.agentlas/plugins/<slug>/plugin.json 마커(3채널 공유 규약)로 판정한다.
  const installedSlugs = new Set(listInstalledLocalPlugins().map((entry) => entry.slug.toLowerCase()));
  const rows = plugins.slice(0, 60).map((plugin) => ({
    slug: String(plugin.slug || ""),
    name: String(plugin.name || "").slice(0, 44),
    installed: installedSlugs.has(String(plugin.slug || "").toLowerCase()),
  }));
  if (isMachineOutput(ctx)) {
    if (ctx.output?.quiet) {
      ctx.out(rows.map((row) => terminalTextOf(row.slug, 256)).filter(Boolean).join("\n"));
    } else {
      emitMachinePluginList(ctx, rows);
    }
    return 0;
  }
  const accent = ctx.output?.noColor ? (value) => String(value) : ctx.ui.accent;
  const green = ctx.output?.noColor ? (value) => String(value) : ctx.ui.green;
  const dim = ctx.output?.noColor ? (value) => String(value) : ctx.ui.dim;
  for (const row of rows) {
    const installedMark = row.installed ? green(" [installed]") : "";
    const plugin = row;
    const slugText = plugin.slug;
    const nameText = plugin.name;
    ctx.out(`${accent(slugText.padEnd(32).slice(0, 32))} ${nameText}${installedMark}`);
  }
  ctx.out("");
  ctx.out(dim("Install: agentlas plugin add <slug>"));
  return 0;
}

async function pluginListWithProject(ctx, projectPath) {
  const root = terminalProjectCandidateCli(projectPath);
  if (!root) {
    ctx.err(`project path is invalid or not safe: ${projectPath}`);
    return 1;
  }
  if (!initializedAgentlasProjectPathCli(root)) {
    ctx.err("project is not initialized for plugin listing. Run `agentlas project init` in that folder first.");
    return 1;
  }
  if (!isMachineOutput(ctx)) {
    ctx.out("Scope: global Hub plugin catalog (project compatibility and local installation state are not evaluated).");
  }
  return pluginList(ctx);
}

function parsePluginListFlags(args) {
  const flags = {
    global: false,
    project: null,
    errors: [],
    positionals: [],
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--global") {
      if (seen.has("global")) {
        flags.errors.push("duplicate flag: --global");
        return flags;
      }
      seen.add("global");
      flags.global = true;
      continue;
    }
    if (arg === "--project") {
      if (seen.has("project")) {
        flags.errors.push("duplicate flag: --project");
        return flags;
      }
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        flags.errors.push("usage: agentlas plugin list --project <path>");
        return flags;
      }
      seen.add("project");
      flags.project = next;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.errors.push("usage: agentlas plugin list [--global | --project <path>]");
      return flags;
    }
    if (arg.startsWith("--")) {
      flags.errors.push(`unknown flag: ${arg}`);
      return flags;
    }
    flags.positionals.push(arg);
  }
  if (flags.project && flags.global) {
    flags.errors.push("cannot use --project and --global together");
  }
  if (flags.positionals.length > 0) {
    flags.errors.push("usage: agentlas plugin list [--global | --project <path>]");
  }
  return flags;
}

async function runPluginList(ctx, args) {
  const flags = parsePluginListFlags(args);
  if (flags.errors.length) {
    ctx.err(flags.errors[0]);
    return 1;
  }
  if (flags.project) return pluginListWithProject(ctx, flags.project);
  return pluginList(ctx);
}

function run(ctx, args) {
  let normalized;
  try {
    normalized = withOutputFlags(ctx, args);
  } catch (error) {
    if (typeof ctx.fail === "function") ctx.fail(error);
    else ctx.err(String((error && error.message) || error));
    return 1;
  }
  ctx = normalized.ctx;
  args = normalized.args;
  const action = args[0];
  // SELF_HELP_COMMANDS 계약(index.cjs): `plugin --help` 는 여기로 ["help"] 가 되어
  // 들어온다. help 분기가 없으면 unknown action → usage exit 1 이라, 도움말을
  // 요청한 사용자가 오류 코드를 받는다.
  if ((action === "help" || action === "--help" || action === "-h") && args.length === 1) {
    const ko = ctx.lang !== "en";
    ctx.out(ko
      ? [
        "agentlas plugin — Hub 플러그인(MCP 서버)",
        "  plugin list [--project <경로>]   설치 가능/설치된 플러그인 목록",
        "  plugin add <slug>               플러그인 설치 (slug는 list에서 확인)",
        "",
        "  연결 확인: agentlas mcp probe <server-id>",
      ].join("\n")
      : [
        "agentlas plugin — Hub plugins (MCP servers)",
        "  plugin list [--project <path>]   list available/installed plugins",
        "  plugin add <slug>               install a plugin (find slugs via list)",
        "",
        "  Check a connection with: agentlas mcp probe <server-id>",
      ].join("\n"));
    return 0;
  }
  if (action === "add") {
    if (args.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(args[1] || ""))) {
      ctx.err("usage: agentlas plugin add <slug>   (run agentlas plugin list first)");
      return 1;
    }
    return pluginAdd(ctx, args[1]);
  }
  if (action === "list" || !action) {
    const rest = action === "list" ? args.slice(1) : [];
    return runPluginList(ctx, rest);
  }
  ctx.err("usage: agentlas plugin add <slug> | agentlas plugin list");
  return 1;
}

module.exports = {
  run,
  parsePluginListFlags,
};
