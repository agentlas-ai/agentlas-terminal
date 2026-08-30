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

function privateSeedName(value, fallback) {
  const name = String(value || fallback || "").trim();
  if (!name || name !== path.basename(name) || name === "." || name === ".." || name.length > 180) {
    throw new Error("Agentlas project seed contains an unsafe file name");
  }
  return name;
}

function ensurePrivateDirectory(dir) {
  try { fs.mkdirSync(dir, { recursive: false, mode: 0o700 }); }
  catch (error) { if (!error || error.code !== "EEXIST") throw error; }
  const listed = fs.lstatSync(dir);
  if (!listed.isDirectory() || listed.isSymbolicLink()) {
    throw new Error("Agentlas project state path must be a real directory");
  }
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}

function ensurePrivateSeedFile(file, content) {
  let fd = null;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
      const bytes = Buffer.from(String(content), "utf8");
      const written = fs.writeSync(fd, bytes, 0, bytes.length, null);
      if (written !== bytes.length) throw new Error("Agentlas project seed write was incomplete");
      fs.fsyncSync(fd);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; }
      fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    }
    const opened = fs.fstatSync(fd);
    const listed = fs.lstatSync(file);
    if (
      !opened.isFile() || opened.nlink !== 1 ||
      !listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 ||
      opened.dev !== listed.dev || opened.ino !== listed.ino
    ) throw new Error("Agentlas project seed target must be a single-link regular file");
    try { fs.fchmodSync(fd, 0o600); } catch { /* Windows/ACL-only host */ }
    return file;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const root = path.resolve(projectPath);
    const canonicalRoot = fs.realpathSync.native(root);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.parse(canonicalRoot).root === canonicalRoot) return null;
    const memoryDirName = privateSeedName(arch.memoryDir, ".agentlas");
    const dir = ensurePrivateDirectory(path.join(root, memoryDirName));
    removeLegacySuperOntologyFiles(dir);
    const name = String(projectName || path.basename(root) || "Project").slice(0, 200);
    ensureLocalCredentialStoreCli(root, name, arch);
    ensureSoulCredentialIndexCli(root, name, arch);
    const sitemap = path.join(dir, privateSeedName(arch.sitemapFile, "sitemap.json"));
    const now = new Date().toISOString();
    ensurePrivateSeedFile(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2));
    const skillRegistryFile = privateSeedName(arch.skillRegistryFile, "skill-registry.json");
    const skillTrialsFile = privateSeedName(arch.skillTrialsFile, "skill-trials.jsonl");
    const curatorDecisionsFile = privateSeedName(arch.curatorDecisionsFile, "curator-decisions.jsonl");
    const ontologyRuntimeFile = privateSeedName(arch.ontologyRuntimeFile, "ontology-runtime.json");
    const ontologySourceManifestFile = privateSeedName(arch.ontologySourceManifestFile, "ontology-sources.json");
    const ontologyInboxDir = privateSeedName(arch.ontologyInboxDir, "ontology-inbox");
    const ontologyDbFile = privateSeedName(arch.ontologyDbFile, "ontology-runtime.sqlite");
    const careerGraphConfigFile = privateSeedName(arch.careerGraphConfigFile, "career-graph.json");
    const careerGraphSourceManifestFile = privateSeedName(arch.careerGraphSourceManifestFile, "career-graph-sources.json");
    const careerGraphInboxDir = privateSeedName(arch.careerGraphInboxDir, "career-graph-inbox");
    const careerGraphDbFile = privateSeedName(arch.careerGraphDbFile, "career-graph.sqlite");
    const skillRegistry = path.join(dir, skillRegistryFile);
    ensurePrivateSeedFile(skillRegistry, JSON.stringify({
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
      }, null, 2));
    const ontologyInbox = ensurePrivateDirectory(path.join(dir, ontologyInboxDir));
    const ontologyRuntime = path.join(dir, ontologyRuntimeFile);
    ensurePrivateSeedFile(ontologyRuntime, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-runtime",
        state: "active",
        activation: "automatic",
        projectRoot: root,
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
      }, null, 2));
    const ontologySources = path.join(dir, ontologySourceManifestFile);
    ensurePrivateSeedFile(ontologySources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-ontology-source-manifest",
        projectRoot: root,
        sources: [],
      }, null, 2));
    const careerGraphInbox = ensurePrivateDirectory(path.join(dir, careerGraphInboxDir));
    const careerGraphConfig = path.join(dir, careerGraphConfigFile);
    ensurePrivateSeedFile(careerGraphConfig, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph",
        state: "active",
        model: "ledger_first_derived_index",
        projectRoot: root,
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
      }, null, 2));
    const careerGraphSources = path.join(dir, careerGraphSourceManifestFile);
    ensurePrivateSeedFile(careerGraphSources, JSON.stringify({
        schemaVersion: "1.0",
        kind: "agentlas-career-graph-source-manifest",
        projectRoot: root,
        sources: [],
      }, null, 2));
    for (const fileName of [skillTrialsFile, curatorDecisionsFile]) {
      ensurePrivateSeedFile(path.join(dir, fileName), "");
    }
    return dir;
  } catch { return null; }
}

module.exports = { ensureProjectMemoryCli, removeLegacySuperOntologyFiles };
