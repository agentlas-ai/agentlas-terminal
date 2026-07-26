#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-cas-client-"));
process.env.AGENTLAS_USER_DATA_DIR = path.join(tempDir, "user-data");
process.env.AGENTLAS_SESSION = "cas-owner-session";

// v2: 모놀리스 대신 cloud-assets 모듈에서 같은 표면을 가져온다. 단언은 v1 그대로.
const { deleteCloudAgent: deleteCloudAgentCli } = require("../engine/cloud-assets/cas.cjs");
const { packageCloudAgent: packageCloudAgentCli } = require("../engine/cloud-assets/package.cjs");
const { readCloudAssetState: readCloudAssetStateCli } = require("../engine/cloud-assets/state.cjs");

function writePrivateAgent(root, title = "CAS Agent") {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), `# ${title}\n\nCAS_TEST_ENTRY\n`, "utf8");
}

function writePublicAgent(root, title = "CAS Public Agent") {
  writePrivateAgent(root, title);
  fs.mkdirSync(path.join(root, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentlas", "routing-card.json"), JSON.stringify({
    schemaVersion: "routing-card/2.0",
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    type: "agent",
    name: title,
    summary: "Exercises conditional multi-host Cloud writes.",
    capabilities: ["cloud_cas_testing"],
    routing_status: "routing_ready",
  }, null, 2) + "\n");
  // 공개 발행 이중 언어 메타데이터 게이트(데스크탑 package.ts:435-449 동형) 충족.
  fs.writeFileSync(path.join(root, ".agentlas", "agent-card.json"), JSON.stringify({
    name: title,
    localized: {
      titleEn: title,
      titleKo: "CAS 공개 에이전트",
      descriptionEn: "Exercises conditional multi-host Cloud writes.",
      descriptionKo: "조건부 멀티호스트 Cloud 쓰기를 검증합니다.",
    },
  }, null, 2) + "\n");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function descriptorFor(body, sequence, cloudId) {
  const scope = body.visibility === "marketplace" ? "hub-public" : "owner-private";
  const revision = `rev-${sequence}-${body.manifest.packageHash.slice(0, 16)}`;
  return {
    cloudId,
    slug: body.manifest.slug,
    scope,
    packageHash: body.manifest.packageHash,
    packageHashVersion: body.manifest.packageHashVersion,
    revision,
    etag: `"${revision}"`,
    updatedAt: new Date().toISOString(),
  };
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

(async () => {
  const assets = new Map();
  const requests = [];
  let sequence = 0;
  let cloudSequence = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      requests.push({ method: request.method, url, headers: { ...request.headers }, body });
      if (request.method === "POST") {
        const scope = body.visibility === "marketplace" ? "hub-public" : "owner-private";
        const key = `${scope}:${body.manifest.slug}`;
        const current = assets.get(key) || null;
        if (body.manifest.slug === "maintenance-agent") {
          sendJson(response, 503, {
            code: "cloud_mutations_maintenance",
            retryable: true,
            error: "Cloud mutations are temporarily disabled.",
          }, { "retry-after": "60" });
          return;
        }
        if (body.manifest.slug === "upgrade-required-agent") {
          sendJson(response, 428, {
            code: "client_upgrade_required",
            current: current || descriptorFor(body, ++sequence, `cloud-test-${++cloudSequence}`),
          });
          return;
        }
        const requested = { slug: body.manifest.slug, scope, cloudId: request.headers["x-agentlas-cloud-id"] };
        const conflict = (reason) => sendJson(response, 412, {
          code: "cloud_agent_revision_conflict",
          conflict: { reason, requested },
          current,
        }, current ? { etag: current.etag } : {});
        if (request.headers["if-none-match"] === "*") {
          if (current) return conflict("already_exists");
          const created = descriptorFor(body, ++sequence, `cloud-test-${++cloudSequence}`);
          assets.set(key, created);
          sendJson(response, 200, {
            schema: "agentlas.agent_cloud.registration.v1",
            operation: "created",
            source: scope === "hub-public" ? "hub" : "agent-cloud",
            visibility: scope === "hub-public" ? "marketplace" : "owner-private",
            scope,
            owner: true,
            publicHubPublished: scope === "hub-public",
            ...created,
            url: `http://agentlas.test/${created.slug}`,
            marketplaceUrl: scope === "hub-public" ? `http://agentlas.test/p/${created.slug}` : undefined,
            registeredAt: created.updatedAt,
            savedAt: created.updatedAt,
            dryRun: false,
            billing: { modelCallsPaidBy: "none", platformModelCalls: 0 },
          }, { etag: body.manifest.slug === "bad-etag-agent" ? '"wrong-revision"' : created.etag });
          return;
        }
        if (!current) return conflict("missing_target");
        if (
          request.headers["if-match"] !== current.etag ||
          request.headers["x-agentlas-cloud-id"] !== current.cloudId
        ) return conflict("revision_mismatch");
        const unchanged = current.packageHash === body.manifest.packageHash && current.packageHashVersion === body.manifest.packageHashVersion;
        const next = unchanged ? current : descriptorFor(body, ++sequence, current.cloudId);
        assets.set(key, next);
        sendJson(response, 200, {
          schema: "agentlas.agent_cloud.registration.v1",
          operation: unchanged ? "unchanged" : "updated",
          source: scope === "hub-public" ? "hub" : "agent-cloud",
          visibility: scope === "hub-public" ? "marketplace" : "owner-private",
          scope,
          owner: true,
          publicHubPublished: scope === "hub-public",
          ...next,
          url: `http://agentlas.test/${next.slug}`,
          marketplaceUrl: scope === "hub-public" ? `http://agentlas.test/p/${next.slug}` : undefined,
          registeredAt: next.updatedAt,
          savedAt: next.updatedAt,
          dryRun: false,
          billing: { modelCallsPaidBy: "none", platformModelCalls: 0 },
        }, { etag: next.etag });
        return;
      }

      if (request.method === "DELETE") {
        const slug = url.searchParams.get("slug");
        const scope = url.searchParams.get("scope");
        const cloudId = url.searchParams.get("cloudId");
        const key = `${scope}:${slug}`;
        const current = assets.get(key) || null;
        if (
          !current || current.cloudId !== cloudId ||
          request.headers["if-match"] !== current.etag ||
          request.headers["x-agentlas-cloud-id"] !== current.cloudId
        ) {
          sendJson(response, 412, {
            code: "cloud_agent_revision_conflict",
            conflict: { reason: "revision_mismatch", requested: { slug, scope, cloudId } },
            current,
          }, current ? { etag: current.etag } : {});
          return;
        }
        assets.delete(key);
        sendJson(response, 200, {
          schema: "agentlas.agent_cloud.delete.v1",
          ok: true,
          source: scope === "hub-public" ? "hub" : "agent-cloud",
          visibility: scope === "hub-public" ? "marketplace" : "owner-private",
          ...current,
          ...(scope === "hub-public"
            ? { operation: "unpublished", unpublishedAt: new Date().toISOString() }
            : { deletedAt: new Date().toISOString() }),
        }, { etag: current.etag });
        return;
      }
      sendJson(response, 405, { error: "method_not_allowed" });
    });
  });

  try {
    const address = await listen(server);
    process.env.AGENTLAS_WEB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const updateRoot = path.join(tempDir, "update-agent");
    writePrivateAgent(updateRoot, "Update Agent");
    const created = await packageCloudAgentCli(null, updateRoot, { slug: "update-agent", dryRun: false, llmReview: false });
    assert.equal(created.registration.operation, "created");
    const createRequest = requests.at(-1);
    assert.equal(createRequest.headers["if-none-match"], "*");
    assert.equal(createRequest.headers["if-match"], undefined);
    const createdMarker = JSON.parse(fs.readFileSync(path.join(updateRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(createdMarker.cloudAssets["owner-private"].revision, created.registration.revision);

    fs.appendFileSync(path.join(updateRoot, "AGENTS.md"), "UPDATED_LOCALLY\n");
    const updated = await packageCloudAgentCli(null, updateRoot, { slug: "update-agent", dryRun: false, llmReview: false });
    assert.equal(updated.registration.operation, "updated");
    const updateRequest = requests.at(-1);
    assert.equal(updateRequest.headers["if-match"], created.registration.etag);
    assert.equal(updateRequest.headers["x-agentlas-cloud-id"], created.registration.cloudId);
    assert.equal(updateRequest.headers["if-none-match"], undefined);

    const updateKey = "owner-private:update-agent";
    const remote = { ...assets.get(updateKey) };
    remote.revision = `rev-remote-${Date.now()}`;
    remote.etag = `"${remote.revision}"`;
    remote.packageHash = "f".repeat(64);
    remote.updatedAt = new Date(Date.now() + 1000).toISOString();
    assets.set(updateKey, remote);
    fs.appendFileSync(path.join(updateRoot, "AGENTS.md"), "STALE_LOCAL_CHANGE\n");
    await assert.rejects(
      packageCloudAgentCli(null, updateRoot, { slug: "update-agent", dryRun: false, llmReview: false }),
      (error) => error.code === "cloud_agent_revision_conflict" && /다른 PC/.test(error.message),
    );
    const staleMarker = JSON.parse(fs.readFileSync(path.join(updateRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(staleMarker.cloudAssets["owner-private"].revision, updated.registration.revision, "412 must never adopt the server revision automatically");
    assert.equal(readCloudAssetStateCli().assets[updateKey].descriptor.revision, updated.registration.revision);

    const foreignRoot = path.join(tempDir, "foreign-agent");
    writePrivateAgent(foreignRoot, "Foreign Agent");
    const foreignBody = {
      visibility: "private-link",
      manifest: {
        slug: "foreign-agent",
        packageHash: "e".repeat(64),
        packageHashVersion: "path-sha256-executable-v2",
      },
    };
    assets.set("owner-private:foreign-agent", descriptorFor(foreignBody, ++sequence, `cloud-test-${++cloudSequence}`));
    await assert.rejects(
      packageCloudAgentCli(null, foreignRoot, { slug: "foreign-agent", dryRun: false, llmReview: false }),
      (error) => error.code === "cloud_agent_revision_conflict",
    );
    assert.equal(fs.existsSync(path.join(foreignRoot, ".agentlas-cloud-package.json")), false);
    assert.equal(requests.at(-1).headers["if-none-match"], "*");

    const upgradeRoot = path.join(tempDir, "upgrade-required-agent");
    writePrivateAgent(upgradeRoot, "Upgrade Required Agent");
    await assert.rejects(
      packageCloudAgentCli(null, upgradeRoot, { slug: "upgrade-required-agent", dryRun: false, llmReview: false }),
      (error) => error.code === "client_upgrade_required" && /will not be copied automatically/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(upgradeRoot, ".agentlas-cloud-package.json")), false);

    const maintenanceRoot = path.join(tempDir, "maintenance-agent");
    writePrivateAgent(maintenanceRoot, "Maintenance Agent");
    await assert.rejects(
      packageCloudAgentCli(null, maintenanceRoot, { slug: "maintenance-agent", dryRun: false, llmReview: false }),
      (error) => error.code === "cloud_mutations_maintenance" && /60 seconds.*Read, list, and restore/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(maintenanceRoot, ".agentlas-cloud-package.json")), false);

    const badEtagRoot = path.join(tempDir, "bad-etag-agent");
    writePrivateAgent(badEtagRoot, "Bad ETag Agent");
    await assert.rejects(
      packageCloudAgentCli(null, badEtagRoot, { slug: "bad-etag-agent", dryRun: false, llmReview: false }),
      /invalid or mismatched registration receipt/,
    );
    assert.equal(fs.existsSync(path.join(badEtagRoot, ".agentlas-cloud-package.json")), false);

    const deleteRoot = path.join(tempDir, "delete-agent");
    writePrivateAgent(deleteRoot, "Delete Agent");
    const beforeDelete = await packageCloudAgentCli(null, deleteRoot, { slug: "delete-agent", dryRun: false, llmReview: false });
    const deleted = await deleteCloudAgentCli("delete-agent", { scope: "owner-private" });
    assert.equal(deleted.revision, beforeDelete.registration.revision);
    const deleteRequest = requests.at(-1);
    assert.equal(deleteRequest.method, "DELETE");
    assert.equal(deleteRequest.url.searchParams.get("scope"), "owner-private");
    assert.equal(deleteRequest.url.searchParams.get("cloudId"), beforeDelete.registration.cloudId);
    assert.equal(deleteRequest.headers["if-match"], beforeDelete.registration.etag);
    const markerAfterDelete = JSON.parse(fs.readFileSync(path.join(deleteRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(markerAfterDelete.cloudAssets["owner-private"], undefined);
    const recreated = await packageCloudAgentCli(null, deleteRoot, { slug: "delete-agent", dryRun: false, llmReview: false });
    assert.equal(recreated.registration.operation, "created");
    assert.notEqual(recreated.registration.cloudId, beforeDelete.registration.cloudId);
    assert.equal(requests.at(-1).headers["if-none-match"], "*", "delete→recreate must not reuse a deleted revision");

    const staleDeleteRoot = path.join(tempDir, "stale-delete-agent");
    writePrivateAgent(staleDeleteRoot, "Stale Delete Agent");
    const staleDeleteBase = await packageCloudAgentCli(null, staleDeleteRoot, { slug: "stale-delete-agent", dryRun: false, llmReview: false });
    const staleDeleteKey = "owner-private:stale-delete-agent";
    const remotelyUpdatedDelete = { ...assets.get(staleDeleteKey) };
    remotelyUpdatedDelete.revision = `rev-remote-delete-${Date.now()}`;
    remotelyUpdatedDelete.etag = `"${remotelyUpdatedDelete.revision}"`;
    remotelyUpdatedDelete.updatedAt = new Date(Date.now() + 1000).toISOString();
    assets.set(staleDeleteKey, remotelyUpdatedDelete);
    await assert.rejects(
      deleteCloudAgentCli("stale-delete-agent", { scope: "owner-private" }),
      (error) => error.code === "cloud_agent_revision_conflict" && /다른 PC/.test(error.message),
    );
    const staleDeleteMarker = JSON.parse(fs.readFileSync(path.join(staleDeleteRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(staleDeleteMarker.cloudAssets["owner-private"].revision, staleDeleteBase.registration.revision);
    assert.equal(readCloudAssetStateCli().assets[staleDeleteKey].descriptor.revision, staleDeleteBase.registration.revision);

    const dualRoot = path.join(tempDir, "dual-scope-agent");
    writePublicAgent(dualRoot, "Dual Scope Agent");
    const dualPrivate = await packageCloudAgentCli(null, dualRoot, { slug: "dual-scope-agent", dryRun: false, llmReview: false });
    const dualPublic = await packageCloudAgentCli(null, dualRoot, { slug: "dual-scope-agent", visibility: "marketplace", dryRun: false, llmReview: false });
    const dualMarker = JSON.parse(fs.readFileSync(path.join(dualRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(dualMarker.cloudAssets["owner-private"].revision, dualPrivate.registration.revision);
    assert.equal(dualMarker.cloudAssets["hub-public"].revision, dualPublic.registration.revision);
    await assert.rejects(
      deleteCloudAgentCli("dual-scope-agent"),
      /multiple scopes/,
      "same slug in private/public scopes must require an exact scope",
    );
    await deleteCloudAgentCli("dual-scope-agent", { scope: "owner-private" });
    const dualAfterDelete = JSON.parse(fs.readFileSync(path.join(dualRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(dualAfterDelete.cloudAssets["owner-private"], undefined);
    assert.equal(dualAfterDelete.cloudAssets["hub-public"].revision, dualPublic.registration.revision);
    const unpublished = await deleteCloudAgentCli("dual-scope-agent", { scope: "hub-public" });
    assert.equal(unpublished.operation, "unpublished");
    assert.ok(Number.isFinite(Date.parse(unpublished.unpublishedAt)));

    console.log("cloud multi-host CAS client: PASS");
  } finally {
    await close(server).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
