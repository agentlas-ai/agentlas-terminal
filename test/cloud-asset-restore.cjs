#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// v2: 설치/물질화 계약은 hub/install.cjs, invoke 프롬프트는 agents/registry.cjs. 단언은 v1 그대로.
const {
  cloudSystemPromptFromPackage: cloudSystemPromptFromPackageCli,
  materializeCloudListing: materializeCloudListingCli,
  persistCloudListing: persistCloudListingCli,
  recoverCloudInstallJournal: recoverCloudInstallJournalCli,
  recoverCloudInstallJournals: recoverCloudInstallJournalsCli,
} = require("../engine/hub/install.cjs");
const { agentSystemPrompt: agentSystemPromptCli } = require("../engine/agents/registry.cjs");

function cloudFile(filePath, content, overrides = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    path: filePath,
    contentBase64: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

function packageHash(files, version = "path-sha256-v1") {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    if (version === "path-sha256-executable-v2") {
      hash.update(file.executable ? "x" : "-");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function packageRecord(files, options = {}) {
  const version = options.packageHashVersion || "path-sha256-v1";
  return {
    packageHash: options.packageHash || packageHash(files, version),
    ...(options.packageHashVersion ? { packageHashVersion: options.packageHashVersion } : {}),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-asset-"));
const previousUserData = process.env.AGENTLAS_USER_DATA_DIR;
process.env.AGENTLAS_USER_DATA_DIR = userData;

try {
  const slug = "portable-agent";
  const root = path.join(userData, "cloud-agent-installs", slug);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "old agent\n");
  fs.writeFileSync(path.join(root, "removed-in-v2.md"), "stale\n");
  fs.writeFileSync(
    path.join(root, ".agentlas-cloud-package.json"),
    JSON.stringify({ agentId: "agent-1", packageHash: "sha256:v1" }),
  );

  const v2Files = [
    cloudFile("AGENTS.md", "new agent\n", { executable: false }),
    cloudFile("assets/model.bin", Buffer.from([0x00, 0xff, 0x80, 0x41]), { executable: false }),
    cloudFile("run.sh", "#!/bin/sh\nexit 0\n", { executable: true }),
    cloudFile("skills/core/SKILL.md", "portable skill\n", { executable: false }),
  ];
  const v2 = {
    cloudPackage: packageRecord(v2Files, { packageHashVersion: "path-sha256-executable-v2" }),
  };
  assert.equal(materializeCloudListingCli("agent-1", slug, v2), root);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n");

  const overlongComponentFiles = [cloudFile("a".repeat(256), "too long\n")];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, {
      cloudPackage: packageRecord(overlongComponentFiles),
    }),
    /unsafe cloud package path/,
  );
  const overlongUtf8Files = [cloudFile("한".repeat(86), "too many UTF-8 bytes\n")];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, { cloudPackage: packageRecord(overlongUtf8Files) }),
    /unsafe cloud package path/,
  );
  const surrogateFiles = [cloudFile("\ud800.txt", "ill-formed path\n")];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, { cloudPackage: packageRecord(surrogateFiles) }),
    /unsafe cloud package path/,
  );
  assert.equal(fs.existsSync(path.join(root, "removed-in-v2.md")), false, "removed files must not survive restore");
  assert.deepEqual(fs.readFileSync(path.join(root, "assets/model.bin")), Buffer.from([0x00, 0xff, 0x80, 0x41]));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "AGENTS.md")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, "run.sh")).mode & 0o777, 0o700);
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, ".agentlas-cloud-package.json"), "utf8")).executablePaths,
    ["run.sh"],
  );

  fs.writeFileSync(path.join(root, "AGENTS.md"), "locally mutated\n");
  materializeCloudListingCli("agent-1", slug, v2);
  assert.equal(
    fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
    "new agent\n",
    "same-hash restore must reproduce the immutable asset",
  );

  const broken = {
    cloudPackage: packageRecord(
      [cloudFile("AGENTS.md", "broken update\n", { sha256: "0".repeat(64), executable: false })],
      { packageHash: "0".repeat(64), packageHashVersion: "path-sha256-executable-v2" },
    ),
  };
  assert.throws(() => materializeCloudListingCli("agent-1", slug, broken), /integrity failed/);
  assert.equal(
    fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
    "new agent\n",
    "failed restore must preserve the last valid asset",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, ".agentlas-cloud-package.json"), "utf8")).packageHash,
    packageHash(v2Files, "path-sha256-executable-v2"),
  );

  const aggregateMismatchFiles = [cloudFile("AGENTS.md", "aggregate mismatch\n", { executable: false })];
  const aggregateMismatch = {
    cloudPackage: packageRecord(aggregateMismatchFiles, { packageHash: "f".repeat(64), packageHashVersion: "path-sha256-executable-v2" }),
  };
  assert.throws(() => materializeCloudListingCli("agent-1", slug, aggregateMismatch), /aggregate integrity failed/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n");

  const writes = [];
  const fakeDb = {
    prepare(sql) {
      return {
        get() {
          if (sql.startsWith("SELECT * FROM installed_agents")) return { id: "agent-1", slug };
          return null;
        },
        run() {
          writes.push(sql);
        },
        all() {
          return [];
        },
      };
    },
  };
  assert.throws(() => persistCloudListingCli(fakeDb, { slug, name: slug, cloudPackage: aggregateMismatch.cloudPackage }), /aggregate integrity failed/);
  assert.equal(writes.length, 0, "failed asset restore must not commit newer DB metadata");

  const nestedEntrySlug = "nested-entry-agent";
  const nestedMarker = "CLOUD_PACKAGE_INVOKE_MARKER_7f3c";
  const nestedEntryFiles = [
    cloudFile("agentlas.json", JSON.stringify({ schemaVersion: "1.0", entry: "agents/ceo/AGENT.md" }) + "\n", { executable: false }),
    cloudFile("AGENTS.md", "ROOT_DECOY_MUST_NOT_WIN\n", { executable: false }),
    cloudFile("agents/ceo/AGENT.md", `# CEO\n\n${nestedMarker}\n`, { executable: false }),
  ];
  const nestedListing = {
    slug: nestedEntrySlug,
    name: "Nested Entry Agent",
    tagline: "Restored package invocation fixture",
    mcpServers: [{ id: "fixture" }],
    envRequirements: [{ key: "FIXTURE_KEY" }],
    cloudPackage: packageRecord(nestedEntryFiles, { packageHashVersion: "path-sha256-executable-v2" }),
  };
  assert.match(cloudSystemPromptFromPackageCli(nestedListing, nestedEntrySlug), new RegExp(nestedMarker));
  assert.doesNotMatch(cloudSystemPromptFromPackageCli(nestedListing, nestedEntrySlug), /ROOT_DECOY_MUST_NOT_WIN/);
  let legacyRow = {
    id: "legacy-db-agent",
    slug: nestedEntrySlug,
    name: "Old Agent",
    name_en: "Old Agent",
    tagline: "old",
    tagline_en: "old",
    system_prompt: "old prompt",
    mcp_servers_json: "[]",
    env_requirements_json: "[]",
    trust_grade: "unknown",
    installed_at: "2000-01-01T00:00:00.000Z",
    tone: "gray",
  };
  const legacySql = [];
  const legacyDb = {
    prepare(sql) {
      legacySql.push(sql);
      return {
        get() {
          if (sql.startsWith("SELECT * FROM installed_agents")) return legacyRow;
          return null;
        },
        all() {
          if (sql.startsWith("PRAGMA table_info(installed_agents)")) {
            return Object.keys(legacyRow).map((name) => ({ name }));
          }
          return [];
        },
        run(...args) {
          if (sql.startsWith("UPDATE installed_agents")) {
            const [name, nameEn, tagline, taglineEn, systemPrompt, mcpJson, envJson, trustGrade, installedAt, tone, updateSlug] = args;
            assert.equal(updateSlug, nestedEntrySlug);
            legacyRow = {
              ...legacyRow,
              name,
              name_en: nameEn,
              tagline,
              tagline_en: taglineEn,
              system_prompt: systemPrompt,
              mcp_servers_json: mcpJson,
              env_requirements_json: envJson,
              trust_grade: trustGrade,
              installed_at: installedAt,
              tone,
            };
          }
        },
      };
    },
    transaction(fn) { return () => fn(); },
  };
  persistCloudListingCli(legacyDb, nestedListing);
  const legacyUpdateSql = legacySql.find((sql) => sql.startsWith("UPDATE installed_agents"));
  assert.ok(legacyUpdateSql);
  assert.equal(/visibility/.test(legacyUpdateSql), false, "legacy DB update must not reference a missing visibility column");
  assert.match(legacyRow.system_prompt, new RegExp(nestedMarker));
  assert.doesNotMatch(legacyRow.system_prompt, /ROOT_DECOY_MUST_NOT_WIN/);
  assert.match(agentSystemPromptCli(legacyRow), new RegExp(nestedMarker), "normal invoke must use the restored canonical package entry");
  assert.equal(
    fs.readFileSync(path.join(userData, "cloud-agent-installs", nestedEntrySlug, "agents/ceo/AGENT.md"), "utf8").includes(nestedMarker),
    true,
  );

  const dbFailureFiles = [cloudFile("AGENTS.md", "db failure must roll back disk\n", { executable: false })];
  const dbFailureListing = {
    slug,
    name: "DB Failure Candidate",
    cloudPackage: packageRecord(dbFailureFiles, { packageHashVersion: "path-sha256-executable-v2" }),
  };
  const dbFailure = {
    prepare(sql) {
      return {
        get() { return sql.startsWith("SELECT * FROM installed_agents") ? { id: "agent-1", slug, name: "Old" } : null; },
        all() { return []; },
        run() { throw new Error("simulated sqlite update failure"); },
      };
    },
  };
  assert.throws(() => persistCloudListingCli(dbFailure, dbFailureListing), /simulated sqlite update failure/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n", "DB failure must restore the prior disk snapshot");
  assert.equal(
    fs.readdirSync(path.dirname(root)).some((name) => name.includes("install-journal") || name.includes(".backup-")),
    false,
    "compensated DB failure must not leave journal or backup debris",
  );

  const crashFiles = [cloudFile("AGENTS.md", "pending crash snapshot\n", { executable: false })];
  materializeCloudListingCli("agent-1", slug, {
    cloudPackage: packageRecord(crashFiles, { packageHashVersion: "path-sha256-executable-v2" }),
  }, { deferCommit: true, dbExpected: { name: "Expected New Row" } });
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "pending crash snapshot\n");
  const oldRowDb = {
    prepare() { return { get() { return { id: "agent-1", slug, name: "Old Row" }; } }; },
  };
  recoverCloudInstallJournalCli(oldRowDb, slug);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n", "restart recovery must roll back disk when DB never committed");

  const committedCrashFiles = [cloudFile("AGENTS.md", "committed crash snapshot\n", { executable: false })];
  materializeCloudListingCli("agent-1", slug, {
    cloudPackage: packageRecord(committedCrashFiles, { packageHashVersion: "path-sha256-executable-v2" }),
  }, { deferCommit: true, dbExpected: { name: "Committed Row" } });
  const committedRowDb = {
    prepare() { return { get() { return { id: "agent-1", slug, name: "Committed Row" }; } }; },
  };
  recoverCloudInstallJournalCli(committedRowDb, slug);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "committed crash snapshot\n", "restart recovery must keep disk when DB committed");

  const metadataOnlyCrashFiles = [cloudFile("AGENTS.md", "metadata-only crash snapshot\n", { executable: false })];
  materializeCloudListingCli("agent-1", slug, {
    cloudPackage: packageRecord(metadataOnlyCrashFiles, { packageHashVersion: "path-sha256-executable-v2" }),
  }, {
    deferCommit: true,
    dbExpected: { name: "Same Display", mcp_servers_json: '["new"]', installed_at: "2099-01-01T00:00:00.000Z" },
  });
  const staleMetadataDb = {
    prepare() {
      return { get() { return { id: "agent-1", slug, name: "Same Display", mcp_servers_json: '["old"]', installed_at: "2000-01-01T00:00:00.000Z" }; } };
    },
  };
  recoverCloudInstallJournalCli(staleMetadataDb, slug);
  assert.equal(
    fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
    "committed crash snapshot\n",
    "WAL recovery must compare MCP/env/revision metadata rather than display text alone",
  );

  const recoveryDb = { prepare() { return { get() { return null; } }; } };
  const installParent = path.join(userData, "cloud-agent-installs");
  const writePreparedJournal = (journalSlug, hadExisting, state) => {
    const destination = path.join(installParent, journalSlug);
    const staging = path.join(installParent, `.${journalSlug}.installing-fixture`);
    const backup = path.join(installParent, `.${journalSlug}.backup-fixture`);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    if (state.destination) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "state.txt"), state.destination);
    }
    if (state.staging) {
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, "state.txt"), state.staging);
    }
    if (state.backup) {
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, "state.txt"), state.backup);
    }
    fs.writeFileSync(
      path.join(installParent, `.${journalSlug}.install-journal.json`),
      JSON.stringify({
        schemaVersion: 1,
        slug: journalSlug,
        phase: "prepared",
        destination,
        staging,
        backup,
        hadExisting,
        dbExpected: { installed_at: "never-committed" },
      }),
    );
    return { destination, staging, backup };
  };
  const afterOldRename = writePreparedJournal("crash-after-old-rename", true, { staging: "new", backup: "old" });
  const afterNewRename = writePreparedJournal("crash-after-new-rename", true, { destination: "new", backup: "old" });
  const firstInstallRename = writePreparedJournal("crash-first-install", false, { destination: "new" });
  assert.equal(recoverCloudInstallJournalsCli(recoveryDb), 3, "startup sweep must recover every interrupted slug before normal resolution");
  assert.equal(fs.readFileSync(path.join(afterOldRename.destination, "state.txt"), "utf8"), "old");
  assert.equal(fs.existsSync(afterOldRename.staging), false);
  assert.equal(fs.readFileSync(path.join(afterNewRename.destination, "state.txt"), "utf8"), "old");
  assert.equal(fs.existsSync(firstInstallRename.destination), false, "uncommitted first install must not survive the prepared crash window");

  // Restore the main v2 fixture for the remaining path-safety assertions.
  materializeCloudListingCli("agent-1", slug, v2);

  const duplicateFiles = [cloudFile("AGENTS.md", "first\n"), cloudFile("AGENTS.md", "second\n")];
  const duplicate = { cloudPackage: packageRecord(duplicateFiles) };
  assert.throws(() => materializeCloudListingCli("agent-1", slug, duplicate), /repeats file path/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n");

  const ancestorAliasFiles = [
    cloudFile("Skills/writer/SKILL.md", "first\n"),
    cloudFile("skills/reviewer/SKILL.md", "second\n"),
  ];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, { cloudPackage: packageRecord(ancestorAliasFiles) }),
    /Ancestor directories.*alias/,
  );
  const unicodeAliasFiles = [
    cloudFile("Caf\u00e9/a.md", "first\n"),
    cloudFile("Cafe\u0301/b.md", "second\n"),
  ];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, { cloudPackage: packageRecord(unicodeAliasFiles) }),
    /Unicode NFC/,
  );

  const missingExecutable = [cloudFile("AGENTS.md", "missing v2 bit\n")];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, {
      cloudPackage: packageRecord(missingExecutable, { packageHashVersion: "path-sha256-executable-v2" }),
    }),
    /requires executable boolean/,
  );
  const executableTamperFiles = [cloudFile("run.sh", "#!/bin/sh\n", { executable: true })];
  const executableTamperHash = packageHash(executableTamperFiles, "path-sha256-executable-v2");
  executableTamperFiles[0].executable = false;
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, {
      cloudPackage: packageRecord(executableTamperFiles, { packageHashVersion: "path-sha256-executable-v2", packageHash: executableTamperHash }),
    }),
    /aggregate integrity failed/,
  );
  const unauthenticatedLegacyMode = [cloudFile("run.sh", "#!/bin/sh\n", { executable: true })];
  assert.throws(
    () => materializeCloudListingCli("agent-1", slug, {
      cloudPackage: packageRecord(unauthenticatedLegacyMode),
    }),
    /legacy cloud package hash v1 cannot authenticate executable flag/,
  );

  const legacySlug = "legacy-v1-agent";
  const legacyRoot = path.join(userData, "cloud-agent-installs", legacySlug);
  const legacyFiles = [cloudFile("AGENTS.md", "legacy v1 exact bytes\n")];
  assert.equal(materializeCloudListingCli("legacy-agent", legacySlug, {
    cloudPackage: packageRecord(legacyFiles),
  }), legacyRoot);
  assert.equal(fs.readFileSync(path.join(legacyRoot, "AGENTS.md"), "utf8"), "legacy v1 exact bytes\n");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(legacyRoot, ".agentlas-cloud-package.json"), "utf8")).packageHashVersion,
    "path-sha256-v1",
  );
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(legacyRoot, "AGENTS.md")).mode & 0o777, 0o600);

  const escapingFiles = [cloudFile("../outside.md", "escape\n")];
  const escaping = { cloudPackage: packageRecord(escapingFiles) };
  assert.throws(() => materializeCloudListingCli("agent-1", slug, escaping), /unsafe cloud package path/);
  assert.equal(fs.existsSync(path.join(userData, "cloud-agent-installs", "outside.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "new agent\n");
  console.log("cloud asset restore: PASS");
} finally {
  if (previousUserData === undefined) delete process.env.AGENTLAS_USER_DATA_DIR;
  else process.env.AGENTLAS_USER_DATA_DIR = previousUserData;
  fs.rmSync(userData, { recursive: true, force: true });
}
