"use strict";
/*
 * project/credentials — 프로젝트 로컬 자격증명 스토어 (v1 monolith 3957–4182 포팅).
 *
 * 계약:
 *  - 값(비밀)은 절대 .agentlas/local-credentials.map.json 이나 soul memory에 기록하지
 *    않는다. 여기엔 env 이름·상대 경로·owner·stale-check 메모만 남는다.
 *  - signing/, credentials/ 폴더와 .env* 는 ensureAgentlasCredentialIgnoreCli 가
 *    프로젝트 .gitignore에 별도 블록으로 등록한다 (README만 예외로 커밋 허용).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadArch } = require("../core/db.cjs");
const { runCwd } = require("./paths.cjs");

const MAX_MANAGED_CREDENTIAL_METADATA_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024 * 1024;
const CREDENTIAL_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const credentialDestinationBindings = new Map();

function credentialSameDirectoryIdentity(left, right) {
  return Boolean(
    left && right && left.isDirectory() && right.isDirectory() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function credentialDirectoryAnchor(target, label, containedBy = null) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real managed directory`);
  const realpath = fs.realpathSync.native(target);
  if (containedBy && !(
    realpath === containedBy.realpath || realpath.startsWith(`${containedBy.realpath}${path.sep}`)
  )) throw new Error(`${label} escaped the managed project`);
  return { path: target, realpath, dev: stat.dev, ino: stat.ino, stat };
}

function credentialAssertDirectoryAnchor(anchor, label, containedBy = null) {
  const current = credentialDirectoryAnchor(anchor.path, label, containedBy);
  if (!credentialSameDirectoryIdentity(anchor.stat || anchor, current.stat || current) || current.realpath !== anchor.realpath) {
    throw new Error(`${label} changed while it was being used`);
  }
  return current;
}

function credentialSameFileIdentity(left, right) {
  return Boolean(
    left && right && left.isFile() && right.isFile() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function credentialSameFileSnapshot(left, right) {
  return credentialSameFileIdentity(left, right) && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function credentialFileSnapshot(file, label, { allowMissing = false, allowHardLinks = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowHardLinks && stat.nlink !== 1) || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular non-symbolic-link file`);
  }
  return stat;
}

function credentialRemoveOwnedFile(file, expected, { allowLinked = false } = {}) {
  try {
    const current = fs.lstatSync(file);
    if (credentialSameFileIdentity(current, expected) && (current.nlink === 1 || (allowLinked && current.nlink >= 2))) {
      fs.unlinkSync(file);
    }
  } catch { /* leave unknown successors and recovery artifacts untouched */ }
}

function credentialRestoreBackup(backup, target, expected, parent) {
  try {
    credentialAssertDirectoryAnchor(parent, "credential destination directory");
    if (credentialFileSnapshot(target, "credential destination successor", { allowMissing: true })) return false;
    const current = credentialFileSnapshot(backup, "credential destination backup");
    if (!current || !credentialSameFileIdentity(current, expected) || current.nlink !== 1) return false;
    fs.linkSync(backup, target);
    const restored = credentialFileSnapshot(target, "credential destination restored", { allowHardLinks: true });
    if (!restored || !credentialSameFileIdentity(restored, expected) || restored.nlink < 2) return false;
    fs.unlinkSync(backup);
    return true;
  } catch {
    return false;
  }
}

