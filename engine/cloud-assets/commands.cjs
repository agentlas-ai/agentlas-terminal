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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const cloudRuntime = require("../agentlas-cloud-runtime.cjs");
const { installHubAgent } = require("../hub/install.cjs");
const { callHubTool, HubError } = require("../cloud/hub-client.cjs");
const { packageCloudAgent } = require("./package.cjs");
const { deleteCloudAgent } = require("./cas.cjs");
const { listOwnedCloudAgents, restoreOwnedCloudAgent } = require("./restore.cjs");
const workforceDeps = require("../workforce/deps.cjs");
const workforceCapture = require("../workforce/capture.cjs");

const PURPOSE_QUESTION = "What concrete work should this agent complete, and what should the finished result look like?";

function purposeRepairNeeded(result) {
  const ids = new Set((result?.review?.findings || []).map((finding) => finding.id));
  return ids.has("routing-card-required") ||
    (result?.review?.findings || []).some((finding) =>
      finding.id === "routing-card-invalid" && /summary|capabilities|name|id|workforce/i.test(finding.message || ""));
}

async function askPurpose(ctx, flags) {
  if (typeof flags.purpose === "string" && flags.purpose.trim()) return flags.purpose.trim();
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
  const prompt = ctx.lang === "ko"
    ? "이 에이전트가 실제로 끝내야 할 일과, 완료됐을 때 나와야 할 결과를 평소 말하듯 적어주세요: "
    : `${PURPOSE_QUESTION} `;
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return String(await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}

function parsePurposeProjection(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(text);
  const ids = (input, prefix, min = 1) => {
    if (!Array.isArray(input)) throw new Error(`${prefix} must be an array`);
    const pattern = prefix === "capability"
      ? /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/
      : new RegExp(`^${prefix}:[a-z0-9][a-z0-9-]*$`);
    const output = [...new Set(input.map((item) => String(item).trim()).filter((item) => pattern.test(item)))];
    if (output.length < min) throw new Error(`${prefix} is incomplete`);
    return output;
  };
  const requiredText = (key) => {
    const output = typeof value[key] === "string" ? value[key].trim() : "";
    if (!output) throw new Error(`${key} is missing`);
    return output;
  };
  return {
    titleEn: requiredText("titleEn"),
    titleKo: requiredText("titleKo"),
    summary: requiredText("summary"),
    descriptionKo: requiredText("descriptionKo"),
    capabilities: ids(value.capabilities, "capability", 2),
    roles: ids(value.roles, "role"),
    communities: ids(value.communities, "community"),
    skills: ids(value.skills, "skill", 2),
    knowledge: ids(value.knowledge, "knowledge"),
  };
}

async function projectPurposeWithConnectedModel(ctx, answer, fallbackName) {
  const runtime = workforceDeps.resolveWorkforceRuntime(ctx.db()).roleRuntimes.orchestrator;
  const system = [
    "Convert an ordinary-language agent purpose into one English internal routing resume.",
    "The answer may be in any language. Preserve meaning; do not add tools, runtimes, languages, modalities, permissions, authorities, or forbidden authorities.",
    "Return JSON only.",
  ].join(" ");
  const prompt = [
    `Working name: ${fallbackName}`,
    `User explanation: ${answer}`,
    "",
    'Return {"titleEn":"","titleKo":"","summary":"","descriptionKo":"","capabilities":[],"roles":[],"communities":[],"skills":[],"knowledge":[]}.',
    "summary must be a concrete English description of work and finished result.",
    "capabilities are 2-8 English snake_case verb-object phrases.",
    "roles, communities, skills, knowledge are faithful open-world English IDs with role:, community:, skill:, knowledge: prefixes.",
    "titleKo and descriptionKo are display translations only; every routing field remains English.",
  ].join("\n");
  let raw;
  if (runtime.mode === "api") {
    raw = await workforceCapture.runApi(runtime.backend, runtime.model, system, prompt, {});
  } else {
    if (runtime.kind === "gemini") {
      throw new Error("The connected Gemini CLI cannot run this no-tool repair safely yet. Choose Codex/Claude or a BYOK model and retry.");
    }
    const env = await workforceCapture.buildChildEnv(ctx.db(), { cwd: process.cwd(), projectPath: process.cwd() });
    raw = await workforceCapture.captureRuntime(runtime.kind, system, prompt, {
      cwd: workforceCapture.runCwd(),
      env,
      permission: "read",
      authorityMode: "no-authority",
      model: runtime.model,
      effort: runtime.effort,
      timeoutConfig: { connectMs: 30_000, idleMs: 45_000, totalMs: 90_000 },
      outputLimitBytes: 256 * 1024,
    });
  }
  return parsePurposeProjection(raw);
}

function writePurposeRepairCopy(root, projection) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-purpose-repair-"));
  fs.cpSync(path.resolve(root), tempRoot, { recursive: true, dereference: false });
  const metadataDir = path.join(tempRoot, ".agentlas");
  fs.mkdirSync(metadataDir, { recursive: true });
  const routingPath = path.join(metadataDir, "routing-card.json");
  let routing = {};
  try { routing = JSON.parse(fs.readFileSync(routingPath, "utf8")); } catch { /* construct it */ }
  const id = String(routing.id || path.basename(root))
    .normalize("NFKC").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const card = {
    ...routing,
    schemaVersion: "routing-card/2.0",
    id,
    type: routing.type === "team" || routing.type === "plugin" ? routing.type : "agent",
    name: projection.titleEn,
    summary: projection.summary.slice(0, 240),
    capabilities: projection.capabilities,
    routing_status: "routing_ready",
    workforce: {
      ...(routing.workforce && typeof routing.workforce === "object" && !Array.isArray(routing.workforce)
        ? routing.workforce
        : {}),
      roles: projection.roles,
      communities: projection.communities,
      skills: projection.skills,
      knowledge: projection.knowledge,
      languages: [],
      modalities: [],
    },
  };
  fs.writeFileSync(routingPath, `${JSON.stringify(card, null, 2)}\n`, "utf8");
  const agentCardPath = path.join(metadataDir, "agent-card.json");
  let agentCard = {};
  try { agentCard = JSON.parse(fs.readFileSync(agentCardPath, "utf8")); } catch { /* construct it */ }
  agentCard = {
    ...agentCard,
    name: agentCard.name || projection.titleEn,
    summary: projection.summary,
    localized: {
      ...(agentCard.localized && typeof agentCard.localized === "object" ? agentCard.localized : {}),
      titleEn: projection.titleEn,
      titleKo: projection.titleKo,
      descriptionEn: projection.summary,
      descriptionKo: projection.descriptionKo,
    },
  };
  fs.writeFileSync(agentCardPath, `${JSON.stringify(agentCard, null, 2)}\n`, "utf8");
  return tempRoot;
}

