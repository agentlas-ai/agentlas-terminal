"use strict";
/*
 * cloud-assets/restore — 소유자 Agent Cloud 자산의 나열/복원.
 *
 * 계약(약화 금지):
 *  - list는 서버 검색 결과의 리비전 디스크립터를 로컬 관측 상태로 승격한다.
 *    (다음 save/delete의 CAS 베이스는 반드시 "관측한" 리비전이어야 한다.)
 *  - restore 영수증(schema/source/owner/slug/해시/리비전)이 완전히 맞아야만
 *    로컬 설치를 진행한다. 봉투와 cloudPackage가 어긋나면 invalid_restore_contract.
 *  - 실제 파일 물질화/DB 반영은 hub/install.cjs persistCloudListing을 재사용한다
 *    (동일 무결성·crash-recovery 계약, 복제 금지).
 */
const {
  CLOUD_PACKAGE_HASH_V1,
  cloudPackageHashVersion,
  normalizeCloudAssetDescriptor,
  persistCloudListing,
} = require("../hub/install.cjs");
const { cargoListAgents, cargoRestorePackage } = require("./cargo.cjs");
const state = require("./state.cjs");

async function listOwnedCloudAgents(limit = 100) {
  const result = (await cargoListAgents(limit)) || {
    schema: "agentlas.agent_cloud.search.v1",
    source: "cloud",
    status: "ok",
    count: 0,
    total: 0,
    results: [],
  };
  if (!Array.isArray(result.results)) throw new Error("Agent Cloud list returned an invalid results contract.");
  if (result.results.length) {
    const stateValue = state.readCloudAssetState();
    for (const raw of result.results) {
      const descriptor = normalizeCloudAssetDescriptor(raw, "Agent Cloud list result");
      const key = state.cloudDescriptorKey(descriptor);
      const previous = stateValue.assets[key];
      const preserveRoots = previous && previous.descriptor.cloudId === descriptor.cloudId && previous.descriptor.revision === descriptor.revision;
      stateValue.assets[key] = { descriptor, sourceRoots: preserveRoots ? previous.sourceRoots : [] };
    }
    state.writeCloudAssetState(stateValue);
  }
  return result;
}