function credentialPublishFile(parent, targetName, temporary, expected) {
  credentialAssertDirectoryAnchor(parent, "credential destination directory");
  const target = path.join(parent.realpath, targetName);
  const current = credentialFileSnapshot(target, "credential destination", { allowMissing: true });
  if ((expected && (!current || !credentialSameFileSnapshot(current, expected))) || (!expected && current)) {
    throw new Error("credential destination changed before replacement");
  }
  let backup = null;
  let linked = false;
  try {
    if (expected) {
      backup = `${target}.previous-${process.pid}-${crypto.randomUUID()}`;
      fs.renameSync(target, backup);
      const moved = credentialFileSnapshot(backup, "credential destination backup");
      if (!moved || !credentialSameFileIdentity(moved, expected) || moved.nlink !== 1) {
        credentialRestoreBackup(backup, target, expected, parent);
        throw new Error("credential destination changed before replacement");
      }
      credentialAssertDirectoryAnchor(parent, "credential destination directory");
      if (credentialFileSnapshot(target, "credential destination successor", { allowMissing: true })) {
        throw new Error("credential destination successor appeared during replacement");
      }
    }
    credentialAssertDirectoryAnchor(parent, "credential destination directory");
    if (credentialFileSnapshot(target, "credential destination successor", { allowMissing: true })) {
      throw new Error("credential destination successor appeared during replacement");
    }
    fs.linkSync(temporary.path, target);
    linked = true;
    const linkedTarget = credentialFileSnapshot(target, "credential destination", { allowHardLinks: true });
    if (!linkedTarget || !credentialSameFileIdentity(linkedTarget, temporary.stat) || linkedTarget.nlink < 2) {
      throw new Error("credential publication produced an unsafe target");
    }
    credentialAssertDirectoryAnchor(parent, "credential destination directory");
    credentialRemoveOwnedFile(temporary.path, temporary.stat, { allowLinked: true });
    const installed = credentialFileSnapshot(target, "credential destination");
    if (!installed || !credentialSameFileIdentity(installed, temporary.stat) || installed.nlink !== 1) {
      throw new Error("credential publication identity changed");
    }
    try { fs.chmodSync(target, 0o600); } catch { /* Windows/best-effort */ }
    const final = credentialFileSnapshot(target, "credential destination");
    if (!final || !credentialSameFileIdentity(final, temporary.stat) || final.nlink !== 1 ||
        (process.platform !== "win32" && (final.mode & 0o777) !== 0o600)) {
      throw new Error("credential publication mode or identity changed");
    }
    credentialAssertDirectoryAnchor(parent, "credential destination directory");
    if (backup) {
      const backupStat = credentialFileSnapshot(backup, "credential destination backup", { allowMissing: true });
      if (backupStat && credentialSameFileIdentity(backupStat, expected) && backupStat.nlink === 1) fs.unlinkSync(backup);
    }
    return target;
  } catch (error) {
    if (linked) credentialRemoveOwnedFile(target, temporary.stat);
    credentialRemoveOwnedFile(temporary.path, temporary.stat);
    if (backup) credentialRestoreBackup(backup, target, expected, parent);
    throw error;
  }
}

function credentialProjectRootCli(projectPath) {
  const requested = path.resolve(projectPath || "");
  const root = fs.realpathSync.native(requested);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("credential project must be a real directory");
  return root;
}

function ensureManagedDirectoryCli(root, relativePath, mode = 0o700) {
  let current = root;
  for (const segment of String(relativePath || "").split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("credential store directories must not be symbolic links");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { recursive: false, mode });
    }
  }
  return current;
}

function readManagedTextSnapshotCli(filePath, maxBytes = MAX_MANAGED_CREDENTIAL_METADATA_BYTES) {
  let before;
  try { before = fs.lstatSync(filePath); }
  catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, text: "", mode: 0o600 };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error("credential store file must be a bounded regular non-symbolic-link file");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("credential store file changed while opening");
    }
    return {
      exists: true,
      text: fs.readFileSync(fd, "utf8"),
      mode: before.mode & 0o777,
      stat: before,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertManagedSnapshotUnchangedCli(filePath, snapshot) {
  let current;
  try { current = fs.lstatSync(filePath); }
  catch (error) {
    if (error && error.code === "ENOENT" && !snapshot.exists) return;
    throw new Error("credential store file changed before replacement");
  }
  if (
    !snapshot.exists || !current.isFile() || current.isSymbolicLink() || !snapshot.stat ||
    current.dev !== snapshot.stat.dev || current.ino !== snapshot.stat.ino ||
    current.size !== snapshot.stat.size || current.mtimeMs !== snapshot.stat.mtimeMs
  ) throw new Error("credential store file changed before replacement");
}

function replaceManagedFileCli(tempPath, filePath, snapshot) {
  assertManagedSnapshotUnchangedCli(filePath, snapshot);
  try {
    fs.renameSync(tempPath, filePath);
    return;
  } catch (error) {
    if (
      process.platform !== "win32" || !snapshot.exists ||
      !["EEXIST", "EPERM", "EACCES"].includes(error && error.code)
    ) throw error;
  }
  assertManagedSnapshotUnchangedCli(filePath, snapshot);
  const backup = `${filePath}.agentlas-${process.pid}-${crypto.randomUUID()}.bak`;
  fs.renameSync(filePath, backup);
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { if (!fs.existsSync(filePath)) fs.renameSync(backup, filePath); } catch { /* leave recoverable backup */ }
    throw error;
  }
  try { fs.rmSync(backup, { force: true }); } catch { /* committed target is authoritative */ }
}

