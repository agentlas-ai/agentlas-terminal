"use strict";
/*
 * hub/install — Hub 에이전트 소스 설치 (persist + materialize + crash-recovery journal).
 *
 * v1 monolith(cmdCloudInstall/persistCloudListingCli 계열)의 충실한 이식.
 * 핵심 계약(약화 금지):
 *  - DB 행과 materialize된 파일은 함께 커밋/롤백된다. materialize는 deferCommit
 *    모드로 스테이징→스왑까지만 하고 저널을 남긴 뒤, DB 트랜잭션이 커밋되면
 *    restore.commit(), 실패하면 restore.rollback()으로 디스크를 원상복구한다.
 *  - 크래시 창은 저널(phase: prepared / disk-swapped-db-pending / db-committed)로
 *    복구한다. DB 기대값(dbExpected)과 실제 행을 대조해 커밋 여부를 판정한다.
 *  - 패키지 무결성: 파일별 sha256 + 집계 해시(정렬 순서 계약) + 바이트 수 3중 검증.
 *    레거시 v1 해시(저장순)와 v2(executable 플래그 포함)를 구분한다.
 *  - call_only Hub 자산은 소스 설치 불가 — 정직 거절(로컬 위장 설치 금지).
 *
 * 테스트 주입: installHubAgent(db, slug, { callTool })의 callTool로 네트워크 없이
 * 매니페스트를 공급할 수 있다(hub-client options.fetch와 같은 설계).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataDir } = require("../core/paths.cjs");
const { columnExists } = require("../core/db.cjs");
// v1 계약: persist의 트랜잭션은 sqlite-policy의 관용형(runWriteTransaction)이다 —
// .transaction이 없는 드라이버/주입 DB에서는 트랜잭션 없이 fn을 실행한다(v1 테스트 계약).
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");
const { callHubTool } = require("../cloud/hub-client.cjs");

// ── 패키지 상한/식별 상수 (서버 package-contract와 동일) ──
// 상한은 정본 하나(upload-scan-catalog.json)에서 생성돼 내려온다. 여기서 다시
// 적으면 서버·엔진·데스크탑과 어긋나고, 어긋난 쪽은 파일 이름도 없는 코드로 거절한다.
const {
  PACKAGE_MAX_TOTAL_BYTES: CLOUD_MAX_TOTAL_BYTES,
  PACKAGE_MAX_FILE_BYTES: CLOUD_MAX_FILE_BYTES,
  PACKAGE_MAX_FILES: CLOUD_MAX_FILES,
} = require("../cloud-assets/upload-scan-catalog.generated.cjs");
const CLOUD_PACKAGE_HASH_V1 = "path-sha256-v1";
const CLOUD_PACKAGE_HASH_V2 = "path-sha256-executable-v2";
const CLOUD_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";
const CLOUD_ASSET_SCOPES = new Set(["owner-private", "hub-public"]);
const CLOUD_LOCAL_EXPERIENCE_LINEAGE_PATH = ".agentlas/experience-relations.jsonl";
const CLOUD_INSTALL_JOURNAL_MAX_BYTES = 128 * 1024;
const CLOUD_INSTALL_DB_EXPECTED_KEYS = new Set([
  "id", "slug", "name", "name_en", "tagline", "tagline_en", "system_prompt",
  "mcp_servers_json", "env_requirements_json", "preferred_backend", "trust_grade",
  "installed_at", "tone", "visibility",
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cloudSlug(value) {
  return (String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agentlas-cloud-agent");
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

// 팀 감지 — 루트뿐 아니라 .claude/ 중첩 구조도 인식한다 (appbridge 처럼).
function detectKind(dir) {
  const rootMarkers = ["TEAM.md", "ceo", "hr-departments", "projects"];
  for (const m of rootMarkers) if (exists(path.join(dir, m))) return "team";
  const nestedMarkers = [".claude/ceo", ".claude/hr-departments", ".claude/agents", ".claude/orgspec.yaml"];
  for (const m of nestedMarkers) if (exists(path.join(dir, m))) return "team";
  return "agent";
}

// ── 포터블 경로 규칙 ──
function cloudPortablePathKey(value) {
  return String(value).normalize("NFC").toLowerCase();
}

function cloudHasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function cloudPortableRelativePath(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")) return null;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.endsWith("/")) return null;
  if (value.includes("//") || value.length > 260) return null;
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.length > 255 || Buffer.byteLength(part, "utf8") > 255 || cloudHasUnpairedSurrogate(part)) return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)) return null;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
  }
  return value;
}

function cloudPortablePathConflict(paths) {
  const files = new Map();
  const directories = new Map();
  for (const value of paths) {
    if (typeof value !== "string" || !value) continue;
    const fileKey = cloudPortablePathKey(value);
    const existingFile = files.get(fileKey);
    if (existingFile) {
      if (existingFile.path === value) {
        return { code: "duplicate-path", message: `Cloud package repeats file path ${JSON.stringify(value)}.` };
      }
      return { code: "path-alias-collision", message: `Cloud package paths ${JSON.stringify(existingFile.path)} and ${JSON.stringify(value)} alias after Unicode NFC normalization and case-folding.` };
    }
    files.set(fileKey, { path: value });
    const parts = value.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      const directoryKey = cloudPortablePathKey(directory);
      const existingDirectory = directories.get(directoryKey);
      if (existingDirectory && existingDirectory.directory !== directory) {
        return {
          code: "path-alias-collision",
          message: `Ancestor directories ${JSON.stringify(existingDirectory.directory)} (from ${JSON.stringify(existingDirectory.sourcePath)}) and ${JSON.stringify(directory)} (from ${JSON.stringify(value)}) alias after Unicode NFC normalization and case-folding.`,
        };
      }
      if (!existingDirectory) directories.set(directoryKey, { directory, sourcePath: value });
    }
  }
  for (const [key, file] of files) {
    const directory = directories.get(key);
    if (!directory) continue;
    if (file.path === directory.directory) {
      return { code: "path-type-collision", message: `Cloud package path ${JSON.stringify(file.path)} is both a file and an ancestor directory.` };
    }
    return {
      code: "path-alias-collision",
      message: `File path ${JSON.stringify(file.path)} aliases ancestor directory ${JSON.stringify(directory.directory)} from ${JSON.stringify(directory.sourcePath)} after Unicode NFC normalization and case-folding.`,
    };
  }
  return null;
}

function cloudIsLocalExperienceLineagePath(value) {
  const normalized = cloudPortablePathKey(String(value || "").replace(/\\/g, "/"));
  const canonical = cloudPortablePathKey(CLOUD_LOCAL_EXPERIENCE_LINEAGE_PATH);
  return normalized === canonical
    || normalized.startsWith(`${canonical}.`)
    || normalized.startsWith(cloudPortablePathKey(".agentlas/.experience-relations.jsonl."));
}

// ── 패키지 해시 ──
function cloudPackageHashVersion(value) {
  if (value === undefined || value === null || value === "") return CLOUD_PACKAGE_HASH_V1;
  if (value === CLOUD_PACKAGE_HASH_V1 || value === CLOUD_PACKAGE_HASH_V2) return value;
  return null;
}

function cloudCodePointPathOrder(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function cloudHashPackage(files, version = CLOUD_PACKAGE_HASH_V1) {
  const hashVersion = cloudPackageHashVersion(version);
  if (!hashVersion) throw new Error(`unsupported cloud package hash version: ${version}`);
  const h = crypto.createHash("sha256");
  // 서버 package-contract.ts와 바이트 동일해야 한다: 경로 코드포인트 순 정렬.
  // 정렬 없이 스캔 순서로 해시하면 대소문자 혼합 경로 패키지(AGENTS.md + agents/…)가
  // 전부 package_hash_mismatch로 거절된다(2026-07-02 근본 수정).
  for (const file of [...files].filter((file) => !cloudIsLocalExperienceLineagePath(file.path)).sort(cloudCodePointPathOrder)) {
    h.update(file.path);
    h.update("\0");
    h.update(file.sha256);
    h.update("\0");
    if (hashVersion === CLOUD_PACKAGE_HASH_V2) {
      h.update(file.executable ? "x" : "-");
      h.update("\0");
    }
  }
  return h.digest("hex");
}

function cloudCanonicalBase64(value) {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

// ── 자산 리비전 디스크립터 ──
function cloudRevisionEtag(revision) {
  return `"${revision}"`;
}

function normalizeCloudAssetDescriptor(value, label = "cloud asset descriptor") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  const cloudId = typeof value.cloudId === "string" ? value.cloudId.trim() : "";
  const slug = typeof value.slug === "string" ? value.slug.trim() : "";
  const scope = value.scope;
  const packageHash = String(value.packageHash || "").replace(/^sha256:/i, "").toLowerCase();
  const packageHashVersion = cloudPackageHashVersion(value.packageHashVersion);
  const revision = typeof value.revision === "string" ? value.revision : "";
  const etag = typeof value.etag === "string" ? value.etag : cloudRevisionEtag(revision);
  const updatedAt = typeof value.updatedAt === "string"
    ? value.updatedAt
    : typeof value.savedAt === "string"
      ? value.savedAt
      : typeof value.registeredAt === "string"
        ? value.registeredAt
        : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(cloudId)) {
    throw new Error(`${label} cloudId is invalid`);
  }
  if (!slug || cloudSlug(slug) !== slug) throw new Error(`${label} slug is invalid`);
  if (!CLOUD_ASSET_SCOPES.has(scope)) throw new Error(`${label} scope is invalid`);
  if (!/^[a-f0-9]{64}$/.test(packageHash) || !packageHashVersion) {
    throw new Error(`${label} package identity is invalid`);
  }
  if (!revision || revision.length > 512 || /["\\\u0000-\u001f\u007f]/.test(revision)) {
    throw new Error(`${label} revision is invalid`);
  }
  if (etag !== cloudRevisionEtag(revision)) throw new Error(`${label} ETag does not authenticate revision`);
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error(`${label} updatedAt is invalid`);
  return { cloudId, slug, scope, packageHash, packageHashVersion, revision, etag, updatedAt };
}

// ── 파일 모드 강제 (restore 스냅샷은 소유자 전용) ──
function cloudApplyPrivateDirectoryMode(directoryPath, platform = process.platform) {
  if (platform === "win32") return;
  const before = fs.lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`cloud restore directory is unsafe: ${directoryPath}`);
  }
  fs.chmodSync(directoryPath, 0o700);
  const after = fs.lstatSync(directoryPath);
  if (
    !after.isDirectory() || after.isSymbolicLink() ||
    after.dev !== before.dev || after.ino !== before.ino ||
    (after.mode & 0o777) !== 0o700
  ) throw new Error(`cloud restore directory mode verification failed: ${directoryPath}`);
}

function cloudApplyPortableFileMode(filePath, mode, platform = process.platform) {
  if (platform === "win32") return;
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`cloud restore file is unsafe: ${filePath}`);
  }
  fs.chmodSync(filePath, mode);
  const after = fs.lstatSync(filePath);
  if (
    !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
    after.dev !== before.dev || after.ino !== before.ino ||
    (after.mode & 0o777) !== mode
  ) throw new Error(`cloud restore file mode verification failed: ${filePath}`);
}

function cloudDirectoryAnchor(target, label, { allowMissing = true, containedBy = null } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a safe managed directory`);
  }
  let realpath;
  try { realpath = fs.realpathSync.native(target); }
  catch (error) { throw new Error(`${label} could not be canonicalized: ${error.message}`); }
  if (containedBy && !(
    realpath === containedBy.realpath || realpath.startsWith(`${containedBy.realpath}${path.sep}`)
  )) {
    throw new Error(`${label} escapes its managed root`);
  }
  return { path: target, realpath, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, stat };
}

function cloudAssertDirectoryAnchor(anchor, label, containedBy = null) {
  const current = cloudDirectoryAnchor(anchor.path, label, { allowMissing: false, containedBy });
  if (
    current.realpath !== anchor.realpath || current.dev !== anchor.dev ||
    current.ino !== anchor.ino || current.nlink !== anchor.nlink
  ) {
    throw new Error(`${label} changed while it was being used`);
  }
  return current;
}

function cloudRefreshDirectoryAnchor(anchor, label, containedBy = null) {
  const current = cloudDirectoryAnchor(anchor.path, label, { allowMissing: false, containedBy });
  if (
    current.realpath !== anchor.realpath || current.dev !== anchor.dev ||
    current.ino !== anchor.ino
  ) {
    throw new Error(`${label} changed while it was being used`);
  }
  return current;
}

function cloudSameRegularFile(left, right) {
  return Boolean(
    left && right && left.isFile() && right.isFile() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink,
  );
}

function cloudEnsurePrivateSubdirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cloud restore subdirectory escapes staging");
  }
  let current = root;
  const rootAnchor = cloudDirectoryAnchor(root, "cloud restore staging", { allowMissing: false });
  const managedPaths = [root];
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { recursive: false, mode: 0o700 }); }
    catch (error) { if (!error || error.code !== "EEXIST") throw error; }
    cloudApplyPrivateDirectoryMode(current);
    managedPaths.push(current);
  }
  // Directory nlink changes when a child directory is added, so take every
  // anchor after the complete path is present rather than before a descendant
  // mkdir can legitimately change an ancestor's nlink.
  return managedPaths.map((managedPath, index) => cloudDirectoryAnchor(
    managedPath,
    index === 0 ? "cloud restore staging" : "cloud restore package directory",
    { allowMissing: false, ...(index === 0 ? {} : { containedBy: rootAnchor }) },
  ));
}

// ── 스테이징 스냅샷 전수 검증 (심링크/특수 엔트리/모드/무결성) ──
function cloudVerifyRestoredSnapshot(root, files, expected) {
  const expectedByPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set();
  function walk(dir) {
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("cloud restore staging contains an unsafe directory");
    if (process.platform !== "win32" && (dirStat.mode & 0o777) !== 0o700) throw new Error("cloud restore staging directory mode mismatch");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === CLOUD_RESTORE_MARKER_PATH) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("cloud restore staging contains a symbolic link");
      if (stat.isDirectory()) { walk(absolute); continue; }
      if (!stat.isFile()) throw new Error("cloud restore staging contains a special filesystem entry");
      const expectedFile = expectedByPath.get(relative);
      if (!expectedFile || seen.has(relative)) throw new Error(`cloud restore staging has an unexpected file: ${relative}`);
      const bytes = fs.readFileSync(absolute);
      if (bytes.length !== expectedFile.bytes || sha(bytes) !== expectedFile.sha256) {
        throw new Error(`cloud restore staging file integrity mismatch: ${relative}`);
      }
      if (process.platform !== "win32") {
        const mode = expected.packageHashVersion === CLOUD_PACKAGE_HASH_V2 && expectedFile.executable ? 0o700 : 0o600;
        if ((stat.mode & 0o777) !== mode) throw new Error(`cloud restore staging file mode mismatch: ${relative}`);
      }
      seen.add(relative);
    }
  }
  walk(root);
  if (seen.size !== expectedByPath.size) throw new Error("cloud restore staging is missing package files");
  const markerPath = path.join(root, CLOUD_RESTORE_MARKER_PATH);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("cloud restore marker is unsafe");
  if (process.platform !== "win32" && (markerStat.mode & 0o777) !== 0o600) throw new Error("cloud restore marker mode mismatch");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const expectedExecutablePaths = expected.packageHashVersion === CLOUD_PACKAGE_HASH_V2
    ? files.filter((file) => file.executable).map((file) => file.path).sort()
    : undefined;
  if (
    marker.schemaVersion !== 1 || marker.source !== "agentlas-cloud" || marker.slug !== expected.slug ||
    String(marker.packageHash).replace(/^sha256:/i, "").toLowerCase() !== expected.packageHash ||
    marker.packageHashVersion !== expected.packageHashVersion || marker.fileCount !== files.length ||
    marker.totalBytes !== expected.totalBytes || typeof marker.restoredAt !== "string" ||
    !Number.isFinite(Date.parse(marker.restoredAt)) ||
    JSON.stringify(marker.executablePaths) !== JSON.stringify(expectedExecutablePaths)
  ) {
    throw new Error("cloud restore marker contract mismatch");
  }
  if (expected.assetDescriptor) {
    const descriptor = normalizeCloudAssetDescriptor(marker, "cloud restore marker");
    const nested = normalizeCloudAssetDescriptor(marker.cloudAssets?.[descriptor.scope], "cloud restore marker scope");
    if (
      JSON.stringify(descriptor) !== JSON.stringify(expected.assetDescriptor) ||
      JSON.stringify(nested) !== JSON.stringify(expected.assetDescriptor)
    ) {
      throw new Error("cloud restore marker revision contract mismatch");
    }
  }
}

function resolveCloudInstallPath(root, relPath) {
  const normalized = cloudPortableRelativePath(relPath);
  if (!normalized || cloudPortablePathKey(normalized) === cloudPortablePathKey(CLOUD_RESTORE_MARKER_PATH)) {
    throw new Error(`unsafe cloud package path: ${relPath}`);
  }
  const parts = normalized.split("/");
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`cloud package path escapes install folder: ${relPath}`);
  }
  return target;
}

// ── 설치 저널 (crash-recovery 계약) ──
function cloudInstallLayout(slug, { createParent = false } = {}) {
  if (typeof slug !== "string" || cloudSlug(slug) !== slug) {
    throw new Error(`invalid cloud install slug: ${String(slug || "")}`);
  }
  const dataRoot = userDataDir();
  if (createParent) fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(dataRoot)) return null;
  if (!fs.statSync(dataRoot).isDirectory()) throw new Error("cloud install user data root is unsafe");
  const realDataRoot = fs.realpathSync.native(dataRoot);
  const parent = path.join(dataRoot, "cloud-agent-installs");
  if (createParent) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(parent)) return null;
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    fs.realpathSync.native(parent) !== path.join(realDataRoot, "cloud-agent-installs")
  ) {
    throw new Error("cloud install root is unsafe");
  }
  cloudApplyPrivateDirectoryMode(parent);
  const destination = path.join(parent, slug);
  return {
    parent,
    destination,
    journalPath: path.join(parent, `.${slug}.install-journal.json`),
  };
}

function cloudManagedDirectoryState(target, label, { allowMissing = true } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a safe managed directory`);
  }
  return stat;
}

function cloudRemoveManagedDirectory(target, label, { anchor = null, containedBy = null } = {}) {
  if (anchor) {
    let current;
    try {
      current = cloudDirectoryAnchor(target, label, { allowMissing: true, containedBy });
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
    if (!current) return false;
    if (
      current.realpath !== anchor.realpath || current.dev !== anchor.dev ||
      current.ino !== anchor.ino
    ) throw new Error(`${label} changed while it was being removed`);
  } else if (containedBy) {
    if (!cloudDirectoryAnchor(target, label, { allowMissing: true, containedBy })) return false;
  } else if (!cloudManagedDirectoryState(target, label)) return false;
  fs.rmSync(target, { recursive: true, force: false });
  return true;
}

function cloudRenameManagedDirectory(source, destination, label, { sourceAnchor = null, parentAnchor = null } = {}) {
  if (parentAnchor) cloudRefreshDirectoryAnchor(parentAnchor, `${label} parent`);
  if (sourceAnchor) {
    cloudRefreshDirectoryAnchor(sourceAnchor, `${label} source`, parentAnchor);
  } else {
    cloudManagedDirectoryState(source, `${label} source`, { allowMissing: false });
  }
  if (cloudManagedDirectoryState(destination, `${label} destination`)) {
    throw new Error(`${label} destination already exists`);
  }
  if (parentAnchor) cloudRefreshDirectoryAnchor(parentAnchor, `${label} parent`);
  fs.renameSync(source, destination);
  if (parentAnchor) {
    cloudRefreshDirectoryAnchor(parentAnchor, `${label} parent`);
    cloudDirectoryAnchor(destination, `${label} destination`, { allowMissing: false, containedBy: parentAnchor });
  }
}

function cloudReadInstallJournal(journalPath) {
  let fd;
  try {
    fd = fs.openSync(journalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const listed = fs.lstatSync(journalPath);
    const before = fs.fstatSync(fd);
    if (
      !listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 ||
      !before.isFile() || before.nlink !== 1 ||
      listed.dev !== before.dev || listed.ino !== before.ino ||
      before.size <= 0 || before.size > CLOUD_INSTALL_JOURNAL_MAX_BYTES
    ) {
      throw new Error("journal is not a bounded private file");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(journalPath);
    if (
      Buffer.byteLength(raw, "utf8") !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1
    ) {
      throw new Error("journal changed while it was read");
    }
    return JSON.parse(raw);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function cloudUnlinkInstallJournal(journalPath) {
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("cloud install recovery journal is unsafe");
  }
  fs.unlinkSync(journalPath);
}

function writeCloudInstallJournal(journalPath, value) {
  const match = path.basename(journalPath).match(/^\.([a-z0-9][a-z0-9-]{0,63})\.install-journal\.json$/);
  const layout = match ? cloudInstallLayout(match[1], { createParent: true }) : null;
  if (!layout || path.resolve(journalPath) !== path.resolve(layout.journalPath)) {
    throw new Error("cloud install recovery journal path is unsafe");
  }
  const temp = `${journalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, journalPath);
  const written = fs.lstatSync(journalPath);
  if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1) {
    throw new Error("cloud install recovery journal write was unsafe");
  }
  cloudFsyncDirectory(path.dirname(journalPath));
}

function cloudFsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch { /* some filesystems do not support directory fsync */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ } }
}

