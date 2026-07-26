"use strict";
/*
 * cloud-assets/commands — `agentlas cloud …` / `agentlas upload …` 명령 글루.
 *
 * 가시성 계약(v1 문구 그대로 — 절대 완화 금지):
 *  - `cloud save`  = 소유자 전용 저장. --visibility marketplace 는 정확한 v1
 *    오류로 거절한다 ("`agentlas cloud save` is owner-private. …").
 *  - `cloud publish` = 공개 Hub 발행. --visibility private-link 도 거절.
 *  - 최상위 `upload <path>` 는 기본 owner-private save. marketplace 는
 *    명시적 --visibility marketplace 로만 publish가 된다.
 * 오류는 throw → 명령 파일이 ctx.err + return 1 로 처리한다 (process.exit 금지).
 */
const cloudRuntime = require("../agentlas-cloud-runtime.cjs");
const { installHubAgent } = require("../hub/install.cjs");
const { callHubTool, HubError } = require("../cloud/hub-client.cjs");
const { packageCloudAgent } = require("./package.cjs");
const { deleteCloudAgent } = require("./cas.cjs");
const { listOwnedCloudAgents, restoreOwnedCloudAgent } = require("./restore.cjs");

function parseCloudFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function cloudVisibilityFlag(value) {
  if (value == null) return null;
  if (value === "private-link" || value === "marketplace") return value;
  throw new Error("--visibility must be private-link or marketplace");
}

function cloudVisibilityForAction(sub, flags) {
  const explicit = cloudVisibilityFlag(flags.visibility);
  if (sub === "save") {
    if (explicit === "marketplace") {
      // v1 문구 그대로 — save가 조용히 공개 발행으로 승격되는 일은 절대 없다.
      throw new Error("`agentlas cloud save` is owner-private. Use `agentlas cloud publish` for the public Hub.");
    }
    return "private-link";
  }
  if (sub === "publish") {
    if (explicit === "private-link") {
      throw new Error("`agentlas cloud publish` is public Hub publication. Use `agentlas cloud save` for owner-private Agent Cloud storage.");
    }
    return "marketplace";
  }
  if (explicit) return explicit;
  return "private-link";
}

/** 최상위 `upload`의 실제 동작 결정: 기본 save, 명시적 marketplace만 publish. */
function cloudActionForTopLevelUpload(args) {
  const flags = parseCloudFlags(args);
  return cloudVisibilityFlag(flags.visibility) === "marketplace" ? "publish" : "save";
}

function printCloudPackageResult(ctx, result) {
  const mark = result.status === "blocked" ? ctx.ui.red("✖") : ctx.ui.green("✓");
  ctx.out(`${mark} ${result.summary}`);
  ctx.out(`  target:  ${result.manifest.visibility === "marketplace" ? "Agentlas Hub (public)" : "Agent Cloud (owner-private)"}`);
  ctx.out(`  slug:    ${result.manifest.slug}`);
  ctx.out(`  files:   ${result.manifest.includedFileCount}/${result.manifest.fileCount}`);
  ctx.out(`  hash:    ${result.manifest.packageHash}`);
  ctx.out(`  bundle:  ${result.bundlePath}`);
  ctx.out(`  review:  ${result.review.mode} · cost=${result.review.costOwner}${result.review.runtimeLabel ? " · " + result.review.runtimeLabel : ""}`);
  const findings = result.review.findings || [];
  if (findings.length) {
    ctx.out("  findings:");
    for (const f of findings.slice(0, 20)) ctx.out(`    - ${f.severity} ${f.file ? f.file + ": " : ""}${f.message}`);
  }
  if (result.registration) {
    const label = result.manifest.visibility === "marketplace" ? "hub" : "cloud";
    ctx.out(`  ${label}:     ${result.registration.marketplaceUrl || result.registration.url || result.registration.cloudId}`);
    if (result.registration.localStateWarning) ctx.out(`  warning: ${result.registration.localStateWarning}`);
  }
}

