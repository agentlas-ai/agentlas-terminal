"use strict";
/*
 * cloud-assets/state — Agent Cloud 자산 리비전의 로컬 관측 상태.
 *
 * 두 저장소를 관리한다 (v1 monolith의 asset-state 계열 충실 이식):
 *  1. <userData>/cloud-asset-state.v1.json — 이 머신이 "관측한" 각 자산의
 *     마지막 리비전 디스크립터 + 소스 루트 목록 + 삭제 톰스톤(deletedBases).
 *  2. <sourceRoot>/.agentlas-cloud-package.json — 소스 폴더 마커. scope별
 *     디스크립터(cloudAssets)를 담아 다음 save의 CAS 베이스가 된다.
 *
 * 계약(약화 금지):
 *  - 관측한 베이스 리비전 없이는 어떤 덮어쓰기도 시도하지 않는다. 이 파일이
 *    깨졌으면 조용히 새로 만들지 않고 정직하게 실패한다 (조용한 기본값 금지).
 *  - 삭제 톰스톤: delete가 커밋된 (rootPath, slug, scope, cloudId, revision)은
 *    다시 베이스로 채택되지 않는다 — delete→재저장은 반드시 새 생성(If-None-Match)이다.
 *  - 상태 파일 쓰기는 O_EXCL temp → fsync → rename → dir fsync (크래시 원자성).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataDir } = require("../core/paths.cjs");
const {
  CLOUD_ASSET_SCOPES,
  CLOUD_PACKAGE_HASH_V1,
  CLOUD_RESTORE_MARKER_PATH,
  cloudSlug,
  cloudApplyPortableFileMode,
  cloudFsyncDirectory,
  normalizeCloudAssetDescriptor,
} = require("../hub/install.cjs");

const CLOUD_ASSET_STATE_FILE = "cloud-asset-state.v1.json";

function normalizeCloudScopeFlag(value) {
  if (value === "owner-private" || value === "private" || value === "private-link") return "owner-private";
  if (value === "hub-public" || value === "marketplace" || value === "public") return "hub-public";
  return null;
}

function cloudDescriptorKey(descriptor) {
  return `${descriptor.scope}:${descriptor.slug}`;
}

function cloudAssetStatePath() {
  return path.join(userDataDir(), CLOUD_ASSET_STATE_FILE);
}

function readCloudAssetState() {
  const statePath = cloudAssetStatePath();
  if (!fs.existsSync(statePath)) return { schemaVersion: 1, assets: {}, deletedBases: [] };
  let fd;
  try {
    // O_NOFOLLOW: 상태 파일이 심링크로 바꿔치기되면 읽지 않는다 (로컬 상태 위조 방어).
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("state file is not a bounded regular file");
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets)) {
      throw new Error("state schema is invalid");
    }
    const assets = {};
    for (const [key, raw] of Object.entries(parsed.assets)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`state entry ${key} is invalid`);
      const descriptor = normalizeCloudAssetDescriptor(raw.descriptor, `state entry ${key}`);
      if (key !== cloudDescriptorKey(descriptor)) throw new Error(`state entry ${key} key is invalid`);
      const sourceRoots = Array.isArray(raw.sourceRoots)
        ? [...new Set(raw.sourceRoots.filter((item) => typeof item === "string" && path.isAbsolute(item)).map((item) => path.resolve(item)))].slice(0, 32)
        : [];
      assets[key] = { descriptor, sourceRoots };
    }
    const deletedBases = Array.isArray(parsed.deletedBases)
      ? parsed.deletedBases.filter((item) =>
          item && typeof item === "object" && !Array.isArray(item) &&
          typeof item.rootPath === "string" && path.isAbsolute(item.rootPath) &&
          typeof item.slug === "string" && cloudSlug(item.slug) === item.slug &&
          CLOUD_ASSET_SCOPES.has(item.scope) && typeof item.cloudId === "string" &&
          typeof item.revision === "string"
        ).map((item) => ({
          rootPath: path.resolve(item.rootPath),
          slug: item.slug,
          scope: item.scope,
          cloudId: item.cloudId,
          revision: item.revision,
        })).slice(-256)
      : [];
    return { schemaVersion: 1, assets, deletedBases };
  } catch (error) {
    // 깨진 상태 파일을 빈 상태로 위장하면 stale 베이스로 원격 리비전을 덮어쓸 수 있다.
    throw new Error(`Agent Cloud local revision state is unreadable: ${error.message || error}`);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

function writeCloudAssetState(state) {
  const statePath = cloudAssetStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, statePath);
  cloudApplyPortableFileMode(statePath, 0o600);
  cloudFsyncDirectory(path.dirname(statePath));
}

/** 서버가 준 리비전 영수증을 관측 상태로 승격. sourceRoot가 있으면 톰스톤도 해제한다. */
function rememberCloudAssetDescriptor(value, options = {}) {
  const descriptor = normalizeCloudAssetDescriptor(value);
  const state = readCloudAssetState();
  const key = cloudDescriptorKey(descriptor);
  const previous = state.assets[key];
  const sameRevision = previous && previous.descriptor.cloudId === descriptor.cloudId && previous.descriptor.revision === descriptor.revision;
  const roots = sameRevision ? [...previous.sourceRoots] : [];
  if (options.sourceRoot) {
    const sourceRoot = path.resolve(options.sourceRoot);
    roots.push(sourceRoot);
    state.deletedBases = state.deletedBases.filter(
      (item) => !(item.rootPath === sourceRoot && item.slug === descriptor.slug && item.scope === descriptor.scope),
    );
  }
  state.assets[key] = { descriptor, sourceRoots: [...new Set(roots)].slice(0, 32) };
  writeCloudAssetState(state);
  return descriptor;
}

