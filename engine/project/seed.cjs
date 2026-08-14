"use strict";
/*
 * project/seed — .agentlas/ 비공개 프로젝트 상태 시드 (v1 ensureProjectMemoryCli 포팅).
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

// 제거 범위는 과거 Terminal이 직접 생성한 정해진 파일명에만 한정한다. `super-ontology-*`
// 와일드카드 삭제는 사용자가 만든 동명 문서까지 지울 수 있고, AO/Workforce/semantic ontology,
// Context Map, Career Graph는 별도 살아 있는 계약이므로 이름 추측으로 건드리지 않는다.
const LEGACY_SUPER_ONTOLOGY_FILES = Object.freeze([
  "super-ontology-contract.json",
  "super-ontology-open-world-coverage.json",
  "super-ontology-consensus-coordination.json",
  "super-ontology-task-coverage.json",
  "super-ontology-contextual-flow.json",
  "super-ontology-causal-impact.json",
  "super-ontology-assurance-case.json",
  "super-ontology-knowledge-homeostasis.json",
  "super-ontology-adversarial-provenance.json",
  "super-ontology-epistemic-calibration.json",
  "super-ontology-semantic-alignment.json",
  "super-ontology-resilience-control.json",
  "super-ontology-invariant-verification.json",
  "super-ontology-observability-telemetry.json",
  "super-ontology-objective-proxy-validity.json",
  "super-ontology-stakeholder-preference-governance.json",
  "super-ontology-normative-authority-drift.json",
  "super-ontology-side-effect-containment.json",
  "super-ontology-source-lineage-version.json",
  "super-ontology-entity-identity-resolution.json",
  "super-ontology-temporal-state-transition.json",
  "super-ontology-capability-delegation-authority.json",
  "super-ontology-privacy-confidentiality-boundary.json",
  "super-ontology-strategic-incentive-compatibility.json",
  "super-ontology-reflexive-feedback-stability.json",
  "super-ontology-replays.jsonl",
  "super-ontology-evidence.jsonl",
  "super-ontology-memory-bridge.jsonl",
]);

function removeLegacySuperOntologyFiles(dir) {
  for (const fileName of LEGACY_SUPER_ONTOLOGY_FILES) {
    const filePath = path.join(dir, fileName);
    let stat;
    try { stat = fs.lstatSync(filePath); } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    // 알려진 레거시 산출물은 파일/링크였다. 같은 이름의 디렉터리는 사용자 데이터일 수 있다.
    if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(filePath);
  }
}

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir || ".agentlas");
    fs.mkdirSync(dir, { recursive: true });
    removeLegacySuperOntologyFiles(dir);
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
    return dir;
  } catch { return null; }
}

module.exports = { ensureProjectMemoryCli, removeLegacySuperOntologyFiles };
