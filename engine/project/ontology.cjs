"use strict";
/*
 * project/ontology — 프로젝트 온톨로지 inbox/source 상태 (v1 monolith 7654–8283 포팅).
 *
 * 안전 계약:
 *  - 현재 프로젝트 수신함(.agentlas/ontology-inbox)과 명시 등록 폴더만 사용.
 *    홈 폴더·형제 프로젝트 스캔은 절대 시작하지 않는다.
 *  - status/list는 수동(비변형): 초기화 안 된 프로젝트에는 파일을 만들지 않고
 *    `agentlas project init` 안내만 한다 (0.9.10 경계).
 *  - open/add 계열만 ensureOntologyCli를 거치며, 그마저도 초기화된 프로젝트에서만
 *    manifest/inbox를 만든다 — 초기화되지 않았으면 던진다.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadArch } = require("../core/db.cjs");
const { initializedAgentlasProjectPathCli } = require("./state.cjs");

const ONTOLOGY_SUPPORTED_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv"]);

/** `--key value` / `--flag` 파서 — v1 parseCloudFlags와 동일 규칙의 로컬 복사본. */
function parseFlagsCli(args) {
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

function ontologyPathsForCli(projectPath) {
  const arch = loadArch();
  const root = path.resolve(projectPath || process.cwd());
  const memoryDir = path.join(root, arch.memoryDir || ".agentlas");
  return {
    root,
    memoryDir,
    configPath: path.join(memoryDir, arch.ontologyRuntimeFile || "ontology-runtime.json"),
    sourceManifestPath: path.join(memoryDir, arch.ontologySourceManifestFile || "ontology-sources.json"),
    inboxPath: path.join(memoryDir, arch.ontologyInboxDir || "ontology-inbox"),
    dbPath: path.join(memoryDir, arch.ontologyDbFile || "ontology-runtime.sqlite"),
  };
}

function readJsonSafeCli(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafeCli(filePath, value) {
  return writeJsonPrivateAtomicCli(filePath, value);
}

// 원자적(temp+rename) + 소유자 전용(0600) JSON 쓰기. 세션 ID/경로 등 민감 상태 파일용:
// (1) 크래시 중간 쓰기로 JSON이 깨져 routesMap()이 {}를 돌려주며 임포트 매핑을 통째로 잃던 사고,
// (2) 기본 umask(0644)로 cli-sessions.json/agent-routes.json이 world-readable이던 정보 노출을 함께 막는다.
function writeJsonPrivateAtomicCli(filePath, value) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* 일부 FS는 chmod 미지원 — best-effort */ }
}

function ontologySourceManifestSkeletonCli(root) {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-ontology-source-manifest",
    projectRoot: root,
    sources: [],
  };
}

function ensureOntologyCli(projectPath, lang) {
  const paths = ontologyPathsForCli(projectPath);
  if (!initializedAgentlasProjectPathCli(paths.root)) {
    throw new Error(lang === "ko"
      ? "Agentlas 프로젝트 상태가 초기화되지 않았습니다. 먼저 `agentlas project init`을 명시적으로 실행하세요."
      : "Agentlas project state is not initialized. Run `agentlas project init` explicitly first.");
  }
  fs.mkdirSync(paths.inboxPath, { recursive: true });
  if (!fs.existsSync(paths.sourceManifestPath)) {
    writeJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  }
  return paths;
}

function listOntologyInboxCli(inboxPath) {
  try {
    if (!fs.existsSync(inboxPath)) return [];
    return fs.readdirSync(inboxPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const full = path.join(inboxPath, entry.name);
        const stat = fs.statSync(full);
        const isDir = entry.isDirectory();
        const ext = path.extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          path: full,
          kind: isDir ? "dir" : "file",
          size: isDir ? 0 : stat.size,
          supported: isDir || ONTOLOGY_SUPPORTED_EXTS.has(ext),
        };
      })
      .slice(0, 80);
  } catch {
    return [];
  }
}

function readOntologySourcesCli(sourceManifestPath) {
  const manifest = readJsonSafeCli(sourceManifestPath, { sources: [] });
  return Array.isArray(manifest.sources) ? manifest.sources : [];
}