function rollbackCloudInstallSwap({
  destination,
  staging,
  backup,
  movedExisting,
  installed,
  parentAnchor = null,
  stagingAnchor = null,
  backupAnchor = null,
  destinationAnchor = null,
}) {
  const safeParent = parentAnchor
    ? cloudRefreshDirectoryAnchor(parentAnchor, "cloud install parent rollback")
    : null;
  if (installed) {
    cloudRemoveManagedDirectory(destination, "cloud install destination", {
      anchor: destinationAnchor,
      containedBy: safeParent,
    });
  }
  if (movedExisting && cloudManagedDirectoryState(backup, "cloud install backup")) {
    cloudRenameManagedDirectory(backup, destination, "cloud install rollback", {
      sourceAnchor: backupAnchor,
      parentAnchor: safeParent,
    });
  }
  cloudRemoveManagedDirectory(staging, "cloud install staging", {
    anchor: stagingAnchor,
    containedBy: safeParent,
  });
  cloudFsyncDirectory(path.dirname(destination));
}

function recoverCloudInstallJournal(db, slug) {
  const layout = cloudInstallLayout(slug);
  if (!layout) return;
  const { destination, parent, journalPath } = layout;
  if (!fs.existsSync(journalPath)) return;
  let journal;
  try { journal = cloudReadInstallJournal(journalPath); } catch { throw new Error(`cloud install recovery journal is unreadable for ${slug}`); }
  const safeSibling = (candidate, prefix) =>
    typeof candidate === "string" && path.dirname(candidate) === parent &&
    (path.basename(candidate).match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[0-9]+-[0-9]+-[a-f0-9]{8}|fixture|crash)$`)) !== null);
  const expected = journal && journal.dbExpected;
  const expectedEntries = expected && typeof expected === "object" && !Array.isArray(expected)
    ? Object.entries(expected)
    : [];
  if (
    journal.schemaVersion !== 1 || journal.slug !== slug || journal.destination !== destination ||
    !["prepared", "disk-swapped-db-pending", "db-committed"].includes(journal.phase) ||
    typeof journal.hadExisting !== "boolean" ||
    !safeSibling(journal.staging, `.${path.basename(destination)}.installing-`) ||
    !safeSibling(journal.backup, `.${path.basename(destination)}.backup-`) ||
    expectedEntries.length === 0 || expectedEntries.length > 32 ||
    expectedEntries.some(([key, value]) =>
      !CLOUD_INSTALL_DB_EXPECTED_KEYS.has(key) ||
      (!["string", "number", "boolean"].includes(typeof value) && value !== null) ||
      (typeof value === "string" && value.length > 256 * 1024)
    )
  ) {
    throw new Error(`cloud install recovery journal is invalid for ${slug}`);
  }
  cloudManagedDirectoryState(destination, "cloud install destination");
  cloudManagedDirectoryState(journal.staging, "cloud install staging");
  cloudManagedDirectoryState(journal.backup, "cloud install backup");
  const row = db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(slug);
  const dbMatches = Boolean(row) && expectedEntries.length > 0 && expectedEntries.every(
    ([key, value]) => String(row[key] ?? "") === String(value ?? ""),
  );
  if (journal.phase === "prepared") {
    // The DB mutation starts only after materializeCloudListing returns, so a
    // prepared journal always represents the pre-DB state. Cover both rename
    // crash windows: old→backup and staging→destination.
    if (journal.hadExisting) {
      if (cloudManagedDirectoryState(journal.backup, "cloud install backup")) {
        cloudRemoveManagedDirectory(destination, "cloud install destination");
        cloudRenameManagedDirectory(journal.backup, destination, "cloud install prepared rollback");
      } else if (!cloudManagedDirectoryState(destination, "cloud install destination")) {
        throw new Error(`prepared cloud install lost both destination and backup for ${slug}`);
      }
    } else {
      if (cloudManagedDirectoryState(journal.backup, "cloud install backup")) {
        throw new Error(`prepared first cloud install has an unexpected backup for ${slug}`);
      }
      cloudRemoveManagedDirectory(destination, "cloud install destination");
    }
    cloudRemoveManagedDirectory(journal.staging, "cloud install staging");
  } else if (dbMatches) {
    if (!cloudManagedDirectoryState(destination, "cloud install destination") && cloudManagedDirectoryState(journal.staging, "cloud install staging")) {
      cloudRenameManagedDirectory(journal.staging, destination, "cloud install committed recovery");
    }
    if (!cloudManagedDirectoryState(destination, "cloud install destination")) throw new Error(`committed cloud install is missing for ${slug}`);
    cloudRemoveManagedDirectory(journal.backup, "cloud install backup");
    cloudRemoveManagedDirectory(journal.staging, "cloud install staging");
  } else if (journal.phase === "disk-swapped-db-pending" || journal.phase === "db-committed") {
    if (!cloudManagedDirectoryState(destination, "cloud install destination")) throw new Error(`pending cloud install destination is missing for ${slug}`);
    if (journal.hadExisting !== Boolean(cloudManagedDirectoryState(journal.backup, "cloud install backup"))) {
      throw new Error(`pending cloud install backup state is invalid for ${slug}`);
    }
    rollbackCloudInstallSwap({
      destination,
      staging: journal.staging,
      backup: journal.backup,
      movedExisting: Boolean(journal.hadExisting),
      installed: true,
    });
  }
  cloudUnlinkInstallJournal(journalPath);
  cloudFsyncDirectory(parent);
}

function recoverCloudInstallJournals(db) {
  const layout = cloudInstallLayout("recovery-sweep");
  if (!layout) return 0;
  const { parent } = layout;
  let recovered = 0;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.endsWith(".install-journal.json")) continue;
    const match = entry.name.match(/^\.([a-z0-9][a-z0-9-]{0,63})\.install-journal\.json$/);
    if (!match || cloudSlug(match[1]) !== match[1] || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`invalid cloud install recovery journal entry: ${entry.name}`);
    }
    recoverCloudInstallJournal(db, match[1]);
    recovered += 1;
  }
  return recovered;
}

// ── 시스템 프롬프트 합성 (패키지 엔트리 문서 → 불변 루트 헤더 포함) ──
function cloudSystemPromptFromPackage(listing, slug) {
  const pkg = listing && listing.cloudPackage;
  if (!pkg || !Array.isArray(pkg.files) || !pkg.files.length) return "";
  const byPath = new Map();
  for (const file of pkg.files) {
    if (!file || typeof file.path !== "string" || typeof file.contentBase64 !== "string") continue;
    byPath.set(cloudPortablePathKey(file.path), file);
  }
  const readText = (candidate) => {
    const safe = cloudPortableRelativePath(candidate);
    if (!safe) return "";
    const file = byPath.get(cloudPortablePathKey(safe));
    if (!file) return "";
    let bytes;
    try { bytes = Buffer.from(file.contentBase64, "base64"); } catch { return ""; }
    if (!bytes.length || bytes.includes(0)) return "";
    const text = bytes.toString("utf8");
    if (!text.trim() || text.includes("�")) return "";
    return text.slice(0, 64 * 1024);
  };
  let manifest = null;
  const manifestFile = byPath.get(cloudPortablePathKey("agentlas.json"));
  if (manifestFile) {
    try { manifest = JSON.parse(Buffer.from(manifestFile.contentBase64, "base64").toString("utf8")); }
    catch { manifest = null; }
  }
  const declaredEntry = manifest && typeof manifest === "object" && typeof manifest.entry === "string"
    ? cloudPortableRelativePath(manifest.entry)
    : null;
  const candidates = [
    declaredEntry,
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "AGENT.md",
    "agent.md",
    "system-prompt.md",
    "README.md",
  ].filter(Boolean);
  let entryPath = "";
  let entryText = "";
  for (const candidate of candidates) {
    const text = readText(candidate);
    if (!text) continue;
    entryPath = candidate;
    entryText = text;
    break;
  }
  if (!entryText) return "";
  const installRoot = path.join(userDataDir(), "cloud-agent-installs", slug);
  return [
    `You are the Agentlas Cloud agent "${listing.name || slug}".`,
    `IMMUTABLE CLOUD AGENT ROOT: ${installRoot}`,
    `CANONICAL ENTRY: ${entryPath}`,
    `PACKAGE HASH: ${String(pkg.packageHash || "").replace(/^sha256:/i, "")}`,
    "Resolve package-relative references under IMMUTABLE CLOUD AGENT ROOT. Treat that root as read-only and do work in the user's active project.",
    "",
    "--- CLOUD AGENT ENTRY ---",
    entryText,
  ].join("\n");
}

// ── materialize (스테이징 → 전수검증 → 원자 스왑; deferCommit이면 저널 + commit/rollback 핸들) ──
function materializeCloudListing(agentId, slug, listing, options = {}) {
  const pkg = listing.cloudPackage;
  if (!pkg || !Array.isArray(pkg.files) || pkg.files.length === 0) return null;
  if (pkg.files.length > CLOUD_MAX_FILES) throw new Error(`cloud package exceeds ${CLOUD_MAX_FILES} files`);
  if (!Number.isSafeInteger(pkg.fileCount) || pkg.fileCount !== pkg.files.length) {
    throw new Error("cloud package file count does not match its manifest");
  }
  if (!Number.isSafeInteger(pkg.totalBytes) || pkg.totalBytes < 0 || pkg.totalBytes > CLOUD_MAX_TOTAL_BYTES) {
    throw new Error("cloud package total byte count is invalid");
  }
  const packageHashVersion = cloudPackageHashVersion(pkg.packageHashVersion);
  if (!packageHashVersion) throw new Error(`unsupported cloud package hash version: ${pkg.packageHashVersion}`);
  const assetDescriptor = listing.assetDescriptor
    ? normalizeCloudAssetDescriptor(listing.assetDescriptor, "restore asset descriptor")
    : null;
  if (assetDescriptor && assetDescriptor.slug !== slug) throw new Error("restore asset descriptor slug mismatch");
  const pathConflict = cloudPortablePathConflict(pkg.files.map((file) => file && file.path));
  if (pathConflict) throw new Error(pathConflict.message);
  const layout = cloudInstallLayout(slug, { createParent: true });
  const { destination: dir, parent, journalPath: journal } = layout;
  let parentAnchor = cloudDirectoryAnchor(parent, "cloud install parent", { allowMissing: false });
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const staging = path.join(parent, `.${path.basename(dir)}.installing-${nonce}`);
  const backup = path.join(parent, `.${path.basename(dir)}.backup-${nonce}`);
  const managedAnchors = new Map();
  const seen = new Set();
  const verifiedFiles = [];
  let verifiedTotalBytes = 0;
  let movedExisting = false;
  let installed = false;
  let stagingAnchor = null;
  let destinationAnchor = null;
  let backupAnchor = null;
  let installedDestinationAnchor = null;
  try {
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    // Creating the staging directory legitimately changes the parent's nlink;
    // refresh that field while retaining the original dev/ino/realpath anchor.
    parentAnchor = cloudRefreshDirectoryAnchor(parentAnchor, "cloud install parent");
    cloudApplyPrivateDirectoryMode(staging);
    stagingAnchor = cloudDirectoryAnchor(staging, "cloud install staging", {
      allowMissing: false,
      containedBy: parentAnchor,
    });
    managedAnchors.set(staging, stagingAnchor);
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    for (const file of pkg.files) {
      const target = resolveCloudInstallPath(staging, file.path);
      const normalizedPath = path.relative(staging, target).split(path.sep).join("/");
      if (seen.has(normalizedPath)) throw new Error(`duplicate cloud package path: ${file.path}`);
      seen.add(normalizedPath);
      if (packageHashVersion === CLOUD_PACKAGE_HASH_V2 && typeof file.executable !== "boolean") {
        throw new Error(`cloud package hash v2 requires executable boolean: ${file.path}`);
      }
      if (packageHashVersion === CLOUD_PACKAGE_HASH_V1 && file.executable !== undefined) {
        throw new Error(`legacy cloud package hash v1 cannot authenticate executable flag: ${file.path}`);
      }
      if (!cloudCanonicalBase64(file.contentBase64)) {
        throw new Error(`cloud package file base64 is not canonical: ${file.path}`);
      }
      const bytes = Buffer.from(String(file.contentBase64 || ""), "base64");
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > CLOUD_MAX_FILE_BYTES) {
        throw new Error(`cloud package file byte count is invalid: ${file.path}`);
      }
      if (bytes.length !== Number(file.bytes) || sha(bytes) !== String(file.sha256 || "").toLowerCase()) {
        throw new Error(`cloud package file integrity failed: ${file.path}`);
      }
      verifiedFiles.push({
        path: normalizedPath,
        bytes: bytes.length,
        sha256: String(file.sha256 || "").toLowerCase(),
        ...(packageHashVersion === CLOUD_PACKAGE_HASH_V2 ? { executable: file.executable } : {}),
      });
      verifiedTotalBytes += bytes.length;
      if (verifiedTotalBytes > CLOUD_MAX_TOTAL_BYTES) throw new Error("cloud package exceeds total byte limit");
      for (const anchor of cloudEnsurePrivateSubdirectory(staging, path.dirname(target))) {
        managedAnchors.set(anchor.path, anchor);
      }
      stagingAnchor = managedAnchors.get(staging);
      cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
      for (const anchor of managedAnchors.values()) {
        cloudAssertDirectoryAnchor(anchor, "cloud install managed directory", stagingAnchor);
      }
      const mode = packageHashVersion === CLOUD_PACKAGE_HASH_V2 && file.executable ? 0o700 : 0o600;
      let fileFd;
      let fileWritten = false;
      try {
        fileFd = fs.openSync(
          target,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
          mode,
        );
        // A parent swap can happen during open. Do not write until the
        // directory anchors and the opened file identity still agree.
        cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
        // O_CREAT may legitimately change a directory's nlink on some
        // filesystems, so refresh that field after the open while retaining
        // the dev/ino/realpath identity and containment checks.
        stagingAnchor = cloudRefreshDirectoryAnchor(stagingAnchor, "cloud install staging", parentAnchor);
        managedAnchors.set(staging, stagingAnchor);
        for (const [anchorPath, anchor] of managedAnchors.entries()) {
          if (anchorPath === staging) continue;
          managedAnchors.set(anchorPath, cloudRefreshDirectoryAnchor(
            anchor,
            "cloud install managed directory",
            stagingAnchor,
          ));
        }
        const opened = fs.fstatSync(fileFd);
        const listed = fs.lstatSync(target);
        if (!cloudSameRegularFile(opened, listed) || opened.size !== 0) {
          throw new Error(`cloud package target changed while opening: ${file.path}`);
        }
        fs.writeFileSync(fileFd, bytes);
        if (process.platform !== "win32") fs.fchmodSync(fileFd, mode);
        fs.fsyncSync(fileFd);
        fileWritten = true;
      } finally {
        if (fileFd !== undefined) {
          if (!fileWritten) {
            // O_EXCL creates a zero-byte file before the final anchor check
            // can reject a swapped parent. Remove it only when the path still
            // names the exact descriptor we opened; never unlink a successor.
            try {
              const opened = fs.fstatSync(fileFd);
              const listed = fs.lstatSync(target);
              if (cloudSameRegularFile(opened, listed)) fs.unlinkSync(target);
            } catch { /* outer rollback retains any unknown successor */ }
          }
          fs.closeSync(fileFd);
        }
      }
    }
    const expectedPackageHash = String(pkg.packageHash || "").toLowerCase().replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(expectedPackageHash)) {
      throw new Error("cloud package aggregate hash is missing or invalid");
    }
    const actualPackageHash = cloudHashPackage(verifiedFiles, packageHashVersion);
    if (actualPackageHash !== expectedPackageHash) {
      throw new Error("cloud package aggregate integrity failed");
    }
    if (assetDescriptor && (
      assetDescriptor.packageHash !== expectedPackageHash ||
      assetDescriptor.packageHashVersion !== packageHashVersion
    )) {
      throw new Error("restore asset descriptor package identity mismatch");
    }
    if (verifiedTotalBytes !== pkg.totalBytes) throw new Error("cloud package total byte count does not match its files");
    const restoredAt = new Date().toISOString();
    const markerPath = path.join(staging, CLOUD_RESTORE_MARKER_PATH);
    stagingAnchor = cloudDirectoryAnchor(staging, "cloud install staging", {
      allowMissing: false,
      containedBy: parentAnchor,
    });
    managedAnchors.set(staging, stagingAnchor);
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    for (const anchor of managedAnchors.values()) {
      cloudAssertDirectoryAnchor(anchor, "cloud install managed directory", stagingAnchor);
    }
    let markerFd;
    let markerWritten = false;
    try {
      markerFd = fs.openSync(
        markerPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
      // As with package files, creating the marker can update the staging
      // directory nlink; refresh it before writing and keep identity strict.
      stagingAnchor = cloudRefreshDirectoryAnchor(stagingAnchor, "cloud install staging", parentAnchor);
      managedAnchors.set(staging, stagingAnchor);
      const opened = fs.fstatSync(markerFd);
      const listed = fs.lstatSync(markerPath);
      if (!cloudSameRegularFile(opened, listed) || opened.size !== 0) {
        throw new Error("cloud restore marker changed while opening");
      }
      fs.writeFileSync(markerFd, JSON.stringify({
        schemaVersion: 1,
        source: "agentlas-cloud",
        slug,
        packageHash: expectedPackageHash,
        packageHashVersion,
        fileCount: verifiedFiles.length,
        totalBytes: verifiedTotalBytes,
        executablePaths: packageHashVersion === CLOUD_PACKAGE_HASH_V2
          ? verifiedFiles.filter((file) => file.executable).map((file) => file.path).sort()
          : undefined,
        ...(assetDescriptor ? {
          cloudId: assetDescriptor.cloudId,
          scope: assetDescriptor.scope,
          revision: assetDescriptor.revision,
          etag: assetDescriptor.etag,
          updatedAt: assetDescriptor.updatedAt,
          cloudAssets: { [assetDescriptor.scope]: assetDescriptor },
        } : {}),
        restoredAt,
      }, null, 2) + "\n", "utf8");
      if (process.platform !== "win32") fs.fchmodSync(markerFd, 0o600);
      fs.fsyncSync(markerFd);
      markerWritten = true;
    } finally {
      if (markerFd !== undefined) {
        if (!markerWritten) {
          try {
            const opened = fs.fstatSync(markerFd);
            const listed = fs.lstatSync(markerPath);
            if (cloudSameRegularFile(opened, listed)) fs.unlinkSync(markerPath);
          } catch { /* outer rollback retains any unknown successor */ }
        }
        fs.closeSync(markerFd);
      }
    }
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    for (const anchor of managedAnchors.values()) {
      cloudAssertDirectoryAnchor(anchor, "cloud install managed directory", stagingAnchor);
    }
    cloudVerifyRestoredSnapshot(staging, verifiedFiles, {
      slug,
      packageHash: expectedPackageHash,
      packageHashVersion,
      totalBytes: verifiedTotalBytes,
      assetDescriptor,
    });

    if (options.deferCommit) {
      cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
      writeCloudInstallJournal(journal, {
        schemaVersion: 1,
        slug,
        phase: "prepared",
        destination: dir,
        staging,
        backup,
        hadExisting: Boolean(cloudManagedDirectoryState(dir, "cloud install destination")),
        dbExpected: options.dbExpected || {},
      });
      // The recovery journal is a file in the managed parent and may update
      // that directory's nlink; refresh the field before publication checks.
      parentAnchor = cloudRefreshDirectoryAnchor(parentAnchor, "cloud install parent");
    }

    // A Cloud agent is an immutable asset snapshot. Replace the managed install
    // as a whole so removed files and local mutations cannot leak across versions.
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    for (const anchor of managedAnchors.values()) {
      cloudAssertDirectoryAnchor(anchor, "cloud install managed directory", stagingAnchor);
    }
    if (cloudManagedDirectoryState(dir, "cloud install destination")) {
      destinationAnchor = cloudDirectoryAnchor(dir, "cloud install destination", {
        allowMissing: false,
        containedBy: parentAnchor,
      });
      cloudRenameManagedDirectory(dir, backup, "cloud install snapshot swap", {
        sourceAnchor: destinationAnchor,
        parentAnchor,
      });
      movedExisting = true;
      backupAnchor = cloudDirectoryAnchor(backup, "cloud install backup", {
        allowMissing: false,
        containedBy: parentAnchor,
      });
    }
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    cloudRenameManagedDirectory(staging, dir, "cloud install staging swap", {
      sourceAnchor: stagingAnchor,
      parentAnchor,
    });
    cloudAssertDirectoryAnchor(parentAnchor, "cloud install parent");
    installedDestinationAnchor = cloudDirectoryAnchor(dir, "cloud install destination", {
      allowMissing: false,
      containedBy: parentAnchor,
    });
    cloudFsyncDirectory(parent);
    installed = true;
    if (options.deferCommit) {
      writeCloudInstallJournal(journal, {
        schemaVersion: 1,
        slug,
        phase: "disk-swapped-db-pending",
        destination: dir,
        staging,
        backup,
        hadExisting: movedExisting,
        dbExpected: options.dbExpected || {},
      });
    }
  } catch (error) {
    rollbackCloudInstallSwap({
      destination: dir,
      staging,
      backup,
      movedExisting,
      installed,
      parentAnchor,
      stagingAnchor,
      backupAnchor,
      destinationAnchor: installedDestinationAnchor,
    });
    try { if (fs.existsSync(journal)) cloudUnlinkInstallJournal(journal); } catch { /* best-effort */ }
    throw error;
  } finally {
    try {
      cloudRemoveManagedDirectory(staging, "cloud install staging", {
        anchor: stagingAnchor,
        containedBy: parentAnchor,
      });
    } catch { /* best-effort */ }
    try {
      if (!options.deferCommit && installed) {
        cloudRemoveManagedDirectory(backup, "cloud install backup", {
          anchor: backupAnchor,
          containedBy: parentAnchor,
        });
      }
    } catch { /* best-effort */ }
  }
  if (!options.deferCommit) return dir;
  let settled = false;
  return {
    path: dir,
    commit() {
      if (settled) return;
      writeCloudInstallJournal(journal, {
        schemaVersion: 1,
        slug,
        phase: "db-committed",
        destination: dir,
        staging,
        backup,
        hadExisting: movedExisting,
        dbExpected: options.dbExpected || {},
      });
      cloudRemoveManagedDirectory(backup, "cloud install backup");
      if (fs.existsSync(journal)) cloudUnlinkInstallJournal(journal);
      cloudFsyncDirectory(parent);
      settled = true;
    },
    rollback() {
      if (settled) return;
      rollbackCloudInstallSwap({ destination: dir, staging, backup, movedExisting, installed });
      if (fs.existsSync(journal)) cloudUnlinkInstallJournal(journal);
      cloudFsyncDirectory(parent);
      settled = true;
    },
  };
}

// ── persist (DB upsert + materialize를 하나의 commit/rollback 단위로) ──
function persistCloudListing(db, listing) {
  if (listing?.delivery?.mode === "call_only") {
    throw new Error(`call-only Hub asset cannot be source-installed; invoke it with agentlas call ${listing.slug || "<slug>"}`);
  }
  const slug = cloudSlug(listing.slug || listing.name || "cloud-agent");
  recoverCloudInstallJournal(db, slug);
  const existing = db.prepare("SELECT * FROM installed_agents WHERE slug=?").get(slug);
  const now = new Date().toISOString();
  const envReqs = JSON.stringify(listing.envRequirements || []);
  const mcpServers = JSON.stringify(listing.mcpServers || []);
  const id = existing?.id || crypto.randomUUID();
  const hasVisibility = columnExists(db, "installed_agents", "visibility");
  let installedAt = now;
  // 재설치 판별용 저널 대조: installed_at까지 기대값에 들어가므로 같은 ms 재설치도 구분한다.
  if (existing && String(existing.installed_at || "") === installedAt) {
    installedAt = new Date(Date.now() + 1).toISOString();
  }
  const tone = listing.tone || "blue";
  const packageSystemPrompt = cloudSystemPromptFromPackage(listing, slug);
  const dbExpected = {
    id,
    slug,
    name: listing.name || slug,
    name_en: listing.nameEn || listing.name || slug,
    tagline: listing.tagline || "",
    tagline_en: listing.taglineEn || listing.tagline || "",
    system_prompt: packageSystemPrompt || listing.systemPrompt || "",
    mcp_servers_json: mcpServers,
    env_requirements_json: envReqs,
    trust_grade: listing.trustGrade || "unknown",
    installed_at: installedAt,
    tone,
    ...(!existing ? { preferred_backend: null } : {}),
    ...(hasVisibility ? { visibility: listing.visibility || "visible" } : {}),
  };
  const restore = materializeCloudListing(id, slug, listing, { deferCommit: true, dbExpected });
  const mutate = () => {
    if (existing) {
      if (hasVisibility) {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, mcp_servers_json=?, env_requirements_json=?, trust_grade=?, installed_at=?, tone=?, visibility=? WHERE slug=?")
          .run(dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, dbExpected.visibility, slug);
      } else {
        db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, mcp_servers_json=?, env_requirements_json=?, trust_grade=?, installed_at=?, tone=? WHERE slug=?")
          .run(dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, slug);
      }
      return;
    }
    if (hasVisibility) {
      db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, visibility) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)")
        .run(id, slug, dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone, dbExpected.visibility);
    } else {
      db.prepare("INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)")
        .run(id, slug, dbExpected.name, dbExpected.name_en, dbExpected.tagline, dbExpected.tagline_en, dbExpected.system_prompt, mcpServers, envReqs, dbExpected.trust_grade, installedAt, tone);
    }
  };
  let dbCommitted = false;
  try {
    runWriteTransaction(db, mutate);
    dbCommitted = true;
    restore?.commit();
  } catch (error) {
    if (!dbCommitted) restore?.rollback();
    throw error;
  }
  const localPath = restore?.path || null;
  // entity_kind 기록 — needsImage의 팀 body-veto가 로컬 폴더 임포트(detectKind)뿐 아니라
  // 클라우드/Hub 소스 설치 팀에도 걸리게 한다. 안 하면 팀 CEO 두뇌의 부서 키워드
  // ("Design HQ" 등)로 needsImage가 참이 되어 세션 런타임이 통째로 gemini로 하이재킹된다.
  // Hub가 준 entityKind를 우선하고, 없으면 materialize된 팩 폴더 구조로 판정한다.
  if (columnExists(db, "installed_agents", "entity_kind")) {
    let kind = String(listing.entityKind || "").toLowerCase();
    if (kind !== "team" && kind !== "agent") {
      kind = localPath && fs.existsSync(localPath) ? detectKind(localPath) : "agent";
    }
    db.prepare("UPDATE installed_agents SET entity_kind=? WHERE id=?").run(kind, id);
  }
  return existing
    ? { ...existing, slug, name: dbExpected.name, ...(localPath ? { localPath } : {}) }
    : { id, slug, name: dbExpected.name, ...(localPath ? { localPath } : {}) };
}

/** Hub 에이전트 매니페스트 조회 (marketplace.get_manifest, kind 고정 "agent"). */
async function fetchHubAgentManifest(slug, { callTool } = {}) {
  const call = callTool || callHubTool;
  return call("marketplace.get_manifest", { kind: "agent", slug });
}

/**
 * Hub 에이전트 설치 진입점.
 * options.callTool — 테스트/오프라인 주입 지점 (hub-client options.fetch와 같은 설계).
 * 반환: persistCloudListing 결과({ id?, slug, name, localPath? }).
 */
async function installHubAgent(db, slug, options = {}) {
  if (!slug) throw new Error("usage: agentlas install <slug>");
  const listing = await fetchHubAgentManifest(slug, options);
  if (!listing) throw new Error(`Hub agent not found: ${slug}`);
  assertHubInstallAllowed(listing, slug);
  return persistCloudListing(db, listing);
}

/*
 * 데스크탑 registry.installAgent와 동일한 설치 게이트 (electron/mcp/registry.ts:178).
 * 제품 모델: Hub는 기본이 "빌림"(call-only → 북마크 또는 agentlas call)이고,
 * 로컬 설치는 소스가 공개된 install-only 패키지 중 신뢰등급 A/B만 허용된다.
 * v1 터미널은 delivery.mode 검사 하나뿐이라 이 게이트들이 전부 빠져 있었다
 * (실사용 테스트에서 실증된 모델 드리프트 — 데스크탑과 토씨까지 맞춘다).
 */
function assertHubInstallAllowed(listing, slug) {
  const { isPrivateWebOnlyAgentRow, publicAgentVisibilityRow } = require("../agents/registry.cjs");
  // 회수된 마켓 시드는 데스크탑 marketplace가 리스팅 자체를 숨긴다
  // (electron/marketplace/index.ts:180 isPublicDesktopAgent → null = not found).
  // 터미널도 같은 관측 결과를 낸다 — 설치 불가, 존재하지 않는 상품으로 취급.
  const rowLike = {
    slug: listing.slug || slug,
    name: listing.name,
    name_en: listing.nameEn,
    tagline: listing.tagline,
    tagline_en: listing.taglineEn,
    visibility: listing.visibility,
    role: listing.role,
  };
  if (publicAgentVisibilityRow(rowLike) === "private" && !isPrivateWebOnlyAgentRow(rowLike)) {
    throw new Error(`Hub agent not found: ${slug}`);
  }
  if (isPrivateWebOnlyAgentRow({
    slug: listing.slug || slug,
    name: listing.name,
    name_en: listing.nameEn,
    tagline: listing.tagline,
    tagline_en: listing.taglineEn,
    visibility: listing.visibility,
    role: listing.role,
  })) {
    throw new Error("This web-only agent is not available in the Agentlas terminal.");
  }
  const callOnly = (listing.delivery && listing.delivery.mode === "call_only")
    || listing.callable === true
    || listing.kind === "cloud-callable"
    || listing.entityKind === "cloud-callable";
  const packagePrompt = cloudSystemPromptFromPackage(listing, listing.slug || slug);
  const hasPrompt = (typeof listing.systemPrompt === "string" && listing.systemPrompt.trim())
    || (typeof packagePrompt === "string" && packagePrompt.trim());
  if (!hasPrompt) {
    if (callOnly) {
      throw new Error(
        "This Hub agent is call-only and cannot be installed locally. Bookmark it or run `agentlas call " + slug + "`; owners can restore their Agent Cloud package with `agentlas cloud restore`.",
      );
    }
    throw new Error("This Hub package is missing the instructions required for a safe local install.");
  }
  if (callOnly) {
    throw new Error(
      "This Hub agent is call-only and cannot be installed locally. Bookmark it or run `agentlas call " + slug + "`.",
    );
  }
  const trust = String(listing.trustGrade || "").toUpperCase();
  if (trust !== "A" && trust !== "B") {
    throw new Error(`Trust grade ${listing.trustGrade || "unknown"} blocked. Sideloading requires explicit approval (V1+).`);
  }
}

module.exports = {
  CLOUD_MAX_TOTAL_BYTES,
  CLOUD_MAX_FILE_BYTES,
  CLOUD_MAX_FILES,
  CLOUD_PACKAGE_HASH_V1,
  CLOUD_PACKAGE_HASH_V2,
  CLOUD_RESTORE_MARKER_PATH,
  // cloud-assets(패키징/CAS/상태 저널)가 같은 원시 규칙을 공유한다 — 복제 금지 계약.
  // 특히 cloudIsLocalExperienceLineagePath는 cloudHashPackage의 제외 규칙과
  // 바이트 단위로 같아야 한다(복제본이 드리프트하면 해시 계약이 갈라진다).
  CLOUD_ASSET_SCOPES,
  cloudRevisionEtag,
  cloudCodePointPathOrder,
  cloudIsLocalExperienceLineagePath,
  cloudApplyPortableFileMode,
  cloudFsyncDirectory,
  cloudSlug,
  detectKind,
  sha,
  cloudPortablePathKey,
  cloudPortableRelativePath,
  cloudPortablePathConflict,
  cloudCanonicalBase64,
  cloudPackageHashVersion,
  cloudHashPackage,
  normalizeCloudAssetDescriptor,
  cloudSystemPromptFromPackage,
  materializeCloudListing,
  writeCloudInstallJournal,
  recoverCloudInstallJournal,
  recoverCloudInstallJournals,
  rollbackCloudInstallSwap,
  persistCloudListing,
  fetchHubAgentManifest,
  installHubAgent,
};