const CLOUD_VALUE_FLAGS = ["limit", "name", "purpose", "scope", "slug", "visibility"];
const CLOUD_BOOLEAN_FLAGS = ["dry-run", "json", "llm-review", "overwrite", "strict"];

function cloudArgumentError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function parseCloudFlags(args, spec = {}) {
  const values = new Set(spec.values || CLOUD_VALUE_FLAGS);
  const booleans = new Set(spec.booleans || CLOUD_BOOLEAN_FLAGS);
  const flags = { _: [] };
  const seen = new Set();
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (positionalOnly) {
      flags._.push(a);
      continue;
    }
    if (a === "--") {
      positionalOnly = true;
      continue;
    }
    if (!String(a).startsWith("-")) {
      flags._.push(a);
      continue;
    }
    if (!String(a).startsWith("--")) throw cloudArgumentError(`unknown option: ${a}`);
    const equal = String(a).indexOf("=");
    const key = String(a).slice(2, equal === -1 ? undefined : equal);
    if (!key || (!values.has(key) && !booleans.has(key))) throw cloudArgumentError(`unknown option: --${key || ""}`);
    if (seen.has(key)) throw cloudArgumentError(`duplicate option: --${key}`);
    seen.add(key);
    if (booleans.has(key)) {
      if (equal !== -1) throw cloudArgumentError(`--${key} does not take a value`);
      flags[key] = true;
      continue;
    }
    let value;
    if (equal !== -1) {
      value = String(a).slice(equal + 1);
    } else {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith("--")) throw cloudArgumentError(`--${key} requires a value`);
      value = String(next);
      i++;
    }
    if (!value) throw cloudArgumentError(`--${key} requires a non-empty value`);
    flags[key] = value;
  }
  return flags;
}

function requireCloudPositionals(flags, min, max, usage) {
  if (flags._.length < min || flags._.length > max) throw cloudArgumentError(usage);
  return flags;
}