function findCloudAssetDescriptor(slug, scope) {
  const safeSlug = cloudSlug(slug);
  const state = readCloudAssetState();
  const matches = Object.values(state.assets).filter(
    (entry) => entry.descriptor.slug === safeSlug && (!scope || entry.descriptor.scope === scope),
  );
  if (!scope && matches.length > 1) {
    // 같은 슬러그가 두 scope에 있으면 "아무거나" 지우지 않는다 — 정확한 지정 강제.
    throw new Error(`Cloud asset ${safeSlug} exists in multiple scopes. Retry with --scope owner-private or --scope hub-public.`);
  }
  return matches.length === 1 ? matches[0] : null;
}

// ── 소스 폴더 마커 (.agentlas-cloud-package.json) ──

function cloudMarkerDescriptors(marker) {
  const descriptors = {};
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return descriptors;
  if (marker.cloudAssets && typeof marker.cloudAssets === "object" && !Array.isArray(marker.cloudAssets)) {
    for (const scope of CLOUD_ASSET_SCOPES) {
      if (!marker.cloudAssets[scope]) continue;
      try {
        const descriptor = normalizeCloudAssetDescriptor(marker.cloudAssets[scope], `local marker ${scope}`);
        if (descriptor.scope === scope) descriptors[scope] = descriptor;
      } catch { /* 레거시/손상 CAS 항목은 베이스 리비전으로 채택하지 않는다 */ }
    }
  }
  if (marker.revision && marker.cloudId && marker.scope) {
    try {
      const descriptor = normalizeCloudAssetDescriptor(marker, "local marker");
      if (!descriptors[descriptor.scope]) descriptors[descriptor.scope] = descriptor;
    } catch { /* legacy marker */ }
  }
  return descriptors;
}

function cloudBaseDescriptorFromMarker(marker, slug, scope) {
  const descriptor = cloudMarkerDescriptors(marker)[scope];
  return descriptor && descriptor.slug === slug ? descriptor : null;
}

/**
 * 다음 save의 CAS 베이스 결정: 마커 vs 상태 저널.
 * 톰스톤에 걸린 마커 디스크립터는 무시(삭제 후 재저장은 새 생성이어야 한다).
 * 둘 다 있으면 같은 cloudId에서 더 최신 관측을 채택한다.
 */
/**
 * 이 slug/scope의 관측된 리비전은 있는데, 이 소스 루트에는 아직 연결되지 않은
 * 경우를 돌려준다.
 *
 * 이 구분이 없으면 base 조회가 null을 돌려주고, 호출부는 그것을 "새 자산"으로
 * 읽어 create precondition을 보낸다. 서버에는 자산이 멀쩡히 존재하므로 412로
 * 거절되고, 사용자는 "다른 PC에서 변경됨 / restore 하세요"라는 엉뚱한 안내를
 * 받는다. restore는 디스크립터를 설치 경로에 묶으므로 소스 루트에서 발행하는
 * 한 영원히 해소되지 않는다. 모름을 그럴듯한 값으로 메꾸지 않기 위한 분기다.
 */
function cloudUnboundDescriptorForSource(rootPath, slug, scope) {
  const state = readCloudAssetState();
  const entry = state.assets[`${scope}:${slug}`];
  if (!entry) return null;
  return entry.sourceRoots.includes(path.resolve(rootPath)) ? null : entry.descriptor;
}