function writeManagedTextAtomicCli(filePath, text, options = {}) {
  const snapshot = options.snapshot || readManagedTextSnapshotCli(filePath, options.maxBytes);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > (options.maxBytes || MAX_MANAGED_CREDENTIAL_METADATA_BYTES)) throw new Error("credential store file exceeds its safety limit");
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: options.mode || snapshot.mode || 0o600, flag: "wx" });
    replaceManagedFileCli(temp, filePath, snapshot);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

function ensureManagedTextFileCli(filePath, content, mode = 0o600) {
  const snapshot = readManagedTextSnapshotCli(filePath);
  if (!snapshot.exists) writeManagedTextAtomicCli(filePath, content, { snapshot, mode });
  return snapshot.exists ? snapshot.text : content;
}

function localCredentialConfigCli(arch) {
  return {
    mapFile: arch.localCredentialsMapFile || "local-credentials.map.json",
    envExampleFile: arch.projectEnvExampleFile || ".env.example",
    signingDir: arch.projectSigningDir || "signing",
    credentialsDir: arch.projectCredentialsDir || "credentials",
    readmeFile: arch.projectCredentialsReadmeFile || "README.md",
  };
}
function projectEnvIdCli(projectPath) {
  const raw = path.basename(projectPath || runCwd() || "project") || "project";
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROJECT";
}
function projectScopedGlobalEnvKeyCli(projectPath, key) {
  return `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_${key}`;
}
function projectScopedEnvValuesCli(values, projectPath) {
  const prefix = `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_`;
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(prefix)) continue;
    const actualKey = key.slice(prefix.length);
    if (/^[A-Z][A-Z0-9_]*$/.test(actualKey)) result[actualKey] = value;
  }
  return result;
}
function localCredentialsMapSkeletonCli(projectPath, projectName, cfg) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    kind: "agentlas-local-credential-store",
    projectName,
    projectRoot: projectPath,
    createdAt: now,
    updatedAt: now,
    envFiles: [".env", ".env.local"],
    secretDirs: [cfg.signingDir, cfg.credentialsDir],
    entries: [],
  };
}
const CREDENTIAL_INDEX_SECTION_CLI = "## Local Credential Index (read first)";
function credentialIndexSectionContentCli(arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const mapFile = (arch && arch.localCredentialsMapFile) || "local-credentials.map.json";
  return `${CREDENTIAL_INDEX_SECTION_CLI}

- For deploy, release, store, billing, auth, API, or cloud work, read
  .agentlas/${mapFile} before saying a credential is missing.
- Real values may live in .env, .env.local, ${cfg.signingDir}/,
  ${cfg.credentialsDir}/, local keychain/vault, or project-scoped global env
  keys like AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME>.
- Keep this memory value-free: record env names, local relative paths, owner,
  stale-check notes, and validation commands only.

| Need | Look here first | Memory record |
|------|-----------------|---------------|
| Scalar env key | .env or .env.local | env name only |
| Store/signing file | ${cfg.signingDir}/ | relative path only |
| App/provider config | ${cfg.credentialsDir}/ | relative path only |
| Shared local env | AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME> | project-scoped env name |
`;
}
function projectSoulTemplateCli(projectName, arch) {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by Agentlas.

${credentialIndexSectionContentCli(arch)}

## Project Purpose

## Current State

## Decisions

## Risks

## Auto-curated memory
`;
}
function ensureSoulCredentialIndexCli(projectPath, projectName, arch) {
  const root = credentialProjectRootCli(projectPath);
  const memoryDir = (arch && arch.memoryDir) || ".agentlas";
  const soulFile = (arch && arch.soulFile) || "project-soul-memory.md";
  const dir = ensureManagedDirectoryCli(root, memoryDir);
  const soul = path.join(dir, soulFile);
  const snapshot = readManagedTextSnapshotCli(soul);
  if (!snapshot.exists) {
    writeManagedTextAtomicCli(soul, projectSoulTemplateCli(projectName, arch), { snapshot, mode: 0o600 });
    return soul;
  }
  const content = snapshot.text;
  if (!content.includes(CREDENTIAL_INDEX_SECTION_CLI)) {
    const section = credentialIndexSectionContentCli(arch);
    const marker = "\n## Project Purpose";
    const next = content.includes(marker)
      ? content.replace(marker, `\n${section}\n## Project Purpose`)
      : `${content.trimEnd()}\n\n${section}\n`;
    writeManagedTextAtomicCli(soul, next.endsWith("\n") ? next : next + "\n", { snapshot, mode: 0o600 });
  }
  return soul;
}
function envExampleContentCli(cfg) {
  return `# Agentlas local project environment.
# Copy this file to .env and fill real values only on this machine.

# File-path style for tools that expect a local JSON credential file.
SUPPLY_JSON_KEY=${cfg.signingDir}/google-play.json

# Inline JSON style for tools that support reading a credential directly from env.
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
`;
}
function signingReadmeContentCli(cfg) {
  return `# ${cfg.signingDir}/

Put release signing material here when this project needs local deploy or store
automation. This folder is ignored by git except for this README.

Examples:

- Google Play release JSON used by SUPPLY_JSON_KEY
- Apple signing certificates or provisioning profiles
- Notarization or release upload keys

Do not commit files from this folder.
`;
}
function credentialsReadmeContentCli(cfg) {
  return `# ${cfg.credentialsDir}/

Put app or service configuration files here when this project needs local runtime
access. This folder is ignored by git except for this README.

Examples:

- Android google-services.json
- iOS GoogleService-Info.plist
- provider config files used only by this local project

Do not commit files from this folder.
`;
}
function ensureAgentlasCredentialIgnoreCli(projectPath, cfg) {
  const root = credentialProjectRootCli(projectPath);
  const gitignorePath = path.join(root, ".gitignore");
  const marker = "# Agentlas local credentials";
  const block = `${marker}
.env
.env.local
.env.*.local
._*
${cfg.signingDir}/*
!${cfg.signingDir}/
!${cfg.signingDir}/${cfg.readmeFile}
${cfg.credentialsDir}/*
!${cfg.credentialsDir}/
!${cfg.credentialsDir}/${cfg.readmeFile}
`;
  const snapshot = readManagedTextSnapshotCli(gitignorePath);
  const existing = snapshot.text;
  if (existing.includes(marker)) {
    if (!/^\._\*$/m.test(existing)) {
      writeManagedTextAtomicCli(gitignorePath, `${existing.trimEnd()}\n._*\n`, { snapshot, mode: snapshot.mode || 0o644 });
    }
    return;
  }
  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  writeManagedTextAtomicCli(gitignorePath, next.endsWith("\n") ? next : next + "\n", {
    snapshot,
    mode: snapshot.exists ? snapshot.mode : 0o644,
  });
}
function ensureLocalCredentialStoreCli(projectPath, projectName, arch) {
  const root = credentialProjectRootCli(projectPath);
  const cfg = localCredentialConfigCli(arch || loadArch());
  const dir = ensureManagedDirectoryCli(root, (arch && arch.memoryDir) || ".agentlas");
  const signingDir = ensureManagedDirectoryCli(root, cfg.signingDir);
  const credentialsDir = ensureManagedDirectoryCli(root, cfg.credentialsDir);
  const envExample = path.join(root, cfg.envExampleFile);
  ensureManagedTextFileCli(envExample, envExampleContentCli(cfg), 0o600);
  const signingReadme = path.join(signingDir, cfg.readmeFile);
  ensureManagedTextFileCli(signingReadme, signingReadmeContentCli(cfg), 0o600);
  const credentialsReadme = path.join(credentialsDir, cfg.readmeFile);
  ensureManagedTextFileCli(credentialsReadme, credentialsReadmeContentCli(cfg), 0o600);
  const mapPath = path.join(dir, cfg.mapFile);
  const mapText = ensureManagedTextFileCli(
    mapPath,
    JSON.stringify(localCredentialsMapSkeletonCli(root, projectName, cfg), null, 2) + "\n",
    0o600,
  );
  let mapValue;
  try { mapValue = JSON.parse(mapText); }
  catch (error) { throw new Error(`credential map is invalid JSON: ${String((error && error.message) || error)}`); }
  if (!mapValue || typeof mapValue !== "object" || Array.isArray(mapValue)) {
    throw new Error("credential map must contain a JSON object");
  }
  ensureAgentlasCredentialIgnoreCli(root, cfg);
  return { cfg, mapPath, projectRoot: root };
}
function readJsonObjectCli(file, fallback, options = {}) {
  try {
    const parsed = JSON.parse(readManagedTextSnapshotCli(file).text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (options.strict) throw new Error("credential map must contain a JSON object");
    return fallback;
  } catch (error) {
    if (options.strict) throw new Error(`credential map is unreadable or invalid: ${String((error && error.message) || error)}`);
    return fallback;
  }
}
function upsertLocalCredentialMapCli(projectPath, projectName, arch, entry) {
  const { cfg, mapPath, projectRoot } = ensureLocalCredentialStoreCli(projectPath, projectName, arch || loadArch());
  const snapshot = readManagedTextSnapshotCli(mapPath);
  const data = readJsonObjectCli(mapPath, localCredentialsMapSkeletonCli(projectPath, projectName, cfg), { strict: true });
  const now = new Date().toISOString();
  data.updatedAt = now;
  if (!Array.isArray(data.entries)) data.entries = [];
  const id = entry.id || `${entry.provider || "credential"}:${(entry.env || []).join(",") || (entry.localFiles || []).join(",")}`;
  const clean = {
    id,
    provider: entry.provider || "unknown",
    env: Array.isArray(entry.env) ? [...new Set(entry.env.filter(Boolean))] : [],
    localFiles: Array.isArray(entry.localFiles) ? [...new Set(entry.localFiles.filter(Boolean))] : [],
    owner: entry.owner || "project",
    valueMaterialized: Boolean(entry.valueMaterialized),
    storage: Array.isArray(entry.storage) ? [...new Set(entry.storage.filter(Boolean))] : [],
    requiredFor: Array.isArray(entry.requiredFor) ? [...new Set(entry.requiredFor.filter(Boolean))] : [],
    lastVerified: entry.lastVerified || null,
    staleCheck: entry.staleCheck || null,
    updatedAt: now,
  };
  const idx = data.entries.findIndex((row) => row && row.id === id);
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...clean };
  else data.entries.push(clean);
  data.projectRoot = projectRoot;
  writeManagedTextAtomicCli(mapPath, JSON.stringify(data, null, 2) + "\n", { snapshot, mode: 0o600 });
}
// v1은 fail()로 즉시 종료했다 — v2 규칙은 throw → 명령이 ctx.err + return 1 로 변환.
function safeCredentialDestRelCli(destRel) {
  const rel = path.normalize(String(destRel || "")).replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || rel === "." || rel.startsWith("../") || /[\u0000-\u001f\u007f]/.test(rel)) {
    throw new Error("credential destination must be a relative path inside the project");
  }
  return rel;
}