function positiveIntegerFlag(value, fallback, name, max) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(String(value))) throw cloudArgumentError(`--${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw cloudArgumentError(`--${name} must be between 1 and ${max}`);
  }
  return parsed;
}

function cloudVisibilityFlag(value) {
  if (value == null) return null;
  if (value === "private-link" || value === "marketplace") return value;
  throw cloudArgumentError("--visibility must be private-link or marketplace");
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
  const flags = requireCloudPositionals(parseCloudFlags(args, {
    values: ["purpose", "slug", "visibility"],
    booleans: ["dry-run", "json", "llm-review", "overwrite"],
  }), 1, 1, "usage: agentlas upload <path> [--visibility marketplace]");
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
  "  --purpose \"ordinary explanation\"     repair a missing purpose through your connected model",
  "  package <path> [--json] [--visibility private-link|marketplace]",
  "  --overwrite                         서버에 더 새 버전이 있어도 지금 폴더 내용으로 덮어쓰기",
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
    requireCloudPositionals(parseCloudFlags(args.slice(1), { values: [], booleans: ["json"] }), 0, 0, "usage: agentlas cloud help");
    ctx.out(CLOUD_HELP);
    return 0;
  }
  if (sub === "search") {
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: ["limit"], booleans: ["json"],
    }), 1, Number.MAX_SAFE_INTEGER, 'usage: agentlas cloud search "<what you need>" [--limit 10]');
    const query = flags._.join(" ").trim();
    if (!query) {
      ctx.err('usage: agentlas cloud search "<what you need>" [--limit 10]');
      return 1;
    }
    const limit = positiveIntegerFlag(flags.limit, 10, "limit", 30);
    let result;
    try {
      result = await callHubTool("marketplace.search_agents", { q: query, limit });
    } catch (e) {
      ctx.err(e instanceof HubError ? e.message : `Marketplace connection failed: ${(e && e.message) || e}`);
      return 1;
    }
    if (flags.json) { ctx.out(JSON.stringify(result, null, 2)); return 0; }
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
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: ["limit"], booleans: ["json"],
    }), 0, 0, "usage: agentlas cloud list [--limit 100] [--json]");
    const result = await listOwnedCloudAgents(positiveIntegerFlag(flags.limit, 100, "limit", 1000));
    if (flags.json) { ctx.out(JSON.stringify(result, null, 2)); return 0; }
    const agents = Array.isArray(result.results) ? result.results : [];
    if (!agents.length) { ctx.out("No agents are stored in Private Agent Cloud."); return 0; }
    const total = Number.isSafeInteger(result.total) ? result.total : agents.length;
    ctx.out(`Private Agent Cloud · ${agents.length} shown${total > agents.length ? ` of ${total}` : ""} · owner-private`);
    ctx.out("");
    ctx.out("SLUG                               KIND   CALLABLE  UPDATED       NAME");
    for (const agent of agents) {
      const slug = String(agent.slug || "?").slice(0, 34).padEnd(34);
      const kind = String(agent.entityKind || agent.agentKind || "agent").slice(0, 6).padEnd(6);
      const callable = agent.callable === true
        ? "yes"
        : agent.callable === false
          ? "no"
          : agent.routingStatus === "routing_ready"
            ? "yes"
            : "unknown";
      const updated = typeof agent.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(agent.updatedAt)
        ? agent.updatedAt.slice(0, 10)
        : "unknown";
      const name = String(agent.name || agent.nameEn || agent.slug || "?").replace(/\s+/g, " ").slice(0, 48);
      ctx.out(`${slug} ${kind} ${callable.padEnd(8)}  ${updated}  ${name}`);
    }
    ctx.out("");
    if (total > agents.length) {
      ctx.out(`Showing ${agents.length} of ${total}. Use --limit <n> to request more.`);
    }
    ctx.out("Inspect machine-readable source, revision, and package identity with: agentlas cloud list --json");
    ctx.out("Restore one exact owner-private revision with: agentlas cloud restore <slug>");
    return 0;
  }
  if (sub === "restore") {
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: [], booleans: ["json"],
    }), 1, 1, "usage: agentlas cloud restore <slug> [--json]");
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
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: ["scope"], booleans: ["json"],
    }), 1, 1, `usage: agentlas cloud ${sub} <slug> [--scope owner-private|hub-public] [--json]`);
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
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: ["name"], booleans: ["json"],
    }), 1, 1, "usage: agentlas cloud wizard <path> [--name name] [--json]");
    const root = flags._[0];
    if (!root) { ctx.err("usage: agentlas cloud wizard <path> [--name name]"); return 1; }
    const result = cloudRuntime.runWizard(root, { name: typeof flags.name === "string" ? flags.name : undefined });
    ctx.out(flags.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.manifest.name} (${result.manifest.entry})`);
    return 0;
  }
  if (sub === "security") {
    if (args[1] !== "scan") { ctx.err("usage: agentlas cloud security scan <path> [--strict]"); return 1; }
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(2), {
      values: [], booleans: ["json", "strict"],
    }), 1, 1, "usage: agentlas cloud security scan <path> [--strict]");
    const root = flags._[0];
    if (!root) { ctx.err("usage: agentlas cloud security scan <path> [--strict]"); return 1; }
    const report = cloudRuntime.scanFolder(root);
    ctx.out(JSON.stringify(report, null, 2));
    return flags.strict && report.verdict === "BLOCK" ? 1 : 0;
  }
  if (sub === "runtime") {
    const action = args[1];
    if (action === "bundle") {
      const flags = requireCloudPositionals(parseCloudFlags(args.slice(2), {
        values: [], booleans: ["json"],
      }), 1, 1, "usage: agentlas cloud runtime bundle <path> [--json]");
      const root = flags._[0];
      ctx.out(JSON.stringify(cloudRuntime.compileBundle(root), null, 2));
      return 0;
    }
    if (action === "read-agent-file") {
      const flags = requireCloudPositionals(parseCloudFlags(args.slice(2), {
        values: [], booleans: ["json"],
      }), 2, 2, "usage: agentlas cloud runtime read-agent-file <path> <file> [--json]");
      const [root, targetPath] = flags._;
      ctx.out(JSON.stringify(cloudRuntime.readAgentFile(root, targetPath), null, 2));
      return 0;
    }
    ctx.err("usage: agentlas cloud runtime <bundle|read-agent-file> ...");
    return 1;
  }
  if (sub === "field-test") {
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: [], booleans: ["json"],
    }), 0, 0, "usage: agentlas cloud field-test [--json]");
    const result = cloudRuntime.runFieldTest();
    ctx.out(flags.json ? JSON.stringify(result, null, 2) : `${result.suite}: ${result.status}`);
    return result.status === "PASS" ? 0 : 1;
  }
  if (sub === "install") {
    const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
      values: [], booleans: ["json"],
    }), 1, 1, "usage: agentlas cloud install <slug> [--json]");
    const slug = flags._[0];
    const agent = await installHubAgent(ctx.db(), slug);
    if (flags.json) { ctx.out(JSON.stringify(agent, null, 2)); return 0; }
    ctx.out(`${ctx.ui.green("✓")} Hub installed ${agent.slug} — ${agent.name}`);
    if (agent.localPath) ctx.out(`  files: ${agent.localPath}`);
    return 0;
  }
  if (sub !== "package" && sub !== "save" && sub !== "publish") {
    ctx.err("usage: agentlas cloud <save|publish|package|list|restore|install|delete|field-test> ...");
    return 1;
  }
  const flags = requireCloudPositionals(parseCloudFlags(args.slice(1), {
    values: ["purpose", "slug", "visibility"],
    booleans: ["dry-run", "json", "llm-review", "overwrite"],
  }), 1, 1, `usage: agentlas cloud ${sub} <path>`);
  const root = flags._[0];
  if (!root) { ctx.err(`usage: agentlas cloud ${sub} <path>`); return 1; }
  const visibility = cloudVisibilityForAction(sub, flags);
  const dryRun = sub === "package" || Boolean(flags["dry-run"]);
  const packageOptions = {
    slug: typeof flags.slug === "string" ? flags.slug : undefined,
    visibility,
    llmReview: Boolean(flags["llm-review"]),
    overwriteRemote: Boolean(flags.overwrite),
    dryRun,
  };
  let result = await packageCloudAgent(ctx.db(), root, packageOptions);
  if (sub === "publish" && result.status === "blocked" && purposeRepairNeeded(result) && !flags.json) {
    const answer = await askPurpose(ctx, flags);
    if (answer) {
      const projection = await projectPurposeWithConnectedModel(ctx, answer, path.basename(path.resolve(root)));
      const repairedRoot = writePurposeRepairCopy(root, projection);
      try {
        result = await packageCloudAgent(ctx.db(), repairedRoot, packageOptions);
      } finally {
        fs.rmSync(repairedRoot, { recursive: true, force: true });
      }
    } else {
      ctx.err(ctx.lang === "ko"
        ? `업로드를 완성하려면 답이 필요합니다. 다시 실행할 때 --purpose "평소 말로 설명"을 붙이세요.`
        : `This upload needs one answer. Retry with --purpose "your ordinary explanation".`);
    }
  }
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
  purposeRepairNeeded,
  parsePurposeProjection,
  printCloudPackageResult,
  runCloud,
  runUpload,
};