/** 이 소스 루트를 이미 관측된 클라우드 자산에 명시적으로 연결한다. */
function bindCloudAssetSourceRoot(rootPath, slug, scope) {
  const state = readCloudAssetState();
  const key = `${scope}:${slug}`;
  const entry = state.assets[key];
  if (!entry) throw new Error(`No observed Cloud revision for ${key} to bind.`);
  const normalizedRoot = path.resolve(rootPath);
  const roots = [...new Set([...entry.sourceRoots, normalizedRoot])].slice(0, 32);
  state.assets[key] = { descriptor: entry.descriptor, sourceRoots: roots };
  state.deletedBases = state.deletedBases.filter(
    (item) => !(item.rootPath === normalizedRoot && item.slug === slug && item.scope === scope),
  );
  writeCloudAssetState(state);
  return entry.descriptor;
}

function cloudBaseDescriptorForSource(marker, rootPath, slug, scope) {
  const state = readCloudAssetState();
  const normalizedRoot = path.resolve(rootPath);
  let markerDescriptor = cloudBaseDescriptorFromMarker(marker, slug, scope);
  if (markerDescriptor && state.deletedBases.some((item) =>
    item.rootPath === normalizedRoot && item.slug === slug && item.scope === scope &&
    item.cloudId === markerDescriptor.cloudId && item.revision === markerDescriptor.revision
  )) {
    markerDescriptor = null;
  }
  const entry = state.assets[`${scope}:${slug}`];
  const stateDescriptor = entry && entry.sourceRoots.includes(normalizedRoot) ? entry.descriptor : null;
  if (!markerDescriptor) return stateDescriptor;
  if (!stateDescriptor) return markerDescriptor;
  return stateDescriptor.cloudId === markerDescriptor.cloudId && stateDescriptor.updatedAt >= markerDescriptor.updatedAt
    ? stateDescriptor
    : markerDescriptor;
}

function writeCloudSourceMarker(rootPath, scan, descriptor, options = {}) {
  const markerPath = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  if (fs.existsSync(markerPath)) {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent Cloud revision marker is not a regular file");
  }
  const descriptors = cloudMarkerDescriptors(options.previousMarker);
  if (descriptor) descriptors[descriptor.scope] = descriptor;
  if (options.removeDescriptor) {
    const current = descriptors[options.removeDescriptor.scope];
    if (current && current.cloudId === options.removeDescriptor.cloudId && current.revision === options.removeDescriptor.revision) {
      delete descriptors[options.removeDescriptor.scope];
    }
  }
  const latest = descriptor || Object.values(descriptors)[0] || null;
  const marker = {
    schemaVersion: 1,
    source: "agentlas-cloud",
    slug: latest?.slug || options.removeDescriptor?.slug || cloudSlug(path.basename(rootPath)),
    packageHash: descriptor?.packageHash || options.packageHash || options.previousMarker?.packageHash || "",
    packageHashVersion: descriptor?.packageHashVersion || options.packageHashVersion || options.previousMarker?.packageHashVersion || CLOUD_PACKAGE_HASH_V1,
    fileCount: Number.isSafeInteger(options.fileCount) ? options.fileCount : (options.previousMarker?.fileCount || 0),
    totalBytes: Number.isSafeInteger(options.totalBytes) ? options.totalBytes : (options.previousMarker?.totalBytes || 0),
    executablePaths: Array.isArray(options.executablePaths) ? options.executablePaths : options.previousMarker?.executablePaths,
    cloudAssets: descriptors,
    ...(latest ? latest : {}),
    restoredAt: options.previousMarker?.restoredAt,
    savedAt: new Date().toISOString(),
  };
  for (const key of Object.keys(marker)) if (marker[key] === undefined) delete marker[key];
  const temp = path.join(rootPath, `.${CLOUD_RESTORE_MARKER_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, markerPath);
  cloudApplyPortableFileMode(markerPath, 0o600);
  cloudFsyncDirectory(rootPath);
  return marker;
}

function readCloudSourceMarker(rootPath) {
  const markerPath = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  if (!fs.existsSync(markerPath)) return null;
  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("marker is not a bounded regular file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = {
  CLOUD_ASSET_STATE_FILE,
  normalizeCloudScopeFlag,
  cloudDescriptorKey,
  cloudAssetStatePath,
  readCloudAssetState,
  writeCloudAssetState,
  rememberCloudAssetDescriptor,
  findCloudAssetDescriptor,
  cloudMarkerDescriptors,
  cloudBaseDescriptorFromMarker,
  cloudBaseDescriptorForSource,
  cloudUnboundDescriptorForSource,
  bindCloudAssetSourceRoot,
  writeCloudSourceMarker,
  readCloudSourceMarker,
};