function resolveCredentialDestinationCli(projectPath, destRel) {
  const root = credentialProjectRootCli(projectPath);
  const rel = safeCredentialDestRelCli(destRel);
  const rootAnchor = credentialDirectoryAnchor(root, "credential project root");
  const parentRel = path.dirname(rel);
  const parent = parentRel === "." ? root : ensureManagedDirectoryCli(root, parentRel);
  const realParent = fs.realpathSync.native(parent);
  const relativeParent = path.relative(root, realParent);
  if (path.isAbsolute(relativeParent) || relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`)) {
    throw new Error("credential destination escaped the project");
  }
  const parentAnchor = credentialDirectoryAnchor(realParent, "credential destination directory", rootAnchor);
  const destination = path.join(parentAnchor.realpath, path.basename(rel));
  credentialDestinationBindings.set(path.resolve(destination), {
    root: rootAnchor,
    parent: parentAnchor,
  });
  return destination;
}

function copyCredentialFileAtomicCli(sourcePath, destinationPath, options = {}) {
  const resolvedDestination = path.resolve(destinationPath);
  const binding = credentialDestinationBindings.get(resolvedDestination) || null;
  try {
    const source = fs.realpathSync.native(path.resolve(sourcePath));
    const sourceStat = fs.statSync(source);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error("credential source must be a non-empty regular file no larger than 16 MiB");
    }
    const root = binding ? credentialAssertDirectoryAnchor(binding.root, "credential project root") : null;
    const parent = binding
      ? credentialAssertDirectoryAnchor(binding.parent, "credential destination directory", root)
      : credentialDirectoryAnchor(path.dirname(resolvedDestination), "credential destination directory");
    if (path.dirname(resolvedDestination) !== parent.path || path.basename(resolvedDestination).includes(path.sep)) {
      throw new Error("credential destination path is not anchored to its managed directory");
    }
    const destination = path.join(parent.realpath, path.basename(resolvedDestination));
    const snapshot = (() => {
      try {
        const stat = credentialFileSnapshot(destination, "credential destination");
        if (!options.force) throw new Error("credential destination already exists (use --force to replace)");
        return { exists: true, stat };
      } catch (error) {
        if (error && error.code === "ENOENT") return { exists: false };
        throw error;
      }
    })();
    const temp = path.join(parent.realpath, `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let tempStat = null;
    try {
      credentialAssertDirectoryAnchor(parent, "credential destination directory", root);
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
      tempStat = credentialFileSnapshot(temp, "credential temporary file");
      if (!tempStat || tempStat.size !== sourceStat.size) {
        throw new Error("credential copy did not produce the exact regular file");
      }
      let readFd;
      try {
        readFd = fs.openSync(temp, fs.constants.O_RDONLY | CREDENTIAL_NOFOLLOW);
        const opened = fs.fstatSync(readFd);
        if (!credentialSameFileSnapshot(opened, tempStat) || opened.size !== sourceStat.size) {
          throw new Error("credential temporary file changed while opening");
        }
      } finally {
        if (readFd !== undefined) try { fs.closeSync(readFd); } catch { /* preserve original failure */ }
      }
      try { fs.chmodSync(temp, 0o600); } catch { /* Windows/best-effort */ }
      credentialAssertDirectoryAnchor(parent, "credential destination directory", root);
      credentialPublishFile(parent, path.basename(destination), { path: temp, stat: tempStat }, snapshot.exists ? snapshot.stat : null);
    } finally {
      if (tempStat) credentialRemoveOwnedFile(temp, tempStat);
    }
    return destinationPath;
  } finally {
    if (binding) credentialDestinationBindings.delete(resolvedDestination);
  }
}

module.exports = {
  CREDENTIAL_INDEX_SECTION_CLI,
  localCredentialConfigCli,
  projectEnvIdCli,
  projectScopedGlobalEnvKeyCli,
  projectScopedEnvValuesCli,
  localCredentialsMapSkeletonCli,
  credentialIndexSectionContentCli,
  projectSoulTemplateCli,
  ensureSoulCredentialIndexCli,
  envExampleContentCli,
  signingReadmeContentCli,
  credentialsReadmeContentCli,
  ensureAgentlasCredentialIgnoreCli,
  ensureLocalCredentialStoreCli,
  readJsonObjectCli,
  upsertLocalCredentialMapCli,
  safeCredentialDestRelCli,
  credentialProjectRootCli,
  resolveCredentialDestinationCli,
  copyCredentialFileAtomicCli,
};