function ontologyUsageLinesCli(lang) {
  if (lang === "ko") {
    return [
      "온톨로지 명령:",
      "  /ontology                         이 프로젝트의 온톨로지 상태 표시",
      "  /ontology list                    수신함 파일과 등록 폴더 목록",
      "  /ontology open                    프로젝트 온톨로지 수신함 열기",
      "  /ontology add ./docs              폴더를 비공개 프로젝트 지식으로 등록",
      "  /ontology company ./docs          회사 문서를 비공개로 등록",
      "  /ontology personal ~/notes        개인 문서를 비공개로 등록",
      "",
      "안전: 현재 프로젝트 수신함과 명시적으로 등록한 폴더만 사용합니다.",
      "홈 폴더나 이웃 프로젝트 스캔은 시작하지 않습니다.",
    ];
  }
  return [
    "Ontology commands:",
    "  /ontology                         turn on/show this project's ontology",
    "  /ontology list                    list inbox files and registered folders",
    "  /ontology open                    open the project ontology inbox",
    "  /ontology add ./docs              register a folder as private project knowledge",
    "  /ontology company ./docs          register company docs as private",
    "  /ontology personal ~/notes        register personal docs as private",
    "",
    "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
    "",
    "Safety: only the current project inbox and registered folders are used.",
    "No home folder or sibling project scan is started.",
  ];
}

function shellSplitCli(text) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of String(text || "")) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function expandUserPathCli(value) {
  const v = String(value || "").trim();
  if (v === "~") return os.homedir();
  if (v.startsWith("~/") || v.startsWith("~\\")) return path.join(os.homedir(), v.slice(2));
  return v;
}

function cleanOntologyPathTokenCli(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^[`"']+|[`"',;]+$/g, "");
}

function resolveOntologyPathCli(value, cwd) {
  const clean = expandUserPathCli(cleanOntologyPathTokenCli(value));
  return path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd || process.cwd(), clean);
}

function inferOntologyKindCli(value, text) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["company", "work", "business", "corp", "team", "회사", "업무", "팀", "조직"].includes(v) || /(company|work|business|corp|team|회사|업무|조직)/i.test(hay)) return "company";
  if (["personal", "private-life", "life", "me", "개인", "내자료", "일상"].includes(v) || /(personal|private-life|\bme\b|개인|내\s*자료|일상)/i.test(hay)) return "personal";
  if (["project", "repo", "프로젝트", "레포"].includes(v) || /(project|repo|프로젝트|레포)/i.test(hay)) return "project";
  return "project";
}

function inferOntologyScopeCli(value, text, kind) {
  const v = String(value || "").toLowerCase();
  const hay = String(text || "").toLowerCase();
  if (["public", "open", "공개"].includes(v) || /(public|open|공개)/i.test(hay)) return "public";
  if (["internal", "team", "내부", "팀"].includes(v) || /(internal|team-only|company-wide|내부|팀\s*공유|회사\s*공유)/i.test(hay)) return "internal";
  if (["private", "secret", "local", "비공개", "개인"].includes(v) || /(private|secret|local-only|비공개|개인만|나만)/i.test(hay)) return "private";
  return kind === "company" || kind === "personal" ? "private" : "private";
}

