"use strict";
/*
 * project/career-graph — 커리어 그래프 소스 라우팅 (v1 monolith 8042–8252 포팅).
 *
 * 원칙: 그래프는 재생성 가능한 파생 인덱스다 — Markdown/JSONL/JSON 원장이 원본.
 * 전체 인덱스 실행(ingest/query/verify/trace)은 Agentlas OS / Hephaestus 런타임
 * (career_graph 파이썬 모듈)이 소유하고, 터미널은 소스 등록/상태만 담당한다.
 * status/list는 비변형(초기화 안 된 프로젝트에 파일 생성 금지 — 0.9.10 경계).
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadArch } = require("../core/db.cjs");
const { initializedAgentlasProjectPathCli } = require("./state.cjs");
const {
  parseFlagsCli,
  readJsonSafeCli,
  writeJsonSafeCli,
  listOntologyInboxCli,
  resolveOntologyPathCli,
  inferOntologyKindCli,
  inferOntologyScopeCli,
  parseOntologyNaturalArgsCli,
  openLocalPathCli,
} = require("./ontology.cjs");

function careerGraphPathsForCli(projectPath) {
  const arch = loadArch();
  const root = path.resolve(projectPath || process.cwd());
  const memoryDir = path.join(root, arch.memoryDir || ".agentlas");
  return {
    root,
    memoryDir,
    configPath: path.join(memoryDir, arch.careerGraphConfigFile || "career-graph.json"),
    sourceManifestPath: path.join(memoryDir, arch.careerGraphSourceManifestFile || "career-graph-sources.json"),
    inboxPath: path.join(memoryDir, arch.careerGraphInboxDir || "career-graph-inbox"),
    dbPath: path.join(memoryDir, arch.careerGraphDbFile || "career-graph.sqlite"),
  };
}

function careerGraphSourceManifestSkeletonCli(root) {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-career-graph-source-manifest",
    projectRoot: root,
    sources: [],
  };
}

function ensureCareerGraphCli(projectPath, lang) {
  const paths = careerGraphPathsForCli(projectPath);
  if (!initializedAgentlasProjectPathCli(paths.root)) {
    throw new Error(lang === "ko"
      ? "Agentlas 프로젝트 상태가 초기화되지 않았습니다. 먼저 `agentlas project init`을 명시적으로 실행하세요."
      : "Agentlas project state is not initialized. Run `agentlas project init` explicitly first.");
  }
  fs.mkdirSync(paths.inboxPath, { recursive: true });
  if (!fs.existsSync(paths.sourceManifestPath)) {
    writeJsonSafeCli(paths.sourceManifestPath, careerGraphSourceManifestSkeletonCli(paths.root));
  }
  return paths;
}

function readCareerGraphSourcesCli(sourceManifestPath) {
  const manifest = readJsonSafeCli(sourceManifestPath, { sources: [] });
  return Array.isArray(manifest.sources) ? manifest.sources : [];
}

function careerGraphUsageLinesCli(lang) {
  if (lang === "ko") {
    return [
      "커리어 그래프 명령:",
      "  career-graph status               소스 라우팅 파일과 인덱스 상태 표시",
      "  career-graph list                 수신함 파일과 등록 소스 참조 목록",
      "  career-graph open                 프로젝트 커리어 그래프 수신함 열기",
      "  career-graph add ./docs           폴더를 비공개 소스 자료로 등록",
      "",
      "전체 그래프 인덱스 실행은 Agentlas OS / Hephaestus에서 제공합니다.",
      "안전: 그래프는 재생성 가능하며 Markdown·JSONL·sitemap·code map이 원본입니다.",
    ];
  }
  return [
    "Career Graph commands:",
    "  career-graph status               show source-routing files and index state",
    "  career-graph list                 list inbox files and registered source refs",
    "  career-graph open                 open the project career graph inbox",
    "  career-graph add ./docs           register a folder as private source material",
    "",
    "Full graph index commands live in Agentlas OS / Hephaestus:",
    "  hephaestus career-graph ingest --project .",
    "  hephaestus career-graph query \"release failures\" --project .",
    "  hephaestus career-graph verify --project .",
    "",
    "Safety: the graph is rebuildable. Markdown, JSONL ledgers, sitemap, and code map stay source of truth.",
  ];
}

function existingCareerGraphCanonicalRefsCli(root) {
  return [
    ".agentlas/project-soul-memory.md",
    ".agentlas/memory-log.jsonl",
    ".agentlas/curator-decisions.jsonl",
    ".agentlas/sitemap.json",
    ".agentlas/code-map/project-map.json",
    ".agentlas/ledgers/routing-decisions.jsonl",
    ".agentlas/ledgers/executions.jsonl",
    ".agentlas/ledgers/agent-evolution-proposals.jsonl",
  ].filter((rel) => fs.existsSync(path.join(root, rel)));
}

function formatCareerGraphStatusCli(paths, lang) {
  const ko = lang === "ko";
  const sources = readCareerGraphSourcesCli(paths.sourceManifestPath);
  const inbox = listOntologyInboxCli(paths.inboxPath);
  const canonical = existingCareerGraphCanonicalRefsCli(paths.root);
  const lines = [
    ko ? "커리어 그래프: 활성" : "Career Graph: active",
    `  ${ko ? "프로젝트" : "project"}: ${paths.root}`,
    `  ${ko ? "수신함" : "inbox"}:  ${paths.inboxPath}`,
    `  DB:     ${paths.dbPath}`,
    `  ${ko ? "인덱스" : "index"}:  ${fs.existsSync(paths.dbPath) ? (ko ? "있음" : "present") : (ko ? "대기" : "pending")}`,
    `  ${ko ? "정책" : "policy"}: ledger_first_derived_index`,
    ko ? "  원본 기준: Markdown / JSONL / JSON 파일" : "  source of truth: Markdown / JSONL / JSON files",
    "",
    `${ko ? "기본 소스 참조" : "Canonical source refs"} (${canonical.length}):`,
  ];
  for (const rel of canonical) lines.push(`  ${rel}`);
  if (!canonical.length) lines.push(ko ? "  (아직 없음)" : "  (none yet)");
  lines.push("", `${ko ? "수신함" : "Inbox"} (${inbox.length}):`);
  for (const item of inbox) lines.push(`  ${item.supported ? "ok" : "!"} ${item.name}  ${item.supported ? (ko ? "지원됨" : "supported") : (ko ? "어댑터 대기" : "adapter pending")}`);
  if (!inbox.length) lines.push(ko ? "  (비어 있음)" : "  (empty)");
  lines.push("", `${ko ? "등록된 소스 참조" : "Registered source refs"} (${sources.length}):`);
  for (const source of sources) {
    const sourcePath = path.resolve(String(source.path || ""));
    lines.push(`  ${fs.existsSync(sourcePath) ? "ok" : "!"} ${sourcePath}  ${source.kind || "project"} / ${source.scope || "private"}`);
  }
  if (!sources.length) lines.push(ko ? "  (없음)" : "  (none)");
  lines.push(
    "",
    ko ? "Agentlas OS로 파생 인덱스 만들기:" : "Build the derived index with Agentlas OS:",
    `  hephaestus career-graph ingest --project ${JSON.stringify(paths.root)}`,
  );
  return lines;
}

function registerCareerGraphSourceCli(paths, source, kind, scope, cwd, lang) {
  const ko = lang === "ko";
  if (!source) throw new Error(ko ? "사용법: career-graph add <경로>" : "usage: career-graph add <path>");
  const sourcePath = resolveOntologyPathCli(source, cwd || paths.root);
  if (!fs.existsSync(sourcePath)) throw new Error(ko ? `소스를 찾지 못했습니다: ${sourcePath}` : `source not found: ${sourcePath}`);
  const manifest = readJsonSafeCli(paths.sourceManifestPath, careerGraphSourceManifestSkeletonCli(paths.root));
  const nextSources = (Array.isArray(manifest.sources) ? manifest.sources : [])
    .filter((item) => path.resolve(String(item.path || "")) !== sourcePath);
  nextSources.push({ path: sourcePath, kind, scope, registeredAt: new Date().toISOString() });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-career-graph-source-manifest";
  manifest.projectRoot = paths.root;
  manifest.sources = nextSources;
  writeJsonSafeCli(paths.sourceManifestPath, manifest);
  return ko
    ? [
        `커리어 그래프 소스 등록됨: ${sourcePath}`,
        `  종류:  ${kind}`,
        `  범위: ${scope}`,
        "  복사:  안 함",
        "  스캔:  이 등록 폴더만 사용하며 홈/이웃 프로젝트는 스캔하지 않음",
      ]
    : [
        `Registered Career Graph source: ${sourcePath}`,
        `  kind:  ${kind}`,
        `  scope: ${scope}`,
        "  copy:  no",
        "  scan:  only this registered folder, not home/sibling projects",
      ];
}

async function runCareerGraphCli(args, opts) {
  opts = opts || {};
  const ko = opts.lang === "ko";
  const cwd = path.resolve(opts.cwd || process.cwd());
  const projectPath = path.resolve(opts.projectPath || cwd);
  const normalizedArgs = Array.isArray(args) ? args : [];
  const sub = normalizedArgs[0] || "status";
  const passivePaths = careerGraphPathsForCli(projectPath);
  if (sub === "status" || sub === "list") {
    if (!initializedAgentlasProjectPathCli(projectPath)) {
      return [
        ko ? "커리어 그래프: 초기화되지 않음" : "Career Graph: not initialized",
        `  ${ko ? "프로젝트" : "project"}: ${projectPath}`,
        ko ? "  생성된 파일 없음" : "  no files were created",
        ko ? "  명시적 초기화: agentlas project init" : "  initialize explicitly: agentlas project init",
      ];
    }
    return formatCareerGraphStatusCli(passivePaths, opts.lang);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") return careerGraphUsageLinesCli(opts.lang);
  if (["ingest", "query", "verify", "trace"].includes(String(sub))) {
    return [
      ko
        ? "Career Graph 인덱스 실행은 Agentlas OS / Hephaestus에서 제공합니다."
        : "Career Graph index execution is provided by Agentlas OS / Hephaestus.",
      `${ko ? "실행" : "Run"}: hephaestus career-graph ${normalizedArgs.join(" ")} --project ${JSON.stringify(passivePaths.root)}`,
    ];
  }
  const directCareerCommand = ["open", "add"].includes(String(sub));
  if (!directCareerCommand) {
    // 자연어는 판정기 경유로 액션을 정한다. 판정 불가면 ["help"](사용법 안내).
    const parsed = await parseOntologyNaturalArgsCli(normalizedArgs.join(" "), cwd);
    return runCareerGraphCli(parsed, opts);
  }
  const paths = ensureCareerGraphCli(projectPath, opts.lang);
  if (sub === "open") {
    const opened = opts.noOpen ? true : openLocalPathCli(paths.inboxPath, opts.notify);
    return [`${opened
      ? (ko ? "커리어 그래프 수신함을 열었습니다" : "Opened Career Graph inbox")
      : (ko ? "커리어 그래프 수신함을 자동으로 열지 못했습니다. 직접 여세요" : "Could not open Career Graph inbox automatically; open it manually")}: ${paths.inboxPath}`];
  }
  if (sub === "add") {
    const flags = parseFlagsCli(normalizedArgs.slice(1));
    const source = flags._[0];
    const kind = inferOntologyKindCli(flags.kind || flags._[1], normalizedArgs.join(" "));
    const scope = inferOntologyScopeCli(flags.scope || flags._[2], normalizedArgs.join(" "), kind);
    return registerCareerGraphSourceCli(paths, source, kind, scope, cwd, opts.lang);
  }
  throw new Error(ko
    ? "사용법: /career-graph status|list|open|add <경로>"
    : "usage: /career-graph status|list|open|add <path>");
}

async function runCareerGraphNaturalCli(text, opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  const parsed = await parseOntologyNaturalArgsCli(text, cwd);
  return runCareerGraphCli(parsed, { ...(opts || {}), cwd });
}

module.exports = {
  careerGraphPathsForCli,
  careerGraphSourceManifestSkeletonCli,
  ensureCareerGraphCli,
  readCareerGraphSourcesCli,
  careerGraphUsageLinesCli,
  existingCareerGraphCanonicalRefsCli,
  formatCareerGraphStatusCli,
  registerCareerGraphSourceCli,
  runCareerGraphCli,
  runCareerGraphNaturalCli,
};
