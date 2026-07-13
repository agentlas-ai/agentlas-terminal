#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exchange = require("../engine/agentlas-experience-exchange.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seal(bundle) {
  const value = clone(bundle);
  value.pack.contentHash = exchange.experiencePackContentHash(value);
  value.bundleHash = exchange.experienceBundleHash(value);
  value.bundleId = exchange.experienceBundleId(value);
  return value;
}

function response(status, body, revision = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: JSON.stringify(body),
    headers: { get: (name) => String(name).toLowerCase() === "etag" && revision ? `"${revision}"` : null },
  };
}

function receipt(bundle, overrides = {}) {
  return {
    schema: "agentlas.experience-upload-receipt.v1",
    uploadId: overrides.uploadId || `exu_${"a".repeat(48)}`,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    experiencePackId: bundle.pack.experiencePackId,
    experienceReleaseId: bundle.pack.releaseId,
    ownerWorkspaceRef: "workspace:server-authority",
    status: overrides.status || "verification-requested",
    requestedVisibility: bundle.requestedVisibility,
    revision: overrides.revision || `rev_${"b".repeat(32)}`,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-07-13T00:00:00.000Z",
  };
}

function baseResolution(bundle) {
  return {
    schema: "agentlas.experience-base-resolution.v1",
    cloudId: "cloud:exact-base",
    slug: "exact-base",
    agentDefinitionId: bundle.pack.baseCompatibility.agentDefinitionId,
    agentReleaseId: bundle.pack.baseCompatibility.compatibleBaseReleaseIds[0],
    packageHash: `sha256:${"c".repeat(64)}`,
    packageHashVersion: "path-sha256-executable-v2",
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-experience-p6-"));
  const userData = path.join(root, "user-data");
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  let checks = 0;
  const check = (fn) => { fn(); checks += 1; };
  try {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "portable-experience-bundle-v1-golden.json"), "utf8"));
    const first = exchange.validateExperienceBundle(fixture.bundle);
    exchange.saveLocalBundle(userData, first, { cwd: project });

    let legacyCalls = 0;
    let networkCalls = 0;
    const output = [];
    const baseOptions = {
      userDataDir: userData,
      cwd: project,
      out: (line) => output.push(String(line)),
      legacyCommand: () => { legacyCalls += 1; return { legacy: true }; },
      getSessionCookie: async () => "agentlas_session=test-session",
      fetchHub: async () => { networkCalls += 1; throw new Error("unexpected network"); },
    };

    const listed = await exchange.cmdExperienceExchange({ ...baseOptions, args: ["list", "--json"] });
    check(() => assert.equal(listed.bundles.length, 1));
    check(() => assert.equal(listed.networkUsed, false));
    check(() => assert.equal(legacyCalls, 0, "modern list must not fall through to the pack-only intent store"));
    check(() => assert.equal(networkCalls, 0));
    check(() => assert.doesNotMatch(output.at(-1), /submitted-owner|ownerRef|instructions|summary|user-data|project\//i));

    const otherListed = exchange.listStoredExperienceBundles(userData, otherProject);
    check(() => assert.deepEqual(otherListed, [], "portable Experience listing must stay scoped to the current project"));

    output.length = 0;
    const inspected = await exchange.cmdExperienceExchange({
      ...baseOptions,
      args: ["inspect", first.bundle.pack.releaseId, "--json"],
    });
    check(() => assert.equal(inspected.experiencePackReleaseId, first.bundle.pack.releaseId));
    check(() => assert.equal(inspected.localBundleVerified, true));
    check(() => assert.equal(inspected.publicActivationClaimed, false));
    check(() => assert.equal(inspected.evaluatorAuthority, false));
    check(() => assert.equal(networkCalls, 0));
    check(() => assert.doesNotMatch(output[0], /submitted-owner|ownerWorkspaceRef|instructions|summary|raw|transcript/i));

    const legacyPackFile = path.join(project, "legacy-pack-only.json");
    fs.writeFileSync(legacyPackFile, JSON.stringify(first.bundle.pack));
    await assert.rejects(exchange.cmdExperienceExchange({
      ...baseOptions,
      args: ["publish", legacyPackFile, "--dry-run"],
    }), /invalid Portable Experience Bundle|schemaVersion|unsupported/i);
    checks += 1;
    check(() => assert.equal(legacyCalls, 0, "pack-only publication must require explicit legacy-publish"));
    check(() => assert.equal(networkCalls, 0));

    const secondBundle = clone(first.bundle);
    secondBundle.pack.releaseId = "experience-release:portable-v2";
    secondBundle.pack.version = "2.0.0";
    secondBundle.items = secondBundle.items.map((item) => ({ ...item, experiencePackReleaseId: secondBundle.pack.releaseId }));
    const second = exchange.validateExperienceBundle(seal(secondBundle));
    exchange.saveLocalBundle(userData, second, { cwd: project });
    check(() => assert.throws(
      () => exchange.inspectStoredExperienceBundle(userData, first.bundle.pack.experiencePackId, project),
      /ambiguous; use an exact release/i,
    ));
    check(() => assert.equal(exchange.inspectStoredExperienceBundle(userData, second.bundle.pack.releaseId, project).bundleId, second.bundle.bundleId));

    const observedReceipt = receipt(first.bundle);
    exchange.commitServerAcceptedBundle(userData, first, observedReceipt, baseResolution(first.bundle), { cwd: project });
    const stateBeforePreview = fs.readFileSync(exchange.exchangeStatePath(userData));
    output.length = 0;
    const preview = await exchange.cmdExperienceExchange({
      ...baseOptions,
      args: ["unpublish", first.bundle.pack.releaseId, "--dry-run", "--json"],
    });
    check(() => assert.equal(preview.dryRun, true));
    check(() => assert.equal(preview.ifMatchRevision, observedReceipt.revision));
    check(() => assert.equal(preview.serverReceiptPresent, true));
    check(() => assert.equal(preview.networkUsed, false));
    check(() => assert.equal(networkCalls, 0));
    check(() => assert.deepEqual(fs.readFileSync(exchange.exchangeStatePath(userData)), stateBeforePreview));
    check(() => assert.doesNotMatch(output[0], /ownerWorkspaceRef|workspace:server-authority/));

    let cookieReads = 0;
    await assert.rejects(exchange.cmdExperienceExchange({
      ...baseOptions,
      args: ["unpublish", "experience-release:not-local", "--dry-run"],
      getSessionCookie: async () => { cookieReads += 1; return "agentlas_session=test-session"; },
    }), /no exact local Experience record/);
    checks += 1;
    check(() => assert.equal(cookieReads, 0));
    check(() => assert.equal(networkCalls, 0));

    const withdrawnReceipt = receipt(first.bundle, {
      status: "withdrawn",
      revision: `rev_${"d".repeat(32)}`,
      updatedAt: "2026-07-13T00:01:00.000Z",
    });
    let deleteCalls = 0;
    output.length = 0;
    const unpublished = await exchange.cmdExperienceExchange({
      ...baseOptions,
      args: ["unpublish", first.bundle.pack.releaseId, "--json"],
      fetchHub: async (url, init) => {
        deleteCalls += 1;
        check(() => assert.match(url, new RegExp(`/uploads/${observedReceipt.uploadId}$`)));
        check(() => assert.equal(init.method, "DELETE"));
        check(() => assert.equal(init.headers["If-Match"], `"${observedReceipt.revision}"`));
        return response(200, { receipt: withdrawnReceipt }, withdrawnReceipt.revision);
      },
    });
    check(() => assert.equal(deleteCalls, 1));
    check(() => assert.equal(unpublished.receipt.status, "withdrawn"));
    check(() => assert.equal(exchange.inspectStoredExperienceBundle(userData, first.bundle.pack.releaseId, project).remote.revision, withdrawnReceipt.revision));
    check(() => assert.doesNotMatch(output[0], /ownerWorkspaceRef|workspace:server-authority/));

    await exchange.cmdExperienceExchange({ ...baseOptions, args: ["legacy-list"] });
    check(() => assert.equal(legacyCalls, 1, "legacy intent access must require an explicit legacy-* command"));

    console.log(JSON.stringify({ ok: true, checks, simulatedConditionalDeleteCalls: deleteCalls, liveNetworkCalls: 0, automaticPublishOrAttach: 0 }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
