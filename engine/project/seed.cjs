"use strict";
/*
 * project/seed — .agentlas/ 비공개 프로젝트 상태 시드 (v1 ensureProjectMemoryCli 포팅).
 *
 * v1 monolith 4184–7652에서 ~3,400줄이 super-ontology JSON 문서 리터럴 25개였다.
 * 그 문서들은 engine/project/super-ontology-seed.json 데이터 파일로 추출했고
 * (바이트 동일 — projectId만 치환 자리), 이 모듈은 그 목록을 순회만 한다.
 *
 * 경계(0.9.10): 이 함수는 아무 명령에서나 자동으로 불리지 않는다.
 * `agentlas project init` 경로(state.cjs의 ensureCoreProjectCli 폴백)만 호출한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadArch } = require("../core/db.cjs");
const {
  ensureLocalCredentialStoreCli,
  ensureSoulCredentialIndexCli,
} = require("./credentials.cjs");

// 추출된 super-ontology 시드 문서 (v1과 동일한 기록 순서를 배열 순서로 보존).
const SUPER_ONTOLOGY_SEED = require("./super-ontology-seed.json");

/** projectId 자리만 치환해 v1과 바이트 동일한 문서를 만든다 (키 순서 보존). */
function superOntologyDocumentFor(entry, projectName) {
  const doc = JSON.parse(JSON.stringify(entry.doc));
  doc.projectId = projectName;
  return doc;
}

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir || ".agentlas");
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    ensureLocalCredentialStoreCli(projectPath, name, arch);
    ensureSoulCredentialIndexCli(projectPath, name, arch);
    const sitemap = path.join(dir, arch.sitemapFile || "sitemap.json");
    if (!fs.existsSync(sitemap)) {
      const now = new Date().toISOString();
      fs.writeFileSync(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2), "utf8");
    }
    const skillRegistryFile = arch.skillRegistryFile || "skill-registry.json";
    const skillTrialsFile = arch.skillTrialsFile || "skill-trials.jsonl";
    const curatorDecisionsFile = arch.curatorDecisionsFile || "curator-decisions.jsonl";
    const ontologyRuntimeFile = arch.ontologyRuntimeFile || "ontology-runtime.json";
    const ontologySourceManifestFile = arch.ontologySourceManifestFile || "ontology-sources.json";
    const ontologyInboxDir = arch.ontologyInboxDir || "ontology-inbox";
    const ontologyDbFile = arch.ontologyDbFile || "ontology-runtime.sqlite";
    const careerGraphConfigFile = arch.careerGraphConfigFile || "career-graph.json";
    const careerGraphSourceManifestFile = arch.careerGraphSourceManifestFile || "career-graph-sources.json";
    const careerGraphInboxDir = arch.careerGraphInboxDir || "career-graph-inbox";
    const careerGraphDbFile = arch.careerGraphDbFile || "career-graph.sqlite";
    const superOntologyReplaysFile = arch.superOntologyReplaysFile || "super-ontology-replays.jsonl";
    const superOntologyEvidenceFile = arch.superOntologyEvidenceFile || "super-ontology-evidence.jsonl";
    const superOntologyMemoryBridgeFile = arch.superOntologyMemoryBridgeFile || "super-ontology-memory-bridge.jsonl";
    const skillRegistry = path.join(dir, skillRegistryFile);
    if (!fs.existsSync(skillRegistry)) {
      fs.writeFileSync(skillRegistry, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-skill-lifecycle-registry",
        state: "local_candidate",
        projectId: name,
        draftId: null,
        defaultTier: "candidate",
        runtimeFirstClassRecallEnabled: false,
        predicatesRequired: true,
        curatorQuarantineRequired: true,
        evidenceLedgers: {
          trials: `.agentlas/${skillTrialsFile}`,
          curatorDecisions: `.agentlas/${curatorDecisionsFile}`,
          memoryEvents: `.agentlas/${arch.logFile || "memory-log.jsonl"}`,
        },
        hardStops: [
          "permission_change",
          "credential_change",
          "payment_or_billing_effect",
          "regulated_or_irreversible_side_effect",
          "same_authority_patch_and_validator",
          "holdout_contamination",
          "missing_rollback_snapshot",
        ],
        effectiveErrorBudgetTerms: [
          "first_class_error_mass",
          "quarantine_false_accept_estimate",
          "blind_spot_estimate",
          "drift_estimate",
        ],
        niches: [],
        skills: [],
        rolloutPolicy: {
          staticOnlyCanApprove: false,
          sandboxRequired: true,
          holdoutRequired: true,
          shadowRequiredForFastPathChanges: true,
          lowRiskCanaryOnly: true,
          severeFailureTolerance: 0,
        },
      }, null, 2), "utf8");
    }
    const ontologyInbox = path.join(dir, ontologyInboxDir);
    if (!fs.existsSync(ontologyInbox)) fs.mkdirSync(ontologyInbox, { recursive: true });
    const ontologyRuntime = path.join(dir, ontologyRuntimeFile);
    if (!fs.existsSync(ontologyRuntime)) {
      fs.writeFileSync(ontologyRuntime, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-runtime",
        state: "active",
        activation: "automatic",
        projectRoot: projectPath,
        projectName: name,
        dbPath: path.join(dir, ontologyDbFile),
        inboxPath: ontologyInbox,
        sourceManifest: path.join(dir, ontologySourceManifestFile),
        defaultScope: "internal",
        autoIngestPolicy: {
          mode: "inbox_and_registered_sources_only",
          neverScanHomeDirectory: true,
          neverScanSiblingProjects: true,
          crossProjectSearchDefault: "disabled",
          privateScopeDefaultSearch: "excluded",
        },
        promotionMode: {
          operatorManagedLocal: true,
          securityGateMode: "context_folder_routing_only",
          blockingSecurityGate: false,
          notes: "Local promotion is blocked by missing project/folder/owner/evidence/rollback structure, not by a generic security gate.",
        },
        memoryPolicy: {
          durableWrites: "candidate-ticket-only",
          workingMemory: "runtime-cache-only",
        },
      }, null, 2), "utf8");
    }
    const ontologySources = path.join(dir, ontologySourceManifestFile);
    if (!fs.existsSync(ontologySources)) {
      fs.writeFileSync(ontologySources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-source-manifest",
        projectRoot: projectPath,
        sources: [],
      }, null, 2), "utf8");
    }
    const careerGraphInbox = path.join(dir, careerGraphInboxDir);
    if (!fs.existsSync(careerGraphInbox)) fs.mkdirSync(careerGraphInbox, { recursive: true });
    const careerGraphConfig = path.join(dir, careerGraphConfigFile);
    if (!fs.existsSync(careerGraphConfig)) {
      fs.writeFileSync(careerGraphConfig, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph",
        state: "active",
        model: "ledger_first_derived_index",
        projectRoot: projectPath,
        projectName: name,
        dbPath: path.join(dir, careerGraphDbFile),
        inboxPath: careerGraphInbox,
        sourceManifest: path.join(dir, careerGraphSourceManifestFile),
        canonicalSourcePolicy: {
          sourceOfTruth: "markdown_jsonl_json",
          graphIsRebuildable: true,
          fallbackWhenStale: "read_canonical_files",
          neverScanHomeDirectory: true,
          neverScanSiblingProjects: true,
        },
      }, null, 2), "utf8");
    }
    const careerGraphSources = path.join(dir, careerGraphSourceManifestFile);
    if (!fs.existsSync(careerGraphSources)) {
      fs.writeFileSync(careerGraphSources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph-source-manifest",
        projectRoot: projectPath,
        sources: [],
      }, null, 2), "utf8");
    }
    for (const fileName of [skillTrialsFile, curatorDecisionsFile]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    // super-ontology 계약 문서 25종 — 데이터 파일 순회 (v1 인라인 리터럴과 바이트 동일).
    for (const entry of SUPER_ONTOLOGY_SEED.documents) {
      const fileName = arch[entry.archKey] || entry.file;
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(superOntologyDocumentFor(entry, name), null, 2), "utf8");
      }
    }
    for (const fileName of [
      superOntologyReplaysFile,
      superOntologyEvidenceFile,
      superOntologyMemoryBridgeFile,
    ]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
    }
    return dir;
  } catch { return null; }
}

module.exports = { ensureProjectMemoryCli, SUPER_ONTOLOGY_SEED };