const CLOUD_HELP = [
  "agentlas cloud",
  "",
  "  wizard <path> [--name name] [--json] generate/repair agentlas.json",
  "  security scan <path> [--strict]     scan risky instructions and secret paths",
  "  runtime bundle <path> [--json]      compile runtime bundle from agentlas.json",
  "  runtime read-agent-file <path> <file>",
  "                                      lazy read with allow/deny gates",
  "  field-test [--json]                 run local Cloud contract field test",
  "  save <path> [--dry-run] [--slug name]",
  "                                      save owner-private in Agent Cloud (default upload)",
  "  publish <path> [--dry-run] [--slug name]",
  "                                      explicitly publish to the public Agentlas Hub",
  "  package <path> [--json] [--visibility private-link|marketplace]",
  "                                      package only; defaults to private-save checks",
  "  list [--json]                       list packages in your private Agent Cloud",
  "  restore <slug> [--json]             restore an owned Cloud package on this machine",
  "  install <slug>                      compatibility alias: install from the public Hub",
  "  delete <slug> [--scope owner-private|hub-public] [--json]",
  "                                      conditionally delete one exact observed Cloud revision",
  "  search \"<what you need>\" [--limit 10]",
  "                                      search the public Hub (no sign-in needed)",
  "",
  "Private save rule: no public review or routing card; local secret/path/hash checks remain.",
].join("\n");