function normalizeOwnerRestorePayload(raw, expectedSlug) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_restore_contract");
  if (raw.schema !== "agentlas.agent_cloud.restore.v1" || raw.source !== "cloud" || raw.owner !== true) {
    throw new Error("invalid_restore_contract");
  }
  if (typeof raw.slug !== "string" || !raw.slug || raw.slug !== expectedSlug) {
    // cross-slug 응답을 그대로 설치하면 다른 자산이 요청 슬러그로 위장 설치된다.
    throw new Error(`restore_slug_mismatch: requested ${expectedSlug}; received ${String(raw.slug || "")}`);
  }
  const pkg = raw.cloudPackage;
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || !Array.isArray(pkg.files)) {
    throw new Error("invalid_restore_contract");
  }
  const version = cloudPackageHashVersion(pkg.packageHashVersion);
  if (!version || !/^[a-f0-9]{64}$/i.test(String(pkg.packageHash || "").replace(/^sha256:/i, ""))) {
    throw new Error("invalid_restore_contract");
  }
  let descriptor;
  let nestedDescriptor;
  try {
    descriptor = normalizeCloudAssetDescriptor(raw, "owner restore receipt");
    nestedDescriptor = normalizeCloudAssetDescriptor({
      ...pkg,
      slug: raw.slug,
      etag: raw.etag,
    }, "owner restore package receipt");
  } catch (error) {
    throw new Error(`invalid_restore_contract: ${error.message || error}`);
  }
  if (JSON.stringify(descriptor) !== JSON.stringify(nestedDescriptor)) {
    throw new Error("invalid_restore_contract: restore revision envelope and cloudPackage disagree");
  }
  if (!["agent", "team", "repo"].includes(pkg.agentKind) || !Number.isSafeInteger(pkg.fileCount) || !Number.isSafeInteger(pkg.totalBytes)) {
    throw new Error("invalid_restore_contract");
  }
  for (const file of pkg.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || typeof file.sha256 !== "string" || typeof file.contentBase64 !== "string") {
      throw new Error("invalid_restore_contract");
    }
  }
  const outerVersion = raw.packageHashVersion == null ? version : cloudPackageHashVersion(raw.packageHashVersion);
  if (
    (raw.packageHash != null && String(raw.packageHash) !== String(pkg.packageHash)) ||
    !outerVersion || outerVersion !== version ||
    (raw.fileCount != null && raw.fileCount !== pkg.fileCount) ||
    (raw.totalBytes != null && raw.totalBytes !== pkg.totalBytes) ||
    (raw.agentKind != null && raw.agentKind !== pkg.agentKind)
  ) {
    throw new Error("invalid_restore_contract: restore envelope and cloudPackage disagree");
  }
  return {
    schema: raw.schema,
    source: raw.source,
    owner: true,
    slug: raw.slug,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.slug,
    nameEn: typeof raw.nameEn === "string" && raw.nameEn ? raw.nameEn : (raw.name || raw.slug),
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    taglineEn: typeof raw.taglineEn === "string" ? raw.taglineEn : (raw.tagline || ""),
    descriptor,
    cloudPackage: {
      cloudId: descriptor.cloudId,
      scope: descriptor.scope,
      revision: descriptor.revision,
      updatedAt: descriptor.updatedAt,
      packageHash: String(pkg.packageHash).replace(/^sha256:/i, "").toLowerCase(),
      packageHashVersion: version,
      fileCount: pkg.fileCount,
      totalBytes: pkg.totalBytes,
      agentKind: pkg.agentKind,
      runtimeLabels: Array.isArray(pkg.runtimeLabels) ? pkg.runtimeLabels.filter((item) => typeof item === "string" && item.trim()) : [],
      files: pkg.files,
    },
  };
}

async function restoreOwnedCloudAgent(db, slug) {
  const raw = await cargoRestorePackage(slug);
  if (!raw || raw.error) {
    const code = raw && raw.error ? raw.error : "agent_not_found";
    const message = raw && raw.message ? raw.message : `Agent Cloud package not found: ${slug}`;
    throw new Error(`${code}: ${message}`);
  }
  const restored = normalizeOwnerRestorePayload(raw, slug);
  const cloudPackage = restored.cloudPackage;
  const listing = {
    slug: restored.slug || slug,
    name: restored.name || restored.nameEn || restored.slug || slug,
    nameEn: restored.nameEn || restored.name || restored.slug || slug,
    tagline: restored.tagline || restored.taglineEn || "",
    taglineEn: restored.taglineEn || restored.tagline || "",
    trustGrade: "A",
    visibility: "visible",
    source: "cloud",
    assetDescriptor: restored.descriptor,
    cloudPackage,
  };
  const agent = persistCloudListing(db, listing);
  let descriptor = restored.descriptor;
  let localStateWarning;
  try {
    descriptor = state.rememberCloudAssetDescriptor(restored.descriptor, { sourceRoot: agent.localPath || undefined });
  } catch (error) {
    localStateWarning = `Restore completed, but observed revision state could not be indexed: ${error.message || error}`;
  }
  return {
    schema: restored.schema || "agentlas.agent_cloud.restore.v1",
    source: "cloud",
    slug: agent.slug,
    name: agent.name,
    packageHash: cloudPackage.packageHash,
    packageHashVersion: cloudPackage.packageHashVersion || CLOUD_PACKAGE_HASH_V1,
    cloudId: descriptor.cloudId,
    scope: descriptor.scope,
    revision: descriptor.revision,
    etag: descriptor.etag,
    updatedAt: descriptor.updatedAt,
    localPath: agent.localPath || null,
    ...(localStateWarning ? { localStateWarning } : {}),
  };
}

module.exports = {
  listOwnedCloudAgents,
  normalizeOwnerRestorePayload,
  restoreOwnedCloudAgent,
};
