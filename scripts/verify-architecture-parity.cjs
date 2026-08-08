#!/usr/bin/env node
"use strict";
/*
 * 구조 상수 쌍둥이 값 대조 게이트 (2026-08-08 신설).
 *
 * 데스크탑 `electron/architecture/manifest.ts`와 터미널
 * `engine/architecture.data.json`은 키 1:1 쌍둥이인데, 이 둘을 비교하는
 * 게이트가 어느 쪽에도 없었다. 상한 상수 드리프트를 "필드명만 비교하는
 * 게이트"가 못 잡은 실측 사고가 있으므로 이 게이트는 **값**을 비교한다.
 *
 * 비교 원본은 저장소에 벤더링된 컴파일 사본
 * (`engine/vendor/desktop-core/dist/electron/architecture/manifest.js`)이라
 * 형제 체크아웃 없이 자기완결로 돈다. 사본이 없거나 로드에 실패하면
 * 게이트는 SKIP이 아니라 **실패**한다(검사 못 하면 실패해야 한다 — 죽은
 * 패리티 게이트 3개가 조용히 PASS하던 실측 사고의 재발 방지).
 *
 * 등록 지점: scripts/vendor-desktop-core.cjs 끝(벤더 갱신 직후가 쌍둥이가
 * 갈라질 수 있는 유일한 순간) + test/smoke.sh(로컬 전체 실행).
 */
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];
const check = (label, expected, actual) => {
  const left = JSON.stringify(expected);
  const right = JSON.stringify(actual);
  if (left !== right) failures.push(`${label}\n  desktop : ${String(left).slice(0, 160)}\n  terminal: ${String(right).slice(0, 160)}`);
};

let m;
let arch;
try {
  m = require(path.join(root, "engine/vendor/desktop-core/dist/electron/architecture/manifest.js"));
} catch (error) {
  console.error("FAIL architecture-parity: vendored desktop manifest unavailable —", String(error && error.message));
  console.error("     (검사 불가는 통과가 아니다. scripts/vendor-desktop-core.cjs 로 벤더를 갱신하라.)");
  process.exit(1);
}
try {
  arch = require(path.join(root, "engine/architecture.data.json"));
} catch (error) {
  console.error("FAIL architecture-parity: engine/architecture.data.json unreadable —", String(error && error.message));
  process.exit(1);
}

// ── 스칼라 상수: JSON 키 ↔ TS export 명시 매핑 ──────────────────────────────
const SCALAR_MAP = {
  version: "ARCHITECTURE_VERSION",
  emitterBlock: "MEMORY_EMITTER_BLOCK",
  eventsHeading: "MEMORY_EVENTS_HEADING",
  memoryDir: "PROJECT_MEMORY_DIR",
  soulFile: "PROJECT_SOUL_FILE",
  sitemapFile: "SITEMAP_FILE",
  logFile: "MEMORY_LOG_FILE",
  localCredentialsMapFile: "LOCAL_CREDENTIALS_MAP_FILE",
  projectEnvExampleFile: "PROJECT_ENV_EXAMPLE_FILE",
  projectSigningDir: "PROJECT_SIGNING_DIR",
  projectCredentialsDir: "PROJECT_CREDENTIALS_DIR",
  projectCredentialsReadmeFile: "PROJECT_CREDENTIALS_README_FILE",
  skillRegistryFile: "SKILL_REGISTRY_FILE",
  skillTrialsFile: "SKILL_TRIALS_FILE",
  curatorDecisionsFile: "CURATOR_DECISIONS_FILE",
  careerGraphConfigFile: "CAREER_GRAPH_CONFIG_FILE",
  careerGraphSourceManifestFile: "CAREER_GRAPH_SOURCE_MANIFEST_FILE",
  careerGraphInboxDir: "CAREER_GRAPH_INBOX_DIR",
  careerGraphDbFile: "CAREER_GRAPH_DB_FILE",
};
for (const [jsonKey, tsName] of Object.entries(SCALAR_MAP)) {
  if (!(tsName in m)) { failures.push(`missing desktop export: ${tsName}`); continue; }
  if (!(jsonKey in arch)) { failures.push(`missing terminal key: ${jsonKey}`); continue; }
  check(`${jsonKey} ↔ ${tsName}`, m[tsName], arch[jsonKey]);
}

// ── superOntology* 계열: 기계적 camel ↔ SNAKE 변환으로 전수 대조 ────────────
for (const jsonKey of Object.keys(arch)) {
  if (!jsonKey.startsWith("superOntology")) continue;
  const tsName = jsonKey.replace(/([A-Z])/g, "_$1").toUpperCase(); // superOntologyContractFile → SUPER_ONTOLOGY_CONTRACT_FILE
  if (!(tsName in m)) { failures.push(`missing desktop export for ${jsonKey}: ${tsName}`); continue; }
  check(`${jsonKey} ↔ ${tsName}`, m[tsName], arch[jsonKey]);
}

// ── 배열 계약: kinds / scopes / 빌트인 에이전트 ─────────────────────────────
check("kinds ↔ MEMORY_KINDS", m.MEMORY_KINDS, arch.kinds);
check("scopes ↔ MEMORY_SCOPES", m.MEMORY_SCOPES, arch.scopes);

const desktopAgents = (m.BUILTIN_AGENTS || []).map((a) => a.slug).sort();
const terminalAgents = (arch.agents || []).map((a) => a.slug).sort();
check("builtin agent slugs", desktopAgents, terminalAgents);
// 프롬프트 본문까지 값 대조 — 이름만 같고 지시문이 갈리면 두 표면의 시스템
// 에이전트가 다르게 행동한다.
const desktopPrompts = new Map((m.BUILTIN_AGENTS || []).map((a) => [a.slug, a.systemPrompt]));
for (const agent of arch.agents || []) {
  if (!desktopPrompts.has(agent.slug)) continue;
  if (typeof agent.systemPrompt === "string" && agent.systemPrompt !== desktopPrompts.get(agent.slug)) {
    failures.push(`systemPrompt drift: ${agent.slug} (desktop ${String(desktopPrompts.get(agent.slug)).length}B vs terminal ${agent.systemPrompt.length}B)`);
  }
}
// 터미널 소유 빌트인(예: agentlas-builder)은 데스크탑 명단에 없어도 정상 —
// 표면 소유 분리(2026-08-06 오너 원칙). 이 게이트는 "공유 선언이 같은가"만 본다.

if (failures.length) {
  console.error(`FAIL architecture-parity: ${failures.length} drift(s)`);
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log(`PASS architecture-parity (scalars ${Object.keys(SCALAR_MAP).length} + superOntology ${Object.keys(arch).filter((k) => k.startsWith("superOntology")).length} + kinds/scopes/agents)`);