function isOntologyPathishCli(token, cwd, allowExistingName) {
  const clean = cleanOntologyPathTokenCli(token);
  if (!clean || clean === "." || clean === "..") return true;
  if (/^(?:~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(clean)) return true;
  if (clean.includes("/") || clean.includes("\\")) return true;
  if (allowExistingName) {
    try {
      return fs.existsSync(resolveOntologyPathCli(clean, cwd));
    } catch {
      return false;
    }
  }
  return false;
}

function findOntologyPathTokenCli(tokens, cwd, addIntent) {
  const skip = new Set([
    "add", "register", "attach", "source", "sources", "folder", "folders", "watch", "sync", "use",
    "company", "personal", "project", "private", "internal", "public", "work", "business",
    "추가", "등록", "붙여", "붙여줘", "연결", "켜줘", "켜", "회사", "개인", "프로젝트", "자료", "문서", "폴더", "비공개", "내부", "공개",
  ]);
  for (const token of tokens) {
    const clean = cleanOntologyPathTokenCli(token);
    if (!clean || skip.has(clean.toLowerCase())) continue;
    if (isOntologyPathishCli(clean, cwd, addIntent)) return clean;
  }
  return null;
}

/*
 * 자연어 → 온톨로지 CLI 액션 (2026-08-20: 전면 판정기 경유로 교체).
 * 예전에는 액션·kind·scope 전부 ko/en 정규식이 확정했다 — 제3언어는 영구 미도달,
 * 우연한 단어 일치("register a canon decision")는 오폭. 이제:
 *   - 액션(status/open/add/help)은 판정기(engine/agentlas-judgment.cjs)가 뜻으로 고른다.
 *   - add의 kind/scope도 같은 판정기 경유(불가 시 안전 기본값 project/private).
 *   - 판정 불가면 ["help"] — 단어장 폴백 없음.
 * 경로 토큰 추출(findOntologyPathTokenCli)은 fs 실존 검사 기반의 구조 증거라 유지한다.
 */
const ONTOLOGY_NATURAL_ACTIONS = ["status", "open", "add", "help"];
const ONTOLOGY_ADD_FACETS = ["company", "personal", "project", "public", "internal", "private", "current-directory"];

async function judgeOntologyNaturalCli(raw, options = {}) {
  let judgment;
  try {
    judgment = options.judgment || require("../agentlas-judgment.cjs");
  } catch {
    return { action: null, kind: null, scope: null };
  }
  if (!judgment.hasJudgmentRunner()) return { action: null, kind: null, scope: null };
  const actionVerdict = await judgment.judgeLabels({
    kind: "terminal-ontology-natural-action",
    question:
      "Which single ontology CLI action does this natural-language request ask for? status = show the current ontology state or list registered sources; open = open the ontology inbox folder; add = register a folder, file, or document collection as an ontology source; help = explain usage.",
    labels: ONTOLOGY_NATURAL_ACTIONS,
    input: raw,
    multi: false,
    guidance:
      "Judge meaning in any language. Naming a concrete folder/path/material to attach or watch means add. Enabling/starting the ontology means status. When the request is not an ontology action at all, choose help.",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (actionVerdict.source !== "llm" || actionVerdict.labels.length !== 1) {
    return { action: null, kind: null, scope: null };
  }
  const action = actionVerdict.labels[0];
  if (action !== "add") return { action, kind: null, scope: null };
  const facetVerdict = await judgment.judgeLabels({
    kind: "terminal-ontology-add-facets",
    question:
      "For this source-registration request, which facets apply? Material kind: company (work/organization material), personal (private-life material), project (this project's material). Sharing scope: public, internal (team/company shared), private (only this user). Location: current-directory when the request refers to the folder the user is currently in ('this folder', 'here').",
    labels: ONTOLOGY_ADD_FACETS,
    input: raw,
    guidance:
      "Judge meaning in any language. Pick at most one kind and at most one scope; pick nothing for a facet the request does not state. Pick current-directory only for an explicit reference to the present folder, not for a named path.",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const facets = facetVerdict.source === "llm" ? facetVerdict.labels : [];
  const kind = ["company", "personal", "project"].find((label) => facets.includes(label)) || null;
  const scope = ["public", "internal", "private"].find((label) => facets.includes(label)) || null;
  return { action, kind, scope, currentDirectory: facets.includes("current-directory") };
}

async function parseOntologyNaturalArgsCli(text, cwd, options = {}) {
  const raw = String(text || "").trim();
  if (!raw) return ["status"];
  const judged = await judgeOntologyNaturalCli(raw, options);
  if (judged.action === null || judged.action === "help") return ["help"];
  if (judged.action === "status") return ["list"];
  if (judged.action === "open") return ["open"];
  const tokens = shellSplitCli(raw);
  let source = findOntologyPathTokenCli(tokens, cwd, true);
  if (!source && judged.currentDirectory) source = ".";
  if (!source) return ["add"];
  const kind = judged.kind || "project";
  const scope = judged.scope || "private";
  return ["add", source, "--kind", kind, "--scope", scope];
}

function formatOntologyStatusCli(paths, lang) {
  const ko = lang === "ko";
  const sources = readOntologySourcesCli(paths.sourceManifestPath);
  const inbox = listOntologyInboxCli(paths.inboxPath);
  const lines = [
    ko ? "온톨로지: 활성" : "Ontology: active",
    `  ${ko ? "프로젝트" : "project"}: ${paths.root}`,
    `  ${ko ? "수신함" : "inbox"}:  ${paths.inboxPath}`,
    `  DB:     ${paths.dbPath}`,
    `  ${ko ? "정책" : "policy"}: inbox_and_registered_sources_only`,
    ko ? "  검색: 홈 폴더·형제 프로젝트 제외" : "  scan:   no home folder, no sibling projects",
    "",
    `${ko ? "수신함" : "Inbox"} (${inbox.length}):`,
  ];
  for (const item of inbox) lines.push(`  ${item.supported ? "✓" : "!"} ${item.name}  ${item.supported ? (ko ? "지원됨" : "supported") : (ko ? "어댑터 대기" : "adapter pending")}`);
  if (!inbox.length) lines.push(ko ? "  (비어 있음)" : "  (empty)");
  lines.push("", `${ko ? "소스" : "Sources"} (${sources.length}):`);
  for (const source of sources) {
    const sourcePath = path.resolve(String(source.path || ""));
    lines.push(`  ${fs.existsSync(sourcePath) ? "✓" : "!"} ${sourcePath}  ${source.kind || "project"} / ${source.scope || "internal"}`);
  }
  if (!sources.length) lines.push(ko ? "  (없음)" : "  (none)");
  lines.push(
    "",
    ko ? "소스 추가:" : "Add sources:",
    "  /ontology add ./docs",
    "  /ontology company ./docs",
    "  /ontology personal ~/notes",
    "",
    ko ? "자연어 예시:" : "Natural examples:",
    "  /ontology use ./docs as company knowledge",
    "  /ontology attach ~/notes as personal private memory",
    "  /ontology open the inbox",
  );
  return lines;
}

function registerOntologySourceCli(paths, source, kind, scope, cwd, lang) {
  const ko = lang === "ko";
  if (!source) throw new Error(ko
    ? "사용법: /ontology add <경로>  또는  /ontology company ./docs"
    : "usage: /ontology add <path>  or  /ontology company ./docs");
  const sourcePath = resolveOntologyPathCli(source, cwd || paths.root);
  if (!fs.existsSync(sourcePath)) throw new Error(ko ? `소스를 찾지 못했습니다: ${sourcePath}` : `source not found: ${sourcePath}`);
  const manifest = readJsonSafeCli(paths.sourceManifestPath, ontologySourceManifestSkeletonCli(paths.root));
  const nextSources = (Array.isArray(manifest.sources) ? manifest.sources : [])
    .filter((item) => path.resolve(String(item.path || "")) !== sourcePath);
  nextSources.push({ path: sourcePath, kind, scope, registeredAt: new Date().toISOString() });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-ontology-source-manifest";
  manifest.projectRoot = paths.root;
  manifest.sources = nextSources;
  writeJsonSafeCli(paths.sourceManifestPath, manifest);
  return ko
    ? [
        `온톨로지 소스 등록됨: ${sourcePath}`,
        `  종류:  ${kind}`,
        `  범위: ${scope}`,
        "  복사:  안 함",
        "  스캔:  이 등록 폴더만 사용하며 홈/이웃 프로젝트는 스캔하지 않음",
      ]
    : [
        `Registered ontology source: ${sourcePath}`,
        `  kind:  ${kind}`,
        `  scope: ${scope}`,
        "  copy:  no",
        "  scan:  only this registered folder, not home/sibling projects",
      ];
}

function openLocalPathCli(targetPath, notify) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    const result = spawnSync(command, [targetPath], { stdio: "ignore", windowsHide: true });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
    return true;
  } catch {
    if (typeof notify === "function") notify(`Open manually: ${targetPath}`);
    return false;
  }
}

async function runOntologyCli(args, opts) {
  opts = opts || {};
  const ko = opts.lang === "ko";
  const cwd = path.resolve(opts.cwd || process.cwd());
  const projectPath = path.resolve(opts.projectPath || cwd);
  const normalizedArgs = Array.isArray(args) ? args : [];
  const sub = normalizedArgs[0] || "status";
  const passivePaths = ontologyPathsForCli(projectPath);
  if (sub === "status" || sub === "list") {
    if (!initializedAgentlasProjectPathCli(projectPath)) {
      return [
        ko ? "온톨로지: 초기화되지 않음" : "Ontology: not initialized",
        `  ${ko ? "프로젝트" : "project"}: ${projectPath}`,
        ko ? "  생성된 파일 없음" : "  no files were created",
        ko ? "  명시적 초기화: agentlas project init" : "  initialize explicitly: agentlas project init",
      ];
    }
    return formatOntologyStatusCli(passivePaths, opts.lang);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") return ontologyUsageLinesCli(opts.lang);
  const directOntologyCommand = ["open", "add", "company", "personal", "project"].includes(String(sub).toLowerCase())
    || isOntologyPathishCli(sub, cwd, true);
  if (!directOntologyCommand) {
    // 자연어는 판정기 경유로 액션을 정한다. 판정 불가면 ["help"](사용법 안내).
    const parsed = await parseOntologyNaturalArgsCli(normalizedArgs.join(" "), cwd);
    return runOntologyCli(parsed, opts);
  }
  const paths = ensureOntologyCli(projectPath, opts.lang);
  if (sub === "open") {
    const opened = opts.noOpen ? true : openLocalPathCli(paths.inboxPath, opts.notify);
    return [`${opened
      ? (ko ? "온톨로지 수신함을 열었습니다" : "Opened ontology inbox")
      : (ko ? "온톨로지 수신함을 자동으로 열지 못했습니다. 직접 여세요" : "Could not open ontology inbox automatically; open it manually")}: ${paths.inboxPath}`];
  }
  if (sub === "add") {
    const flags = parseFlagsCli(normalizedArgs.slice(1));
    const source = flags._[0];
    const kind = inferOntologyKindCli(flags.kind || flags._[1], normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[2], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, source, kind, scope, cwd, opts.lang);
  }
  if (["company", "personal", "project"].includes(String(sub).toLowerCase())) {
    const flags = parseFlagsCli(normalizedArgs.slice(1));
    const kind = inferOntologyKindCli(sub, normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[1], normalizedArgs.join(" "), kind);
    return registerOntologySourceCli(paths, flags._[0], kind, scope, cwd, opts.lang);
  }
  if (isOntologyPathishCli(sub, cwd, true)) {
    return registerOntologySourceCli(paths, sub, inferOntologyKindCli(null, normalizedArgs.join(" ")), inferOntologyScopeCli(null, normalizedArgs.join(" "), "project"), cwd, opts.lang);
  }
  throw new Error(ko
    ? "사용법: /ontology status|list|open|add <경로>"
    : "usage: /ontology status|list|open|add <path>");
}

async function runOntologyNaturalCli(text, opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  const parsed = await parseOntologyNaturalArgsCli(text, cwd);
  return runOntologyCli(parsed, { ...(opts || {}), cwd });
}

module.exports = {
  ONTOLOGY_SUPPORTED_EXTS,
  parseFlagsCli,
  ontologyPathsForCli,
  readJsonSafeCli,
  writeJsonSafeCli,
  writeJsonPrivateAtomicCli,
  ontologySourceManifestSkeletonCli,
  ensureOntologyCli,
  listOntologyInboxCli,
  readOntologySourcesCli,
  ontologyUsageLinesCli,
  shellSplitCli,
  expandUserPathCli,
  cleanOntologyPathTokenCli,
  resolveOntologyPathCli,
  inferOntologyKindCli,
  inferOntologyScopeCli,
  isOntologyPathishCli,
  findOntologyPathTokenCli,
  parseOntologyNaturalArgsCli,
  formatOntologyStatusCli,
  registerOntologySourceCli,
  openLocalPathCli,
  runOntologyCli,
  runOntologyNaturalCli,
};