async function runCloud(ctx, args) {
  const sub = args[0] || "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    ctx.out(CLOUD_HELP);
    return 0;
  }
  if (sub === "search") {
    const flags = parseCloudFlags(args.slice(1));
    const query = flags._.join(" ").trim();
    if (!query) {
      ctx.err('usage: agentlas cloud search "<what you need>" [--limit 10]');
      return 1;
    }
    const limit = Math.max(1, Math.min(30, Number(flags.limit) || 10));
    let result;
    try {
      result = await callHubTool("marketplace.search_agents", { q: query, query, limit });
    } catch (e) {
      ctx.err(e instanceof HubError ? e.message : `Marketplace connection failed: ${(e && e.message) || e}`);
      return 1;
    }
    const items = (result && (result.results || result.agents || result.items)) || [];
    if (!Array.isArray(items) || !items.length) {
      ctx.out(`No results for "${query}"`);
      return 0;
    }
    for (const it of items.slice(0, limit)) {
      ctx.out(`${String(it.slug || it.id || "?").padEnd(34).slice(0, 34)} ${String(it.name || it.title || "").slice(0, 40)}`);
    }
    return 0;
  }
  if (sub === "list") {
    const flags = parseCloudFlags(args.slice(1));
    const result = await listOwnedCloudAgents(Number(flags.limit || 100));
    if (flags.json) { ctx.out(JSON.stringify(result, null, 2)); return 0; }
    const agents = Array.isArray(result.results) ? result.results : [];
    if (!agents.length) { ctx.out("No agents are stored in Private Agent Cloud."); return 0; }
    for (const agent of agents) ctx.out(`${agent.slug}\t${agent.name || agent.nameEn || agent.slug}\t${agent.entityKind || "agent"}`);
    return 0;
  }
  if (sub === "restore") {
    const flags = parseCloudFlags(args.slice(1));
    const slug = flags._[0];
    if (!slug) { ctx.err("usage: agentlas cloud restore <slug> [--json]"); return 1; }
    const result = await restoreOwnedCloudAgent(ctx.db(), slug);
    if (flags.json) { ctx.out(JSON.stringify(result, null, 2)); return 0; }
    ctx.out(`${ctx.ui.green("✓")} restored ${result.slug} from private Agent Cloud`);
    ctx.out(`  hash: ${result.packageHash}`);
    if (result.localPath) ctx.out(`  files: ${result.localPath}`);
    if (result.localStateWarning) ctx.out(`  warning: ${result.localStateWarning}`);
    return 0;
  }
  if (sub === "delete" || sub === "unpublish") {
    const flags = parseCloudFlags(args.slice(1));
    const slug = flags._[0];
    if (!slug) { ctx.err(`usage: agentlas cloud ${sub} <slug> [--json]`); return 1; }
    const result = await deleteCloudAgent(slug, { scope: flags.scope });
    ctx.out(flags.json ? JSON.stringify(result, null, 2) : `${ctx.ui.green("✓")} deleted ${result.slug || slug}`);
    if (!flags.json && Array.isArray(result.localStateWarnings)) {
      for (const warning of result.localStateWarnings) ctx.out(`  warning: ${warning}`);
    }
    return 0;
  }
  // ── agentlas-cloud-runtime 소비 지점 (스캔/매니페스트/lazy-read/필드테스트) ──
  if (sub === "wizard") {
    const flags = parseCloudFlags(args.slice(1));
    const root = flags._[0];
    if (!root) { ctx.err("usage: agentlas cloud wizard <path> [--name name]"); return 1; }
    const result = cloudRuntime.runWizard(root, { name: typeof flags.name === "string" ? flags.name : undefined });
    ctx.out(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.manifest.name} (${result.manifest.entry})`);
    return 0;
  }
  if (sub === "security") {
    if (args[1] !== "scan") { ctx.err("usage: agentlas cloud security scan <path> [--strict]"); return 1; }
    const flags = parseCloudFlags(args.slice(2));
    const root = flags._[0];
    if (!root) { ctx.err("usage: agentlas cloud security scan <path> [--strict]"); return 1; }
    const report = cloudRuntime.scanFolder(root);
    ctx.out(JSON.stringify(report, null, 2));
    return flags.strict && report.verdict === "BLOCK" ? 1 : 0;
  }
  if (sub === "runtime") {
    const action = args[1];
    if (action === "bundle") {
      const root = args[2];
      if (!root) { ctx.err("usage: agentlas cloud runtime bundle <path>"); return 1; }
      ctx.out(JSON.stringify(cloudRuntime.compileBundle(root), null, 2));
      return 0;
    }
    if (action === "read-agent-file") {
      const root = args[2];
      const targetPath = args[3];
      if (!root || !targetPath) { ctx.err("usage: agentlas cloud runtime read-agent-file <path> <file>"); return 1; }
      ctx.out(JSON.stringify(cloudRuntime.readAgentFile(root, targetPath), null, 2));
      return 0;
    }
    ctx.err("usage: agentlas cloud runtime <bundle|read-agent-file> ...");
    return 1;
  }
  if (sub === "field-test") {
    const flags = parseCloudFlags(args.slice(1));
    const result = cloudRuntime.runFieldTest();
    ctx.out(flags.json ? JSON.stringify(result, null, 2) : `${result.suite}: ${result.status}`);
    return result.status === "PASS" ? 0 : 1;
  }
  if (sub === "install") {
    const slug = args[1];
    if (!slug) { ctx.err("usage: agentlas cloud install <slug>"); return 1; }
    const agent = await installHubAgent(ctx.db(), slug);
    ctx.out(`${ctx.ui.green("✓")} Hub installed ${agent.slug} — ${agent.name}`);
    if (agent.localPath) ctx.out(`  files: ${agent.localPath}`);
    return 0;
  }
  if (sub !== "package" && sub !== "save" && sub !== "publish") {
    ctx.err("usage: agentlas cloud <save|publish|package|list|restore|install|delete|field-test> ...");
    return 1;
  }
  const flags = parseCloudFlags(args.slice(1));
  const root = flags._[0];
  if (!root) { ctx.err(`usage: agentlas cloud ${sub} <path>`); return 1; }
  const visibility = cloudVisibilityForAction(sub, flags);
  const dryRun = sub === "package" || Boolean(flags["dry-run"]);
  const result = await packageCloudAgent(ctx.db(), root, {
    slug: typeof flags.slug === "string" ? flags.slug : undefined,
    visibility,
    llmReview: Boolean(flags["llm-review"]),
    dryRun,
  });
  if (flags.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return (sub === "save" || sub === "publish") && result.status === "blocked" ? 1 : 0;
  }
  printCloudPackageResult(ctx, result);
  return (sub === "save" || sub === "publish") && result.status === "blocked" ? 1 : 0;
}

async function runUpload(ctx, args) {
  if (!args.length) {
    ctx.err("usage: agentlas upload <path> [--visibility marketplace]");
    return 1;
  }
  // 기본 = owner-private save. marketplace는 오직 명시적 플래그로만 publish가 된다.
  // --visibility 인자는 그대로 넘긴다 — cloudVisibilityForAction이 재검증한다.
  const action = cloudActionForTopLevelUpload(args);
  return runCloud(ctx, [action, ...args]);
}

module.exports = {
  parseCloudFlags,
  cloudVisibilityFlag,
  cloudVisibilityForAction,
  cloudActionForTopLevelUpload,
  printCloudPackageResult,
  runCloud,
  runUpload,
};
